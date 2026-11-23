import { test, expect, open } from './fixtures.ts';
import { commandPost } from './command-post.ts';

test.use({ isolated: true, fixedTime: false });
// The read mark has no width of its own (read-store.ts, TimeTree's one data-unread): each case runs once, the widths shared between them.
for (const [width, fail] of [[390, true]] as const) test(`unread dot leaves on the click frame through list updates and ${fail ? 'returns on refusal' : 'stays read after save'} · ${width}`, async ({ page, runtime }, info) => {
  await page.setViewportSize({ width, height: 950 });
  await open(page, runtime);
  // Wait for the baseline's initial save before introducing unread news.
  await expect.poll(async () => (await (await page.request.get(runtime.origin + '/api/person/notices')).json()).revision).not.toBeNull();
  const response = await commandPost(page.request, runtime.origin + '/api/commands/task/new', { data: { title: 'Immediate read dot' } });
  expect(response.status()).toBe(200);
  const { task } = await response.json();
  const row = page.locator(`[data-row="${task.id}"]`);
  await expect(row.locator('[data-unread]')).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath(`before-${width}.png`) });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/person/notices/save', async route => {
    await gate;
    if (!fail) return route.continue();
    await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'forbidden', retry: 'fix', message: 'synthetic read refusal' } }) });
  });
  try {
    // Check the first paint after a genuine click handler. No network answer can resolve yet.
    await row.locator('[data-row-head]').evaluate((element, id) => {
      (window as any).readFrames = [];
      element.addEventListener('click', () => {
        const sample = () => {
          const row = document.querySelector(`[data-row="${id}"]`);
          (window as any).readFrames.push({ present: !!row, unread: !!row?.querySelector('[data-unread]') });
          if ((window as any).readFrames.length < 30) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, { once: true });
    }, task.id);
    await row.locator('[data-row-head]').click();
    await expect.poll(() => page.evaluate(() => (window as any).readFrames.length)).toBeGreaterThanOrEqual(30);
    expect(await page.evaluate(() => (window as any).readFrames)).toEqual(Array(30).fill({ present: true, unread: false }));
    const update = await commandPost(page.request, runtime.origin + '/api/commands/task/new', { data: { title: 'Unrelated list refresh while read is pending' } });
    expect(update.status()).toBe(200);
    const updated = await update.json();
    await expect(page.locator(`[data-row="${updated.task.id}"]`)).toBeVisible();
    await expect(row.locator('[data-unread]')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`pending-${width}.png`) });
    release();
    if (fail) await expect(row.locator('[data-unread]')).toHaveCount(1);
    else {
      await expect.poll(async () => (await (await page.request.get(runtime.origin + '/api/person/notices')).json()).state.reads[task.id]).toBeTruthy();
      await expect(row.locator('[data-unread]')).toHaveCount(0);
    }
    await page.screenshot({ path: info.outputPath(`refused-${width}.png`) });
  } finally { release(); }
});
