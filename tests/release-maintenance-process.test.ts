import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { runMaintenance } from '@alpacawork/backend/test-dist/release/maintenance-process.js';
import { packageEnvironment } from '@alpacawork/backend/test-dist/release/package-facts.js';

test('maintenance streams progress and waits for its final verification JSON', async () => {
  const progress: string[] = [];
  const result = await runMaintenance(process.execPath, ['-e',
    "console.error('before verification');setTimeout(()=>{console.error('verification done');console.log(JSON.stringify({schema:16}));},100)"],
  process.env, line => progress.push(line));
  assert.deepEqual(JSON.parse(result), { schema: 16 });
  assert.match(progress.join('\n'), /before verification[\s\S]*verification done[\s\S]*completed in/);
});

test('maintenance reports a signal even when the child has no stderr', async () => {
  await assert.rejects(runMaintenance(process.execPath, ['-e', "process.kill(process.pid,'SIGTERM')"], process.env, () => {}),
    (error: { message: string; reason?: { kind: string; diagnostic?: string }; detail?: { signal?: string; stderr?: string; elapsedMs?: number } }) => {
      assert.match(error.message, /signal SIGTERM/);
      assert.equal(error.detail?.signal, 'SIGTERM');
      assert.equal(error.detail?.stderr, '');
      assert.equal(typeof error.detail?.elapsedMs, 'number');
      assert.equal(error.reason?.kind, 'unexpected_error');
      assert.equal(error.reason?.diagnostic, 'signal SIGTERM');
      return true;
    });
});

test('maintenance distinguishes spawn failure from an empty error response', async () => {
  await assert.rejects(runMaintenance('/nonexistent/node', [], process.env, () => {}),
    (error: { message: string; reason?: { kind: string; code?: string }; detail?: { error?: { code?: string } } }) => {
      assert.match(error.message, /ENOENT/);
      assert.equal(error.detail?.error?.code, 'ENOENT');
      assert.equal(error.reason?.kind, 'system_error');
      assert.equal(error.reason?.code, 'ENOENT');
      return true;
    });
});

test('maintenance keeps useful diagnostic tail when a child fails', async () => {
  await assert.rejects(runMaintenance(process.execPath, ['-e',
    "console.error('certification reached');process.exitCode=7"], process.env, () => {}),
    (error: { message: string; detail?: { code?: number; stderr?: string } }) => {
      assert.match(error.message, /exit 7/);
      assert.equal(error.detail?.code, 7);
      assert.match(error.detail?.stderr ?? '', /certification reached/);
      return true;
    });
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) test(`${signal} to a release controller reaps its maintenance child and reports cancellation`, { timeout: 12_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'aw-maintenance-stop-')), pidFile = join(root, 'child.pid');
  const driver = join(root, 'driver.mjs');
  const subject = new URL('../apps/backend/test-dist/release/maintenance-process.js', import.meta.url).href;
  writeFileSync(driver, `import{runMaintenance}from ${JSON.stringify(subject)};
try{await runMaintenance(process.execPath,['-e',${JSON.stringify(`${signal === 'SIGINT' ? "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});" : ''}require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`)}],process.env,()=>{});}
catch(error){console.log(JSON.stringify({signal:error.detail?.signal,interruptedBy:error.detail?.interruptedBy,message:error.message}));process.exitCode=6;}`);
  const child = spawn(process.execPath, [driver], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      try { if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(root)) process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ }
    }
    rmSync(root, { recursive: true, force: true });
  });
  for (const deadline = Date.now() + 5000; !existsSync(pidFile);) {
    assert.ok(Date.now() < deadline, 'maintenance starts: ' + stderr);
    await delay(20);
  }
  const pid = Number(readFileSync(pidFile, 'utf8'));
  child.kill(signal);
  const [code] = await closed;
  assert.equal(code, 6, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.interruptedBy, signal); assert.equal(result.signal, signal === 'SIGINT' ? 'SIGKILL' : signal);
  assert.match(result.message, new RegExp(`interrupted by ${signal}`));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('a failed progress observer preserves its cause and reaps the maintenance child', { timeout: 10_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'aw-maintenance-observer-')), pidFile = join(root, 'child.pid');
  t.after(() => {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      try { if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(root)) process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ }
    }
    rmSync(root, { recursive: true, force: true });
  });
  const original = new Error('progress observer failed');
  await assert.rejects(runMaintenance(process.execPath, ['-e',
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));console.error('observer checkpoint');setInterval(()=>{},1000);`],
  process.env, line => { if (line.includes('observer checkpoint')) throw original; }), error => {
    assert.equal((error as Error).cause, original);
    assert.match((error as Error).message, /progress observer failed/);
    return true;
  });
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('build environment uses the driver Node with a hostile PATH Node first', t => {
  const root = mkdtempSync(join(tmpdir(), 'aw-build-node-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'node'), '#!/bin/sh\necho v22-hostile\n', { mode: 0o700 });
  const path = process.env.PATH;
  process.env.PATH = root + ':' + path;
  try {
    assert.equal(spawnSync('node', ['--version'], { encoding: 'utf8' }).stdout.trim(), 'v22-hostile', 'hostile Node is actually reachable');
    const env = packageEnvironment();
    const child = spawnSync('node', ['-p', 'JSON.stringify({version:process.version,execPath:process.execPath})'], { env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { version: process.version, execPath: process.execPath });
  } finally { if (path === undefined) delete process.env.PATH; else process.env.PATH = path; }
});
