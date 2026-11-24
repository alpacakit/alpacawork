import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskBaseState } from '@alpacawork/raw';
import type { TaskLog } from '@alpacawork/raw/task-log-schema';
import type { OwnerChoice } from '@alpacawork/contract/analysis';
import { summarizeOwnerChoices } from '@alpacawork/backend/test-dist/analysis/owner-choices.js';
import { launchOf, taskOutcome, type RunEvidence } from '@alpacawork/backend/test-dist/analysis/rules.js';

const epoch = Date.UTC(2026, 0, 1);
const at = (offset: number) => new Date(epoch + offset).toISOString();
const task = (n: number) => 'T' + n;
const event = (kind: TaskLog['kind'], time: number, fields: Partial<TaskLog> = {}): TaskLog =>
  ({ id: kind + time, kind, at: at(time), actor: { kind: 'human' }, fromState: null, toState: null, title: null,
    description: null, ...fields });
const accept = (time: number) => event('review_approved', time, { fromState: 'waiting', toState: 'done' });
const sendBack = (time: number) => event('review_sent_back', time, { fromState: 'waiting' });
const stop = (time: number) => event('reported', time, { fromState: 'doing', toState: 'stopped' });

const launch = (taskId: string, effort: string, started: number, duration: number, output: number,
  other: Partial<RunEvidence> = {}) => launchOf({
  id: 'R' + started, task: taskId, role: 'owner', agent: 'claude', session: null, state: 'succeeded',
  launch: { adapter: 'claude', values: { model: 'opus', effort } } as RunEvidence['launch'],
  created_at: at(started), started_at: at(started), ended_at: at(started + duration), pids: { agent: 42, manager: null },
  usage: { includesEarlier: false, conversation: null, run: { input: 0, output, cacheRead: 0, cacheWrite: 0 } },
  ...other,
});

function unit(n: number, effort: string, state: TaskBaseState, log: TaskLog[], extras: ReturnType<typeof launch>[] = []) {
  const id = task(n);
  return { node: { id, state }, outcome: taskOutcome(log, state, at(0)),
    launches: [launch(id, effort, 10, effort === 'high' ? 60 : 30, effort === 'high' ? 80 : 40), ...extras]
      .filter(run => run !== null) };
}

type Unit = ReturnType<typeof unit>;
const view = (...units: Unit[]) => summarizeOwnerChoices(units, ({ adapter, model, effort }) => model
  ? { key: effort!, choice: { adapter, model, effort } satisfies OwnerChoice } : null,
choice => choice.effort !== 'removed', epoch + 1000);
const passes = (n: number, effort: string) => unit(n, effort, 'done', [accept(100 + n)]);
const pending = (n: number, effort: string) => unit(n, effort, 'waiting', []);

test('trials gain evidence after acceptance, while non-judgments leave the latest five intact', () => {
  const baseline = [passes(1, 'high'), passes(2, 'high')];
  assert.deepEqual(view(...baseline).rows[0]?.judgments.map(item => item.result), ['passed', 'passed']);
  assert.deepEqual(view(...baseline, pending(3, 'medium')).rows[1]?.pendingTasks, [task(3)]);
  assert.deepEqual(view(...baseline, passes(3, 'medium')).rows[1]?.judgments.map(item => item.result), ['passed']);
  const adopted = [...baseline, passes(3, 'medium'), passes(4, 'medium')];
  const withOthers = view(...adopted, ...Array.from({ length: 6 }, (_, i) =>
    unit(i + 5, 'medium', 'stopped', [stop(200 + i)])), pending(11, 'medium'));
  assert.deepEqual(withOthers.rows[1]?.judgments.map(item => [item.task, item.result]),
    [[task(4), 'passed'], [task(3), 'passed']]);
  assert.deepEqual(withOthers.rows.map(row => row.medianCost), [{ outputTokens: 80, runMs: 60 }, { outputTokens: 40, runMs: 30 }]);
  assert.equal(withOthers.rows[1]?.counts.stopped, 6);
  const many = view(...Array.from({ length: 7 }, (_, i) => passes(12 + i, 'medium')));
  assert.deepEqual(many.rows[0]?.judgments.map(item => item.task), [18, 17, 16, 15, 14].map(task));
});

test('early rework stays with the tried choice across a later repair or stop', () => {
  const failedBeforeSpawn = launch(task(3), 'high', 1, 5, 0, { state: 'failed', pids: { agent: null, manager: 42 } });
  const repair = launch(task(3), 'high', 120, 20, 30);
  const review = launch(task(30), 'high', 60, 20, 20);
  const joined = launch(task(3), 'high', 50, 20, 200, { state: 'joined' });
  const modify = (state: TaskBaseState, ...log: TaskLog[]) => unit(3, 'medium', state, [sendBack(100), ...log],
    [failedBeforeSpawn, joined, repair, review]);
  for (const changed of [modify('doing'), modify('done', accept(150)), modify('stopped', stop(145))]) {
    const result = view(passes(1, 'high'), passes(2, 'high'), changed);
    assert.equal(result.counts.mixed, 0);
    assert.deepEqual(result.rows[1]?.judgments, [{
      task: task(3), result: 'reworked', at: at(100), cost: { outputTokens: 90, runMs: 70 },
    }]);
    assert.equal(result.rows[1]?.pendingTasks.length, 0);
  }
  assert.equal(view(modify('doing')).rows[0]?.medianCost.outputTokens, null);
  assert.equal(view(modify('done', accept(150))).rows[0]?.medianCost.outputTokens, 90);
});

test('missing or mixed evidence cannot count as a pass, and later instructions follow analysis', () => {
  const missing = view(passes(1, 'high'), passes(2, 'high'), pending(3, 'medium'), pending(4, 'medium'),
    unit(5, 'medium', 'done', []), unit(6, 'medium', 'done', [accept(120)], [launch(task(6), 'high', 40, 30, 40)]));
  assert.deepEqual(missing.counts, { passed: 2, reworked: 0, stopped: 0, pending: 2, unjudged: 1, mixed: 1 });
  assert.deepEqual(missing.rows[1]?.pendingTasks, [task(3), task(4)]);
  assert.deepEqual(missing.rows[1]?.judgments, []);
  const raised = view(unit(7, 'high', 'doing', [sendBack(100)]), unit(8, 'high', 'doing', [sendBack(101)]));
  assert.deepEqual(raised.rows[0]?.judgments.map(item => item.result), ['reworked', 'reworked']);
  const addedScope = view(passes(9, 'medium'), unit(10, 'medium', 'doing',
    [accept(110), event('request_accepted', 150, { fromState: 'done' })]), passes(11, 'removed'));
  assert.deepEqual(addedScope.rows[0]?.judgments.map(item => item.result), ['reworked', 'passed']);
  assert.equal(addedScope.rows[1]?.available, false);
});
