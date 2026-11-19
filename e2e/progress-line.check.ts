import { test as base, expect, open } from './fixtures.ts';
import { start } from './server.ts';

// Out of reach, the feed's grey line stands flush with the screen's top edge, nothing behind it shows above
// it, and the bar's one mark explains it. Its own serve, so the check can take it away.
type Served = Awaited<ReturnType<typeof start>>;
const test = base.extend<{ runtime: Served }>({ runtime: async ({}, use) => {
  const runtime = await start();
  try { await use(runtime); } finally { await runtime.stop(); }
} });
test.use({ isolated: true });

test('online before foreground does not reuse a hidden stream failure', async ({ page, runtime }, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 844 });
  await open(page, runtime, '?agent=1');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  let failed = 0;
  await page.route('**/api/events*', async route => { failed++; await route.abort('failed'); });
  // Fail the hidden SSE while native networking remains online, creating historical failures.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => failed).toBeGreaterThanOrEqual(2);
  await expect(page.locator('[data-toast-id="offline"]')).toHaveCount(0);
  await page.unroute('**/api/events*');
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let requested = 0;
  await page.route('**/api/events*', async route => { requested++; await pending; await route.continue().catch(() => {}); });
  try {
    // Both events arrive in one task, before React has installed the next subscription effect.
    await page.evaluate(() => {
      window.dispatchEvent(new Event('online'));
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => requested).toBeGreaterThan(0);
    expect(await page.evaluate(() => navigator.onLine)).toBe(true);
    await page.waitForTimeout(2300);
    await info.attach('online-first-resume.png', { body: await page.screenshot(), contentType: 'image/png' });
    await expect(page.locator('[data-toast-id="offline"]')).toHaveCount(0);
    await expect(page.locator('[data-offline-mark]')).toHaveCount(0);
  } finally { release(); }
});
