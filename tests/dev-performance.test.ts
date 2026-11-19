import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { createServer as httpServer } from 'node:http';
import { devPerformance } from '../apps/web/dev/performance-plugin.ts';
import { ENDPOINT, MAX_LOG_BYTES, MAX_REQUEST_BYTES, emptyLifecycle, emptyDetails, emptyMetrics } from '../apps/backend/src/diagnostics/protocol.ts';

test('development HTML alone loads diagnostics; receiver strips content, bounds storage and rejects invalid inputs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'alpacawork-dev-performance-')), root = join(directory, 'apps/web');
  mkdirSync(root, { recursive: true });
  // HTTP/plugin checks do not edit source; avoid unrelated native watcher capacity.
  const server = await createServer({ configFile: false, root, plugins: [devPerformance()], server: { host: '127.0.0.1', port: 0, watch: null }, logLevel: 'silent' });
  try {
    await server.listen(); const origin = server.resolvedUrls!.local[0]!.replace(/\/$/, '');
    const html = await server.transformIndexHtml('/', '<html><head></head><body><script type="module" src="/src/main.tsx"></script></body></html>');
    assert.ok(html.includes(`${ENDPOINT}/bootstrap.ts`));
    const send = (value: unknown, source = origin) => fetch(origin + ENDPOINT, { method: 'POST', headers: { Origin: source, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    const sample = { buildId: 'development', tab: 'test-tab', sinceMs: 5000, details: { ...emptyDetails(), resources: Object.fromEntries(['api', 'asset', 'stream', 'other'].map(key => [key, { count: 0, durationMs: 0, maxDurationMs: 0, ttfbCount: 0, ttfbMs: 0, transferBytes: 0, dropped: 0 }])) }, lifecycle: emptyLifecycle(), context: { atStart: ['unknown'], atSample: ['list'], events: [], dropped: 0 }, metrics: { ...emptyMetrics(), reactCommits: 3, domElements: 42, secret: 'PRIVATE' },
      components: [{ name: 'Workspace', renders: 2, props: 'PRIVATE' }], supported: { reactCommits: true, reactRender: true, componentNames: true, longtask: true, longFrame: false, resource: true, heap: false, eventTiming: false, renderPhases: false }, input: 'PRIVATE' };
    assert.equal((await send(sample, 'http://other.invalid')).status, 403);
    assert.equal((await send({ ...sample, metrics: { ...sample.metrics, fps: -1 } })).status, 400);
    assert.equal((await send({ ...sample, input: 'x'.repeat(MAX_REQUEST_BYTES) })).status, 413);
    assert.equal((await send(sample)).status, 204);
    const folder = join(directory, '.local/dev-performance'), current = join(folder, 'current.jsonl'), previous = join(folder, 'previous.jsonl');
    const held = readFileSync(current, 'utf8'); assert.ok(!held.includes('PRIVATE')); assert.equal(JSON.parse(held).metrics.domElements, 42);
    writeFileSync(current, ' '.repeat(MAX_LOG_BYTES)); assert.equal((await send(sample)).status, 204);
    assert.equal(statSync(previous).size, MAX_LOG_BYTES); assert.ok(statSync(current).size < MAX_LOG_BYTES);
    rmSync(current); mkdirSync(current); assert.equal((await send(sample)).status, 503); assert.equal((await send(sample)).status, 503);
  } finally { await server.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('plugin is serve-only and cannot alter production or preview HTML', () => {
  const apply = devPerformance().apply as Function;
  assert.equal(apply({}, { command: 'serve', mode: 'development', isPreview: false }), true);
  assert.equal(apply({}, { command: 'build', mode: 'production' }), false);
  assert.equal(apply({}, { command: 'serve', mode: 'production', isPreview: true }), false);
  assert.equal(apply({}, { command: 'serve', mode: 'test' }), false);
});

test('fresh production assets contain neither diagnostic client nor its receiving URL', () => {
  const output = new URL('../apps/backend/public/', import.meta.url);
  const files = readdirSync(output, { recursive: true }).filter(file => /\.(html|js)$/.test(String(file)));
  assert.ok(files.length > 0, 'Build web before this integration check');
  for (const file of files) assert.ok(!readFileSync(new URL(String(file), output), 'utf8').includes(ENDPOINT), String(file));
});

test('API proxy translates its own page origin but preserves a foreign origin for backend rejection', async () => {
  const backend = httpServer((request, response) => response.end(request.headers.origin));
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${(backend.address() as { port: number }).port}`;
  const before = process.env.ALPACAWORK_DEV_BACKEND; process.env.ALPACAWORK_DEV_BACKEND = target;
  // HTTP/plugin checks do not edit source; avoid unrelated native watcher capacity.
  const server = await createServer({ configFile: false, plugins: [devPerformance()], server: { host: '127.0.0.1', port: 0, watch: null }, logLevel: 'silent' });
  try {
    await server.listen(); const origin = server.resolvedUrls!.local[0]!.replace(/\/$/, '');
    for (const source of [origin, 'http://foreign.invalid']) {
      const response = await fetch(origin + '/api/check', { method: 'POST', headers: { Origin: source } });
      assert.equal(await response.text(), source === origin ? target : source);
    }
  } finally {
    if (before === undefined) delete process.env.ALPACAWORK_DEV_BACKEND; else process.env.ALPACAWORK_DEV_BACKEND = before;
    await server.close(); await new Promise<void>(resolve => backend.close(() => resolve()));
  }
});
