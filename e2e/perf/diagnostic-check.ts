import { startPackagedServer } from './packaged-server.ts';
/** Built-path regression and comparison. Run via pnpm test:diagnostic --out <fresh path>. */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { installedWorker } from '../service-worker-lifecycle.ts';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createOriginal, copyWorkspace, removeWorkspace, profiles } from '../../scripts/dev-fixtures/fixture.ts';
import { releaseKind, validateRelease, builtReleases, point } from '@alpacawork/backend/test-dist/release/layout.js';
import { buildRelease } from '@alpacawork/backend/test-dist/release/build.js';
const { values } = parseArgs({ options: { production: { type: 'string' }, diagnostic: { type: 'string' }, old: { type: 'string' }, out: { type: 'string' }, rounds: { type: 'string', default: '3' } } });
const { production, diagnostic, old } = values;
if (!production || !diagnostic || !old || !values.out) throw Error('all release paths and out required');
const out = resolve(values.out), releases = dirname(production), sha = readFileSync(join(production, 'SOURCE'), 'utf8').trim();
const save = (name: string, value: unknown) => writeFileSync(join(out, name), JSON.stringify(value, null, 2));
const report: Record<string, unknown> = { sha, at: new Date().toISOString(), node: process.version, checks: [] };
const checks = report.checks as string[];
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ALPACAWORK_|CODEX_|CLAUDE_)/.test(key)));
async function command(file: string, args: string[], name: string, env = cleanEnv) {
  const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  const status = await new Promise<number>(done => child.once('exit', code => done(code ?? 1)));
  save(name + '.json', { file, args, status, stdout, stderr, pid: child.pid });
  return { status, stdout, stderr };
}
async function until<T>(read: () => Promise<T | false> | T | false, label: string, ms = 30000): Promise<T> {
  const end = performance.now() + ms;
  while (performance.now() < end) { const found = await read(); if (found !== false) return found; await delay(100); }
  throw Error('Timeout: ' + label);
}
const start = startPackagedServer;
const small = createOriginal({ ...profiles.small, seed: 'diagnostic-small' }, join(out, 'fixture-cache'));
const perf = createOriginal({ ...profiles.perf, seed: 'diagnostic-perf' }, join(out, 'fixture-cache'));
const copies: string[] = [];
const copy = (name: string, original = small.root) => { const root = join(out, name); copyWorkspace(original, root); copies.push(root); return root; };
let success = false;
try {
  assert.equal(releaseKind(production), 'production'); assert.equal(releaseKind(diagnostic), 'diagnostic'); assert.equal(releaseKind(old), 'production');
  assert.equal(readFileSync(join(diagnostic, 'SOURCE'), 'utf8').trim(), sha);
  const format = readFileSync(join(production, 'FORMAT'), 'utf8').trim();
  report.format = { production: format, diagnostic: readFileSync(join(diagnostic, 'FORMAT'), 'utf8').trim(), historical: readFileSync(join(old, 'FORMAT'), 'utf8').trim() };
  assert.equal(readFileSync(join(diagnostic, 'FORMAT'), 'utf8').trim(), format);
  const runtime: Record<string, string> = {};
  for (const release of [production, diagnostic]) {
    const roots = ['apps/backend/dist', 'apps/backend/public', 'apps/cli/dist', 'apps/agent-cli/dist', 'node_modules/@alpacawork/core/dist', 'node_modules/@alpacawork/db/dist'];
    for (const folder of roots) for (const file of readdirSync(join(release, folder), { recursive: true }).map(String)) {
      const path = join(release, folder, file); if (!/\.(js|html|json)$/.test(file)) continue;
      const body = readFileSync(path); runtime[basename(release) + '/' + folder + '/' + file] = createHash('sha256').update(body).digest('hex');
      // Release control knows the endpoint for edition validation; it does not implement collection.
      if (release === production && !folder.endsWith('/public') && !file.startsWith('release/'))
        assert.ok(!body.includes(Buffer.from('/__dev-performance')) && !body.includes(Buffer.from('log write failed; recording stopped')), path);
    }
  }
  for (const release of [production, diagnostic]) for (const file of readdirSync(join(release, 'apps/backend/public/assets'))) {
    if (file.endsWith('.js')) {
      const source = readFileSync(join(release, 'apps/backend/public/assets', file), 'utf8');
      assert.ok(!source.includes('react-dom-client.development.js') && !source.includes('react.development.js'), file);
      assert.ok(!source.includes('react-dom-client.profiling.js'), file);
    }
  }
  save('artifact-hashes.json', runtime); checks.push('both artifact kinds, optimized production executable negative, FORMAT');
  assert.equal(await buildRelease(process.cwd(), releases, sha, () => {}, 'production'), production);
  assert.equal(await buildRelease(process.cwd(), releases, sha, () => {}, 'diagnostic'), diagnostic);
  assert.ok(builtReleases(releases).includes(old));
  checks.push('same SHA independent reuse and existing production listing');
  // Deliberate artifact substitutions must fail the real content validator.
  const bad = join(releases, 'bad'); mkdirSync(bad); cpSync(join(diagnostic, 'apps'), join(bad, 'apps'), { recursive: true }); writeFileSync(join(bad, 'SOURCE'), sha);
  writeFileSync(join(bad, 'apps/backend/public/index.html'), '<script src="/assets/wrong.js"></script>');
  assert.throws(() => releaseKind(bad), /disconnected/);
  cpSync(join(diagnostic, 'apps/backend/public/index.html'), join(bad, 'apps/backend/public/index.html'));
  assert.throws(() => validateRelease(releases, bad, 'diagnostic'), /name/); rmSync(bad, { recursive: true });
  checks.push('disconnected HTML and wrong release name rejected');

  const root = copy('built-small'), directory = join(root, '.alpacawork/diagnostics/performance');
  let app = await start(diagnostic, root); const browser = await chromium.launch();
  try {
    const page = await browser.newPage(), received: number[] = [], errors: string[] = [];
    page.on('response', response => { if (new URL(response.url()).pathname === '/__dev-performance') received.push(response.status()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(app.url); await page.getByText('Synthetic development project', { exact: true }).first().waitFor();
    await until(() => received.includes(204), 'built browser→HTTP→JSONL');
    const line = JSON.parse(readFileSync(join(directory, 'current.jsonl'), 'utf8').trim().split('\n')[0]!);
    assert.equal(line.buildId, sha + '-diagnostic'); assert.equal(line.metrics.reactRenderMs, null);
    assert.equal(line.metrics.componentRenders, null); assert.equal(line.supported.componentNames, false); assert.deepEqual(line.components, []);
    save('built-sample.json', line); assert.deepEqual(errors, []);
    const stale = await fetch(new URL('/__dev-performance', app.url), { method: 'POST', headers: { Origin: new URL(app.url).origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...line, buildId: 'b'.repeat(40) + '-diagnostic' }) });
    assert.equal(stale.status, 409); checks.push('stale built-client identity rejected');
    // Force actual save failure while preserving the first successful sample.
    cpSync(directory, join(out, 'before-save-fault'), { recursive: true });
    rmSync(join(directory, 'current.jsonl')); mkdirSync(join(directory, 'current.jsonl'));
    const streamAbort = new AbortController();
    const stream = await fetch(new URL('/api/events', app.url), { signal: streamAbort.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    assert.match(await reader.read().then(value => new TextDecoder().decode(value.value)), /index|hello/);
    await until(() => received.includes(503), 'storage failure reaches browser');
    const posts = received.length; await delay(6000); assert.equal(received.length, posts);
    assert.equal((await fetch(new URL('/api/workspace/live', app.url))).status, 200);
    assert.equal((await fetch(new URL('/api/task/view?task=T2', app.url))).status, 200);
    let continuation = '';
    const sseDeadline = setTimeout(() => streamAbort.abort(), 20_000);
    try {
      while (!continuation.includes('heartbeat')) {
        const chunk = await reader.read(); assert.equal(chunk.done, false, 'same SSE connection survives storage failure');
        continuation += new TextDecoder().decode(chunk.value);
      }
    } finally { clearTimeout(sseDeadline); streamAbort.abort(); }
    save('sse-after-fault.json', { sameConnection: true, continuation });
    save('save-fault.json', { received, pageErrors: errors, api: 200, sse: 200, noRetryAfterMs: 6000 });
    checks.push('built browser collection, unsupported values, storage failure API/SSE continuity, page stops');
    // Reuse one origin and browser context for production→diagnostic→production SW takeover.
    await page.close(); await app.close(); const port = new URL(app.url).port;
    const context = await browser.newContext({ serviceWorkers: 'allow' }); let tab = await context.newPage();
    const versions = [];
    for (const edition of [production, diagnostic, production]) {
      if (app) await app.close(); app = await start(edition, root, Number(port));
      // The diagnostic writer is new for each serve; remove the deliberate fault after stopping it.
      if (existsSync(join(directory, 'current.jsonl')) && readdirSync(directory).includes('current.jsonl')) rmSync(join(directory, 'current.jsonl'), { recursive: true, force: true });
      await tab.goto(app.url); await tab.getByText('Synthetic development project', { exact: true }).first().waitFor();
      const worker = await (await fetch(new URL('/sw.js', app.url))).text();
      const expectedVersion = worker.match(/"version":"([^"]+)"/)?.[1];
      assert.ok(expectedVersion, 'served worker identifies its build');
      const expectedCache = 'alpacawork-' + expectedVersion;
      await installedWorker(tab);
      if (versions.length) {
        await tab.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
        await tab.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state === 'installed');
      } else {
        assert.equal(await tab.evaluate(() => navigator.serviceWorker.controller), null, 'first install does not claim the open page');
      }
      // Select the actual new worker: old and waiting workers share the same scriptURL.
      const next = await until(async () => {
        for (const candidate of context.serviceWorkers())
          if (await candidate.evaluate('BUILD.version').catch(() => null) === expectedVersion) return candidate;
        return false;
      }, 'installed build worker');
      // Natural activation requires all old controlled documents to close. No claim/skipWaiting/unregister.
      await tab.close();
      await until(() => next.evaluate(`(async () => {
        const keys = (await caches.keys()).filter(name => name.startsWith('alpacawork-'));
        return self.serviceWorker.state === 'activated' && keys.length === 1 && keys[0] === ${JSON.stringify(expectedCache)};
      })()`), 'natural SW activation and old cache cleanup');
      tab = await context.newPage();
      await tab.goto(app.url); await tab.getByText('Synthetic development project', { exact: true }).first().waitFor();
      await until(() => tab.evaluate(async expected => {
        const keys = (await caches.keys()).filter(name => name.startsWith('alpacawork-'));
        return !!navigator.serviceWorker.controller && keys.length === 1 && keys[0] === expected;
      }, expectedCache), 'controlled navigation and exact build cache');
      const cache = await tab.evaluate(async () => (await caches.keys()).filter(name => name.startsWith('alpacawork-')));
      const html = await tab.content(); assert.equal(html.includes('/assets/diagnostic-'), edition === diagnostic);
      if (edition === production) {
        const response = await fetch(new URL('/__dev-performance', app.url), { method: 'POST', headers: { Origin: new URL(app.url).origin, 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(response.status, 404, 'ordinary built server has no receiver');
      }
      if (versions.length) assert.notDeepEqual(cache, versions[versions.length - 1]); versions.push(cache);
      // Required startup files, including the delayed application, are actually cached.
      const manifest = JSON.parse(readFileSync(join(edition, 'apps/backend/public/asset-manifest.json'), 'utf8'));
      if (edition === diagnostic) assert.equal(await tab.evaluate(async file => !!(await caches.match('/' + file)), manifest['src/main.tsx'].file), true);
    }
    save('sw-switch.json', versions); await context.close(); checks.push('SW production→diagnostic→production and delayed app cached');
  } catch (error) {
    for (const [n, page] of browser.contexts().flatMap(context => context.pages()).entries()) {
      await page.screenshot({ path: join(out, `failed-browser-${n}.png`) }).catch(() => {});
      writeFileSync(join(out, `failed-browser-${n}.html`), await page.content().catch(() => 'page unavailable'));
    }
    throw error;
  } finally { await browser.close(); await app.close(); }

  const rounds = Number(values.rounds), measurements: Record<string, any[]> = { production: [], diagnostic: [] };
  for (let round = 0; round < rounds; round++) for (const kind of round % 2 ? ['diagnostic', 'production'] : ['production', 'diagnostic']) {
    const root = copy(`perf-${round}-${kind}`, perf.root), file = join(out, `perf-${round}-${kind}.json`);
    const result = await command(process.execPath, ['--import', './e2e/perf/guard.mjs', 'e2e/perf/diagnostic-observe.ts', '--release', kind === 'production' ? production : diagnostic, '--root', root, '--out', file], `perf-${round}-${kind}.process`);
    assert.equal(result.status, 0, result.stderr); measurements[kind]!.push(JSON.parse(readFileSync(file, 'utf8')));
    removeWorkspace(root); copies.splice(copies.indexOf(root), 1);
  }
  const summarize = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return { raw: values, median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted[sorted.length - 1] }; };
  save('comparison.json', Object.fromEntries(Object.entries(measurements).map(([kind, rows]) => [kind, {
    firstVisibleMs: summarize(rows.map(row => row.firstVisibleMs)), browserTaskMs: summarize(rows.map(row => row.browserTaskMs)),
    browserHeapBytes: summarize(rows.map(row => row.browserHeapBytes)), serverCpuMs: summarize(rows.map(row => row.serverCpuMs).filter(value => value !== null)),
    maxFrameMs: summarize(rows.map(row => Math.max(...row.frameGapsMs))),
  }])));
  checks.push('alternating independent perf-copy rounds with raw/median/range');
  save('checks-before-upgrade.json', report);
  // The actual old CLI and a time-limited dedicated test unit exercise the first-update entrance.
  const upgrade = await command(process.execPath, ['--import', './e2e/perf/guard.mjs', 'e2e/perf/diagnostic-upgrade.ts', '--production', production, '--diagnostic', diagnostic, '--old', old, '--out', out], 'upgrade-process');
  assert.equal(upgrade.status, 0, upgrade.stderr); checks.push('old CLI (--old-ref) first upgrade, old journal resume, candidate rollback');
  success = true;
} finally {
  report.success = success; save('result.json', report);
  if (success) for (const root of copies) removeWorkspace(root);
  else save('retained-failure-roots.json', copies);
}
