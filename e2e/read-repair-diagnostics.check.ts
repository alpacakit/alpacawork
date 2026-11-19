import { test, expect, controlledPwa } from './pwa-fixture.ts';
import { open, openDiagnostics } from './fixtures.ts';
import { readSnapshot } from './read-evidence.ts';

test.setTimeout(120_000);
test('diagnostics keep their original rows while acquired Family facts survive a full reload', async ({ page, runtime }) => {
  await open(page, runtime, '?agent=1&task=T11'); await controlledPwa(page);
  const initial: any = await readSnapshot(page);
  const ids = (values: { id: string }[]) => values.map(value => value.id).sort();
  const index = (state: any) => state.queries.find((query: any) => query.key[0] === 'index').state.data;
  expect(initial.workspace.tasks).toHaveLength(9);
  expect(ids(initial.workspace.tasks)).toEqual(ids(index(initial).tasks));
  const reader = page.locator('aside[data-reader-mode]');
  await reader.locator('[data-family-entry]').click();
  const family = page.locator('[data-family-panel]');
  await expect(family.locator('[data-family-row="T115"]')).toBeVisible();
  if (!await family.locator('[data-family-row="T1111"]').count()) await family.locator('[data-family-row="T111"] [data-family-fold]').click();
  await expect(family.locator('[data-family-row="T1111"]')).toBeVisible();
  const extra = ['T1111', 'T115', 'T116', 'T118'];
  const finished = (state: any) => state.queries.filter((query: any) => query.key[0] === 'task-finished').flatMap((query: any) => query.state.data?.pages?.flatMap((page: any) => page.rows.map((row: any) => row.id)) ?? []);
  await expect.poll(async () => [...new Set(finished(await readSnapshot(page)))].sort()).toEqual(extra);
  await expect.poll(async () => {
    const state: any = await readSnapshot(page);
    return state.idb.slots.filter((slot: any) => slot.key[0] === 'task-finished').flatMap((slot: any) => JSON.parse(slot.payload).pages.flatMap((page: any) => page.rows.map((row: any) => row.id))).sort();
  }).toEqual(extra);
  const acquired: any = await readSnapshot(page); expect(acquired.workspace.tasks).toHaveLength(13);
  const gets: string[] = []; page.on('request', request => { if (new URL(request.url()).pathname === '/api/task/finished') gets.push(request.url()); });
  await page.goto(runtime.origin + '/?agent=1&task=T11'); await controlledPwa(page);
  await openDiagnostics(page);
  const dialog = page.getByRole('dialog', { name: 'Loading and connection status', exact: true });
  await expect(dialog).toContainText('13 shown');
  await expect(dialog.locator('[data-read-saving]')).toHaveCount(0);
  await expect(dialog).not.toContainText('Saved on this device');
  const restored: any = await readSnapshot(page);
  expect(index(restored).tasks).toHaveLength(9);
  expect(ids(restored.workspace.tasks).filter(id => !ids(index(restored).tasks).includes(id))).toEqual(extra);
  expect(new Set(ids(restored.workspace.tasks)).size).toBe(13); expect([...new Set(finished(restored))].sort()).toEqual(extra);
  expect(gets).toEqual([]);
  for (const before of acquired.idb.slots.filter((slot: any) => slot.key[0] === 'task-finished')) {
    const after = restored.idb.slots.find((slot: any) => slot.hash === before.hash);
    expect(after.acquiredAt).toBe(before.acquiredAt); expect(after.payload).toEqual(before.payload);
  }
  expect(restored.idb.control.savedAt).not.toBeNull();
  await test.info().attach('diagnostic-authorities', { contentType: 'application/json', body: JSON.stringify({ initial, acquired, restored, gets, extra }) });
  await page.screenshot({ path: test.info().outputPath('original-diagnostics-with-restored-facts.png') });
});
