import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyCursor, compareHistoryEvents } from '@alpacawork/contract';
import { taskHistoryWindowSchema, taskProjectedViewSchema, type TaskHistoryWindowDTO } from '@alpacawork/contract/control';
import { Problem } from '@alpacawork/core';
import { historyWindow, ProjectedHistory, projectedView } from '@alpacawork/backend/test-dist/receiver/task-reads.js';
import { recordedRun } from '@alpacawork/backend/test-dist/receiver/projected-records.js';
import { historyWindowInput } from '@alpacawork/backend/test-dist/receiver/task-read-inputs.js';
import { screenTree } from '@alpacawork/backend/test-dist/receiver/entries.js';
import { collectHttpRoutes } from '@alpacakit/channels/http';
import { at, bundle, entry, FakeRecords, frame, pv } from './helpers/projection-read-fixture.ts';
import { record } from './runs-fixtures.ts';
import type { TaskBundle } from '../apps/backend/src/receiver/projection-contract.js';

const event = (n: number, id = `L${n}`) => ({ id, kind: 'comment' as const, taskId: 'T1', fromChild: false,
  at: at(n), state: null, by: 'human' as const, title: id, summary: '' });

test('History windows protect a cursor through new arrivals, shrink by keep, refuse overflow, and reopen at 80', () => {
  const events = Array.from({ length: 641 }, (_, n) => event(n + 1)).sort(compareHistoryEvents);
  const oldest = historyCursor(event(1));
  const protectedWindow = historyWindow(events, { mode: 'protect', since: oldest, protect: oldest });
  assert.equal(protectedWindow.events.length, 641);
  assert.equal(protectedWindow.events.at(-1)!.id, 'L1');
  assert.equal(protectedWindow.events[0]!.id, 'L641');
  const kept = historyWindow(events, { mode: 'since', since: oldest, keep: 640 });
  assert.equal(kept.oldestKey, historyCursor(event(2)));
  assert.equal(kept.hasOlder, true);
  const latest = historyWindow(events, { mode: 'latest' });
  assert.equal(latest.events.length, 80);
  assert.equal(latest.oldestKey, historyCursor(event(562)));
  const older = historyWindow(events, { mode: 'older', before: latest.oldestKey!, limit: 80 });
  assert.equal(older.events.length, 80);
  assert.equal(older.events[0]!.id, 'L561');
  assert.equal(older.oldestKey, historyCursor(event(482)));
  // A deleted boundary still names a position, and equal timestamps use the cursor's code-unit ID order.
  const tied = [event(1, 'La'), event(1, 'LA'), event(1, 'LZ')].sort(compareHistoryEvents);
  assert.deepEqual(historyWindow(tied, { mode: 'since', since: historyCursor(event(1, 'LY')), keep: 80 }).events.map(item => item.id), ['La', 'LZ']);
  assert.deepEqual(historyWindow(tied, { mode: 'older', before: historyCursor(event(1, 'LZ')), limit: 80 }).events.map(item => item.id), ['LA']);
  const many = Array.from({ length: 2001 }, (_, n) => event(n + 1)).sort(compareHistoryEvents);
  assert.equal(historyWindow(many.slice(1), { mode: 'protect', since: oldest, protect: oldest }).events.length, 2000);
  assert.throws(() => historyWindow(many, { mode: 'protect', since: oldest, protect: oldest }),
    (error: unknown) => error instanceof Problem && error.reason?.kind === 'history_window_too_large' && error.reason.limit === 2000);
  assert.equal(historyWindow(many, { mode: 'latest' }).events.length, 80);
  assert.throws(() => historyWindow(events, { mode: 'since', since: oldest, keep: 2001 }));
  assert.deepEqual(historyWindow([event(1)], { mode: 'since', since: historyCursor(event(2)), keep: 80 }),
    { events: [], oldestKey: null, hasOlder: true });
  assert.deepEqual(historyWindow([], { mode: 'latest' }), { events: [], oldestKey: null, hasOlder: false });
});

test('a protected position inside the default window keeps the window at its default size', () => {
  const events = Array.from({ length: 5 }, (_, n) => event(n + 1)).sort(compareHistoryEvents);
  const window = historyWindow(events, { mode: 'protect', since: historyCursor(event(1)), protect: historyCursor(event(4)) });
  assert.deepEqual(window.events.map(item => item.id), ['L5', 'L4', 'L3', 'L2', 'L1']);
  assert.equal(window.hasOlder, false);
});

test('History queries accept exactly one of the four window operations and bound older/keep requests', () => {
  const key = historyCursor(event(1));
  const parse = (query: object) => historyWindowInput.parse({ task: 'T1', ...query }).window;
  assert.deepEqual(parse({ mode: 'latest' }), { mode: 'latest' });
  assert.deepEqual(parse({ mode: 'since', since: key, keep: '80' }), { mode: 'since', since: key, keep: 80 });
  assert.deepEqual(parse({ mode: 'protect', since: key, protect: key }), { mode: 'protect', since: key, protect: key });
  assert.deepEqual(parse({ mode: 'older', before: key }), { mode: 'older', before: key, limit: 80 });
  for (const query of [{}, { mode: 'since', since: key }, { mode: 'since', since: key, keep: '80', protect: key },
    { mode: 'older', before: key, since: key, keep: '80' }, { mode: 'older', before: key, limit: '81' },
    { mode: 'latest', keep: '80' }, { mode: 'since', since: key, keep: '2001' }, { mode: 'latest', after: at(1) }])
    assert.throws(() => parse(query));
});

test('view reads only its own row and ancestor headings, without descendant aggregates or ancestor list rows', () => {
  const records = new FakeRecords([bundle('P1'), bundle('T1'), bundle('T2', 'T1',
    [entry('Lreview', 1, { fromState: 'doing', toState: 'waiting', title: 'Review the result', description: 'Ready for review' })],
    { baseState: 'waiting' })]);
  const point = frame(records);
  const actual = projectedView({ ...point, derived: id => { assert.equal(id, 'T2'); return point.derived(id); },
    aggregate: new Proxy(point.aggregate, { get() { throw new Error('View must not read aggregates'); } }) }, 'T2');
  taskProjectedViewSchema.parse(actual);
  assert.deepEqual(actual.ancestors.map(item => [item.id, Object.keys(item).sort()]),
    ['P1', 'T1'].map(id => [id, ['id', 'kind', 'lifecycle', 'parentId', 'title']]));
  for (const key of ['movedAt', 'usageBelow', 'runsBelow', 'rowFacts', 'childCounts']) assert.equal(key in actual.row, false, key);
  assert.equal('homeSection' in actual, false);
  assert.equal(actual.sourcePv, records.pv);
  assert.equal(actual.generation, 'g');
  assert.equal(actual.userReviews?.[0]?.id, 'Lreview');
  assert.equal(actual.userReviews?.[0]?.summary, 'Ready for review');
});

test('activity-file changes leave the opened view unchanged while durable execution status remains available', () => {
  const project = bundle('P1'), own = bundle('T1');
  const raw = record('R10', { task: 'T1', placementId: 'placed', state: 'running', started_at: at(1) });
  const records = new FakeRecords([project, { ...own, runs: [raw] }]);
  const point = frame(records), base = point.derived('T1')!;
  const placement = { id: 'placed', taskId: 'T1', agentId: 'agent', profileKey: 'codex', active: true, responsible: true,
    revision: 1, startedAt: at(0), endedAt: null, headRunId: 'R10', previousValues: null,
    runtime: { displayState: 'running' as const, reason: null, sourceRunIds: ['R10'], runningCount: 1, queuedCount: 0,
      since: at(1), lastOutputAt: at(2), activityKind: 'tool_start' as const, toolName: 'Read' } };
  const run = { ...recordedRun(raw), activity: { at: at(2), kind: 'tool_start' as const, toolName: 'Read', doing: null, note: null, steps: [] },
    errorCause: 'weekly_limit' as const };
  const first = taskProjectedViewSchema.parse(projectedView({ ...point,
    derived: () => ({ ...base, placements: [placement], runs: [run] }) }, 'T1'));
  const second = taskProjectedViewSchema.parse(projectedView({ ...point, pv: pv(2),
    derived: () => ({ ...base, placements: [{ ...placement, runtime: { ...placement.runtime, lastOutputAt: at(3), toolName: 'Write' } }],
      runs: [{ ...run, activity: { ...run.activity, at: at(3), toolName: 'Write' }, errorCause: 'model_capacity' }] }) }, 'T1'));
  assert.deepEqual(second, { ...first, sourcePv: pv(2) });
  assert.equal(first.placements[0]!.runtime.runningCount, 1);
  assert.equal(first.placements[0]!.runtime.since, at(1));
  for (const key of ['lastOutputAt', 'activityKind', 'toolName']) assert.equal(key in first.placements[0]!.runtime, false);
  for (const key of ['activity', 'errorCause']) assert.equal(key in first.runs[0]!, false);
});

test('History merges only a changed child source and refreshes existing events and finished Task names', () => {
  const project = bundle('P1'), parent = bundle('T1', 'P1', [entry('Lp', 1)]);
  const child = bundle('T2', 'T1', [entry('Lc', 2, { kind: 'reported', toState: 'done' })]);
  const sibling = bundle('T3', 'T1', [entry('Ls', 3, { kind: 'reported', toState: 'done' })]);
  const grandchild = bundle('T4', 'T2', [entry('Lg', 4, { kind: 'reported', toState: 'done' })]);
  const reads = new ProjectedHistory();
  const first = frame(new FakeRecords([project, parent, child, sibling, grandchild]));
  const events = reads.events(first, 'T1');
  const kept = new Map<string, TaskHistoryWindowDTO['events'][number]>(events.map(event => [event.id, event] as const));
  assert.deepEqual(events.map(event => event.id), ['Ls', 'Lc', 'Lp']);
  const changed = { ...child, task: { ...child.task, meta: { ...child.task.meta, title: 'Finished child',
    log: [entry('Lc', 2, { kind: 'reported', toState: 'done', description: 'Edited' }), entry('Lnew', 5, { kind: 'reported', toState: 'done' })] } } };
  const second = frame(new FakeRecords([project, parent, changed, sibling, grandchild], pv(2)));
  const updated = reads.events(second, 'T1');
  assert.equal(updated.find(event => event.id === 'Lp'), kept.get('Lp'));
  assert.equal(updated.find(event => event.id === 'Ls'), kept.get('Ls'));
  assert.equal(updated.find(event => event.id === 'Lc')?.summary, 'Edited');
  assert.deepEqual(updated.map(event => event.id), ['Lnew', 'Ls', 'Lc', 'Lp']);
  const window = taskHistoryWindowSchema.parse(reads.read(second, 'T1', { mode: 'since', since: historyCursor(kept.get('Lp')!), keep: 80 }));
  assert.equal(window.tasks?.T2?.title, 'Finished child');
  assert.equal(window.sourcePv, 2);
});

test('member results and joined Requests take their receiving Run, role, and result head from the records', () => {
  const own = bundle('T1');
  const placed = { id: 'member', taskId: 'T1', agentId: 'agent', profileKey: 'codex', responsible: false,
    active: true, revision: 1, startedAt: at(1), endedAt: null };
  const request = (id: string, n: number, runId: string) => ({ id, taskId: 'T1', placementId: placed.id, placementRevision: 1, taskHash: '1'.repeat(64),
    waitCycleId: null, headRunId: null, aboutRunId: null, mode: 'continue' as const, purpose: 'instruction' as const,
    body: `Request ${id}`, author: { kind: 'human' as const }, submittedAt: at(n), deliveryState: 'queued' as const, runId });
  const joined = record('R1', { task: 'T1', placementId: placed.id, requestId: 'q1', role: 'worker', state: 'joined', into: 'R2', ended_at: at(3) });
  const ended = { ...record('R2', { task: 'T1', placementId: placed.id, requestId: 'q2', role: 'worker', state: 'succeeded', ended_at: at(4) }), resultHead: 'The result\nMore detail' };
  const data: TaskBundle = { ...own, placements: [placed], runs: [joined, ended], requests: [request('q1', 1, 'R1'), request('q2', 2, 'R2')] };
  const records = new FakeRecords([bundle('P1'), data]);
  const reads = new ProjectedHistory();
  const window = reads.read(frame(records), 'T1');
  assert.equal(window.events.find(event => event.id === 'q1')?.result, undefined);
  assert.deepEqual(window.events.find(event => event.id === 'q2')?.result, { runId: 'R2', at: at(4), head: 'The result\nMore detail' });
  assert.equal(window.events.find(event => event.id === 'q2')?.recipient?.role, 'member');
  const updatedRun = { ...ended, resultHead: 'Updated result' };
  const next = new FakeRecords([bundle('P1'), { ...data, runs: [joined, updatedRun] }], pv(2));
  const refreshed = reads.read(frame(next), 'T1', { mode: 'since', since: window.oldestKey!, keep: 80 });
  assert.deepEqual(refreshed.events.map(event => event.id), window.events.map(event => event.id));
  assert.equal(refreshed.events.find(event => event.id === 'q2')?.result?.head, 'Updated result');
});

test('task read entries await the supplied published frame and answer with the new DTOs without a database', async () => {
  const routes = new Map<string, { handler: (input: object, context: object) => unknown; parse: (query: Record<string, string[]>) => object }>();
  collectHttpRoutes(screenTree).forEach(route => routes.set(route.path, {
    handler: route.handler as (input: object, context: object) => unknown, parse: query => route.input.parseQuery(query) as object }));
  const invoke = (name: string, input: object, readFrame: () => unknown) => {
    const route = routes.get(`/task/${name}`)!;
    return route.handler(route.parse(Object.fromEntries(Object.entries(input).map(([name, value]) => [name, [String(value)]]))), { readFrame });
  };
  const records = new FakeRecords([bundle('P1'), bundle('T1', 'P1', [entry('L1', 1)])]);
  let publish!: (value: unknown) => void;
  const waiting = new Promise(resolve => { publish = resolve; });
  let settled = false;
  const response = Promise.resolve(invoke('view', { address: 'tasks/T1' }, () => waiting)).then(value => { settled = true; return value; });
  await Promise.resolve();
  assert.equal(settled, false);
  publish(frame(records));
  assert.equal(taskProjectedViewSchema.parse(await response).task.id, 'T1');
  assert.throws(() => invoke('view', { task: 'T0' }, () => { throw new Error('Must validate first'); }), (error: unknown) => error instanceof Problem && error.code === 'invalid_input');
  assert.equal(taskHistoryWindowSchema.parse(await invoke('history', { task: 'T1', mode: 'latest' }, () => frame(records))).events[0]!.id, 'L1');
  const archived = bundle('P2', 'P1', [], { lifecycle: 'archived' });
  const shelved = frame(new FakeRecords([bundle('P1'), archived, bundle('T2', 'P2')]));
  for (const name of ['view', 'history']) await assert.rejects(
    Promise.resolve(invoke(name, { task: 'T2', ...(name === 'history' ? { mode: 'latest' } : {}) }, () => shelved)),
    (error: unknown) => error instanceof Problem && error.reason?.kind === 'task_archived');
  await assert.rejects(Promise.resolve(invoke('view', { address: 'wrong/T1' }, () => frame(records))), /Task does not exist/);
});


test('History keeps only current owners responsible and bounds cached Task orders', () => {
  const own = bundle('T1', 'P1', [entry('L1', 1)]);
  const placement = { id: 'old', taskId: 'T1', agentId: 'agent', profileKey: 'codex', responsible: true,
    active: false, revision: 1, startedAt: at(0), endedAt: at(2) };
  const data = { ...own, placements: [placement, { ...placement, id: 'current', active: true, endedAt: null }] };
  const others = Array.from({ length: 64 }, (_, n) => bundle(`T${n + 2}`, 'P1', [entry(`L${n + 2}`, 1)]));
  const point = frame(new FakeRecords([bundle('P1'), data, ...others]));
  const reads = new ProjectedHistory();
  const first = reads.events(point, 'T1');
  const crew = reads.read(point, 'T1').tasks?.T1?.crew;
  assert.deepEqual(crew?.placements.map(item => [item.id, item.responsible]), [['old', false], ['current', true]]);
  for (const other of others) reads.events(point, other.task.id);
  assert.notEqual(reads.events(point, 'T1'), first, 'evicted Tasks are reconstructed from the published frame');
  assert.deepEqual(reads.events(point, 'T1'), first);
});
