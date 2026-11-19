import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { stopGroup } from './helpers/process-groups.ts';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupGroups, processes } from './acceptance/processes.ts';

test('fixture cleanup waits for its killed group to disappear without probing an exiting group', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-cleanup-')));
  const child = spawn(process.execPath, ['-e', 'console.log("ready");setTimeout(()=>process.exit(42),60_000)', root],
    { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  const kill = process.kill;
  try {
    await once(child.stdout!, 'data');
    assert.ok(processes(root).some(p => p.pid === child.pid && p.pgid === child.pid));
    // Real macOS failure observed after SIGKILL: group probes fail with EPERM
    // while ps still reports the process in state E (exiting).
    process.kill = ((pid, signal) => {
      if (pid === -child.pid! && signal === 0) throw Object.assign(new Error('exiting group'), { code: 'EPERM' });
      return kill.call(process, pid, signal);
    }) as typeof process.kill;
    await cleanupGroups(root);
    assert.deepEqual(await exited, [null, 'SIGKILL']);
    assert.equal(processes().some(p => p.pgid === child.pid), false);
  } finally {
    process.kill = kill;
    if (child.exitCode === null && child.signalCode === null) {
      kill.call(process, -child.pid!, 'SIGKILL');
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('fixture cleanup waits when SIGKILL reports EPERM after the group starts exiting', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-cleanup-')));
  const child = spawn(process.execPath, ['-e', 'console.log("ready");setTimeout(()=>process.exit(42),60_000)', root],
    { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  const kill = process.kill;
  let injected = false;
  try {
    await once(child.stdout!, 'data');
    assert.ok(processes(root).some(p => p.pid === child.pid && p.pgid === child.pid));
    process.kill = ((pid, signal) => {
      if (pid === -child.pid! && signal === 'SIGKILL' && !injected) {
        injected = true;
        kill.call(process, pid, signal);
        throw Object.assign(new Error('exiting group'), { code: 'EPERM' });
      }
      return kill.call(process, pid, signal);
    }) as typeof process.kill;
    await cleanupGroups(root);
    assert.equal(injected, true);
    assert.deepEqual(await exited, [null, 'SIGKILL']);
    assert.equal(processes().some(p => p.pgid === child.pid), false);
  } finally {
    process.kill = kill;
    if (child.exitCode === null && child.signalCode === null) {
      if (!injected) kill.call(process, -child.pid!, 'SIGKILL');
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('fixture cleanup names a live PID when SIGKILL is denied', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-cleanup-')));
  const child = spawn(process.execPath, ['-e', 'console.log("ready");setTimeout(()=>process.exit(42),60_000)', root],
    { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  const kill = process.kill;
  try {
    await once(child.stdout!, 'data');
    process.kill = ((pid, signal) => {
      if (pid === -child.pid! && signal === 'SIGKILL') throw Object.assign(new Error('denied'), { code: 'EPERM' });
      return kill.call(process, pid, signal);
    }) as typeof process.kill;
    await assert.rejects(cleanupGroups(root), new RegExp(`live PID ${child.pid}`));
    assert.ok(processes(root).some(p => p.pid === child.pid));
  } finally {
    process.kill = kill;
    if (child.exitCode === null && child.signalCode === null) {
      kill.call(process, -child.pid!, 'SIGKILL');
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

// Exercise Darwin-only ps states without requiring a macOS host or leaving zombies.
// Which ps states count as live: posix-process.test.ts. Here the stop follows each answer.
for (const state of ['Z', 'R']) test(`group SIGKILL EPERM checks the observed ${state} state`, async t => {
  const pgid = 1_000_000_000;
  const denied = Object.assign(new Error('denied'), { code: 'EPERM' });
  const kill = t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, -pgid);
    assert.equal(signal, 'SIGKILL');
    throw denied;
  });
  const ps = t.mock.method(childProcess, 'execFileSync', (file, args) => {
    assert.equal(file, '/bin/ps');
    assert.deepEqual(args, ['-axo', 'pid=,pgid=,stat=,command=']);
    return `${pgid} ${pgid} ${state} test-owned\n`;
  });
  syncBuiltinESMExports();
  try {
    if (state === 'Z') await stopGroup(pgid);
    else await assert.rejects(stopGroup(pgid), error => {
      assert.match((error as Error).message, new RegExp(`live PID ${pgid}`));
      assert.equal((error as Error).cause, denied);
      return true;
    });
    assert.equal(kill.mock.callCount(), 1);
    assert.ok(ps.mock.callCount() > 0);
  } finally {
    kill.mock.restore();
    ps.mock.restore();
    syncBuiltinESMExports();
  }
});
