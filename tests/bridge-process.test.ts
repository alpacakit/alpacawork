import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnBridge } from './helpers/bridge-process.ts';
import { waitForGate } from './fixtures/fake-gate.mjs';

import { isLive, killGroup, processRows, stopGroup } from './helpers/process-groups.ts';

test('bridge capture keeps a split JSONL event and split UTF-8 character intact', async t => {
  const h = spawnBridge(t, ['-e', `
    const bytes = Buffer.from(JSON.stringify({ type: 'item.completed', text: 'あ' }) + '\\n');
    const split = bytes.indexOf(Buffer.from('あ')) + 1;
    process.stdout.write(bytes.subarray(0, split));
    process.stdin.once('data', () => process.stdout.end(bytes.subarray(split)));
  `]);
  // Synchronize on a partial write before letting the fake process finish the line.
  await new Promise<void>(resolve => h.child.stdout.once('data', () => resolve()));
  assert.deepEqual(h.events(), []);
  h.child.stdin.end('release');
  await h.until(events => events.length === 1);
  assert.equal(await h.exited, 0);
  assert.deepEqual(h.events(), [{ type: 'item.completed', text: 'あ' }]);
  // The promise remains usable after close; no late event subscription can miss it.
  assert.equal(await h.exited, 0);
});

test('a fake Pi waiting for a gate exits when its bridge input pipe closes', { timeout: 2000 }, async t => {
  const area = mkdtempSync(join(tmpdir(), 'alpacawork-pi-pipe-'));
  const release = join(area, 'release');
  const h = spawnBridge(t, [join(import.meta.dirname, 'fixtures/fake-pi.mjs')], {
    env: { ...process.env, PI_STUB_MODE: 'hold', PI_STUB_LOG: join(area, 'log'), PI_STUB_RELEASE: release },
  });
  t.after(() => rmSync(area, { recursive: true, force: true }));
  h.child.stdin.write(`${JSON.stringify({ id: '1', type: 'prompt', message: 'start' })}\n`);
  await h.until(events => events.some(event => event.type === 'agent_start'));
  assert.equal(existsSync(release), false, 'the turn is still waiting for its gate');
  h.child.stdin.end();
  assert.equal(await h.exited, 0, h.stderr());
});

test('a fake gate has a deadline when its test process can no longer release it', async t => {
  const area = mkdtempSync(join(tmpdir(), 'alpacawork-gate-deadline-'));
  t.after(() => rmSync(area, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const waiting = waitForGate(join(area, 'release'));
  const rejected = assert.rejects(waiting, /Fake gate was not released within 10 seconds/);
  t.mock.timers.tick(10_000);
  await rejected;
});

test('fake gates observe releases before and after waiting without OS watchers and leave no timers', { timeout: 2000 }, async t => {
  const area = mkdtempSync(join(tmpdir(), 'alpacawork-gate-poll-'));
  t.after(() => rmSync(area, { recursive: true, force: true }));
  const gate = new URL('./fixtures/fake-gate.mjs', import.meta.url).href;
  const h = spawnBridge(t, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    // Local fault injection: never consume another process's inotify instances.
    fs.watch = () => { throw Object.assign(new Error('watch unavailable'), { code: 'EMFILE' }); };
    syncBuiltinESMExports();
    const { waitForGate } = await import(${JSON.stringify(gate)});
    const before = ${JSON.stringify(join(area, 'before'))};
    const after = ${JSON.stringify(join(area, 'after'))};
    fs.writeFileSync(before, '');
    await waitForGate(before);
    const waiting = waitForGate(after);
    console.log(JSON.stringify({ type: 'waiting' }));
    process.stdin.once('data', () => fs.writeFileSync(after, ''));
    await waiting;
    process.stdin.destroy();
    console.log(JSON.stringify({ type: 'released' }));
  `]);
  await h.until(events => events.some(event => event.type === 'waiting'));
  assert.equal(existsSync(join(area, 'after')), false);
  assert.equal(h.events().some(event => event.type === 'released'), false);
  h.child.stdin.end('release');
  await h.until(events => events.some(event => event.type === 'released'));
  // Natural close, within the test's existing pipe-close bound, proves cleanup.
  assert.equal(await h.exited, 0);
});

// Invoke the real after hook explicitly so its rejection can be asserted.
function bridge(t: TestContext, source: string) {
  let cleanup: () => Promise<void>;
  const hooks = { after: (fn: () => Promise<void>) => { cleanup = fn; } };
  const h = spawnBridge(hooks as unknown as TestContext, ['-e', source]);
  t.after(async () => {
    if (h.child.pid) {
      killGroup(h.child.pid);
    }
    await h.exited;
  });
  return { ...h, cleanup: () => cleanup() };
}

test('bridge cleanup accepts EPERM for a group whose bridge has already closed', async t => {
  const h = bridge(t, 'console.log(JSON.stringify({type:"ready"}))');
  assert.equal(await h.exited, 0);
  const kill = process.kill;
  let injected = false;
  process.kill = ((pid, signal) => {
    if (pid === -h.child.pid! && signal === 'SIGKILL') {
      injected = true;
      throw Object.assign(new Error('exiting group'), { code: 'EPERM' });
    }
    return kill.call(process, pid, signal);
  }) as typeof process.kill;
  try {
    await h.cleanup();
    assert.equal(injected, true);
  } finally { process.kill = kill; }
});

const orphanProvider = `
  const { spawn } = require('node:child_process');
  const provider = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60_000)'], { stdio: 'ignore' });
  console.log(JSON.stringify({type:'provider',pid:provider.pid}));
  process.exit(0);
`;

test('bridge cleanup stops a provider left alive after bridge close', async t => {
  const h = bridge(t, orphanProvider);
  assert.equal(await h.exited, 0);
  const provider = h.events()[0].pid;
  assert.ok(processRows().some(p => p.pid === provider && p.pgid === h.child.pid && isLive(p)));
  await h.cleanup();
  assert.equal(processRows().some(p => p.pgid === h.child.pid && isLive(p)), false);
});

test('bridge cleanup accepts EPERM during real group termination and verifies no live provider remains', async t => {
  const h = bridge(t, orphanProvider);
  assert.equal(await h.exited, 0);
  const kill = process.kill;
  let injected = false;
  process.kill = ((pid, signal) => {
    if (pid === -h.child.pid! && signal === 'SIGKILL') {
      injected = true;
      kill.call(process, pid, signal);
      throw Object.assign(new Error('exiting group'), { code: 'EPERM' });
    }
    return kill.call(process, pid, signal);
  }) as typeof process.kill;
  try {
    await h.cleanup();
    assert.equal(injected, true);
    assert.equal(processRows().some(p => p.pgid === h.child.pid && isLive(p)), false);
  } finally { process.kill = kill; }
});

test('bridge cleanup rejects EPERM when a provider is still alive', async t => {
  const h = bridge(t, orphanProvider);
  assert.equal(await h.exited, 0);
  const provider = h.events()[0].pid;
  const kill = process.kill;
  const denied = Object.assign(new Error('denied'), { code: 'EPERM' });
  process.kill = ((pid, signal) => {
    if (pid === -h.child.pid! && signal === 'SIGKILL') throw denied;
    return kill.call(process, pid, signal);
  }) as typeof process.kill;
  try {
    await assert.rejects(h.cleanup(), error => {
      assert.match((error as Error).message, new RegExp(`live PID ${provider}`));
      assert.equal((error as Error).cause, denied);
      return true;
    });
    assert.ok(processRows().some(p => p.pid === provider && isLive(p)));
  } finally { process.kill = kill; }
});

test('bridge cleanup forces a bridge that ignores TERM and waits for close', async t => {
  const h = bridge(t, `process.on('SIGTERM',()=>{}); console.log('{"type":"ready"}'); setTimeout(()=>{},60_000)`);
  await h.until(rows => rows.length === 1);
  await h.cleanup();
  assert.equal(await h.exited, null);
  assert.equal(h.child.signalCode, 'SIGKILL');
  assert.equal(processRows().some(p => p.pgid === h.child.pid && isLive(p)), false);
});

test('bridge cleanup preserves output errors even when its group is already gone', async t => {
  const h = bridge(t, 'console.log("not JSON")');
  await h.exited;
  await assert.rejects(h.cleanup(), /Invalid bridge output/);
});

test('group cleanup rejects unknown signal errors and bounds a successful signal that did not stop its target', async t => {
  const h = bridge(t, orphanProvider);
  await h.exited;
  const kill = process.kill;
  const unknown = Object.assign(new Error('unknown kill failure'), { code: 'EINVAL' });
  process.kill = ((pid, signal) => {
    if (pid === -h.child.pid! && signal === 'SIGKILL') throw unknown;
    return kill.call(process, pid, signal);
  }) as typeof process.kill;
  try {
    await assert.rejects(h.cleanup(), error => error === unknown);
    process.kill = ((pid, signal) => {
      if (pid === -h.child.pid! && signal === 'SIGKILL') return true;
      return kill.call(process, pid, signal);
    }) as typeof process.kill;
    await assert.rejects(stopGroup(h.child.pid!, 50), /Deadline: process group .* stopped/);
  } finally { process.kill = kill; }
});

test('bridge cleanup reports force-kill denial as a hook rejection when the bridge ignores TERM', async t => {
  const h = bridge(t, `process.on('SIGTERM',()=>{}); console.log('{"type":"ready"}'); setTimeout(()=>{},60_000)`);
  await h.until(rows => rows.length === 1);
  const kill = process.kill;
  const denied = Object.assign(new Error('denied'), { code: 'EPERM' });
  process.kill = ((pid, signal) => {
    if (pid === -h.child.pid! && signal === 'SIGKILL') throw denied;
    return kill.call(process, pid, signal);
  }) as typeof process.kill;
  try {
    await assert.rejects(h.cleanup(), error => {
      assert.match((error as Error).message, new RegExp(`live PID ${h.child.pid}`));
      assert.equal((error as Error).cause, denied);
      return true;
    });
  } finally { process.kill = kill; }
});
