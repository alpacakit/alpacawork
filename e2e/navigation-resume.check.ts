
import type { Page } from '@playwright/test';
import { test, expect, open } from './fixtures.ts';
import { readSnapshot } from './read-evidence.ts';
test.use({ isolated: true });
const reader = (page: Page) => page.getByRole('complementary', { name: 'Full text of the task' });
const task = (page: Page) => new URL(page.url()).searchParams.get('task');
const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('alpacawork.navigation.v2')!));

for (const width of [1440]) {
  test(`root startup restores the last committed task and list, explicit links and notifications win (${width}px)`, async ({ page, context, runtime }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page, runtime, '?task=T111&tab=files');
    await expect(reader(page)).toBeVisible();
    await expect.poll(async () => (await stored(page))?.search).toContain('task=T111');
    // A new page has no session/history from the old page, just the same origin's localStorage.
    await page.close();
    const next = await context.newPage();
    await next.setViewportSize({ width, height: 900 });
    await open(next, runtime);
    await expect.poll(() => task(next)).toBe('T111');
    await expect(reader(next)).toBeVisible();
    expect(new URL(next.url()).searchParams.get('tab')).toBe('files');
    await reader(next).getByRole('button', { name: 'Close details' }).click();
    await expect(reader(next)).toHaveCount(0);
    await expect.poll(async () => new URLSearchParams((await stored(next)).search).has('task')).toBe(false);
    await next.close();
    const list = await context.newPage();
    await list.setViewportSize({ width, height: 900 });
    await open(list, runtime);
    await expect(reader(list)).toHaveCount(0);
    expect(task(list)).toBeNull();
    // A link to a task or an explicit list/search takes priority over another saved task.
    await open(list, runtime, '?task=T111');
    await open(list, runtime, '?task=T113');
    await expect.poll(() => task(list)).toBe('T113');
    await expect(reader(list)).toContainText('T113');
    await list.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'open-task', task: 'T111' } })));
    await expect.poll(() => task(list)).toBe('T111');
    await list.goto(`${runtime.origin}/?q=UI`);
    await expect.poll(() => new URL(list.url()).searchParams.get('q')).toBe('UI');
    await expect(reader(list)).toHaveCount(0);
    expect(task(list)).toBeNull();
    expect(new URL(list.url()).searchParams.get('q')).toBe('UI');
    await list.close();
  });
}

test.describe('native resume read failure', () => {
  test.use({ retainRuntime:true, captureScreenshots:false });
  test('an in-flight resume GET lost to native offline resumes from a fresh accepted GET', async ({page,context,runtime}) => {
    await page.setViewportSize({width:1440,height:900});
    await open(page,runtime,'?task=T111&tab=files');
    await expect(page.locator('[data-reader-task-id]')).toHaveText('T111');
    await expect.poll(async () => ((await readSnapshot(page)).idb as any)?.slots?.some((slot:any) =>
      slot.query?.queryKey?.[0] === 'task' && slot.query.queryKey[2] === 'T111')).toBe(true);
    const saved = await stored(page);
    await page.close();
    const next = await context.newPage();
    await next.setViewportSize({width:1440,height:900});
    const network:any[] = [];
    next.on('request', request => network.push({kind:'request',url:request.url(),at:Date.now()}));
    next.on('response', response => network.push({kind:'response',url:response.url(),status:response.status(),at:Date.now()}));
    next.on('requestfailed', request => network.push({kind:'failed',url:request.url(),failure:request.failure(),at:Date.now()}));
    let release!: () => void, seen!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const requested = new Promise<void>(resolve => { seen = resolve; });
    await next.route('**/api/task/view?task=T111', async route => { seen(); await gate; await route.continue(); });
    try {
      await next.goto(runtime.origin + '/');
      await requested;
      await context.setOffline(true);
      await expect.poll(() => next.evaluate(() => navigator.onLine)).toBe(false);
      release();
      await expect.poll(async () => ((await readSnapshot(next)).queries as any)?.find((query:any) =>
        query.key?.[0] === 'task' && query.key[2] === 'T111')?.state.fetchStatus).toBe('idle');
      const networkBeforeReconnect = [...network];
      expect(await stored(next)).toEqual(saved);
      await context.setOffline(false);
      await expect(next.locator('[data-progress-line="offline"]')).toHaveCount(0);
      await expect.poll(() => network.some(event => event.kind === 'response' && event.url.endsWith('/api/events') && event.status === 200)).toBe(true);
      await expect.poll(() => task(next)).toBe('T111');
      await expect(reader(next)).toBeVisible();
      expect(new URL(next.url()).searchParams.get('tab')).toBe('files');
      await expect(reader(next).locator('[data-reader-content] [role=toolbar]')).toBeVisible();
      expect(networkBeforeReconnect.some(event => event.kind === 'failed' && event.failure?.errorText === 'net::ERR_INTERNET_DISCONNECTED'
        && event.url.includes('/api/task/view?task=T111'))).toBe(true);
      expect(network.some(event => event.kind === 'response' && event.status === 200 && event.url.includes('/api/task/view?task=T111'))).toBe(true);
    } finally { release(); await context.setOffline(false); await next.close(); }
  });
});
