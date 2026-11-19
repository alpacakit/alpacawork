
import { writeFileSync } from 'node:fs';
import { test as base, expect, open, openCoordinator } from './fixtures.ts';
import { configureCoordinator, readyCoordinator } from './coordinator-fixture.ts';
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
    // The answer replied to is the send's own; the background warm-up it would otherwise wait behind has its own lifetime.
    await readyCoordinator(page, runtime);
    const field = page.locator('[data-one-input]'), send = page.locator('[data-ask-send]');
    await field.fill('answer-from:' + runtime.root + '/answer.md'); await send.click();
    const source = page.locator('[data-coordinator-turn=succeeded]').first(); await expect(source).toBeVisible();
    await field.fill('wait:' + runtime.root + '/gate'); await send.click();
    await expect(page.locator('[data-coordinator-turn=running]')).toBeVisible();
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
});
