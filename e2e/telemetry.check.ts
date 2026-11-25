/** One screen flow, with real consent/preview routes composed inside the test only.
 * Neither an environment flag nor a fixture endpoint is added to the shipped server. */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const { Hono } = createRequire(new URL('../apps/backend/package.json', import.meta.url))('hono') as typeof import('../apps/backend/node_modules/hono/dist/types/index.js');
import { test as base, expect } from './fixtures.ts';
import { startServer } from './fixture/server.ts';
import { createOriginal, copyWorkspace, removeWorkspace } from '../scripts/dev-fixtures/fixture.ts';
import { TelemetryService } from '@alpacawork/backend/test-dist/telemetry/service.js';
import { installTelemetryRoutes } from '@alpacawork/backend/test-dist/telemetry/routes.js';
import { writeJson } from '@alpacawork/backend/test-dist/telemetry/files.js';
import { TELEMETRY_ENDPOINT } from '@alpacawork/contract/telemetry';

const test = base.extend({
  runtime: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'telemetry-browser-'));
    const original = createOriginal({ tasks: 14, logs: 19, runs: 7, seed: 'telemetry-screen' }, join(dir, 'cache'));
    const copy = copyWorkspace(original.root, join(dir, 'workspace'));
    const server = await startServer(copy.root, 0);
    try { await use({ root: copy.root, origin: new URL(server.url).origin }); }
    finally { await server.close(); removeWorkspace(copy.root); removeWorkspace(original.root); rmSync(dir, { recursive: true, force: true }); }
  },
});

test.use({ locale: 'ja-JP', fixedTime: false });

test('usage data is chosen in Settings, never by a dialog on the page; the switch applies at once; read-only report preview', async ({ page, runtime }, info) => {
  test.setTimeout(120_000);
  const dir = mkdtempSync(join(tmpdir(), 'telemetry-screen-state-'));
  const at = Date.parse('2026-11-06T12:00:00Z');
  let blocked = false, network = 0;
  const deletes: string[] = [];
  const service = new TelemetryService(runtime.root, {}, { now: () => at,
    paths: { consent: join(dir, 'consent.json'), state: join(dir, 'state') },
    // Only this unshipped test supplies synthetic gate facts; its fetch counts any send.
    facts: (consent, now, latestDay) => ({ consent, now, latestDay, env: blocked ? { VITEST: '1' } : {},
      edition: 'production', source: false, fixture: false, container: false }),
    envelope: (day, id) => ({ schema: 2, id, day, version: '0.3.0', os: 'linux', arch: 'x64', node: 24 }),
    // A delete is answered as the receiver would; any report sent is counted.
    fetch: (async (url, init) => {
      if (init?.method === 'DELETE') { deletes.push(String(url)); return new Response(null, { status: 204 }); }
      network++; throw Error('Browser fixture must not send');
    }) as typeof fetch,
  });
  const api = new Hono();
  installTelemetryRoutes(api, service, () => {});
  await page.route('**/api/telemetry/**', async route => {
    const request = route.request();
    const response = await api.fetch(new Request(request.url(), { method: request.method(), headers: request.headers(),
      ...(request.postData() ? { body: request.postData() } : {}) }));
    await route.fulfill({ status: response.status, body: await response.text(), contentType: 'application/json' });
  });
  await page.addInitScript(() => { Object.defineProperty(navigator, 'languages', { get: () => ['ja'] }); });
  const shots = process.env.TELEMETRY_SHOTS ?? info.outputPath('shots'); mkdirSync(shots, { recursive: true });
  const shot = async (name: string) => {
    if (process.env.TELEMETRY_SHOTS_CHANGED_ONLY === '1' && !/^(settings-preview-off|settings-reask|settings-blocked)-/.test(name)) return;
    await page.screenshot({ path: join(shots, name + '.png'), animations: 'disabled' }); };
  const switcher = page.locator('#telemetry-switch');
  const openSettings = async () => {
    await page.keyboard.press('Control+,');
    await page.getByRole('tab', { name: '一般', exact: true }).click();
    await expect(switcher).toBeVisible();
  };
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(runtime.origin);
    // Not chosen yet: nothing asks on the page (setup asks a new workspace), and nothing is sent until it is chosen.
    await expect(page.locator('[data-section]').first()).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await openSettings();
    await expect(page.locator('[data-telemetry-settings]')).toContainText('まだ選択されていません。選択するまで送信しません。');
    await expect(switcher).not.toBeChecked();
    await switcher.click(); await expect(switcher).toBeChecked(); expect(service.status().state).toBe('on');
    const id = service.status().id!;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await page.keyboard.press('Escape');
    service.mark({ kind: 'activity' });
    service.mark({ kind: 'event', op: 'search', attributes: { device: 'desktop.linux', via: 'screen', lang: 'ja', theme: 'system' } });
    await openSettings(); await expect(switcher).toBeChecked();
    await shot('settings-on-ja-pc');
    await page.setViewportSize({ width: 390, height: 844 }); await shot('settings-on-ja-phone');
    await page.setViewportSize({ width: 1440, height: 900 });
    const queued = service.queue.queued();
    await page.getByRole('button', { name: '送信内容を表示', exact: true }).click();
    const preview = page.locator('[data-telemetry-history]');
    await preview.locator('[data-telemetry-upcoming] summary').first().click();
    await expect(preview.locator('[data-telemetry-upcoming] pre').first()).toContainText('"events"');
    await expect(preview.locator('[data-telemetry-upcoming] pre').first()).toContainText(id);
    await expect(preview.locator('[data-telemetry-id]')).toHaveText(id);
    expect(service.queue.queued()).toEqual(queued);
    await shot('settings-preview-ja-pc');
    await page.setViewportSize({ width: 390, height: 844 }); await shot('settings-preview-ja-phone');
    await preview.locator('[data-slot=dialog-footer]').getByRole('button', { name: '閉じる', exact: true }).click();
    // Deleting what was sent asks once more, then asks the receiver to delete this number's reports.
    await page.getByRole('button', { name: '送信済みのデータを削除', exact: true }).click();
    const deleting = page.locator('[data-telemetry-delete]');
    await expect(deleting).toContainText('番号を含まない集計は削除できません。');
    await expect(deleting).toContainText('送信を続けると、これからの分は同じ番号で送られます。');
    await expect(deleting.locator('[data-telemetry-id]')).toHaveText(id);
    await shot('settings-delete-ja-pc');
    await deleting.getByRole('button', { name: '削除する', exact: true }).click();
    await expect(deleting).toHaveCount(0); await expect(page.locator('[data-toast]')).toContainText('送信済みのデータを削除しました');
    expect(deletes).toEqual([`${TELEMETRY_ENDPOINT}/${id}`]);
    await switcher.click(); await expect(switcher).not.toBeChecked(); expect(service.status().state).toBe('off');
    expect(service.queue.queued()).toHaveLength(0);
    await page.getByRole('button', { name: '送信内容を表示', exact: true }).click();
    await expect(preview).toContainText('送信していないため、これから送る分はありません。');
    // What was sent stays listed after sending stops.
    await expect(preview.locator('[data-telemetry-log]')).toContainText('送信済みのデータの削除の依頼');
    await page.setViewportSize({ width: 1440, height: 900 }); await shot('settings-preview-off-ja-pc');
    await page.setViewportSize({ width: 390, height: 844 }); await shot('settings-preview-off-ja-phone');
    await preview.locator('[data-slot=dialog-footer]').getByRole('button', { name: '閉じる', exact: true }).click();
    await switcher.click(); await expect(switcher).toBeChecked(); expect(service.status().state).toBe('on');
    // Stopping and choosing again keeps the same number.
    expect(service.status().id).toBe(id);

    // A kind of information added after the person chose: asked again in a window, naming what was added.
    const saved = service.store.read()!;
    writeJson(service.store.paths.consent, { ...saved, fields: saved.fields!.filter(field => field !== 'shape.parallel') });
    await page.reload(); await expect(page.locator('[data-section]').first()).toBeVisible();
    const reask = page.locator('[data-telemetry-reask]');
    // What it is and an example lead; the field's name follows in brackets.
    await expect(reask.locator('[data-telemetry-added] li')).toHaveCount(1);
    await expect(reask.locator('[data-field="shape.parallel"]')).toContainText('同時に動いていた AI の最大の数例: 3-4(shape.parallel)');
    await page.setViewportSize({ width: 1440, height: 900 }); await shot('settings-reask-ja-pc');
    await page.setViewportSize({ width: 390, height: 844 }); await shot('settings-reask-ja-phone');
    await page.setViewportSize({ width: 1440, height: 900 });
    await reask.getByRole('button', { name: '送る', exact: true }).click();
    await expect(reask).toHaveCount(0); expect(service.status().state).toBe('on');
    await openSettings();

    // The settings hints are observable when consent changes elsewhere during this opening.
    rmSync(service.store.paths.consent);
    await page.keyboard.press('Escape'); await openSettings();
    await expect(page.locator('[data-telemetry-settings]')).toContainText('まだ選択されていません。選択するまで送信しません。');
    await page.setViewportSize({ width: 1440, height: 900 }); await shot('settings-not-asked-ja-pc');
    await page.setViewportSize({ width: 390, height: 844 }); await shot('settings-not-asked-ja-phone');
    blocked = true;
    await page.keyboard.press('Escape'); await openSettings();
    await expect(switcher).toBeDisabled(); await expect(page.locator('[data-telemetry-settings]')).toContainText('テスト中のため、送信していません。');
    await page.setViewportSize({ width: 1440, height: 900 }); await shot('settings-blocked-ja-pc');
    await page.setViewportSize({ width: 390, height: 844 }); await shot('settings-blocked-ja-phone');
    blocked = false;
    // Changed terms ask again too; closing the window answers nothing and sends nothing.
    writeJson(service.store.paths.consent, { version: 1, choice: 'on', consentVersion: 0, decidedAt: new Date(at).toISOString(), decidedBy: 'screen' });
    await page.keyboard.press('Escape');
    await page.reload(); await expect(page.locator('[data-section]').first()).toBeVisible();
    await expect(reask).toContainText('送る情報か送り方が変わりました。');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0); expect(service.status().state).toBe('needs_reask');
    expect(network).toBe(0);
    writeFileSync(join(shots, 'evidence.json'), JSON.stringify({ fixture: 'scripts/dev-fixtures small', viewport: ['1440x900', '390x844'], network }, null, 2));
  } finally { await service.close(); rmSync(dir, { recursive: true, force: true }); }
});
