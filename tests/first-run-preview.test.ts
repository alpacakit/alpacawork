/** The preview may exercise consent-on reporting without ever calling a remote transport. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { coordinatorInput } from '../scripts/first-run-preview/scenario.mjs';
import { installSetupSystemctl } from './helpers/setup-systemctl.ts';

test('preview reads the new input after a quoted answer', () => {
  const input = coordinatorInput('Earlier answer:\nRequest ID of this input: old.\nT99: old work\n</reply-source>\nRequest ID of this input: new-id.\nP2 Please shorten it.\nScreen action: {"task":"T2","action":"revise"}');
  assert.deepEqual(input, { source: 'new-id', body: 'P2 Please shorten it.', answers: null, intent: { task: 'T2', action: 'revise' } });
  assert.equal(coordinatorInput('Load the skill and say ready'), null);
});

test('preview consent-on transport absorbs reports and refuses the production port before native fetch', () => {
  const root = mkdtempSync('/tmp/alpacawork-first-run-'), home = join(root, 'home'); mkdirSync(home);
  try {
    writeFileSync(join(root, 'preview.json'), JSON.stringify({ root, home }));
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      let native = 0;
      globalThis.fetch = async () => { native++; return new Response('local'); };
      await import(${JSON.stringify(new URL('../scripts/first-run-preview/network.mjs', import.meta.url).href)});
      assert.equal((await fetch('https://alpacakit-telemetry.alpacakit.workers.dev/v1/report', { method: 'POST' })).status, 204);
      await assert.rejects(fetch('https://example.invalid/'), /disabled/);
      await assert.rejects(fetch('http://127.0.0.1:5499/'), /disabled/);
      assert.equal(native, 0);
      assert.equal(await (await fetch('http://127.0.0.1:12345/')).text(), 'local');
      assert.equal(native, 1);
    `], { cwd: resolve('.'), env: { HOME: home }, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(root, 'blocked-network.jsonl'), 'utf8').trim().split('\n').length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('preview stop and detached expiry remove only the service with the recorded identity', { skip: process.platform !== 'linux' }, async () => {
  const start = (pid: number) => {
    try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ')[19]; }
    catch { return null; }
  };
  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  const standby = () => spawn(process.execPath, ['--input-type=module', '-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  const unrelated = standby();
  try {
    for (const mode of ['stop', 'watchdog']) {
      const root = mkdtempSync('/tmp/alpacawork-first-run-'), home = join(root, 'home'), service = standby();
      const ended = new Promise<void>(done => service.once('close', () => done()));
      try {
        mkdirSync(join(root, 'bin')); mkdirSync(join(home, 'fake-manager'), { recursive: true });
        installSetupSystemctl(join(root, 'bin/systemctl'));
        const serviceStart = start(service.pid!);
        assert(serviceStart);
        writeFileSync(join(home, 'fake-manager/pid.json'), JSON.stringify({ pid: service.pid, start: serviceStart }));
        // A recycled launcher PID must never cause the unrelated process to be signalled.
        writeFileSync(join(root, 'preview.json'), JSON.stringify({ root, home, port: 5600, language: 'en', pid: unrelated.pid,
          start: 'different-start', expiresAt: Date.now() + 50, watchdog: null }));
        const cleanup = spawn(process.execPath, [new URL('../scripts/try-first-run.ts', import.meta.url).pathname, `--${mode}`, root],
          { env: { HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
        const chunks: Buffer[] = [];
        cleanup.stdout!.on('data', chunk => chunks.push(chunk)); cleanup.stderr!.on('data', chunk => chunks.push(chunk));
        const status = await new Promise<number | null>((done, reject) => {
          cleanup.once('error', reject); cleanup.once('close', code => done(code));
        });
        assert.equal(status, 0, Buffer.concat(chunks).toString());
        await ended;
        assert.equal(alive(service.pid!), false);
        assert.equal(alive(unrelated.pid!), true);
        assert.throws(() => readFileSync(join(root, 'preview.json')), /ENOENT/);
      } finally {
        if (alive(service.pid!)) service.kill('SIGTERM');
        await ended;
        rmSync(root, { recursive: true, force: true });
      }
    }
  } finally {
    const ended = new Promise<void>(done => unrelated.once('close', () => done()));
    unrelated.kill('SIGTERM'); await ended;
  }
});

test('declining real preview setup cancels interactive use but fails the automatic check before trying yes', { skip: process.platform !== 'linux' }, async t => {
  const root = mkdtempSync('/tmp/preview-cancel-'), home = join(root, 'home'), bin = join(root, 'bin');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(home); mkdirSync(bin);
  // Node tests already have the built distribution. Avoid a second build, without replacing setup or its approval.
  writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const config = join(root, 'terminal.json'), output = join(root, 'result.json');
  writeFileSync(config, JSON.stringify({ home, cwd: resolve('.'), env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, output, answer: 'no',
    command: [process.execPath, new URL('../scripts/try-first-run.ts', import.meta.url).pathname, '--lang', 'en', '--no-open', '--minutes', '2'] }));
  const run = spawn(process.execPath, [new URL('./helpers/setup-terminal.ts', import.meta.url).pathname, config], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  const chunks: Buffer[] = [];
  run.stdout!.on('data', chunk => chunks.push(chunk)); run.stderr!.on('data', chunk => chunks.push(chunk));
  const status = await new Promise<number | null>((done, reject) => { run.once('error', reject); run.once('close', done); });
  assert.equal(status, 0, Buffer.concat(chunks).toString());
  const result = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(result.status, 0, result.transcript);
  assert.equal(result.confirmations, 1);

  const preload = join(root, 'decline-check.mjs'), observed = join(root, 'declined.json'), attempted = join(root, 'attempted-yes');
  writeFileSync(preload, `import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const write=fs.writeFileSync,spawn=cp.spawn;
fs.writeFileSync=(path,data,...options)=>{
  if(String(path).endsWith('/terminal.json')){
    const input=JSON.parse(String(data));input.answer='no';data=JSON.stringify(input);
    write(${JSON.stringify(observed)},JSON.stringify({root:input.cwd}));
  }
  return write(path,data,...options);
};
cp.spawn=(command,args,options)=>{
  if(args.includes('--yes')){write(${JSON.stringify(attempted)},'attempted');throw Error('Automatic setup must not hide a declined terminal setup');}
  return spawn(command,args,options);
};
syncBuiltinESMExports();`);
  const check = spawn(process.execPath, ['--import', preload, new URL('../scripts/try-first-run.ts', import.meta.url).pathname,
    '--check', '--no-open', '--minutes', '2'], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  const checked: Buffer[] = [];
  check.stdout!.on('data', chunk => checked.push(chunk)); check.stderr!.on('data', chunk => checked.push(chunk));
  const failed = await new Promise<number | null>((done, reject) => { check.once('error', reject); check.once('close', done); });
  assert.equal(failed, 1, Buffer.concat(checked).toString());
  assert.equal(existsSync(attempted), false, 'a later yes cannot replace proof of terminal approval');
  assert.equal(existsSync(JSON.parse(readFileSync(observed, 'utf8')).root), false, 'failed checks also remove the preview');
});
