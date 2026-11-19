import { test, expect, open } from './fixtures.ts';
import { commandPost } from './command-post.ts';

test.use({ isolated: true, fixedTime: false });

test('DNS failures and a 200 stream body failure recover automatically while native networking stays online', async ({ page, runtime }, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const failed: string[] = [], faults: string[] = [];
  page.on('requestfailed', request => { if (request.url().includes('/api/events')) failed.push(request.failure()?.errorText ?? 'unknown'); });
  page.on('pageerror', error => faults.push(error.message));
  await page.addInitScript(() => {
    const nativeFetch = window.fetch;
    Object.assign(window, { failStream: undefined });
    window.fetch = async (...args) => {
      const response = await nativeFetch(...args);
      if (!String(args[0]).includes('/api/events') || !response.body) return response;
      const transform = new TransformStream<Uint8Array, Uint8Array>({
        start(controller) { Object.assign(window, { failStream: () => controller.error(new TypeError('injected stream connection aborted after HTTP 200')) }); },
      });
      return new Response(response.body.pipeThrough(transform), { status: response.status, headers: response.headers });
    };
  });
  let attempts = 0;
  await page.route('**/api/events*', route => ++attempts <= 2 ? route.abort('namenotresolved') : route.continue());
  await open(page, runtime, '?agent=1');
  await expect.poll(() => attempts).toBeGreaterThanOrEqual(3);
  await expect(page.locator('[data-progress-line="loading"]')).toHaveCount(0);
  await expect(page.locator('[data-offline-mark]')).toHaveCount(0);
  expect(failed.filter(error => error.includes('ERR_NAME_NOT_RESOLVED'))).toHaveLength(2);
  const previous = attempts;
  // No visibility, online event or reload: the production stream parser must retry this body failure itself.
  await page.evaluate(() => (window as unknown as { failStream: () => void }).failStream());
  await expect.poll(() => attempts).toBeGreaterThan(previous);
  await expect(page.locator('[data-progress-line="loading"]')).toHaveCount(0);
  await expect(page.locator('[data-offline-mark]')).toHaveCount(0);
  await expect(page.locator('[data-toast-id="offline"]')).toHaveCount(0);
  expect(await page.evaluate(() => navigator.onLine)).toBe(true);
  const { task } = await (await page.request.get(`${runtime.origin}/api/task/view?task=T11`)).json();
  const changed = await commandPost(page.request, `${runtime.origin}/api/task/update`, {
    data: { task: 'T11', title: 'Update received after reconnect', expectedTaskHash: task.hash },
  });
  expect(changed.ok(), await changed.text()).toBe(true);
  await expect(page.locator('[data-row=T11]')).toContainText('Update received after reconnect');
  expect(faults).toEqual([]);
  await info.attach('automatic-recovery.json', { body: JSON.stringify({ failed, attempts, faults, viewport: 390, nativeOnline: true }), contentType: 'application/json' });
  await info.attach('recovered.png', { body: await page.screenshot(), contentType: 'image/png' });
});
