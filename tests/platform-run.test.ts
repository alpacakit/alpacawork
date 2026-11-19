/**
 * `platform.run.spawnDetached(..., unit)` on both of its Linux paths, whatever the environment that runs the
 * tests: each case sets the child's environment itself. The scope path needs the user's systemd; where it is
 * unreachable the case is skipped with that reason, so the result says which paths ran.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { platform, tryLock, unlock } from '@alpacawork/core';

const base = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'INVOCATION_ID'].includes(name)));
const direct = base;
const runtime = `/run/user/${process.getuid?.()}`;
const scoped = { ...base, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` };
const scopesReachable = process.platform === 'linux' && spawnSync('systemd-run',
  ['--user', '--scope', '--quiet', '--collect', '--', 'true'], { env: scoped, stdio: 'ignore', timeout: 5000 }).status === 0;
const unreachable = 'the user systemd is unreachable here; the scope path is not exercised';
const unit = () => `alpacawork-test-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;

/**
 * Start a process that reports its PID, cgroup and INVOCATION_ID, holding a locked fd 3 the way a Run manager
 * holds manager.lock; it stays until its stdin closes, so the lock can be tried from here meanwhile.
 */
async function observe(env: NodeJS.ProcessEnv, name: string) {
  const folder = mkdtempSync(join(tmpdir(), 'alpacawork-platform-run-'));
  const lockPath = join(folder, 'manager.lock');
  const held = openSync(lockPath, 'w');
  try {
    assert.equal(tryLock(held), true);
    const script = `const fs = require('node:fs');
      const read = path => { try { return fs.readFileSync(path, 'utf8'); } catch { return null; } };
      process.stdout.write(JSON.stringify({ pid: process.pid, cgroup: read('/proc/self/cgroup'),
        invocation: process.env.INVOCATION_ID ?? null }) + '\\n');
      process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`;
    const child = platform.run.spawnDetached(process.execPath, ['-e', script],
      { env, stdio: ['pipe', 'pipe', 'inherit', held] }, name);
    closeSync(held);
    const [line] = await once(child.stdout!, 'data') as [Buffer];
    const seen = JSON.parse(line.toString()) as { pid: number; cgroup: string | null; invocation: string | null };
    const probe = openSync(lockPath, 'r+');
    let lockedByChild: boolean;
    try { lockedByChild = !tryLock(probe); } finally { closeSync(probe); }
    child.stdin!.end();
    const [code] = await once(child, 'exit') as [number | null];
    const after = openSync(lockPath, 'r+');
    let releasedAtExit: boolean;
    try { releasedAtExit = tryLock(after); if (releasedAtExit) unlock(after); } finally { closeSync(after); }
    assert.equal(code, 0);
    return { childPid: child.pid, lockedByChild, releasedAtExit, ...seen };
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

test('direct path: without the user systemd a unit launch stays with its caller', async () => {
  const name = unit(), seen = await observe(direct, name);
  assert.equal(seen.pid, seen.childPid);
  assert.equal(seen.invocation, null);
  assert.equal(seen.lockedByChild, true, 'the child holds the inherited lock');
  assert.equal(seen.releasedAtExit, true);
  if (process.platform === 'linux') assert.ok(!seen.cgroup!.includes(name), seen.cgroup!);
});

test('scope path: with the user systemd a unit launch runs in its own scope as the same process',
  { skip: scopesReachable ? false : unreachable }, async () => {
    const name = unit(), seen = await observe(scoped, name);
    assert.ok(seen.cgroup!.trim().endsWith(`/${name}.scope`), seen.cgroup!);
    assert.equal(seen.pid, seen.childPid, 'systemd-run and env exec in place');
    assert.equal(seen.invocation, null, 'systemd adds nothing to the environment');
    assert.equal(seen.lockedByChild, true, 'the inherited lock is held in the scope');
    assert.equal(seen.releasedAtExit, true);
  });

test('scope path: a recorded unit stops with whatever left its group or moved to a group inside it, and only the unit it names',
  { skip: scopesReachable ? false : unreachable, timeout: 15_000 }, async () => {
    const name = unit();
    // A manager's agent and a child that left its group (a session of its own), both in the manager's scope, and a
    // child moved into a group made inside that scope.
    const script = `const { spawn } = require('node:child_process');
      const idle = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
      const away = idle(), inside = idle();
      process.stdout.write(JSON.stringify({ pid: process.pid, away: away.pid, inside: inside.pid, cgroup: require('node:fs').readFileSync('/proc/self/cgroup', 'utf8') }) + '\\n');
      setInterval(() => {}, 1000);`;
    const child = platform.run.spawnDetached(process.execPath, ['-e', script], { env: scoped, stdio: ['ignore', 'pipe', 'inherit'] }, name);
    // Listened for before anything stops it: the stop waits until its scope is empty, by when the exit has happened.
    const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    let seen: { pid: number; away: number; inside: number; cgroup: string } | undefined, nested: string | undefined;
    try {
      const [line] = await once(child.stdout!, 'data') as [Buffer];
      seen = JSON.parse(line.toString()) as { pid: number; away: number; inside: number; cgroup: string };
      const mount = readFileSync('/proc/self/mounts', 'utf8').split('\n').map(row => row.split(' ')).find(row => row[2] === 'cgroup2')![1]!;
      nested = join(mount, /^0::(\/.*)$/m.exec(seen.cgroup)![1]!, 'nested');
      mkdirSync(nested); writeFileSync(join(nested, 'cgroup.procs'), String(seen.inside));
      await platform.run.stopUnitOthers({ scope: seen.cgroup, ours: other => other !== name });
      assert.ok(alive(seen.pid) && alive(seen.away) && alive(seen.inside), 'a unit not named as ours is left alone');
      await platform.run.stopUnitOthers({ scope: seen.cgroup, ours: other => other === name });
      // Its parent killed too, the children that left are reaped by whoever adopted them.
      for (const until = performance.now() + 2000; (alive(seen.away) || alive(seen.inside)) && performance.now() < until;) await delay(50);
      assert.ok(!alive(seen.away), 'what left the group stops with the unit');
      assert.ok(!alive(seen.inside), 'what moved to a group inside the unit stops with the unit');
      assert.deepEqual(await exited, [null, 'SIGKILL'], 'the unit\'s own process is killed by the stop');
    } finally {
      for (const pid of [child.pid, seen?.away, seen?.inside]) if (pid !== undefined) try { process.kill(pid, 'SIGKILL'); } catch { /* Stopped. */ }
      if (nested) try { rmdirSync(nested); } catch { /* systemd removed the scope with it. */ }
    }
  });

/** How a launch of `command` ends at once: spawn's error code, or the exit status of what did start. */
async function outcome(command: string, env: NodeJS.ProcessEnv) {
  const child = platform.run.spawnDetached(command, [], { env, stdio: 'ignore' }, unit());
  return Promise.race([once(child, 'error').then(([error]) => (error as NodeJS.ErrnoException).code),
    once(child, 'exit').then(([code]) => `exit ${code}`)]);
}

test('a command that cannot start fails the same way on both paths', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'alpacawork-platform-run-'));
  try {
    const script = (name: string, line: string) => {
      writeFileSync(join(folder, name), `${line}\n`); chmodSync(join(folder, name), 0o755); return join(folder, name);
    };
    const cases = [
      { command: '/this-command-does-not-exist-t36', direct: 'ENOENT' },
      { command: script('no-interpreter', '#!/this-interpreter-does-not-exist-t36'), direct: 'ENOENT' },
      // env itself starts here, so even a direct launch ends as env's exit status.
      { command: script('no-env-target', '#!/usr/bin/env this-program-does-not-exist-t36'), direct: 'exit 127' },
      // The kernel keeps a CR in the interpreter's name: a CRLF script does not start.
      { command: script('crlf', '#!/bin/sh\r'), direct: 'ENOENT' },
    ];
    for (const { command, direct: expected } of cases) {
      assert.equal(await outcome(command, direct), expected, `direct ${command}`);
      if (scopesReachable) assert.equal(await outcome(command, scoped), expected, `scope ${command}`);
    }
    if (!scopesReachable) t.diagnostic(unreachable);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
