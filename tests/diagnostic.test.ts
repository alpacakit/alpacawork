import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPerformanceReceiver } from '../apps/backend/src/diagnostics/receiver.ts';
import { emptyLifecycle, emptyDetails, emptyMetrics, MAX_LOG_BYTES, MAX_REQUEST_BYTES, ENDPOINT, readSample, MAX_CONTEXT_EVENTS, MAX_DETAIL_ENTRIES, INPUT_KEYS, RENDER_KEYS, RESOURCE_KEYS, RESOURCE_CATEGORIES, LIFECYCLE_TIMES, RETURN_TRIGGERS, zeroes } from '../apps/backend/src/diagnostics/protocol.ts';
import { releaseKind } from '@alpacawork/backend/test-dist/release/layout.js';

const buildId = 'a'.repeat(40) + '-diagnostic';
const sample = () => ({ buildId, tab: 'test', sinceMs: 5000,
  details: { ...emptyDetails(), resources: Object.fromEntries(['api', 'asset', 'stream', 'other'].map(key => [key, { count: 0, durationMs: 0, maxDurationMs: 0, ttfbCount: 0, ttfbMs: 0, transferBytes: 0, dropped: 0 }])) }, lifecycle: emptyLifecycle(), context: { atStart: ['unknown'], atSample: ['list'], events: [], dropped: 0 }, metrics: { ...emptyMetrics(), componentRenders: null, reactRenderMs: null }, components: [],
  supported: { reactCommits: true, reactRender: false, componentNames: false, longtask: true, longFrame: false, resource: true, heap: false, eventTiming: false, renderPhases: false } });

test('context boundary rejects unknown enums, invalid times, counts and oversized lists; strips arbitrary fields', () => {
  const event = { atMs: 10, kind: 'scroll', screen: ['detail'], task: 'PRIVATE' };
  const good = { ...sample(), metrics: { ...sample().metrics, visibleMs: 5000 }, context: {
    atStart: ['unknown'], atSample: ['detail'], events: [event], dropped: 3, url: 'PRIVATE' } };
  assert.ok(readSample(good)); assert.ok(!JSON.stringify(readSample(good)).includes('PRIVATE'));
  for (const context of [undefined, { ...good.context, atSample: ['PRIVATE'] }, { ...good.context, atStart: [] },
    { ...good.context, atStart: ['unknown', 'detail'] }, { ...good.context, atSample: ['detail', 'detail'] },
    { ...good.context, dropped: -1 }, { ...good.context, dropped: 0.5 }, { ...good.context, dropped: Infinity },
    { ...good.context, events: Array(MAX_CONTEXT_EVENTS + 1).fill(event) },
    ...[{ kind: 'PRIVATE' }, { atMs: -1 }, { atMs: NaN }, { atMs: 5001 }, { screen: ['PRIVATE'] }].map(bad => ({ ...good.context, events: [{ ...event, ...bad }] })),
    { ...good.context, events: [event, { ...event, atMs: 9 }] }]) assert.equal(readSample({ ...good, context }), undefined);
  assert.ok(readSample({ ...good, context: { ...good.context, events: Array(MAX_CONTEXT_EVENTS).fill(event) } }));
});

test('details enforce support/null and finite bounds, strip extra keys and fit the worst allowed payload', t => {
  const base = sample();
  const good = { ...base, supported: { ...base.supported, eventTiming: true, renderPhases: true, longFrame: true }, details: {
    input: zeroes(INPUT_KEYS), render: zeroes(RENDER_KEYS), resources: base.details.resources, dom: { rows: 1, reports: 2, viewportWidth: 390, viewportHeight: 900 } } };
  assert.ok(readSample(good));
  assert.ok(readSample({ ...base, supported: { ...base.supported, resource: false }, details: emptyDetails() }));
  for (const bad of [
    { ...good, details: { ...good.details, input: null } },
    { ...good, details: { ...good.details, input: { ...good.details.input, count: MAX_DETAIL_ENTRIES + 1 } } },
    { ...good, details: { ...good.details, input: { ...good.details.input, processingMs: -1 } } },
    { ...good, details: { ...good.details, render: { ...good.details.render, renderMs: Infinity } } },
    { ...good, details: { ...good.details, dom: { ...good.details.dom, rows: 1.5 } } },
    { ...good, supported: { ...good.supported, eventTiming: false } },
    { ...good, supported: { ...good.supported, resource: false } },
    { ...good, supported: { ...good.supported, longFrame: false } },
    { ...good, details: { ...good.details, resources: { ...good.details.resources, api: { ...good.details.resources.api, ttfbCount: 1 } } } },
  ]) assert.equal(readSample(bad), undefined);
  const extra = { ...good, details: { ...good.details, url: 'PRIVATE', input: { ...good.details.input, name: 'PRIVATE' },
    resources: { ...good.details.resources, PRIVATE: { url: 'PRIVATE' } } } };
  assert.ok(!JSON.stringify(readSample(extra)).includes('PRIVATE'));
  const max = (keys: readonly string[]) => Object.fromEntries(keys.map(key => [key, ['count', 'ttfbCount'].includes(key) ? MAX_DETAIL_ENTRIES : 1e12]));
  const worst = { ...good, sinceMs: 1e12, metrics: Object.fromEntries(Object.keys(good.metrics).map(key => [key, 1e12])),
    lifecycle: { ...emptyLifecycle(), hiddenObserved: true, pagehideObserved: true, ...Object.fromEntries(LIFECYCLE_TIMES.map(key => [key, 1e12])), triggersSinceSample: [...RETURN_TRIGGERS] },
    supported: { ...good.supported, reactRender: true, componentNames: true }, buildId: 'development', tab: 'a'.repeat(40),
    components: Array.from({ length: 10 }, () => ({ name: 'a'.repeat(64), renders: 1e12 })),
    context: { atStart: ['list', 'detail', 'conversation', 'timeline'], atSample: ['list', 'detail', 'conversation', 'timeline'], dropped: 1e12,
      events: Array.from({ length: 24 }, () => ({ atMs: 1e12, kind: 'intent-task-previous', screen: ['list', 'detail', 'conversation', 'timeline'] })) },
    details: { input: max(INPUT_KEYS), render: max(RENDER_KEYS), resources: Object.fromEntries(RESOURCE_CATEGORIES.map(key => [key, max(RESOURCE_KEYS)])), dom: max(['rows', 'reports', 'viewportWidth', 'viewportHeight']) } };
  assert.ok(readSample(worst));
  const bytes = Buffer.byteLength(JSON.stringify(worst));
  const numericFields = (value: unknown): number => typeof value === 'number' ? 1
    : value && typeof value === 'object' ? Object.values(value).reduce<number>((sum, item) => sum + numericFields(item), 0) : 0;
  // A finite nonnegative JS number can serialize longer than the integer 1e12.
  // Allow 24 EXTRA bytes per numeric token, plus 128 for enum/boolean length variation.
  const upperBound = bytes + numericFields(worst) * 24 + 128;
  assert.ok(upperBound < MAX_REQUEST_BYTES);
  t.diagnostic(`All caps/max integer request: ${bytes} bytes; conservative serialization bound: ${upperBound} / ${MAX_REQUEST_BYTES}`);
});

test('lifecycle boundary checks fixed triggers, nullable clocks and observation meaning, and drops unknown strings', () => {
  const base = sample(), life = { ...emptyLifecycle(), hiddenObserved: true, hiddenWallMs: 100, sinceHiddenEndPerfMs: 5, sinceReturnTriggerPerfMs: 4, triggersSinceSample: ['resume'] };
  assert.ok(readSample({ ...base, lifecycle: { ...life, private: 'PRIVATE' } }));
  assert.ok(!JSON.stringify(readSample({ ...base, lifecycle: { ...life, private: 'PRIVATE' } })).includes('PRIVATE'));
  for (const lifecycle of [undefined, { ...life, initialVisibility: 'PRIVATE' }, { ...life, hiddenObserved: 'true' },
    { ...life, hiddenWallMs: -1 }, { ...life, sampleGapWallMs: Infinity }, { ...life, hiddenObserved: false },
    { ...life, sinceHiddenEndPerfMs: null }, { ...life, sinceReturnTriggerPerfMs: null },
    { ...life, triggersSinceSample: ['PRIVATE'] }, { ...life, triggersSinceSample: ['resume', 'resume'] },
    { ...life, triggersSinceSample: Array(4).fill('resume') }]) assert.equal(readSample({ ...base, lifecycle }), undefined);
  assert.ok(readSample({ ...base, lifecycle: { ...life, sampleGapWallMs: null, sampleGapPerfMs: 5 } }), 'clock rollback may leave only perf gap known');
});

test('receiver allowlist, identity, bounded rotation, permissions and isolated storage fault', async t => {
  const root = mkdtempSync(join(tmpdir(), 'alpacawork-diagnostic-')), directory = join(root, 'diagnostics/performance');
  const warnings: string[] = [], receiver = createPerformanceReceiver(directory, buildId, message => warnings.push(message));
  const server = createServer((req, res) => {
    const origin = `http://${req.headers.host}`;
    if (receiver.handle(req, res, origin)) return;
    res.end('normal API');
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await receiver.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); rmSync(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const send = (value: unknown, from: string | null = origin) => fetch(origin + ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(from === null ? {} : { Origin: from }) }, body: JSON.stringify(value) });
  assert.equal((await send(sample(), null)).status, 403);
  assert.equal((await send(sample(), 'https://foreign.invalid')).status, 403);
  assert.equal((await send({ ...sample(), buildId: 'b'.repeat(40) + '-diagnostic' })).status, 409);
  assert.equal((await send({ ...sample(), extra: 'x'.repeat(MAX_REQUEST_BYTES) })).status, 413);
  assert.equal((await send({ ...sample(), metrics: { ...sample().metrics, reactRenderMs: 0 } })).status, 400);
  assert.equal((await send({ ...sample(), text: 'PRIVATE', metrics: { ...sample().metrics, secret: 'PRIVATE' } })).status, 204);
  const current = join(directory, 'current.jsonl'), previous = join(directory, 'previous.jsonl');
  assert.ok(!readFileSync(current, 'utf8').includes('PRIVATE'));
  assert.equal(statSync(current).mode & 0o777, 0o600); assert.equal(statSync(directory).mode & 0o777, 0o700);
  writeFileSync(current, ' '.repeat(MAX_LOG_BYTES)); assert.equal((await send(sample())).status, 204);
  assert.equal(statSync(previous).size, MAX_LOG_BYTES); assert.ok(statSync(current).size < MAX_LOG_BYTES);
  rmSync(current); mkdirSync(current);
  assert.equal((await send(sample())).status, 503); assert.equal((await send(sample())).status, 503);
  assert.equal(warnings.length, 1); assert.equal(await (await fetch(origin + '/api')).text(), 'normal API');
});

test('incomplete bodies have a deadline and finite admission', async t => {
  const root = mkdtempSync(join(tmpdir(), 'alpacawork-diagnostic-')), warnings: string[] = [];
  const receiver = createPerformanceReceiver(join(root, 'performance'), buildId, message => warnings.push(message));
  const server = createServer((req, res) => receiver.handle(req, res, `http://${req.headers.host}`)).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await receiver.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); rmSync(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const hanging = Array.from({ length: 8 }, () => {
    const req = request(origin + ENDPOINT, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } });
    req.on('error', () => {}); req.write('{');
    return new Promise<number>(done => req.on('response', res => { res.resume(); done(res.statusCode!); }));
  });
  await new Promise(done => setTimeout(done, 100));
  const send = () => fetch(origin + ENDPOINT, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(sample()) });
  assert.equal((await send()).status, 429);
  assert.deepEqual(await Promise.all(hanging), Array(8).fill(408));
  assert.equal((await send()).status, 204); assert.equal(warnings.length, 0);
});

test('fresh ordinary build excludes diagnostic executable modules and browser collector', () => {
  assert.equal(releaseKind(new URL('../', import.meta.url).pathname), 'production');
  for (const folder of ['apps/backend/dist/diagnostics']) assert.throws(() => statSync(new URL('../' + folder, import.meta.url)));
  const output = new URL('../apps/backend/dist/', import.meta.url);
  for (const file of readdirSync(output, { recursive: true }).map(String).filter(file => file.endsWith('.js')))
    assert.doesNotMatch(readFileSync(new URL(file, output), 'utf8'), /\/__dev-performance|log write failed; recording stopped/, file);
});

test('ordinary typecheck includes diagnostic source: a deliberate diagnostic-only type error is caught', async t => {
  const { cpSync, copyFileSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'alpacawork-diagnostic-types-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = new URL('../', import.meta.url).pathname;
  cpSync(join(repo, 'apps/backend/src/diagnostics'), join(root, 'src/diagnostics'), { recursive: true });
  for (const name of ['tsconfig.json', 'tsconfig.diagnostic.json']) copyFileSync(join(repo, 'apps/backend', name), join(root, name));
  writeFileSync(join(root, 'src/base.ts'), 'export const valid = 1;');
  const file = join(root, 'src/diagnostics/receiver.ts');
  writeFileSync(file, readFileSync(file, 'utf8') + "\nconst deliberateTypeFault: number = 'wrong';\n");
  const compiler = join(repo, 'node_modules/typescript/bin/tsc');
  const check = (config: string) => spawnSync(process.execPath, [compiler, '-p', join(root, config), '--noEmit', '--types', 'node', '--typeRoots', join(repo, 'node_modules/@types')], { encoding: 'utf8' });
  const normal = check('tsconfig.json'); assert.equal(normal.status, 0, normal.stdout + normal.stderr);
  const diagnostic = check('tsconfig.diagnostic.json'); assert.notEqual(diagnostic.status, 0);
  assert.match(diagnostic.stdout, /diagnostics\/receiver.ts.*TS2322/);
});

test('writer admits at most eight pending saves and preserves serial order', async t => {
  const { performanceWriter } = await import('../apps/backend/src/diagnostics/writer.ts');
  const root = mkdtempSync(join(tmpdir(), 'alpacawork-diagnostic-queue-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const warnings: string[] = [], writer = performanceWriter(join(root, 'performance'), message => warnings.push(message));
  const accepted = Array.from({ length: 8 }, (_, n) => writer.write({ n }));
  assert.ok(accepted.every(Boolean)); assert.equal(writer.write({ n: 8 }), undefined);
  assert.deepEqual(await Promise.all(accepted), Array(8).fill(true)); await writer.close();
  assert.deepEqual(readFileSync(join(root, 'performance/current.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).n), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(warnings, []);
});
