/**
 * The screen projection's two rules over the records: a Task's ball read through one Task's source is the ball the
 * whole read gives, and a change reaches the Tasks and surfaces the dependency ledger names, and no relation fires when
 * the fact it reads did not move.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChangeKey } from '@alpacawork/db';
import type { ProjectionVersion } from '@alpacawork/contract/control';
import { ballsOf, ballSourceOf } from './helpers/ball-source.ts';
import { seatSourceOf } from '@alpacawork/backend/test-dist/control/wake.js';
import { affected, ballOfTask, deriveTask, recordReads, recordsSource, type RecordedRead } from '@alpacawork/backend/test-dist/receiver/screen-derive.js';
import { taskViewRowSchema } from '@alpacawork/contract/control';
import { IndexPatcher, aggregateResources, raiseRequiredPv } from '@alpacawork/backend/test-dist/receiver/index-rows.js';
import type { Facet, RecordsReader, TaskBundle } from '@alpacawork/backend/test-dist/receiver/projection-contract.js';
import { bundle, entry, placement, project, records, replace, request, returned, run, task, time, type Extras } from './helpers/fake-records.ts';

// P1 is the project. T2, the user's Task, has a responsible (PL2) whose Run R2 sent T3 a Request (Q23); T3's Run R3
// took it and failed T3. T5 is below T3; T4 starts after T3.
const asked = entry('L2-ask', 3, { kind: 'asked', title: 'Which?', askedTo: null, decide: [], actor: { kind: 'placement', placementId: 'PL2' } });
function world(t2Log = [entry('L2-created', 0, { kind: 'created', actor: { kind: 'human' }, toState: 'todo', userRequested: true }),
  entry('L2-started', 1, { fromState: 'todo', toState: 'doing', runId: 'R2' })], t3State: 'error' | 'doing' = 'error'): TaskBundle[] {
  const t3Log = [entry('L3-created', 1, { kind: 'created', toState: 'todo' }), entry('L3-started', 2, { fromState: 'todo', toState: 'doing', runId: 'R3' }),
    ...(t3State === 'error' ? [entry('L3-failed', 4, { fromState: 'doing', toState: 'error', runId: 'R3' })] : [])];
  return [
    bundle(project('P1')),
    bundle(task('T2', { state: 'doing', userRequested: true, log: t2Log }), {
      placements: [placement('PL2', 'T2')], runs: [run('R2', 'T2', 'PL2', { state: 'running', started_at: time(1) })],
      requests: [request('Q2', 'T2', 'PL2', { submittedAt: time(0) })] }),
    bundle(task('T3', { parentId: 'T2', state: t3State, log: t3Log }), {
      placements: [placement('PL3', 'T3')],
      runs: [run('R3', 'T3', 'PL3', { requestId: 'Q23', caller: { run: 'R2' },
        state: t3State === 'error' ? 'failed' : 'running', started_at: time(2), ended_at: t3State === 'error' ? time(4) : null })],
      requests: [request('Q23', 'T3', 'PL3', { author: { kind: 'placement', placementId: 'PL2' }, submittedAt: time(2) })] }),
    bundle(task('T4', { state: 'todo' }), { after: ['T3'] }),
    bundle(task('T5', { parentId: 'T3', state: 'todo' })),
  ];
}
const withT2 = (bundles: TaskBundle[], fields: Parameters<typeof task>[1], parts: Partial<TaskBundle> = {}) =>
  replace(bundles, { ...bundles.find(item => item.task.id === 'T2')!, ...parts,
    task: task('T2', { ...bundles.find(item => item.task.id === 'T2')!.task.meta, ...fields }) });
const withTask = (bundles: TaskBundle[], id: string, fields: Parameters<typeof task>[1], parts: Partial<TaskBundle> = {}) => {
  const held = bundles.find(item => item.task.id === id)!;
  return replace(bundles, { ...held, ...parts, task: { ...task(id, { ...held.task.meta, ...fields }), values: held.task.values } });
};

/** The seat source of the whole read, as the tree made it before: one source over every Task. */
function eagerSeats(bundles: readonly TaskBundle[]) {
  const tasks = bundles.map(item => item.task);
  const seats = seatSourceOf(tasks, { records: bundles.flatMap(item => item.runs), runError: null, agents: [],
    placements: bundles.flatMap(item => item.placements), requests: bundles.flatMap(item => item.requests),
    returns: bundles.flatMap(item => item.returns), waitCycles: [], headRunIds: new Map(), resultStates: new Map(),
    questionClosures: new Map(), uncertainInputs: new Map(), inputClosed: new Set() }, { profiles: new Set(['fake']), automaticLimit: 20 });
  return { tasks, seats };
}
/** The balls of the whole read. */
function eagerBalls(bundles: readonly TaskBundle[]) {
  const { tasks, seats } = eagerSeats(bundles);
  return ballsOf(ballSourceOf(seats, tasks));
}
const oneByOne = (bundles: readonly TaskBundle[], extras?: Extras) => {
  const read = records(bundles, extras);
  return Object.fromEntries(bundles.flatMap(item => {
    const ball = ballOfTask(read, item.task.id);
    return ball ? [[item.task.id, ball]] : [];
  }));
};

test("a Task's ball read through its own records is the ball the whole read gives", () => {
  const failed = world();
  assert.deepEqual(oneByOne(failed), eagerBalls(failed), 'a failed child goes back to the Task that sent its Request');
  // The sender asks the user and no Run of it works: the failure becomes the user's.
  const askedUser = withT2(world([...failed[1]!.task.meta.log, asked]), {},
    { runs: [run('R2', 'T2', 'PL2', { state: 'succeeded', started_at: time(1), ended_at: time(3) })] });
  assert.deepEqual(oneByOne(askedUser), eagerBalls(askedUser), 'while the sender asks the user, the failure is the user\'s');
  assert.notDeepEqual(eagerBalls(askedUser).T3, eagerBalls(failed).T3, 'the sender\'s question moves the failed child\'s ball');
  const working = world(undefined, 'doing');
  assert.deepEqual(oneByOne(working), eagerBalls(working), 'a working child sent to keeps its sender waiting');
});

test('a seat waits only on its open Requests across destinations shared with other senders', () => {
  let bundles = world(undefined, 'doing');
  bundles = withTask(bundles, 'T5', { state: 'doing' }, {
    placements: [placement('PL5', 'T5')], runs: [run('R5', 'T5', 'PL5', { requestId: 'Q5', state: 'running', started_at: time(1) })],
    requests: [request('Q5', 'T5', 'PL5')],
  });
  bundles = withTask(bundles, 'T4', { state: 'doing' }, {
    placements: [placement('PL4', 'T4')],
    runs: [run('R4', 'T4', 'PL4', { requestId: 'Q24', caller: { run: 'R2' }, state: 'running', started_at: time(2) }),
      run('R6', 'T4', 'PL4', { requestId: 'Q54', caller: { run: 'R5' }, state: 'running', started_at: time(2) }),
      run('R7', 'T4', 'PL4', { requestId: 'Qhuman', caller: { run: 'R2' }, state: 'running', started_at: time(2) })],
    requests: [request('Q24', 'T4', 'PL4', { author: { kind: 'placement', placementId: 'PL2' } }),
      request('Q54', 'T4', 'PL4', { author: { kind: 'placement', placementId: 'PL5' } }), request('Qhuman', 'T4', 'PL4')],
  });
  const sender = bundles.find(item => item.task.id === 'T2')!;
  bundles = replace(bundles, { ...sender, returns: [returned('Closed24', 'T2', { requestId: 'Q24', outcome: 'closed' })] });
  const read = records(bundles), source = recordsSource(read);
  assert.deepEqual(read.sentRequests('T2').map(item => item.id).sort(), ['Q23', 'Q24'], 'closed candidates remain subject to the Request rules');
  assert.deepEqual(source.openSent('T2').map(item => item.id), ['Q23']);
  assert.deepEqual(source.openSent('T5').map(item => item.id), ['Q54']);
  assert.deepEqual(oneByOne(bundles), eagerBalls(bundles));
});

test("reading one Task's ball reads only the Tasks its rules ask for", () => {
  const sink: RecordedRead[] = [];
  ballOfTask(recordReads(records(world()), sink, 'records'), 'T3');
  const tasks = new Set(sink.filter(read => read.method === 'bundle').map(read => read.args[0]));
  assert.ok(!tasks.has('T4') && !tasks.has('T5'), `read ${[...tasks].join(', ')}`);
  assert.ok(tasks.has('T3') && tasks.has('T2'), 'the failed Task and the seat its failure goes to');
});

test("a Task's derived row is its own: the ball it reads, its working Run carried live, and its part of the aggregates", () => {
  const derive = deriveTask;
  const read = records(world());
  const t2 = derive(read, 'T2'), t3 = derive(read, 'T3');
  taskViewRowSchema.parse(t2.row);
  assert.deepEqual(t3.ball, ballOfTask(read, 'T3'));
  assert.deepEqual([...t2.live.runs], ['R2'], 'its running Run');
  assert.equal(t2.contribution.running, true);
  assert.equal(t3.contribution.running, false);
  assert.equal(t2.row.projectId, 'P1');
  assert.equal('movedAt' in t2.row || 'rowFacts' in t2.row, false, 'what descendants decide is not its own');
});

const change = (before: TaskBundle[], after: TaskBundle[], owners: string[], keys: ChangeKey[] = owners.map(id => ({ kind: 'task', id })),
  extras?: Extras) => affected({ keys, before: records(before, extras), after: records(after, extras), owners: new Set(owners) });
const facets = (result: ReturnType<typeof affected>, id: string) => [...result.tasks.get(id) ?? []].sort();
const has = (result: ReturnType<typeof affected>, id: string, ...wanted: Facet[]) =>
  assert.ok(wanted.every(facet => result.tasks.get(id)?.has(facet)), `${id} has ${facets(result, id).join(',')}, wanted ${wanted.join(',')}`);
const lacks = (result: ReturnType<typeof affected>, id: string, ...unwanted: Facet[]) =>
  assert.ok(unwanted.every(facet => !result.tasks.get(id)?.has(facet)), `${id} has ${facets(result, id).join(',')}`);

test('a Task that starts after another is made again when what its start order reads of it moved, and only then', () => {
  const before = world(undefined, 'doing');
  has(change(before, withTask(before, 'T3', { state: 'done', baseState: 'done' }), ['T3']), 'T4', 'row', 'view');
  const valuesOnly = withTask(before, 'T3', {});
  valuesOnly.find(item => item.task.id === 'T3')!.task.values = { goal: 'x' } as never;
  assert.equal(change(before, valuesOnly, ['T3']).tasks.has('T4'), false, 'a value of T3 is not in T4\'s start order');
  const finished = withTask(before, 'T4', { state: 'done', baseState: 'done' });
  const closed = change(finished, withTask(finished, 'T3', { title: 'Renamed' }), ['T3']);
  has(closed, 'T4', 'row');
  assert.ok(closed.scopes.page.has('finished:root'), 'the closed page that lists the finished Task');
  assert.ok(closed.scopes.search.has('root') && closed.scopes.timeline.has('root'), 'and every search and timeline listing it');
});

test("a child's closing record reaches the Task waiting on its Request; a failed child's requester reaches the child", () => {
  const working = world(undefined, 'doing');
  has(change(working, world(undefined, 'error'), ['T3']), 'T2', 'row', 'seat', 'push');
  // Whether a Request waits for its closing return reads its delivery state alone.
  const t3 = working.find(item => item.task.id === 'T3')!;
  const unconfirmed = replace(working, { ...t3, requests: [{ ...t3.requests[0]!, deliveryState: 'recorded_unconfirmed' }] });
  has(change(unconfirmed, working, ['T3']), 'T2', 'row', 'seat');
  const failed = world();
  const asking = world([...failed[1]!.task.meta.log, asked]);
  has(change(failed, asking, ['T2']), 'T3', 'row', 'push');
  lacks(change(failed, asking, ['T2']), 'T5', 'row');
});

test('a reset of the automatic limit reaches every seat below the Task it was made on', () => {
  const before = world();
  const reset = request('Q2-reset', 'T2', 'PL2', { submittedAt: time(5) });
  const after = withT2(before, {}, { requests: [...before[1]!.requests, reset] });
  has(change(before, after, ['T2']), 'T5', 'seat');
  const moved = withT2(before, {}, { requests: [{ ...before[1]!.requests[0]!, deliveryState: 'waiting_for_run' }] });
  lacks(change(before, moved, ['T2']), 'T5', 'seat');
});

test("a retitled ancestor reaches the views below it, not their rows; a move re-places the whole subtree", () => {
  const before = world();
  const retitled = change(before, withTask(before, 'T3', { title: 'Renamed' }), ['T3']);
  has(retitled, 'T5', 'view');
  lacks(retitled, 'T5', 'row');
  const moved = change(before, withTask(before, 'T3', { parentId: 'P1' }), ['T3']);
  has(moved, 'T5', 'row', 'membership');
  assert.ok(moved.scopes.timeline.has('T2') && moved.scopes.timeline.has('P1'), 'both the old and the new place');
});

test('settings, files, activity and the coordinator reach what they name, and nothing else', () => {
  const bundles = world();
  const config = change(bundles, bundles, [], [{ kind: 'config', id: '*' }]);
  for (const item of bundles) has(config, item.task.id, 'seat', 'row', 'view', 'history');
  assert.equal(config.meta, true);
  const files = change(bundles, bundles.map(item => item.task.id === 'T5' ? { ...item, files: [] } : item), ['T5'], [{ kind: 'files', id: 'T5' }]);
  has(files, 'T5', 'files', 'view');
  lacks(files, 'T5', 'history');
  assert.equal(files.tasks.has('T3'), false);
  const activity = change(bundles, bundles, [], [{ kind: 'activity', id: 'R2' }]);
  has(activity, 'T2', 'row');
  lacks(activity, 'T2', 'view', 'timeline', 'history', 'seat');
  assert.equal(activity.scopes.timeline.size, 0, 'the timeline carries no activity');
  const coordinator = change(bundles, bundles, [], [{ kind: 'run', id: 'R90' }], { joinedMessages: { R90: ['Q-said'] }, dialogueTasks: { 'Q-said': ['T4'] } });
  has(coordinator, 'T4', 'history');
  assert.deepEqual([...coordinator.tasks.keys()], ['T4']);
});

test('a question closed on its asker reaches the Task its return waits at', () => {
  const ask = entry('L5-ask', 3, { kind: 'asked', title: 'Which?', askedTo: 'T3', decide: [], actor: { kind: 'placement', placementId: 'PL5' } });
  const base = world();
  const before = replace(withTask(base, 'T5', { log: [ask] }),
    { ...base.find(item => item.task.id === 'T3')!, returns: [returned('RET-1', 'T3', { causeLogId: 'L5-ask' })] });
  const answered = withTask(before, 'T5', { log: [ask, entry('L5-withdrawn', 4, { kind: 'question_withdrawn', questionId: 'L5-ask' } as never)] });
  has(change(before, answered, ['T5']), 'T3', 'seat', 'row');
});

test('the versions an applied batch raises are those of the resources it changed, sent once', () => {
  const required = { view: {}, history: {}, page: {}, timeline: {}, search: {} };
  const pv = 3 as ProjectionVersion;
  const raised = raiseRequiredPv(required, { tasks: new Map([['T2', new Set<Facet>(['view'])], ['T3', new Set<Facet>(['history', 'row'])]]),
    scopes: { page: new Set(['finished:root']), search: new Set(), timeline: new Set(['root']) }, meta: false }, pv);
  assert.deepEqual(raised.next, { view: { T2: 3 }, history: { T3: 3 }, page: { 'finished:root': 3 }, timeline: { root: 3 }, search: {} });
  const again = raiseRequiredPv(raised.next, { tasks: new Map([['T2', new Set<Facet>(['view'])]]),
    scopes: { page: new Set(), search: new Set(), timeline: new Set() }, meta: false }, pv);
  assert.deepEqual(again.patch.view.upsert, {}, 'a version already sent is not sent again');
  // A child's count or a moved order changes a closed page and the searches that list the Task, without any facet.
  const fromAggregate = raiseRequiredPv(raised.next, { tasks: new Map(), scopes: { page: new Set(), search: new Set(), timeline: new Set() }, meta: false },
    4 as ProjectionVersion, aggregateResources({ tasks: new Set(['T2']), pages: new Set(['finished:T2']), counts: false }, () => ['root', 'P1']));
  assert.deepEqual(fromAggregate.patch.page.upsert, { 'finished:T2': 4 });
  assert.deepEqual(fromAggregate.patch.search.upsert, { root: 4, P1: 4 });
});

test('a patch carries what changed among the candidates, the Tasks it no longer lists, and nothing when nothing changed', () => {
  const patcher = new IndexPatcher();
  const rows = new Map<string, object>([['T2', { id: 'T2', title: 'a' }], ['T3', { id: 'T3', title: 'b' }]]);
  const none = { view: { upsert: {}, remove: [] }, history: { upsert: {}, remove: [] }, page: { upsert: {}, remove: [] },
    timeline: { upsert: {}, remove: [] }, search: { upsert: {}, remove: [] } };
  const source = (candidates: string[]) => ({ rev: 1, generation: 'g', pv: 1 as ProjectionVersion, candidates,
    row: (id: string) => rows.get(id) as never, placements: () => [], runs: () => [], home: () => undefined, children: () => undefined,
    counts: null, requiredPv: none, meta: { root: '/workspace' } as never });
  assert.deepEqual(patcher.patch(source(['T2', 'T3']))!.tasks.upsert.map(row => row.id), ['T2', 'T3']);
  assert.equal(patcher.patch(source(['T2', 'T3'])), null);
  rows.set('T2', { id: 'T2', title: 'c' });
  rows.delete('T3');
  const next = patcher.patch(source(['T2', 'T3']))!;
  assert.deepEqual(next.tasks.upsert.map(row => row.id), ['T2']);
  assert.deepEqual(next.tasks.remove, ['T3']);
  assert.deepEqual(next.meta, {}, 'the small fields went once');
});

// The records reader the tests build stands for the real one; keep the type honest.
const _reader: RecordsReader = records([]);
void _reader;

test("a parent's History is made again when its child's question closes, the child moves, or the child is retitled", () => {
  const ask = entry('L5-ask', 3, { kind: 'asked', title: 'Which?', askedTo: null, decide: [], actor: { kind: 'placement', placementId: 'PL5' } });
  const before = withTask(world(), 'T5', { log: [ask] });
  const withdrawn = withTask(before, 'T5', { log: [ask, entry('L5-withdrawn', 4, { kind: 'question_withdrawn', questionId: 'L5-ask' } as never)] });
  has(change(before, withdrawn, ['T5']), 'T3', 'history');
  const moved = change(before, withTask(before, 'T5', { parentId: 'T2' }), ['T5']);
  has(moved, 'T3', 'history');
  has(moved, 'T2', 'history');
  has(change(before, withTask(before, 'T5', { title: 'Renamed' }), ['T5']), 'T3', 'history');
});

test("a Task's ball read through its own records is the whole read's at the automatic limit, its resets and a question's return", () => {
  // T3 is idle with a return waiting; T2's responsible sent it as many Requests as one placement takes.
  const base = world(undefined, 'doing');
  const t3 = base.find(item => item.task.id === 'T3')!;
  const sent = Array.from({ length: 20 }, (_, at) => request(`Q-auto-${at}`, 'T3', 'PL3',
    { author: { kind: 'placement', placementId: 'PL2' }, submittedAt: time(3) }));
  const carried = sent.map((item, at) => run(`R${100 + at}`, 'T3', 'PL3', { requestId: item.id, caller: { run: 'R2' },
    state: 'succeeded', started_at: time(3), ended_at: time(3) }));
  const idle = replace(base, { ...t3, runs: [run('R3', 'T3', 'PL3', { requestId: 'Q23', caller: { run: 'R2' }, state: 'succeeded', started_at: time(2), ended_at: time(3) }), ...carried],
    requests: [...t3.requests, ...sent], returns: [returned('RET-u', 'T3', { outcome: 'urgent', causeLogId: 'L5-x', createdAt: time(5) })] });
  const limited = eagerBalls(idle);
  assert.equal((limited.T3 as { reason?: string } | undefined)?.reason, 'limit', 'the limit is reached');
  assert.deepEqual(oneByOne(idle), limited);
  const t2 = idle.find(item => item.task.id === 'T2')!;
  const parentReset = replace(idle, { ...t2, requests: [...t2.requests, request('Q2-reset', 'T2', 'PL2', { submittedAt: time(4) })] });
  assert.deepEqual(oneByOne(parentReset), eagerBalls(parentReset), 'a reset on the parent');
  const t3Limited = idle.find(item => item.task.id === 'T3')!;
  const selfReset = replace(idle, { ...t3Limited, requests: [...t3Limited.requests, request('Q3-reset', 'T3', 'PL3', { submittedAt: time(4) })] });
  assert.deepEqual(oneByOne(selfReset), eagerBalls(selfReset), 'a reset on the Task itself');

  const ask = entry('L5-ask', 3, { kind: 'asked', title: 'Which?', askedTo: 'T3', decide: [], actor: { kind: 'placement', placementId: 'PL5' } });
  const asking = replace(withTask(idle, 'T5', { log: [ask] }),
    { ...t3Limited, requests: t3.requests, returns: [returned('RET-q', 'T3', { causeLogId: 'L5-ask' })] });
  assert.deepEqual(oneByOne(asking), eagerBalls(asking), 'an open question waits at its destination');
  const closed = withTask(asking, 'T5', { log: [ask, entry('L5-withdrawn', 4, { kind: 'question_withdrawn', questionId: 'L5-ask' } as never)] });
  assert.deepEqual(oneByOne(closed), eagerBalls(closed), 'a withdrawn question no longer does');
  const waiting = (bundles: TaskBundle[]) => ({ one: recordsSource(records(bundles)).returnsTo('T3').map(row => row.id),
    whole: eagerSeats(bundles).seats.returnsTo('T3').map(row => row.id) });
  assert.deepEqual(waiting(asking), { one: ['RET-q'], whole: ['RET-q'] }, 'the open question\'s return waits at its destination');
  assert.deepEqual(waiting(closed), { one: [], whole: [] }, 'the withdrawn one does not');
});

test("a Task's own row moving is what raises the pages, searches and timelines that list it, and nothing else", () => {
  const base = withTask(world(), 'T4', { state: 'done', baseState: 'done' });
  // A value of the finished T4: its row's body mark moves, so every scope that lists T4 changes.
  const valued = withTask(base, 'T4', {});
  valued.find(item => item.task.id === 'T4')!.task.values = { goal: 'x' } as never;
  const values = change(base, valued, ['T4']);
  assert.ok(values.scopes.page.has('finished:root') && values.scopes.search.has('root') && values.scopes.timeline.has('root'));
  // A start order T4 waits on: its row carries it.
  const after = replace(base, { ...base.find(item => item.task.id === 'T4')!, after: ['T2'] });
  assert.ok(change(base, after, ['T4']).scopes.page.has('finished:root'), 'a dependency added');
  // Activity alone moves no row a scope returns.
  const activity = change(base, base, [], [{ kind: 'activity', id: 'R2' }]);
  assert.deepEqual([...activity.scopes.page, ...activity.scopes.search, ...activity.scopes.timeline], []);
});
