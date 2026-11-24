import { controlRunFixture } from './helpers/control-run-fixture.ts';
import type { RunRecord } from '@alpacawork/contract/run';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureAttentionWindow, placementRuntimeSchema, type ControlRunDTO } from '@alpacawork/contract';
import { projectPlacementRuntimes } from '@alpacawork/backend/test-dist/control/runtime.js';
import { projectPlacements } from '@alpacawork/backend/test-dist/control/tree.js';

const at = (minute: number) => `2026-09-29T00:${String(minute).padStart(2, '0')}:00.000Z`;
function run(id: string, fields: Partial<RunRecord> = {}): ControlRunDTO {
  return controlRunFixture(id, { task: 'T1', placementId: 'P1', agent: 'codex',
    requestId: `request-${id}`, cwd: '/fixture/run', created_at: at(0), ...fields });
}
const activity = (id: string) => id === 'R2' ? { at: at(3), kind: 'tool_start' as const, toolName: 'Bash', note: null, doing: null, context: null, steps: [] } : null;
const placement = { id: 'P1', endedAt: null as string | null };
const task = { state: 'doing', stateLog: [{ at: at(0), toState: 'doing' }] };
const runtime = (runs: readonly ControlRunDTO[] | null, activityOf = activity,
  currentPlacement = placement, currentTask = task) =>
  projectPlacementRuntimes([{ ...currentPlacement, taskId: 'T1' }], new Map([['T1', currentTask]]),
    runs, activityOf).get(currentPlacement.id)!;

test('running is based on Run state; absent output does not imply idle', () => {
  const current = run('R1', { state: 'running', started_at: at(1) });
  const view = placementRuntimeSchema.parse(runtime([current], () => null));
  assert.deepEqual([view.displayState, view.since, view.lastOutputAt], ['running', at(1), null]);
});

test('a failed series clears when its resumed Run starts, but not while it is queued', () => {
  const failed = run('R1', { state: 'failed', reason: 'exit', started_at: at(1), ended_at: at(2) });
  const unrelated = run('R2', { state: 'succeeded', started_at: at(2), ended_at: at(3) });
  assert.equal(runtime([failed, unrelated]).displayState, 'attention');
  const unrelatedRunning = run('R2', { state: 'running', started_at: at(3) });
  assert.deepEqual(runtime([failed, unrelatedRunning]).sourceRunIds, ['R1']);
  const queued = run('R3', { resumes: 'R1' });
  assert.equal(runtime([failed, unrelated, queued]).displayState, 'attention');
  const retry = run('R3', { resumes: 'R1', state: 'running', started_at: at(3) });
  assert.deepEqual([runtime([failed, unrelated, retry]).displayState,
    runtime([failed, unrelated, retry]).sourceRunIds], ['running', ['R3']]);
  assert.deepEqual(failureAttentionWindow(failed, retry, placement, task),
    { startAt: at(2), endAt: at(3), ongoing: false });
  const otherPlacement = run('R4', { placementId: 'P2', resumes: 'R1', state: 'succeeded', started_at: at(4), ended_at: at(5) });
  assert.equal(runtime([failed, otherPlacement]).displayState, 'idle');
  const retriedFailure = run('R3', { resumes: 'R1', state: 'failed', reason: 'timeout', started_at: at(3), ended_at: at(4) });
  assert.deepEqual(runtime([failed, unrelated, retriedFailure]).sourceRunIds, ['R3']);
});

test('one shared Run projection gives each placement the same state as a direct projection', () => {
  const placements = [placement, { id: 'P2', endedAt: null }];
  const runs = [
    run('R1', { state: 'failed', reason: 'exit', started_at: at(0), ended_at: at(1) }),
    run('R2', { placementId: 'P2', state: 'running', started_at: at(2) }),
    run('R3', { placementId: 'P2', resumes: 'R1', state: 'succeeded', started_at: at(2), ended_at: at(3) }),
    run('R4', { state: 'running', started_at: at(4) }),
  ];
  const prepared = projectPlacementRuntimes(placements.map(item => ({ ...item, taskId: 'T1' })),
    new Map([['T1', task]]), runs, activity);
  assert.equal(prepared.get('P1')?.displayState, 'running', 'the other placement resolved P1 failure');
  assert.deepEqual(prepared.get('P1')?.sourceRunIds, ['R4']);
  assert.deepEqual(prepared.get('P2')?.sourceRunIds, ['R2']);
  const unavailable = projectPlacementRuntimes(placements.map(item => ({ ...item, taskId: 'T1' })),
    new Map([['T1', task]]), null, activity);
  assert.equal(unavailable.get('P1')?.displayState, 'unknown');
  assert.equal(unavailable.get('P2')?.displayState, 'unknown');
});

test('handover and Task completion clear current attention without a successful resume', () => {
  const failed = run('R1', { state: 'failed', reason: 'conversation_busy', started_at: at(1), ended_at: at(2) });
  const unrelated = run('R2', { placementId: 'P2', state: 'succeeded', started_at: at(4), ended_at: at(5) });
  assert.equal(runtime([failed, unrelated]).displayState, 'attention');
  assert.equal(runtime([failed, unrelated], activity, { id: 'P1', endedAt: at(3) }).displayState, 'idle');
  assert.equal(runtime([failed], activity, placement,
    { state: 'done', stateLog: [...task.stateLog, { at: at(3), toState: 'done' }] }).displayState, 'idle');
  assert.equal(runtime([failed], activity, placement,
    { state: 'stopped', stateLog: [...task.stateLog, { at: at(3), toState: 'stopped' }] }).displayState, 'idle');
  assert.equal(runtime([failed], activity, placement,
    { state: 'doing', stateLog: [...task.stateLog, { at: at(3), toState: 'done' },
      { at: at(4), toState: 'doing' }] }).displayState, 'idle');
});

test('the backend tree passes the recorded Task and placement ends to current attention', () => {
  const failed = run('R1', { state: 'failed', reason: 'conversation_busy', started_at: at(1), ended_at: at(2) });
  const people = { agents: [{ id: 'A1', createdAt: at(0) }],
    placed: [{ id: 'P1', taskId: 'T1', agentId: 'A1', profileKey: 'codex', responsible: true,
      active: true, revision: 1, startedAt: at(0), endedAt: null }], error: null };
  const tasks = [{ id: 'T1', state: 'done', log: [
    { at: at(0), toState: 'doing' }, { at: at(3), toState: 'done' },
  ] }];
  assert.equal(projectPlacements('/synthetic', people.placed, tasks, [failed])[0]?.runtime.displayState, 'idle');
});

test('alerts take precedence over running and stdout activity exposes only kind, tool and time', () => {
  const failed = run('R1', { state: 'needs_review', reason: 'manager_lost', started_at: at(1) });
  const running = run('R2', { state: 'running', started_at: at(2) });
  const view = runtime([failed, running]);
  assert.equal(view.displayState, 'attention');
  assert.equal(view.runningCount, 1);
  assert.deepEqual(view.sourceRunIds, ['R1']);
  assert.deepEqual(runtime([running]).toolName, 'Bash');
});

test('Run DB failure is unknown, not a hollow dot', () => {
  assert.equal(runtime(null).displayState, 'unknown');
  assert.equal(runtime([]).displayState, 'idle');
});
