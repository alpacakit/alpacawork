import type { Page } from '@playwright/test';
import { test, expect, open, openCoordinator, openReference, writeCoordinator, settleMotion } from './fixtures.ts';
import { configureCoordinator, revealReplies } from './coordinator-fixture.ts';

const panel = (page: Page) => page.locator('[data-coordinator-panel]');
const reader = (page: Page) => page.locator('aside[data-reader-mode]');
const heightKey = 'alpacawork.coordinatorExtent';

async function talking(page: Page, runtime: { root: string; origin: string }) {
  configureCoordinator(runtime.root);
  const conversation = (await (await page.request.get(`${runtime.origin}/api/coordinator`)).json()).conversation;
  const sent = await page.request.post(`${runtime.origin}/api/coordinator/messages`, { data: {
    conversationId: conversation.id, id: crypto.randomUUID(), text: 'T11 markdown-answer', tasks: ['T11'], attachments: [],
  } });
  expect(sent.ok()).toBe(true);
  await expect.poll(async () => (await (await page.request.get(`${runtime.origin}/api/coordinator`)).json()).conversation.turns.at(-1)?.status,
    { timeout: 20_000 }).toBe('succeeded');
  await open(page, runtime, '?agent=1');
  // Exercise the real input too: the half-height budget includes this separate surface.
  await writeCoordinator(page);
  if (!await panel(page).isVisible()) await openCoordinator(page);
  // The latest answer is shown on opening; reveal older unread answers if present.
  await revealReplies(page);
  await settleMotion(page);
}

// A phone opens the detail as a whole sheet behind the lower-half conversation and Back folds both; a computer opens it
// from the hover card, docked beside the conversation, and Back closes the detail alone (follow-task.ts, close-on-back.ts).
for (const screen of [
  { width: 390, height: 844, phone: true },
  { width: 1280, height: 800, phone: false },
]) test.describe(`${screen.width}×${screen.height} conversation task links`, () => {
  test.use({ isolated: true, viewport: { width: screen.width, height: screen.height }, isMobile: screen.phone, hasTouch: screen.phone });
  // Both open through followTask (follow-task.ts); the answer's link is pressed here, the sent label's own press is not run.
  for (const source of ['answer'] as const) test(`${source} opens detail behind the conversation and keeps ordinary close and Back`, async ({ page, runtime }, testInfo) => {
    await talking(page, runtime);
    const link = panel(page).locator('[data-ask-answer] [data-task-reference="T11"]');
    await expect(link).toHaveCount(1);
    const follow = async () => {
      await link.scrollIntoViewIfNeeded();
      if (screen.phone) await openReference(link, { tap: true });
      else {
        await link.hover();
        await expect(page.getByRole('dialog', { name: 'T11', exact: true })).toBeVisible();
        await expect(page.locator('[data-task-peek]')).toHaveCount(0);
        await page.locator('[data-task-card-open]').click();
      }
      await expect(reader(page).locator('[data-reader-task-id]')).toHaveText('T11');
      await settleMotion(page);
    };
    await follow();
    const geometry = await page.evaluate(() => {
      const bounds = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().toJSON();
      return { reader: bounds('aside[data-reader-mode]'), panel: bounds('[data-coordinator-panel]'), input: bounds('[data-coordinator-card]') };
    });
    await testInfo.attach('geometry', { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' });
    await page.screenshot({ path: testInfo.outputPath('opened.png') });
    if (screen.phone) {
      await expect(page.locator('[data-sheet]')).toHaveAttribute('data-whole', 'true');
      const sheet = (await page.locator('[data-sheet]').boundingBox())!;
      expect(sheet.y).toBe(0); expect(sheet.height).toBe(screen.height);
      expect(Math.abs(geometry.panel.y - screen.height / 2)).toBeLessThanOrEqual(1);
      expect(geometry.input.bottom).toBe(screen.height);
      expect(geometry.panel.bottom).toBeLessThanOrEqual(geometry.input.top + 1);
      const hits = await page.evaluate(({ width, height }) => ({
        upper: !!document.elementFromPoint(width / 2, height / 4)?.closest('[data-sheet]'),
        lower: !!document.elementFromPoint(width / 2, height * 0.65)?.closest('[data-coordinator-panel]'),
        input: !!document.elementFromPoint(width / 2, height - 30)?.closest('[data-coordinator-card]'),
      }), screen);
      expect(hits).toEqual({ upper: true, lower: true, input: true });
      await page.screenshot({ path: testInfo.outputPath('phone-half.png') });
    } else {
      await expect(reader(page)).toHaveAttribute('data-reader-mode', 'docked');
      await expect(page.locator('[data-sheet]')).toHaveCount(0);
      expect(await page.evaluate(key => localStorage.getItem(key), heightKey)).toBeNull();
      // The detail docks beside the conversation and its input, covering neither, which stand one over the other.
      expect(geometry.panel.right).toBeLessThanOrEqual(geometry.reader.left);
      expect(geometry.input.right).toBeLessThanOrEqual(geometry.reader.left);
      expect(geometry.panel.left).toBe(geometry.input.left);
      expect(geometry.panel.bottom).toBeLessThanOrEqual(geometry.input.top);
      expect(geometry.input.bottom).toBeLessThanOrEqual(screen.height);
    }
    const saved = await page.evaluate(key => localStorage.getItem(key), heightKey);
    await reader(page).getByRole('button', { name: 'Close details', exact: true }).click();
    await expect(reader(page)).toHaveCount(0);
    // On a phone that press is a tap on what the conversation stands over, and folds it; a computer's conversation
    // goes down by itself on no tap, read once the press's motion is over.
    if (screen.phone) await expect(panel(page)).toHaveCount(0);
    else { await settleMotion(page); await expect(panel(page)).toBeVisible(); }
    expect(await page.evaluate(key => localStorage.getItem(key), heightKey)).toBe(saved);
    // Peeking records no read; reopening still shows the latest answer directly.
    if (screen.phone) { await openCoordinator(page); await revealReplies(page); }
    await settleMotion(page);
    await follow();
    // Browser Back closes the detail; on a phone it folds the conversation too.
    await page.goBack();
    await expect(reader(page)).toHaveCount(0);
    if (screen.phone) await expect(panel(page)).toHaveCount(0);
    else await expect(panel(page)).toBeVisible();
    expect(await page.evaluate(key => localStorage.getItem(key), heightKey)).toBe(saved);
    // Once Back's motion is over, a computer's conversation is still up (the check above can pass before a fold starts).
    if (!screen.phone) { await settleMotion(page); await expect(panel(page)).toBeVisible(); }
    if (screen.phone) await openCoordinator(page);
    await settleMotion(page);
    expect(await page.evaluate(key => localStorage.getItem(key), heightKey)).toBe(saved);
  });

});

test.describe('conversation in its own window', () => {
  test.use({ isolated: true, viewport: { width: 1440, height: 900 } });
  test('hover uses that window for the card and pointer corridor', async ({ page, runtime, context }) => {
    await talking(page, runtime);
    test.skip(!(await page.evaluate(() => 'documentPictureInPicture' in window)), 'Document PiP unavailable');
    const pending = context.waitForEvent('page');
    await page.locator('[data-coordinator-pop-out]').focus();
    await page.keyboard.press('Enter');
    const own = await pending;
    try {
      const reference = own.locator('[data-ask-answer] [data-task-reference="T11"]').first();
      await reference.hover();
      const card = own.getByRole('dialog', { name: 'T11', exact: true });
      await expect(card).toBeVisible();
      await expect(page.locator('[data-badge-card]')).toHaveCount(0);
      const from = (await reference.boundingBox())!, to = (await card.boundingBox())!;
      const x = Math.max(to.x + 4, Math.min(from.x + from.width / 2, to.x + to.width - 4));
      const edge = to.y < from.y ? to.y + to.height : to.y;
      await own.mouse.move(x, (edge + (to.y < from.y ? from.y : from.y + from.height)) / 2, { steps: 10 });
      await own.waitForTimeout(700);
      await expect(card).toBeVisible();
      await card.locator('[data-task-card-open]').hover();
      await own.waitForTimeout(700);
      await expect(card).toBeVisible();
      await card.locator('[data-task-card-open]').click();
      await expect(reader(page).locator('[data-reader-task-id]')).toHaveText('T11');
    } finally { await own.close(); }
  });
});
