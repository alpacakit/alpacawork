import { test } from 'node:test';
import assert from 'node:assert/strict';
import { platform, type RunProcess } from '@alpacawork/core';
import { processUnit, runScope } from '@alpacawork/backend/test-dist/runs/launch-agent.js';
import { CommandWatch } from '@alpacawork/backend/test-dist/runs/command-watch.js';

const row = (pid: number, session = pid, started = 'first', ageMs = 0): RunProcess => ({ pid, session, started, ageMs, parent: 1 });
test('one session rule, elapsed age, TERM grace, leader exit, and PID reuse', t => {
  let rows = [row(1), row(2, 1), row(3), row(4, 3)];
  const sent: unknown[] = [], events: unknown[] = [];
  t.mock.method(platform.run, 'commandProcesses', () => rows);
  t.mock.method(platform.run, 'started', (pid: number) => rows.find(row => row.pid === pid)?.started ?? null);
  t.mock.method(process, 'kill', (pid: number, signal: string) => { sent.push([pid, signal]); return true; });
  const watch = new CommandWatch(1, 5, null, { append: (...args: unknown[]) => { events.push(args); } } as any);
  watch.tick(0); watch.tick(4999); assert.deepEqual(sent, []);
  watch.tick(5000); assert.deepEqual(sent, [[3, 'SIGTERM'], [4, 'SIGTERM']]);
  rows = [row(1), row(2, 1), row(4, 3)];
  watch.tick(5999); assert.equal(sent.length, 2);
  watch.tick(6000); assert.deepEqual(sent.at(-1), [4, 'SIGKILL']);
  rows = [row(1), row(2, 1), row(3, 3, 'reused')];
  watch.tick(6100); assert.equal(sent.length, 3, 'reused leader gets its own deadline');
  rows = [row(1), row(2, 1)]; watch.tick(12000);
  assert.equal(sent.length, 3, 'short-lived command is never signalled');
  assert.equal(events.length, 2);
});
test('PID replaced between collection and signalling is never signalled', t => {
  t.mock.method(platform.run, 'commandProcesses', () => [row(3, 3, 'old', 5000)]);
  t.mock.method(platform.run, 'started', () => 'new');
  t.mock.method(process, 'kill', () => assert.fail('reused PID'));
  const watch = new CommandWatch(1, 5, null, { append: () => assert.fail('no signal') } as any);
  watch.tick(0);
});
test('newly observed old command uses host age, without granting another full deadline', t => {
  t.mock.method(platform.run, 'commandProcesses', () => [row(3, 3, 'first', 6000)]);
  t.mock.method(platform.run, 'started', () => 'first');
  const kill = t.mock.method(process, 'kill', () => true);
  new CommandWatch(1, 5, null, { append() {} } as any).tick(0);
  assert.equal(kill.mock.calls.length, 1);
});

test('cgroup collection requires this Run own scope, never an inherited or another Run scope', () => {
  const unit = processUnit('/fixture', 'R1');
  const scope = `0::/user.slice/${unit}.scope`;
  assert.equal(runScope('/fixture', 'R1', scope), scope);
  for (const other of [null, '0::/user.slice/session-3.scope', '0::/system.slice/service.service', scope]) {
    assert.equal(runScope('/other-fixture', 'R1', other), null);
    assert.equal(runScope('/fixture', 'R2', other), null);
  }
});

test('EPERM and ESRCH leave a diagnostic, continue the session, and stop retrying after one KILL', t => {
  const rows = [row(1), row(2, 1), row(3), row(4, 3), row(5, 3)];
  const events: Array<{ type: string; payload: any }> = [];
  t.mock.method(platform.run, 'commandProcesses', () => rows);
  t.mock.method(platform.run, 'started', (pid: number) => rows.find(row => row.pid === pid)?.started ?? null);
  const sent: Array<[number, string]> = [];
  t.mock.method(process, 'kill', (pid: number, signal: string) => {
    sent.push([pid, signal]);
    if (pid === 3 || pid === 5) throw Object.assign(new Error('refused or gone'), { code: pid === 3 ? 'EPERM' : 'ESRCH' });
    return true;
  });
  const watch = new CommandWatch(1, 5, null, { append(type: string, payload: any) { events.push({ type, payload }); } } as any);
  watch.tick(0);
  assert.doesNotThrow(() => watch.tick(5000));
  assert.deepEqual(sent, [[3, 'SIGTERM'], [4, 'SIGTERM'], [5, 'SIGTERM']]);
  assert.deepEqual(events[0], { type: 'command_stopped', payload: { session: 3, started: 'first', signal: 'SIGTERM', seconds: 5,
    pids: [4], failed: [{ pid: 3, code: 'EPERM' }, { pid: 5, code: 'ESRCH' }] } });
  watch.tick(5999); assert.equal(sent.length, 3);
  assert.doesNotThrow(() => watch.tick(6000));
  assert.deepEqual(sent.slice(3), [[3, 'SIGKILL'], [4, 'SIGKILL'], [5, 'SIGKILL']]);
  assert.equal(events[1]!.payload.signal, 'SIGKILL');
  assert.deepEqual(events[1]!.payload.failed, events[0]!.payload.failed);
  // Even processes reported live after KILL do not restart the sequence or produce a journal flood.
  for (const now of [7000, 8000, 100000]) watch.tick(now);
  assert.equal(sent.length, 6); assert.equal(events.length, 2);
});
