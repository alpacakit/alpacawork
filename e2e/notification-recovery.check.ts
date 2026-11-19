import { commandPost } from './command-post.ts';
import { test, expect, open, openCoordinator } from './fixtures.ts';
import { readSnapshot } from './read-evidence.ts';
import { configureCoordinator, readyCoordinator } from './coordinator-fixture.ts';

test.use({ isolated: true });
test('attachment save failure uses one shared toast', async ({ page, runtime }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  configureCoordinator(runtime.root);
  await open(page, runtime, '?agent=1&task=T117');
  await openCoordinator(page);
  await readyCoordinator(page, runtime);
  const card = page.locator('[data-coordinator-card]');
  const field = page.locator('[data-one-input]');
  await field.fill('Keep these words');
  let failing = true;
  const ops: string[] = [];
  await page.route('**/api/coordinator/attachments?*', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    ops.push(route.request().headers()['x-alpacawork-op-id']!);
    if (failing) { expect((await route.fetch()).ok()).toBe(true); return route.abort('connectionfailed'); }
    return route.continue();
  });
  await card.locator('input[type=file]').setInputFiles({ name: 'review.txt', mimeType: 'text/plain', buffer: Buffer.from('attachment bytes') });
  const notice = page.locator('[data-toast][data-kind=error]');
  await expect(notice).toContainText('review.txt');
  await expect(notice).toContainText('Check whether the change was saved.');
  await expect(notice).not.toContainText('Cannot reach the server.');
  await expect(card.locator('[data-attachment-state=failed]')).toHaveCount(1);
  await expect(page.locator('[data-attachment-failure]')).toHaveCount(0);
  await notice.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => ops.length).toBe(2);
  await expect(notice).toHaveCount(1);
  failing = false;
  await notice.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(card.locator('[data-attachment-state=saved]')).toHaveCount(1);
  await expect(notice).toHaveCount(0);
  expect(new Set(ops).size).toBe(1);
  await expect(field).toContainText('Keep these words');
  await expect(card.locator('[data-ask-send]')).toBeEnabled();
});

test('connection-only read failure is quiet and settings and notices recover automatically', async ({ page, runtime }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let failing = false;
  const counts = { settings: 0, notices: 0 };
  const reads = { settings: '**/api/settings/get', notices: '**/api/person/notices' };
  for (const kind of ['settings', 'notices'] as const) await page.route(reads[kind], route => {
    counts[kind]++;
    return failing ? route.abort('connectionfailed') : route.continue();
  });
  await open(page, runtime, '?agent=1');
  await expect(page.locator('[data-time-tree]')).toBeVisible();
  await expect.poll(() => counts.settings > 0 && counts.notices > 0).toBe(true);
  const priorSettings = await (await page.request.get(runtime.origin + '/api/settings/get')).json();
  const priorNotices = await (await page.request.get(runtime.origin + '/api/person/notices')).json();
  const theme = priorSettings.values.theme === 'dark' ? 'light' : 'dark';
  const before = { ...counts };
  failing = true;
  const settingsResponse = await commandPost(page.request, runtime.origin + '/api/settings/set', { data: {
    key: 'theme', value: theme, expectedRevision: priorSettings.revision,
  } });
  expect(settingsResponse.ok()).toBe(true);
  const settings = await settingsResponse.json();
  const noticesResponse = await page.request.post(runtime.origin + '/api/person/notices/save', { data: {
    state: { ...priorNotices.state, checkpoint: { ...priorNotices.state.checkpoint, at: new Date().toISOString() } },
    expectedRevision: priorNotices.revision,
  } });
  expect(noticesResponse.ok()).toBe(true);
  const notices = await noticesResponse.json();
  await expect.poll(() => counts.settings > before.settings && counts.notices > before.notices).toBe(true);
  await expect.poll(async () => {
    const snapshot = await readSnapshot(page);
    const reads = snapshot.queries.filter((query: any) => ['person-settings', 'person-notices'].includes(query.key[0]));
    return reads.length === 2 && reads.every((query: any) => query.state.status === 'error' && query.state.fetchStatus === 'idle');
  }).toBe(true);
  await expect(page.locator('[data-toast][data-kind=error]')).toHaveCount(0);
  await expect(page.locator('[data-workspace-notice]')).toHaveCount(0);
  await page.context().setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.locator('[data-offline-mark]').first()).toBeVisible();
  await expect(page.locator('[data-toast][data-kind=error]')).toHaveCount(0);
  const failed = { ...counts };
  failing = false;
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => counts.settings > failed.settings && counts.notices > failed.notices).toBe(true);
  await expect.poll(async () => {
    const snapshot = await readSnapshot(page);
    return ['settings', 'notices'].every(kind => snapshot.queries.some((query: any) =>
      query.key[0] === `person-${kind}` && query.state.status === 'success'
      && query.state.data.revision === (kind === 'settings' ? settings : notices).revision));
  }).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.locator('[data-offline-mark]')).toHaveCount(0);
  await expect(page.locator('[data-toast][data-kind=error]')).toHaveCount(0);
  await expect(page.locator('[data-time-tree]')).toBeVisible();
});
