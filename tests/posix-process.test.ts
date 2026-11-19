import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
import { posixRun, processRows } from '../packages/core/dist/platform/posix-process.js';
import { terminateAgent } from '../apps/backend/test-dist/runs/ending.js';

const pgid = 1_000_000_000;
const denied = Object.assign(new Error('permission denied'), { code: 'EPERM' });

function intercept(t: import('node:test').TestContext, rows: string | Error, code: Error = denied) {
  const kill = t.mock.method(process, 'kill', (pid: number) => {
    assert.equal(pid, -pgid);
    throw code;
  });
  const ps = t.mock.method(childProcess, 'execFileSync', (file, args) => {
    assert.equal(file, '/bin/ps');
    assert.deepEqual(args, ['-axo', 'pid=,pgid=,stat=,command=']);
    if (rows instanceof Error) throw rows;
    return rows;
  });
  syncBuiltinESMExports();
  t.after(() => { kill.mock.restore(); ps.mock.restore(); syncBuiltinESMExports(); });
  return { kill, ps };
}

// Darwin's ps puts the exiting flag after the run state (adv_cmds ps/print.c); Linux's ps has no `E`.
for (const state of ['', 'Z', 'Z+', 'RE', 'UE', '?Es', 'SNE+']) test(`POSIX EPERM treats ${state || 'absent'} group as stopped`, t => {
  intercept(t, `${pgid + 2} ${pgid + 2} R other-group\n` + (state ? `${pgid} ${pgid} ${state} stopped\n` : ''));
  assert.equal(posixRun.signalGroup(pgid, 'SIGKILL'), false);
});
// The stopped answer comes before anything reads the signal.
for (const signal of [0, 'SIGTERM'] as const) test(`POSIX ${signal} EPERM treats a zombie group as stopped`, t => {
  intercept(t, `${pgid} ${pgid} Z stopped\n`);
  assert.equal(posixRun.signalGroup(pgid, signal), false);
});
for (const state of ['R', 'T', 'S', 'Ss', 'U+', 'IN', 'RX']) {
  test(`POSIX EPERM preserves live ${state} members and explains denied signals`, t => {
    intercept(t, `${pgid} ${pgid} Z zombie\n${pgid + 1} ${pgid} ${state} live-child\n`);
    assert.equal(posixRun.signalGroup(pgid, 0), true);
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) assert.throws(() => posixRun.signalGroup(pgid, signal), error => {
      assert.match((error as Error).message, new RegExp(`${signal}.*${pgid}.*live PID ${pgid + 1} `));
      assert.ok((error as Error).message.endsWith(`(ps pid stat: ${pgid} Z, ${pgid + 1} ${state})`));
      assert.equal((error as Error).cause, denied);
      return true;
    });
  });
}
for (const rows of [new Error('ps failed'), 'malformed process row\n']) {
  test(`POSIX EPERM does not hide ${rows instanceof Error ? 'ps failure' : 'malformed output'}`, t => {
    intercept(t, rows);
    assert.throws(() => posixRun.signalGroup(pgid, 'SIGTERM'), /Cannot inspect process group/);
  });
}
for (const code of ['ESRCH', 'EINVAL']) test(`POSIX preserves ${code}`, t => {
  const error = Object.assign(new Error(code), { code });
  const { ps } = intercept(t, '', error);
  if (code === 'ESRCH') assert.equal(posixRun.signalGroup(pgid, 'SIGKILL'), false);
  else assert.throws(() => posixRun.signalGroup(pgid, 'SIGKILL'), e => e === error);
  assert.equal(ps.mock.callCount(), 0);
});
test('POSIX successful signal does not inspect processes', t => {
  const { kill, ps } = intercept(t, '');
  kill.mock.mockImplementation(() => true as const);
  assert.equal(posixRun.signalGroup(pgid, 'SIGTERM'), true);
  assert.equal(ps.mock.callCount(), 0);
});
for (const pid of [0, -2, NaN, 1.5]) test(`POSIX rejects invalid group ${pid}`, () => {
  assert.throws(() => posixRun.signalGroup(pid, 'SIGTERM'), /Invalid process group/);
});
test('agent stop finishes when its EPERM group has only zombies', async t => {
  const { kill } = intercept(t, `${pgid} ${pgid} Z zombie\n`);
  await terminateAgent(pgid);
  assert.equal(kill.mock.callCount(), 1);
});
test('agent stop finishes when its EPERM group leader is exiting', async t => {
  const { kill } = intercept(t, `${pgid} ${pgid} UEs exiting-leader\n`);
  await terminateAgent(pgid);
  assert.equal(kill.mock.callCount(), 1);
});
test('agent stop rejects a denied TERM with the live child and cause', async t => {
  intercept(t, `${pgid + 1} ${pgid} S live-child\n`);
  await assert.rejects(terminateAgent(pgid), error => {
    assert.match((error as Error).message, new RegExp(`SIGTERM.*live PID ${pgid + 1} \\(ps pid stat: ${pgid + 1} S\\)$`));
    assert.equal((error as Error).cause, denied);
    return true;
  });
});

// After SIGKILL the group answers EPERM on macOS while its leader exits or waits as a zombie; ps tells which.
// Signalling it must never read as refused until the leader is reaped.
test('a killed group is never refused while its leader exits and waits to be reaped', async t => {
  const exiting = new Map<string, number>();
  for (let round = 0; round < 30; round++) {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 60_000)'],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const group = child.pid!;
    t.after(() => { if (child.exitCode === null && child.signalCode === null) posixRun.signalGroup(group, 'SIGKILL'); });
    await once(child.stdout!, 'data', { signal: AbortSignal.timeout(10_000) });
    assert.equal(posixRun.signalGroup(group, 'SIGKILL'), true);
    const deadline = performance.now() + 10_000;
    // Signal only while this process has not reaped the leader: until then its number cannot be reused.
    while (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-group, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM')
          for (const p of processRows()) if (p.pgid === group) exiting.set(p.state, (exiting.get(p.state) ?? 0) + 1);
      }
      posixRun.signalGroup(group, 'SIGKILL');
      posixRun.signalGroup(group, 0);
      assert.ok(performance.now() < deadline, `group ${group} reaped`);
      await tick();
    }
    assert.equal(child.signalCode, 'SIGKILL');
  }
  t.diagnostic(`ps states seen at killpg EPERM: ${[...exiting].map(([state, count]) => `${state}x${count}`).join(' ') || 'none'}`);
});

test('POSIX command identity uses one C-locale ps path despite a Japanese caller locale', t => {
  const previous = process.env.LC_ALL;
  process.env.LC_ALL = 'ja_JP.UTF-8';
  const english = 'Sat Oct  3 15:00:00 2026';
  const ps = t.mock.method(childProcess, 'execFileSync', (file: string, args: string[], options: any) => {
    assert.equal(file, '/bin/ps');
    assert.equal(options.env.LC_ALL, 'C');
    if (args[0] === '-axo') return `321 1 321 ${english} 00:05 Ss\n`;
    assert.deepEqual(args, ['-o', 'lstart=', '-p', '321']);
    return `  ${english}  \n`;
  });
  syncBuiltinESMExports();
  t.after(() => {
    ps.mock.restore(); syncBuiltinESMExports();
    if (previous === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = previous;
  });
  const rows = posixRun.commandProcesses(321, null);
  assert.equal(rows[0]!.started, 'Sat Oct 3 15:00:00 2026');
  assert.equal(posixRun.started(321), rows[0]!.started);
  assert.equal(ps.mock.callCount(), 2);
});
