import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { platform } from '@alpacawork/core';
import { CommandWatch } from '@alpacawork/backend/test-dist/runs/command-watch.js';

test('no-scope collector finds root descendants and their native PID incarnations; the watch signals only the command', { timeout: 10000 }, async () => {
  const child = platform.run.spawnDetached(process.execPath, ['-e', `
    const {spawn}=require('node:child_process');
    const resident=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    const command=spawn('/bin/bash',['-c','sleep 30'],{detached:true,stdio:'ignore'});
    console.log(JSON.stringify({root:process.pid,resident:resident.pid,command:command.pid}));
    setTimeout(()=>process.exit(),8000);
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  let pids: {root:number;resident:number;command:number}|undefined;
  try {
    const [line] = await once(child.stdout!, 'data'); pids = JSON.parse(line.toString());
    const rows = platform.run.commandProcesses(pids!.root, null);
    for (const pid of Object.values(pids!)) {
      const row = rows.find(row => row.pid === pid)!;
      assert.ok(row); assert.equal(row.started, platform.run.started(pid));
    }
    assert.equal(rows.find(row => row.pid === pids!.resident)!.session, pids!.root);
    assert.equal(rows.find(row => row.pid === pids!.command)!.session, pids!.command);
    const events: unknown[] = [];
    const watch = new CommandWatch(pids!.root, 1, null, { append(...args: unknown[]) { events.push(args); } } as any);
    watch.tick(0); watch.tick(1000);
    for (let n=0; n<50 && platform.run.started(pids!.command)!==null; n++) await delay(20);
    assert.equal(platform.run.started(pids!.command), null);
    assert.ok(platform.run.started(pids!.root)); assert.ok(platform.run.started(pids!.resident));
    assert.equal(events.length, 1);
  } finally {
    for (const pid of [pids?.command, pids?.root, pids?.resident, child.pid]) if (pid) {
      try { process.kill(-pid, 'SIGKILL'); } catch {} try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  }
});

test('Linux fallback rechecks candidate ancestry and age with the PID incarnation', { skip: process.platform !== 'linux' }, async t => {
  const { linuxRun } = await import('../packages/core/dist/platform/linux-process.js');
  const { posixRun } = await import('../packages/core/dist/platform/posix-process.js');
  const child = platform.run.spawnDetached(process.execPath, ['-e', 'setTimeout(()=>{},8000)'], { stdio: 'ignore' });
  try {
    await once(child, 'spawn');
    // Simulate ps naming an old child whose PID now belongs outside the tree. The old age and
    // parent must not be combined with the current incarnation read from /proc.
    t.mock.method(posixRun, 'commandProcesses', () => [
      {pid: child.pid!, parent: process.pid, session: child.pid!, started: 'old ps', ageMs: 999999},
      {pid: process.pid, parent: child.pid!, session: process.pid, started: 'old ps', ageMs: 999999},
    ]);
    const rows = linuxRun.commandProcesses(child.pid!, null);
    assert.deepEqual(rows.map(row => row.pid), [child.pid]);
    assert.equal(rows[0]!.started, linuxRun.started(child.pid!));
    assert.ok(rows[0]!.ageMs < 8000, 'uses current /proc age, not old ps age');
  } finally {
    child.kill('SIGKILL');
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  }
});
