
import { writeFileSync } from 'node:fs';
import { test as base, expect, open, openCoordinator } from './fixtures.ts';
import { configureCoordinator, readyCoordinator, revealReplies } from './coordinator-fixture.ts';
import { coordinatorSnapshotSchema } from '@alpacawork/contract/coordinator';
import { start } from './server.ts';

const test = base.extend({ runtime: async ({}, use) => {
  const runtime = await start(undefined, root => {
    configureCoordinator(root);
    writeFileSync(root + '/answer.md', '**Source heading**\n\n' + Array.from({ length: 20 }, (_, i) => `${i + 1}. A point in the original answer.`).join('\n'));
  });
  try { await use(runtime); } finally { await runtime.stop(); }
} });
test.use({ isolated: true });
for (const phone of [false, true]) test.describe(phone ? 'phone reply navigation' : 'pc reply navigation', () => {
  test.use({ viewport: { width: phone ? 390 : 1440, height: 900 }, hasTouch: phone, isMobile: phone });

  if (!phone) test('an unconfirmed queued reply returns to its sent message and cannot jump after acceptance or another disclosure', async ({ page, runtime }) => {
    await open(page, runtime, '?agent=1'); await openCoordinator(page);
    await readyCoordinator(page, runtime);
    const field = page.locator('[data-one-input]'), send = page.locator('[data-ask-send]');
    await field.fill('answer-from:' + runtime.root + '/answer.md'); await send.click();
    const source = page.locator('[data-coordinator-turn=succeeded]').first(); await expect(source).toBeVisible();
    await field.fill('wait:' + runtime.root + '/gate'); await send.click();
    await expect(page.locator('[data-coordinator-turn=running]')).toBeVisible();
    await revealReplies(page);
    if (await source.getAttribute('data-exchange') === 'folded') await source.locator('[data-exchange-toggle]').click();
    await source.locator('[data-reply-answer]').click(); await field.press('End'); await field.pressSequentially('unconfirmed reply');
    let release!: () => void, localId = '';
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/coordinator/messages', async route => {
      localId = route.request().postDataJSON().id; await held; await route.continue();
    });
    try {
      await send.click();
      const local = page.locator('[data-coordinator-local=sending]'); await expect(local).toBeVisible();
      expect(await page.locator(`[data-coordinator-origin="${localId}"]`).count()).toBe(1);
      await local.locator('[data-label=reply] [aria-haspopup]').click();
      await page.getByRole('button', { name: 'Go to the original reply', exact: true }).click();
      await expect(source.locator('[data-ask-answer][data-reply-flash]')).toBeInViewport();
      await page.locator('[data-reply-return]').click();
      await expect(page.locator('[data-reply-return]')).toHaveCount(0);
      await expect(local).toBeInViewport();
      release(); await page.unrouteAll({ behavior: 'wait' }); writeFileSync(runtime.root + '/gate', '');
      const arrived = page.locator(`[data-coordinator-message="${localId}"]`);
      await expect(arrived).toHaveAttribute('data-coordinator-turn', 'succeeded');
      await expect(page.locator('[data-reply-flash]')).toHaveCount(0, { timeout: 6000 });
      // Observe the entire later disclosure, including transient flashes and scrolls to the new message.
      await arrived.locator('[data-coordinator-origin]').evaluate(element => {
        (window as any).__unexpectedReplyFlash = false;
        new MutationObserver(() => { if (element.hasAttribute('data-reply-flash')) (window as any).__unexpectedReplyFlash = true; })
          .observe(element, { attributes: true, attributeFilter: ['data-reply-flash'] });
      });
      await source.locator('[data-exchange-toggle]').click();
      await expect(source).toHaveAttribute('data-exchange', 'folded');
      await page.waitForTimeout(500);
      expect(await page.evaluate(() => (window as any).__unexpectedReplyFlash)).toBe(false);
      await expect(page.locator('[data-reply-return]')).toHaveCount(0);
    } finally {
      release(); writeFileSync(runtime.root + '/gate', ''); await page.unrouteAll({ behavior: 'wait' });
    }
  });

  if (!phone) test('after a reset from the usage ring, a reply to a message no longer among the recent ones still goes, and the ring takes the new figure', async ({ page, runtime }) => {
    await open(page, runtime, '?agent=1'); await openCoordinator(page);
    await readyCoordinator(page, runtime);
    const field = page.locator('[data-one-input]'), send = page.locator('[data-ask-send]');
    const snapshot = async () => coordinatorSnapshotSchema.parse(await (await page.request.get(runtime.origin + '/api/coordinator')).json()).conversation;
    await field.fill('answer-from:' + runtime.root + '/answer.md'); await send.click();
    await expect(page.locator('[data-coordinator-turn=succeeded]').first()).toBeVisible();
    const { id: conversationId, turns: [source] } = await snapshot();
    // Twenty more exchanges push it out of the recent ones the conversation is served with; the last one reports usage.
    for (let n = 1; n <= 20; n++) {
      const posted = await page.request.post(runtime.origin + '/api/coordinator/messages',
        { data: { conversationId, id: crypto.randomUUID(), text: n === 20 ? 'usage:150000' : `filler ${n}`, attachments: [] } });
      expect(posted.ok()).toBe(true);
    }
    await expect.poll(async () => { const now = await snapshot(); return !now.busy && now.turns.every(turn => turn.status === 'succeeded'); }, { timeout: 60_000 }).toBe(true);
    const before = await snapshot();
    expect(before.turns.some(turn => turn.id === source!.id)).toBe(false);
    expect(before.earlier).not.toBeNull();
    const ring = page.locator('[data-coordinator-context]');
    await expect(ring).not.toHaveText('—');

    // Reset from the ring's menu: one line where it happened, and no figure until the new coordinator answers.
    await ring.click(); await page.locator('[data-coordinator-reset]').click();
    await expect(page.locator('[data-coordinator-reset-line=asked]')).toBeVisible();
    await expect(ring).toHaveText('—');

    // The source is read back a page at a time, then replied to.
    await revealReplies(page);
    const origin = page.locator(`[data-coordinator-message="${source!.id}"]`);
    // Opening reads the first older page; a further one is read as the history's head comes into sight.
    const head = page.locator('[data-earlier-head]');
    await expect.poll(async () => { if (!await origin.count()) await head.scrollIntoViewIfNeeded(); return origin.count(); }).toBe(1);
    if (await origin.getAttribute('data-exchange') === 'folded') await origin.locator('[data-exchange-toggle]').click();
    await origin.locator('[data-reply-answer]').click(); await field.press('End'); await field.pressSequentially('reply after reset');
    await send.click();
    await expect.poll(async () => (await snapshot()).turns.find(turn => turn.replyTo?.id === source!.id)?.status, { timeout: 30_000 }).toBe('succeeded');
    // From the reply sent, read afresh: its label leads back to the original answer, read back from the older pages.
    const reply = (await snapshot()).turns.find(turn => turn.replyTo?.id === source!.id)!;
    await page.reload(); await openCoordinator(page);
    await page.locator(`[data-coordinator-message="${reply.id}"] [data-label=reply] [aria-haspopup]`).click();
    await page.getByRole('button', { name: 'Go to the original reply', exact: true }).click();
    await expect(page.locator(`[data-coordinator-message="${source!.id}"] [data-ask-answer][data-reply-flash]`)).toBeInViewport({ timeout: 15_000 });
    await field.fill('usage:90000'); await send.click();
    await expect(ring).not.toHaveText('—', { timeout: 30_000 });
  });
});
