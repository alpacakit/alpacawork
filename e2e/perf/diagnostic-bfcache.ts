import { startPackagedServer } from './packaged-server.ts';
/** Real navigation/back, using full Chromium and removing Playwright's BFCache-disable flag. */
import assert from 'node:assert/strict';
import { chromium, type Browser } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createOriginal, copyWorkspace, profiles, removeWorkspace } from '../../scripts/dev-fixtures/fixture.ts';
const { values } = parseArgs({ options: { release: { type: 'string' }, out: { type: 'string' } } });
if (!values.release || !values.out) throw Error('--release and --out required');
const out = resolve(values.out); mkdirSync(out);
const root = join(out, 'copy'); copyWorkspace(createOriginal({ ...profiles.small, seed: 'diagnostic-bfcache' }, join(out, 'fixture-cache')).root, root);
const app = await startPackagedServer(values.release!, root, 0);
const away = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Away</title>Local away page'); });
await new Promise<void>(done => away.listen(0, '127.0.0.1', done));
const awayUrl = `http://127.0.0.1:${(away.address() as { port: number }).port}/`;
let browser: Browser | undefined;
const deadline = setTimeout(() => { void browser?.close(); void app.close(); away.closeAllConnections(); away.close(); }, 90000);
const record: any = { release: values.release, posts: [], cacheNotUsed: [], transitions: [], success: false };
try {
  browser = await chromium.launch({ channel: 'chromium', ignoreDefaultArgs: ['--disable-back-forward-cache'], args: [`--disk-cache-dir=${join(out, 'browser-cache')}`] });
  const bcdp = await browser.newBrowserCDPSession(); record.version = await bcdp.send('Browser.getVersion');
  const processes = await bcdp.send('SystemInfo.getProcessInfo');
  const pid = processes.processInfo.find(process => process.type === 'browser')!.id;
  record.commandLine = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  const page = await browser.newPage(), began = performance.now();
  await page.addInitScript(() => {
    (window as any).__cacheIdentity = Math.random();
    addEventListener('pageshow', event => { const rows = JSON.parse(sessionStorage.getItem('cacheEvents') || '[]'); rows.push({ persisted: event.persisted, identity: (window as any).__cacheIdentity }); sessionStorage.setItem('cacheEvents', JSON.stringify(rows)); });
  });
  const cdp = await page.context().newCDPSession(page); await cdp.send('Page.enable');
  cdp.on('Page.backForwardCacheNotUsed', event => record.cacheNotUsed.push(event));
  page.on('response', response => { if (new URL(response.url()).pathname === '/__dev-performance') record.posts.push({ status: response.status(), ms: performance.now() - began }); });
  await page.goto(app.url + '?agent=1'); await page.getByText('Synthetic development project', { exact: true }).first().waitFor();
  await page.waitForResponse(response => new URL(response.url()).pathname === '/__dev-performance' && response.status() === 204);
  const identity = await page.evaluate(() => (window as any).__cacheIdentity);
  async function back(label: string) {
    await page.goto(awayUrl); await page.goBack({ waitUntil: 'commit' });
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('cacheEvents') || '[]').length >= 2);
    const events = await page.evaluate(() => JSON.parse(sessionStorage.getItem('cacheEvents') || '[]'));
    record.transitions.push({ label, events });
    assert.equal(events.at(-1).persisted, true, 'must be a real BFCache restoration'); assert.equal(events.at(-1).identity, identity);
  }
  await back('healthy');
  await page.waitForResponse(response => new URL(response.url()).pathname === '/__dev-performance' && response.status() === 204);
  const log = join(root, '.alpacawork/diagnostics/performance/current.jsonl');
  record.healthyRows = readFileSync(log, 'utf8').trim().split('\n').map((line: string) => JSON.parse(line));
  assert.notEqual(record.healthyRows[0].tab, record.healthyRows.at(-1).tab, 'restoration starts fresh observers/windows');
  rmSync(log); mkdirSync(log);
  await page.waitForResponse(response => new URL(response.url()).pathname === '/__dev-performance' && response.status() === 503);
  await page.waitForFunction(() => !(window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__?.onCommitFiberRoot);
  const afterFault = record.posts.length;
  await back('failed'); await page.waitForTimeout(6000);
  assert.equal(record.posts.length, afterFault, 'real BFCache must preserve the first-failure stop');
  record.success = true;
} finally {
  clearTimeout(deadline); await browser?.close(); await app.close(); away.closeAllConnections(); await new Promise<void>(done => away.close(() => done()));
  writeFileSync(join(out, 'result.json'), JSON.stringify(record, null, 2)); if (record.success) removeWorkspace(root);
}
