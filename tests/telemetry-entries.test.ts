import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Hono } from '../apps/backend/node_modules/hono/dist/index.js';
import type { TelemetryService } from '../apps/backend/test-dist/telemetry/service.js';

test('local telemetry refuses Run credentials and has no opt-in command; HTTP authorizes before touching telemetry', async () => {
  const { telemetryNode } = await import('../apps/backend/test-dist/telemetry/entries.js');
  const { installTelemetryRoutes } = await import('../apps/backend/test-dist/telemetry/routes.js');
  const command = (name: string) => telemetryNode.children!.find(node => node.name === name)!.endpoints![0]!.handler;
  for (const name of ['status', 'show', 'off']) for (const env of [{ ALPACAWORK_RUN: '' }, { ALPACAWORK_RUN_TOKEN: '' }])
    await assert.rejects(command(name)({}, { cli: { env, cwd: process.cwd() } }), /person on this PC/);
  assert.equal(telemetryNode.children!.some(node => node.name === 'on'), false);
  const app = new Hono();
  const touched: string[] = [];
  const service = { status: () => { touched.push('status'); return {}; }, show: () => { touched.push('show'); return {}; },
    choose: () => { touched.push('choose'); return {}; }, mark: () => touched.push('mark'),
    deleteSent: () => { touched.push('delete'); return {}; } } as unknown as TelemetryService;
  app.onError(() => new Response('person required', { status: 403 }));
  installTelemetryRoutes(app, service, () => { throw new Error('person required'); });
  for (const [method, path] of [['GET', 'status'], ['GET', 'show'], ['GET', 'preview'], ['POST', 'choice'], ['POST', 'use'], ['POST', 'delete']]) {
    const response = await app.request(`/api/telemetry/${path}`, { method, ...(method === 'POST' ? { body: 'invalid JSON' } : {}) });
    assert.equal(response.status, 403);
  }
  assert.deepEqual(touched, []);
});

test('public launcher keeps telemetry local, preserves workspace tokens, and refuses every --server placement', t => {
  const root = mkdtempSync(join(tmpdir(), 'telemetry-launcher-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path: string, bytes: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); };
  cpSync(resolve('apps/launcher'), join(root, 'bin'), { recursive: true });
  put('package.json', '{"type":"module"}');
  put('apps/backend/dist/package-version.js', 'export function readPackageVersion() { return { version:"1.0.0", targets:["linux-x64-glibc","darwin-arm64"] }; }');
  put('apps/backend/dist/backend.js', 'export async function main(args) { console.log(JSON.stringify(args)); }');
  put('apps/backend/dist/installation/local-cli.js', 'throw new Error("telemetry must not select a server");');
  const launch = (args: string[]) => spawnSync(process.execPath, [join(root, 'bin/alpacawork.mjs'), ...args], { encoding: 'utf8', timeout: 10_000 });
  for (const args of [['telemetry', 'status'], ['telemetry', 'off', '--workspace', '/synthetic data'], ['--workspace=/synthetic data', 'telemetry', 'show']]) {
    const result = launch(args); assert.equal(result.status, 0, result.stderr);
    const expected = args[0] === 'telemetry' && args.includes('--workspace') ? ['--workspace', '/synthetic data', 'telemetry', 'off'] : args;
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
  for (const args of [['telemetry', 'off', '--server', 'http://127.0.0.1:1'], ['--server=http://127.0.0.1:1', 'telemetry', 'status'], ['--server', 'http://127.0.0.1:1', 'telemetry', 'show']]) {
    const result = launch(args); assert.notEqual(result.status, 0); assert.equal(result.stdout, '');
    assert.match(result.stderr, /--server is unavailable for telemetry/);
  }
});
