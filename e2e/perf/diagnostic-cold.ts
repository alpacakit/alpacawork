/** Cold regression: browser already running, formal CLI in a separate process, no API warmup. */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createOriginal, copyWorkspace, profiles, removeWorkspace } from '../../scripts/dev-fixtures/fixture.ts';
const { values } = parseArgs({ options: { release: { type: 'string' }, out: { type: 'string' }, rounds: { type: 'string', default: '3' }, preload: { type: 'string' } } });
if (!values.release || !values.out) throw Error('--release and --out required');
const out = resolve(values.out); mkdirSync(out, { recursive: false });
const original = createOriginal({ ...profiles.perf, seed: 'diagnostic-perf' }, join(out, 'fixture-cache'));
const results: any[] = [];
for (let round = 0; round < Number(values.rounds); round++) {
  const root = join(out, `copy-${round}`); copyWorkspace(original.root, root);
  const result: any = { round, root, release: values.release, events: [], observations: [], passed: false, stdout: '', stderr: '' }; results.push(result);
  const browser = await chromium.launch({ args: [`--disk-cache-dir=${join(out, `browser-cache-${round}`)}`] });
  let child: ChildProcess | undefined, force: ReturnType<typeof setTimeout> | undefined;
  const limit = setTimeout(() => { child?.kill('SIGKILL'); void browser.close(); }, 65000);
  try {
    const page = await browser.newPage(), began = performance.now();
    const record = (kind: string, data: unknown) => result.events.push({ kind, ms: performance.now() - began, ...data as object });
    page.on('request', request => { if (new URL(request.url()).pathname === '/__dev-performance') record('post', { sample: JSON.parse(request.postData()!) }); });
    page.on('response', response => { if (new URL(response.url()).pathname === '/__dev-performance') record('response', { status: response.status() }); });
    page.on('requestfailed', request => record('failed', { path: new URL(request.url()).pathname, failure: request.failure() }));
    page.on('console', message => { if (['warning', 'error'].includes(message.type())) record('console', { text: message.text() }); });
    page.on('pageerror', error => record('pageerror', { message: error.message }));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ALPACAWORK_|CODEX_|CLAUDE_)/.test(key)));
    child = spawn(process.execPath, ['--import', resolve('e2e/perf/guard.mjs'), ...(values.preload ? ['--import', resolve(values.preload), '--cpu-prof', '--cpu-prof-dir=' + out] : []),
      join(resolve(values.release), 'apps/backend/dist/backend.js'), '--workspace', root, 'workspace', 'serve', '--port', '0', ...(values.preload ? ['--timing'] : [])], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    result.serverPid = child.pid;
    child.stderr!.on('data', chunk => { result.stderr += chunk; });
    const url = await new Promise<string>((done, fail) => {
      const timer = setTimeout(() => fail(Error('CLI URL deadline')), 20000);
      child!.once('exit', code => { clearTimeout(timer); fail(Error('CLI exited ' + code)); });
      child!.stdout!.on('data', chunk => { result.stdout += chunk; const found = result.stdout.match(/"url":\s*"(http:[^"]+)"/); if (found) { clearTimeout(timer); done(found[1]!); } });
    });
    record('listening', { url }); await page.goto(url + '?agent=1');
    await page.getByText('Synthetic development project', { exact: true }).first().waitFor({ timeout: 20000 }); record('visible', {});
    for (let n = 0; n < 7; n++) {
      await page.waitForTimeout(4500);
      const file = join(root, '.alpacawork/diagnostics/performance/current.jsonl');
      const rows = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
      result.observations.push({ ms: performance.now() - began, rows });
      if (n < 3) { await page.getByText('Synthetic development project', { exact: true }).first().click(); await page.keyboard.press('Escape'); await page.mouse.wheel(0, n % 2 ? -600 : 600); }
    }
    const rows = result.observations.at(-1).rows;
    result.passed = result.events.filter((event: any) => event.kind === 'response' && event.status === 204).length >= 4 && rows.length >= 4
      && result.events.every((event: any) => event.kind !== 'console' || !event.text.includes('recording stopped'))
      && result.events.filter((event: any) => event.kind === 'post').length === result.events.filter((event: any) => event.kind === 'response' && event.status === 204).length
      && rows[0].sinceMs >= 4900 && rows[0].sinceMs < 6500
      && rows.slice(-2).every((row: any, n: number) => row.sinceMs > rows.at(-3 + n).sinceMs && row.sinceMs - rows.at(-3 + n).sinceMs < 6000);
    // During a long first in-flight send the existing one-send policy drops windows.
    // Require that very first send to succeed AND three subsequent contiguous windows.
    result.savedWindows = rows.map((row: any) => row.sinceMs);
    await page.screenshot({ path: join(out, `round-${round}.png`) }); writeFileSync(join(out, `round-${round}.html`), await page.content());
  } finally {
    clearTimeout(limit); await browser.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(done => child!.once('exit', () => done())); child.kill('SIGTERM');
      force = setTimeout(() => child!.kill('SIGKILL'), 10000); await exited; clearTimeout(force);
    }
    result.serverExitCode = child?.exitCode; result.serverSignal = child?.signalCode;
    writeFileSync(join(out, 'result.json'), JSON.stringify(results, null, 2));
    if (result.passed) removeWorkspace(root);
  }
}
assert.ok(results.every(result => result.passed), 'cold CLI must save at least three consecutive visible windows without reload or warmup');
