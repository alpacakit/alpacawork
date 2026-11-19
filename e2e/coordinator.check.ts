
import { coordinatorMessage, coordinatorCompleted } from './coordinator-completion.ts';
import { stringify } from 'yaml';
import { writeFixtureConfig } from './fixture-writes.ts';
import { fixtureAgentSetting, installAgentStub } from '../tests/helpers/agent-stub.ts';
import { test, expect, open, openCoordinator, settleMotion } from './fixtures.ts';

const fake = new URL('../tests/fixtures/fake-coordinator-agent.mjs', import.meta.url).pathname;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64');

test.use({ isolated: true });
/** The isolated coordinator is the claude adapter run through a local stub (never a provider CLI): it reports its launch. */
const fakeCoordinator = (runtime: { root: string }, rows?: Record<string, string[]>) => {
  installAgentStub(runtime.root, 'claude', [process.execPath, fake]);
  const setting = fixtureAgentSetting('claude');
  if (rows) Object.assign(setting.params, rows);
  // A second kind with one more row at the menu's foot (codex's fast).
  writeFixtureConfig(runtime.root, stringify({ agents: { fake: setting, codex: fixtureAgentSetting('codex') } }, { lineWidth: 0 }));
};

// On a phone too: the chip is in the send row, and its menu opens over the coordinator's sheet, where a finger reaches it.
for (const phone of [true]) test.describe(phone ? 'phone' : 'pc', () => {
  if (phone) test.use({ viewport: { width: 412, height: 846 }, hasTouch: true, isMobile: true });
  test(`the model and effort chosen in the card start the next message and come back after the screen is opened again${phone ? ' (phone)' : ''}`, async ({ page, runtime }) => {
    test.setTimeout(120_000);
    // The fake agent reports the --model and --effort it was launched with.
    // More models than the menu shows at once: only its list scrolls.
    fakeCoordinator(runtime, { model: ['opus', ...Array.from({ length: 12 }, (_, at) => `model-${at + 1}`), 'fable'], effort: ['high', 'max'] });
    const openCard = async () => {
      await openCoordinator(page);
      const card = page.locator('[data-coordinator-card], [data-coordinator-panel]');
      await expect(card.getByRole('button', { name: 'Attach', exact: true })).toBeEnabled();
      return card;
    };
    const send = async (card: ReturnType<typeof page.locator>, text: string, count: number) => {
      await card.getByRole('textbox', { name: 'Message the coordinator' }).fill(text);
      await card.locator('[data-ask-send]').click();
      // Opened again, the exchanges before the one it opened on fold into one row: this one is answered, and shown.
      await expect.poll(async () => ((await (await page.request.get(`${runtime.origin}/api/coordinator`)).json()).conversation.turns as { status: string }[])
        .filter(turn => turn.status === 'succeeded').length).toBe(count);
      await expect(card.locator('[data-coordinator-turn]').last()).toHaveAttribute('data-coordinator-turn', 'succeeded');
      return JSON.parse((await card.locator('[data-coordinator-turn]').last().locator('[data-ask-answer]').textContent())!).args as string[];
    };
    await open(page, runtime);
    let card = await openCard();
    const picker = card.locator('[data-agent-picker]');
    await expect(picker).toBeVisible();
    // The whole chip is in the card's width, beside the send button.
    const chip = (await picker.boundingBox())!, row = (await card.locator('[data-ask-send]').boundingBox())!;
    expect(chip.x + chip.width).toBeLessThanOrEqual(row.x);
    if (phone) await picker.tap(); else await picker.click();
    const menu = page.locator('[data-agent-picker-menu]');
    await expect(menu).toBeVisible();
    // On a phone it comes up as a sheet.
    await settleMotion(page);
    // What a press there lands on is the menu, not the card under it.
    const box = (await menu.boundingBox())!;
    expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-agent-picker-menu]'), { x: box.x + box.width / 2, y: box.y + box.height / 2 })).toBe(true);
    // Opened, the chosen model has the focus.
    await expect(menu.getByRole('radio', { name: 'opus', exact: true })).toBeFocused();
    // Choosing far down the list leaves the menu where it stood: a kind with one more row at the foot takes that row's
    // room from the list, the chosen row stays in sight over the list's fading foot, and nothing in the menu reaches
    // past the list to make its surface scroll.
    const surface = page.locator('[data-slot=sheet], [data-slot=popover-content]').filter({ has: menu });
    const stood = await surface.boundingBox();
    const other = menu.locator('[data-agent-kind-rows=codex] label').first();
    await other.click();
    await expect(menu.getByText('fast', { exact: true })).toHaveCount(2);
    expect(await surface.boundingBox()).toEqual(stood);
    expect(await other.evaluate(row => { const list = row.closest('[role=radiogroup]')!, fade = parseFloat(getComputedStyle(list).getPropertyValue('--fade'));
      return row.getBoundingClientRect().bottom <= list.getBoundingClientRect().bottom - fade; })).toBe(true);
    await menu.getByText('fable', { exact: true }).click();
    await menu.getByText('max', { exact: true }).click();
    expect(await menu.evaluate(el => { const surface = el.closest('[data-slot=sheet], [data-slot=popover-content]')!; return surface.scrollTop === 0 && surface.scrollHeight <= surface.clientHeight; })).toBe(true);
    await page.keyboard.press('Escape');
    await expect(card.locator('[data-agent-picker]')).toHaveText('fable(max)');
    expect(await send(card, 'Select and send', 1)).toEqual(['fable', 'max']);
    // Opened again, a message going on in the conversation carries none of this device's choices: this device's last
    // choice changes, the conversation's model and effort stay.
    await page.evaluate(() => localStorage.setItem('alpacawork.launchChoice', JSON.stringify({ agent: 'fake', values: { fake: { model: 'opus', effort: 'high' } } })));
    await page.reload();
    card = await openCard();
    await expect(card.locator('[data-agent-picker]')).toHaveText('fable(max)');
    expect(await send(card, 'Reopen and send', 2)).toEqual(['fable', 'max']);
    // A new conversation starts from this device's last choice; a kept model the config no longer offers goes back to
    // the first one, the kept effort stays.
    await page.evaluate(() => localStorage.setItem('alpacawork.launchChoice', JSON.stringify({ agent: 'fake', values: { fake: { model: 'sonnet', effort: 'max' } } })));
    await page.reload();
    card = await openCard();
    await card.locator('[data-coordinator-clear]').click();
    await card.locator('[data-coordinator-clear]').click();
    await expect(card.locator('[data-ask-answer]')).toHaveCount(0);
    await expect(card.locator('[data-agent-picker]')).toHaveText('opus(max)');
    expect(await send(card, 'New conversation', 1)).toEqual(['opus', 'max']);
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
    // Opening the card on a new conversation started it in the background: the first message continues that session.
    expect(first.mode).toBe('resume'); expect(first.imageBytes).toBe(PNG.length);
    await input.fill('Follow-up question');
    const followUp = coordinatorMessage(page);
    await card.locator('[data-ask-send]').click();
    await coordinatorCompleted(page, runtime, await followUp);
    await expect(card.locator('[data-ask-answer]')).toHaveCount(2);
    const second = JSON.parse((await card.locator('[data-ask-answer]').last().textContent())!);
    expect(second.mode).toBe('resume'); expect(second.session).toBe(first.session);
    // Under the thumb that reads the answer, starting over asks for a second press.
    await card.locator('[data-coordinator-clear]').click();
    // It asks over itself, staying where it was pressed.
    await expect(page.locator('[data-coordinator-clear-ask]')).toHaveText('Click again to clear');
    await expect(card.locator('[data-coordinator-clear]')).toHaveAttribute('aria-label', 'Click again to clear');
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
      await card.locator('[data-coordinator-clear]').click();
      await expect.poll(() => replyReady).toBe(true);
      await expect(card.locator('[data-ask-answer]')).toHaveCount(0);
      await expect(input).toHaveAttribute('contenteditable', 'false');
    } finally { releaseClear(); }
    await expect(input).toHaveAttribute('contenteditable', 'true');
    await input.fill('New conversation');
    await card.locator('[data-ask-send]').click();
    await expect(card.locator('[data-ask-answer]')).toHaveCount(1);
    const third = JSON.parse((await card.locator('[data-ask-answer]').first().textContent())!);
    expect(third.mode).toBe('resume'); expect(third.session).not.toBe(first.session);
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
