
import { coordinatorMessage, coordinatorCompleted } from './coordinator-completion.ts';
import { stringify } from 'yaml';
import { writeFixtureConfig } from './fixture-writes.ts';
import { fixtureAgentSetting, installAgentStub } from '../tests/helpers/agent-stub.ts';
import { test, expect, open, openCoordinator } from './fixtures.ts';

const fake = new URL('../tests/fixtures/fake-coordinator-agent.mjs', import.meta.url).pathname;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64');

test.use({ isolated: true });
/** The isolated coordinator is the claude adapter run through a local stub (never a provider CLI): it reports its launch. */
const fakeCoordinator = (runtime: { root: string }, rows?: Record<string, string[]>, input?: Record<string, string>) => {
  installAgentStub(runtime.root, 'claude', [process.execPath, fake]);
  const setting = fixtureAgentSetting('claude');
  if (rows) Object.assign(setting.params, rows);
  writeFixtureConfig(runtime.root, stringify({ agents: { fake: setting, codex: fixtureAgentSetting('codex') },
    ...input ? { coordinatorAiStack: [{ agent: 'fake', values: input }] } : {} }, { lineWidth: 0 }));
};

// On a phone too: the AI stands in the send row, and the settings open over the coordinator's sheet.
for (const phone of [true]) test.describe(phone ? 'phone' : 'pc', () => {
  if (phone) test.use({ viewport: { width: 412, height: 846 }, hasTouch: true, isMobile: true });
  test(`the input shows the AI its messages run on, offers no menu, and opens the settings onto that AI${phone ? ' (phone)' : ''}`, async ({ page, runtime }) => {
    test.setTimeout(120_000);
    // The fake agent reports the --model and --effort it was launched with.
    fakeCoordinator(runtime, { model: ['opus', 'fable'], effort: ['high', 'low'] }, { model: 'opus', effort: 'low' });
    await open(page, runtime);
    await openCoordinator(page);
    const card = page.locator('[data-coordinator-card], [data-coordinator-panel]');
    await expect(card.getByRole('button', { name: 'Attach', exact: true })).toBeEnabled();
    const shown = card.locator('[data-coordinator-ai]');
    await expect(shown).toHaveText('opus(low)');
    await expect(page.locator('[data-agent-picker]')).toHaveCount(0);
    // The whole of it is in the card's width, beside the send button.
    const chip = (await shown.boundingBox())!, send = (await card.locator('[data-ask-send]').boundingBox())!;
    expect(chip.x + chip.width).toBeLessThanOrEqual(send.x);
    // A message runs on what it shows.
    await card.getByRole('textbox', { name: 'Message the coordinator' }).fill('Say how you were launched');
    await card.locator('[data-ask-send]').click();
    await expect(card.locator('[data-coordinator-turn]').last()).toHaveAttribute('data-coordinator-turn', 'succeeded');
    expect(JSON.parse((await card.locator('[data-coordinator-turn]').last().locator('[data-ask-answer]').textContent())!).args).toEqual(['opus', 'low']);
    if (phone) await shown.tap(); else await shown.click();
    const heading = page.getByRole('heading', { name: 'AI you talk to in the input (coordinator)' });
    await expect(heading).toBeFocused();
    await expect(heading).toBeInViewport();
  });
});

test('the pinned coordinator card sends, resumes, attaches an image and starts over after clear', async ({ page, runtime }) => {
  test.setTimeout(120_000);
    fakeCoordinator(runtime);
    await open(page, runtime);
    await openCoordinator(page);
    const card = page.locator('[data-coordinator-card], [data-coordinator-panel]');
    await expect(page.locator('[data-coordinator-panel]')).toBeVisible();
    if (await page.getByRole('button', { name: 'Reconnect' }).isVisible())
      await page.getByRole('button', { name: 'Reconnect' }).click();
    await expect(card.getByRole('button', { name: 'Attach', exact: true })).toBeEnabled();
    const input = card.getByRole('textbox', { name: 'Message the coordinator' });
    await input.fill('First question');
    await card.locator('input[type=file]').setInputFiles({ name: 'sample.png', mimeType: 'image/png', buffer: PNG });
    await expect(card.locator('[data-attachment-state=saved]')).toHaveCount(1);
    await input.press('Meta+Enter');
    await expect(card.locator('[data-ask-answer]')).toHaveCount(1);
    const first = JSON.parse((await card.locator('[data-ask-answer]').first().textContent())!);
    expect(first.mode).toBe('start'); expect(first.imageBytes).toBe(PNG.length);
    await input.fill('Follow-up question');
    const followUp = coordinatorMessage(page);
    await card.locator('[data-ask-send]').click();
    await coordinatorCompleted(page, runtime, await followUp);
    await expect(card.locator('[data-ask-answer]')).toHaveCount(2);
    const second = JSON.parse((await card.locator('[data-ask-answer]').last().textContent())!);
    expect(second.mode).toBe('resume'); expect(second.session).toBe(first.session);
    await card.locator('[data-coordinator-context]').click();
    const clear = page.locator('[data-coordinator-clear]');
    await clear.click();
    await expect(clear).toHaveAttribute('data-asking', 'true');
    // Empty answers also occur while the old conversation is withdrawn. They do not certify the new editor.
    let releaseClear!: () => void, replyReady = false;
    const clearGate = new Promise<void>(resolve => { releaseClear = resolve; });
    await page.route('**/api/coordinator/clear', async route => {
      const response = await route.fetch(); replyReady = true; await clearGate; await route.fulfill({ response });
    });
    await page.route('**/api/coordinator', async route => {
      if (route.request().method() === 'GET') await clearGate;
      await route.continue();
    });
    try {
      await clear.click();
      await expect.poll(() => replyReady).toBe(true);
      await expect(card.locator('[data-ask-answer]')).toHaveCount(0);
      await expect(input).toHaveAttribute('contenteditable', 'false');
    } finally { releaseClear(); }
    await expect(input).toHaveAttribute('contenteditable', 'true');
    await input.fill('New conversation');
    await card.locator('[data-ask-send]').click();
    await expect(card.locator('[data-ask-answer]')).toHaveCount(1);
    const third = JSON.parse((await card.locator('[data-ask-answer]').first().textContent())!);
    expect(third.mode).toBe('start'); expect(third.session).not.toBe(first.session);
});

test('the coordinator moves into its own window and back, keeping its draft, and its keys and pictures stay there', async ({ page, runtime }) => {
  test.setTimeout(120_000);
  fakeCoordinator(runtime);
  await open(page, runtime);
  await openCoordinator(page);
  const card = page.locator('[data-coordinator-card], [data-coordinator-panel]');
  await expect(card.getByRole('button', { name: 'Attach', exact: true })).toBeEnabled();
  await card.getByRole('textbox', { name: 'Message the coordinator' }).fill('Continue in another window');
  const opened = page.context().waitForEvent('page');
  await card.getByRole('button', { name: 'Open in a separate window' }).click();
  const own = await opened;
  await expect(page.locator('[data-coordinator-card]')).toHaveCount(0);
  const moved = own.locator('[data-coordinator-own-window]');
  const input = moved.getByRole('textbox', { name: 'Message the coordinator' });
  await expect(input).toHaveText('Continue in another window');
  await expect(input).toBeFocused();
  // Drawn with the app's styles, at a computer's sizes however narrow the window.
  expect(await own.evaluate(() => getComputedStyle(document.querySelector('[data-ask-send]')!).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  expect(await moved.locator('[data-attach]').evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(40);

  // A picture opens over the conversation in its own window; Esc there closes the picture, not the window.
  await moved.locator('input[type=file]').setInputFiles({ name: 'sample.png', mimeType: 'image/png', buffer: PNG });
  await expect(moved.locator('[data-attachment-state=saved]')).toHaveCount(1);
  const thumbnail = moved.locator('[data-attachment-state=saved] button').first();
  await thumbnail.click({ position: { x: 8, y: 30 } });
  await expect(own.locator('[data-image-slider-modal]')).toBeVisible();
  await expect(page.locator('[data-image-slider-modal]')).toHaveCount(0);
  await own.keyboard.press('Escape');
  await expect(own.locator('[data-image-slider-modal]')).toHaveCount(0);
  // Focus returns to the picture on that window's next frame; until then a later focus (the send below) is taken back.
  await expect(thumbnail).toBeFocused();
  await own.keyboard.press('Escape');
  await expect(moved).toBeVisible();
  // Esc in the app's window does not close it either.
  await page.locator('body').press('Escape');
  await expect(moved).toBeVisible();

  await input.press('Meta+Enter');
  await expect(moved.locator('[data-ask-answer]')).toHaveCount(1);
  expect(JSON.parse((await moved.locator('[data-ask-answer]').textContent())!).imageBytes).toBe(PNG.length);
  // Made lower by hand, its window keeps the conversation's end in sight on the frames it draws then, not some time later.
  await moved.locator('[data-card-scroll]').evaluate(area => { area.scrollTop = area.scrollHeight; });
  await own.setViewportSize({ width: 480, height: 260 });
  expect(await own.evaluate(() => new Promise<number>(done => requestAnimationFrame(() => requestAnimationFrame(() => {
    const area = document.querySelector('[data-card-scroll]')!;
    done(area.scrollHeight - area.clientHeight - area.scrollTop);
  }))))).toBeLessThan(2);
  await input.fill('Send after returning');

  // Closing its window puts the card back on the screen, with the conversation and the draft.
  await own.close();
  await expect(page.locator('[data-coordinator-panel]')).toBeVisible();
  await expect(card.locator('[data-ask-answer]')).toHaveCount(1);
  await expect(card.getByRole('textbox', { name: 'Message the coordinator' })).toHaveText('Send after returning');
  await expect(card.getByRole('button', { name: 'Open in a separate window' })).toBeVisible();
  // Back on the screen it stands at the screen's foot again, as its input does (no head line to move it by).
  const back = (await page.locator('[data-coordinator-card]').boundingBox())!;
  expect(Math.round(back.y + back.height)).toBe(page.viewportSize()!.height - 12);

  // Its own button there puts it back too.
  const third = page.context().waitForEvent('page');
  await card.getByRole('button', { name: 'Open in a separate window' }).click();
  const backed = await third;
  const gone = backed.waitForEvent('close');
  // The button closes its own target during the click; Chromium may report that successful close before click returns.
  await backed.getByRole('button', { name: 'Back into the app' }).click().catch(error => {
    if (!backed.isClosed() || !String(error).includes('Target page, context or browser has been closed')) throw error;
  });
  await gone;
  await expect(card.getByRole('textbox', { name: 'Message the coordinator' })).toHaveText('Send after returning');

  // Its window closed, it is back on the screen; folded, its input stands at the foot again.
  const again = page.context().waitForEvent('page');
  await card.getByRole('button', { name: 'Open in a separate window' }).click();
  const second = await again;
  const closed = second.waitForEvent('close');
  await second.close();
  await closed;
  await page.locator('[data-coordinator-panel]').getByRole('button', { name: 'Close the conversation', exact: true }).click();
  await expect(page.locator('[data-coordinator-folded]')).toBeVisible();
});
