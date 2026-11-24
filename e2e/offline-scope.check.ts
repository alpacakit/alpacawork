/** The offline scope's five requirements, through the product build, real SW and persistent browser profile. */
import { test as pwa, expect, controlledPwa } from './pwa-fixture.ts';
import { open, openCoordinator } from './fixtures.ts';
import { configureCoordinator, revealReplies, foldConversation } from './coordinator-fixture.ts';
import type { Page } from '@playwright/test';
const test = pwa.extend({ fixedTime: false,
  runtimePrepare: async ({}, use) => { await use(configureCoordinator); } });
test.setTimeout(120_000);
const reader = (page: Page) => page.locator('aside[data-reader-mode]');
async function disk(page: Page): Promise<any> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('alpacawork-read-checkpoint');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction(['control', 'slots']), control = tx.objectStore('control').get('current'), slots = tx.objectStore('slots').getAll();
      tx.oncomplete = () => { db.close(); resolve({ control: control.result, slots: slots.result.map(({ payload, ...slot }: any) => ({ ...slot, query: { ...slot.query, state: { ...slot.query.state, data: JSON.parse(payload) } } })) }); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }));
}
async function bind(page: Page) {
  await page.evaluate(() => {
    const root = document.getElementById('root')!, key = Object.keys(root).find(key => key.startsWith('__reactContainer'))!;
    let client: any; const seen = new Set();
    const walk = (fiber: any) => { if (!fiber || seen.has(fiber) || client) return; seen.add(fiber); if (fiber.memoizedProps?.client?.getQueryCache) client = fiber.memoizedProps.client;
      walk(fiber.child); walk(fiber.sibling); walk(fiber.stateNode?.current); };
    walk((root as any)[key]); if (!client) throw Error('Mounted QueryClient missing'); (window as any).scopedClient = client;
  });
}
async function shot(page: Page, name: string) { await page.screenshot({ path: test.info().outputPath(name + '.png') }); }
for (const width of [1280]) test(`acquired list/detail/timeline/chat survive offline browser restart, writes stop (${width})`, async ({ page, context, runtime }) => {
  await page.setViewportSize({ width, height: 844 });
  await open(page, runtime, '?agent=1&task=T113'); await controlledPwa(page);
  await expect(page.locator('[data-report-feed]')).toContainText('Please review');
  if (width === 390) await page.locator('[data-reader-close]').count().then(async count => {
    if (count) await page.locator('[data-reader-close]').first().click();
    else await reader(page).getByRole('button', { name: 'Close details' }).click();
  });
  if (width === 390) await page.locator('[data-strips]').click();
  await expect(page.locator('[data-time-clock]').first()).toBeVisible();
  await openCoordinator(page);
  const input = page.locator('[data-one-input]').first(); await input.fill('Offline retained chat');
  await page.locator('[data-ask-send]').click();
  await expect(page.locator('[data-coordinator-thread]')).toContainText('Offline retained chat');
  await expect.poll(async () => (await (await page.request.get(runtime.origin + '/api/coordinator')).json()).conversation.turns.at(-1)?.status).toBe('succeeded');
  await foldConversation(page);
  // Capture all four acquired units before losing transport, without writing any test data to IDB.
  await expect.poll(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    const saved = await disk(page), kinds = saved.slots.map((slot: any) => slot.key[0]);
    return ['task', 'task-history', 'task-timeline', 'coordinator'].every(kind => kinds.includes(kind))
      && saved.slots.some((slot: any) => slot.key[0] === 'task-timeline' && slot.key[2] === 'axis');
  }).toBe(true);
  const before = await disk(page); await shot(page, 'online-list');
  const writes: string[] = []; context.on('request', request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push(request.method() + ' ' + request.url()); });
  await context.setOffline(true);
  await expect(page.locator('[data-offline-mark]').first()).toBeVisible();
  await expect(page.locator('[data-read="T113"]')).toBeVisible();
  await expect(page.locator('[data-time-clock]').first()).toBeVisible(); await shot(page, 'offline-list');
  await page.locator('[data-read="T113"]').first().click();
  await expect(page.locator('[data-report-feed]')).toContainText('Please review'); await shot(page, 'offline-detail');
  const actions = page.locator('[data-task-state]');
  expect(await actions.count()).toBeGreaterThan(0);
  for (const action of await actions.all()) await expect(action).toBeEnabled();
  await actions.first().click();
  const stateForm = page.getByRole('dialog', { name: 'Change the state of T113' });
  await expect(stateForm).toBeVisible();
  await stateForm.getByRole('textbox', { name: 'Title in History', exact: true }).fill('Prepared offline');
  await expect(stateForm.getByRole('button', { name: 'Update', exact: true })).toBeDisabled();
  await stateForm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await openCoordinator(page); await input.fill('Never sent offline');
  await expect(page.locator('[data-ask-send]')).toBeDisabled();
  await input.press('ControlOrMeta+Enter'); await page.locator('[data-ask-send]').evaluate((button: HTMLButtonElement) => button.click());
  await expect(input).toContainText('Never sent offline');
  expect(writes).toEqual([]);
  if (!await page.locator('[data-coordinator-panel]').isVisible()) await openCoordinator(page);
  // An agent view records no read: the latest acquired reply is shown; revealing older unread replies is local, no write.
  await revealReplies(page);
  await expect(page.locator('[data-coordinator-thread]')).toContainText('Offline retained chat'); await shot(page, 'offline-chat');
  expect(writes).toEqual([]);
  const next = await (context as any).restartPwa(true) as Page;
  await next.setViewportSize({ width, height: 844 });
  const restartWrites: string[] = []; next.context().on('request', request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) restartWrites.push(request.method() + ' ' + request.url()); });
  await next.goto(runtime.origin + '/?agent=1&task=T113');
  await expect(next.locator('[data-report-feed]')).toContainText('Please review');
  await expect(next.locator('[data-offline-mark]').first()).toBeVisible();
  expect(await next.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toBe(runtime.origin + '/sw.js');
  expect(await next.evaluate(() => navigator.onLine)).toBe(false);
  await bind(next);
  const restored = await next.evaluate(() => (window as any).scopedClient.getQueryCache().getAll().filter((query: any) => query.state.data !== undefined).map((query: any) => ({ key: query.queryKey, data: query.state.data })));
  for (const kind of ['task', 'task-history', 'coordinator', 'task-timeline']) {
    const saved = before.slots.filter((slot: any) => slot.key[0] === kind);
    for (const slot of saved) expect(restored.find((query: any) => JSON.stringify(query.key) === JSON.stringify(slot.key))?.data).toEqual(slot.query.state.data);
  }
  expect(await next.locator('[data-dated-list], [data-read-note="acquired"], [data-read-note="restored"], [data-read-note="changedAbsent"]').count()).toBe(0);
  await shot(next, 'offline-restarted-detail');
  await next.goto(runtime.origin + '/?agent=1');
  await expect(next.locator('[data-read="T113"]')).toBeVisible();
  if (width === 390 && await next.locator('[data-strips]').getAttribute('aria-pressed') !== 'true') await next.locator('[data-strips]').click();
  await expect(next.locator('[data-time-clock]').first()).toBeVisible();
  await expect(next.locator('[data-row] svg[data-time-strip]').first()).toBeVisible();
  await expect(next.getByText('The time view is not saved on this device.', { exact: false })).toHaveCount(0);
  await expect(next.getByText('Could not load extraction settings.', { exact: true })).toHaveCount(0);
  await bind(next);
  expect(await next.evaluate(() => (window as any).scopedClient.getQueryCache().getAll().some((query: any) => query.queryKey[0] === 'task-timeline' && query.queryKey[2] === 'lane' && query.isActive() && query.state.data !== undefined))).toBe(true);
  await expect(next.locator('[data-offline-mark]').first()).toBeVisible();
  await shot(next, 'offline-restarted-list-timeline');
  await openCoordinator(next); await revealReplies(next);
  await expect(next.locator('[data-coordinator-thread]')).toContainText('Offline retained chat');
  await next.locator('[data-offline-mark]').last().click(); await expect(next.locator('[data-offline-explanation]')).toContainText("You can't send or change anything");
  await expect(next.locator('[data-offline-explanation]')).toBeInViewport({ ratio: 1 });
  await shot(next, 'offline-restarted-chat-explanation');
  expect(restartWrites).toEqual([]);
  await test.info().attach('five-condition-proof', { contentType: 'application/json', body: JSON.stringify({ width, physicalPhone: false, environment: 'Linux headless Chromium persistent profile, native clock, context transport offline, real SW product build', before, restored, writes, restartWrites }) });
});
