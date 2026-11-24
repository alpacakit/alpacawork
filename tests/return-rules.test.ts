/** Pure return rules: a Request's seat, a Task's requester, when a Request closed and what a seat still waits on. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Problem } from '@alpacawork/core';
import type { RunRecord } from '@alpacawork/contract/run';
import type { TaskLog } from '@alpacawork/raw';
import { record, ended, time } from './runs-fixtures.ts';
import { closureOf, cycleClosed, openRequests, openRequestsBySeat, requesterOf, requesterSeat, returnFacts, returnIdOf,
  urgentTarget, type RequestFacts, type TaskFacts } from '@alpacawork/backend/test-dist/control/return-rules.js';

const at = (minutes: number) => new Date(Date.parse(time) + minutes * 60_000).toISOString();
const task = (id: string, fields: Partial<TaskFacts> = {}): TaskFacts => ({ id, kind: 'task', parentId: 'P1',
  lifecycle: 'active', userRequested: false, log: [], responsible: true, ...fields });
const request = (id: string, taskId: string, source: 'human' | 'main' | 'placement' | 'review' | 'returns' = 'placement',
  fields: Partial<RequestFacts> = {}): RequestFacts => ({ id, taskId, purpose: source === 'returns' ? 'return_continuation' : source === 'review' ? 'review_send_back' : 'instruction', author: source === 'placement' || source === 'returns' ? { kind: 'placement', placementId: 'P2' } : { kind: 'human' }, submittedAt: time, deliveryState: 'queued', ...fields });
const log = (id: string, minutes: number, fields: Partial<TaskLog> = {}): TaskLog => ({ id, kind: 'reported',
  at: at(minutes), title: null, description: null, actor: { kind: 'placement', placementId: 'P2' },
  fromState: null, toState: null, ...fields });
const ids = (requests: readonly RequestFacts[]) => requests.map(item => item.id);

// P1 is the project and T2 its top Task, whose owner Run R2 asked the child T3 (R3) and placed a worker (R4).
const project = task('P1', { kind: 'project', parentId: null, responsible: false });
const seatRun = ended('R2', { task: 'T2', requestId: 'top' });
const childRun = (fields: Partial<RunRecord> = {}) =>
  record('R3', { task: 'T3', requestId: 'ask', caller: { run: 'R2' }, ...fields });
const workerRun = (fields: Partial<RunRecord> = {}) =>
  record('R4', { task: 'T2', role: 'worker', requestId: 'work', caller: { run: 'R2' }, ...fields });

test('ordinary history does not add timestamp comparisons to a child Request closure', t => {
  const entries = Array.from({ length: 2048 }, (_, i) => log(`Lnote${i}`, i));
  const finish = log('Lfinish', 2049, { toState: 'done' });
  const ask = request('ask', 'T3');
  const facts = returnFacts([task('T3', { log: [...entries, finish] })], [childRun({ state: 'running', started_at: time })]);
  const parse = t.mock.method(Date, 'parse');
  assert.deepEqual(closureOf(ask, facts), { outcome: 'succeeded', runId: null, causeLogId: 'Lfinish' });
  assert.equal(parse.mock.callCount(), 3, 'the admission, receipt and closing candidate are the only time comparisons');
});

test('a Request comes from the user unless a placement sent it, and a continuation has no requester', () => {
  const caller = ended('R1', { task: 'T1' });
  const child = ended('R2', { task: 'T2', requestId: 'review', caller: { run: caller.id } });
  const facts = returnFacts([], [caller, child, ended('R3', { task: 'T2', requestId: 'agent', caller: { run: caller.id } })]);
  assert.equal(requesterSeat(request('person', 'T2', 'human'), facts), null);
  assert.equal(requesterSeat(request('main', 'T2', 'main'), facts), null);
  assert.equal(requesterSeat(request('review', 'T2', 'review'), facts), null,
    'a send-back is the user\'s proxy\'s, even when the Run that carried it has a caller');
  assert.equal(requesterSeat(request('agent', 'T2'), facts), 'T1');
  assert.throws(() => requesterSeat(request('wake', 'T1', 'returns'), facts), /no requester seat/);
  assert.throws(() => requesterSeat(request('lost', 'T2'), facts), /no caller seat/);
});

test('a worker Request closes when its actual Run ends, including a stopped started Run', () => {
  const closure = (...runs: RunRecord[]) => closureOf(request('work', 'T2'), returnFacts([], [seatRun, ...runs]));
  assert.deepEqual(closure(workerRun({ state: 'succeeded', ended_at: time })),
    { outcome: 'succeeded', runId: 'R4', causeLogId: null });
  assert.equal(closure(workerRun({ state: 'failed', reason: 'output', ended_at: time }))?.outcome, 'failed');
  assert.equal(closure(workerRun({ state: 'cancelled', reason: 'stopped', ended_at: time }))?.outcome, 'stopped');
  assert.equal(closure(workerRun({ state: 'succeeded', stop_requested: true, ended_at: time }))?.outcome, 'stopped');
  assert.equal(closure(workerRun({ state: 'needs_review', reason: 'conversation_busy' }))?.outcome, 'needs_review');
  assert.equal(closure(workerRun({ state: 'needs_review', reason: null })), null, 'an execution fault is provisional');
  assert.equal(closure(workerRun({ state: 'running', started_at: time })), null);
  assert.equal(closure(workerRun({ state: 'running', started_at: time, stop_requested: true })), null,
    'a stop closes the Request when the Run ends');
  const joined = workerRun({ state: 'joined', into: 'R5', ended_at: time });
  const into = (fields: Partial<RunRecord>) => record('R5', { task: 'T2', role: 'worker', requestId: 'earlier', ...fields });
  assert.equal(closure(joined, into({ state: 'running', started_at: time })), null);
  assert.deepEqual(closure(joined, into({ state: 'failed', reason: 'exit', ended_at: time })),
    { outcome: 'failed', runId: 'R5', causeLogId: null });
});

test('a child Request closes at the first finish its Task records after the Request came', () => {
  const ask = request('ask', 'T3', 'placement', { submittedAt: at(10) });
  const facts = (child: TaskFacts) => returnFacts([project, task('T2'), child], [seatRun, childRun({ state: 'running', started_at: at(10) })]);
  const close = (...entries: TaskLog[]) => closureOf(ask, facts(task('T3', { parentId: 'T2', log: entries })));
  assert.equal(close(log('Lbefore', 5, { toState: 'done' }),
    log('Llate', 20, { kind: 'linked', toState: 'error', causeAt: at(5) })), null, 'what happened before it came');
  assert.deepEqual(close(log('Ldone', 20, { toState: 'done' })), { outcome: 'succeeded', runId: null, causeLogId: 'Ldone' });
  assert.deepEqual(close(log('Lapproved', 20, { kind: 'review_approved', actor: { kind: 'human' },
    fromState: 'waiting', toState: 'done' })), { outcome: 'succeeded', runId: null, causeLogId: 'Lapproved' });
  assert.equal(close(log('Lstopped', 20, { toState: 'stopped' }))?.outcome, 'stopped');
  assert.equal(close(log('Lfailed', 20, { kind: 'linked', toState: 'error', causeAt: at(15) }))?.outcome, 'failed');
  assert.deepEqual(close(log('Lmoved', 20, { kind: 'moved', actor: { kind: 'human' }, formerAncestors: ['T2'] })),
    { outcome: 'moved', runId: null, causeLogId: 'Lmoved' });
  assert.equal(close(log('Lasked', 20, { kind: 'asked', askedTo: 'T2', title: 'Which one?', description: 'Pick one', decide: [{ decide_question: 'Which one?' }] }),
    log('Lreview', 25, { toState: 'waiting' }),
    log('Lheld', 30, { actor: { kind: 'human' }, toState: 'held' })), null, 'a question, a review wait and a hold');
  assert.equal(close(log('Lfailed', 20, { toState: 'error' }), log('Ldone', 30, { toState: 'done' }))?.outcome, 'failed');
  assert.deepEqual(closureOf(ask, facts(task('T3', { parentId: 'T2', lifecycle: 'archived' }))),
    { outcome: 'closed', runId: null, causeLogId: null });
  assert.equal(closureOf(ask, facts(task('T3', { parentId: 'T2', lifecycle: 'deleted' })))?.outcome, 'closed');
  assert.equal(closureOf(ask, facts(task('T3', { parentId: 'T2', responsible: false })))?.outcome, 'closed');
  assert.equal(closureOf(ask, returnFacts([project, task('T2')], [seatRun, childRun()]))?.outcome, 'closed');
});

test('a seat waits on the Requests it sent until each closes', () => {
  const requests = [request('top', 'T2', 'human'), request('work', 'T2'), request('ask', 'T3'),
    request('person', 'T3', 'human'), request('wake', 'T2', 'returns'),
    request('aborted', 'T3', 'placement', { deliveryState: 'aborted' }),
    request('unconfirmed', 'T3', 'placement', { deliveryState: 'recorded_unconfirmed' })];
  const later = [record('R5', { task: 'T3', requestId: 'person' }), record('R6', { task: 'T2', requestId: 'wake' }),
    record('R7', { task: 'T3', requestId: 'aborted', caller: { run: 'R2' }, state: 'cancelled', reason: 'stopped', ended_at: time }),
    record('R8', { task: 'T3', requestId: 'unconfirmed', caller: { run: 'R2' } })];
  const tasks = [project, task('T2'), task('T3', { parentId: 'T2' })];
  const working = [seatRun, workerRun({ state: 'running', started_at: time }), childRun({ state: 'running', started_at: time }), ...later];
  assert.deepEqual(ids(openRequests('T2', requests, returnFacts(tasks, working))), ['work', 'ask']);
  assert.deepEqual(ids(openRequests('T3', requests, returnFacts(tasks, working))), []);
  const bySeat = openRequestsBySeat(requests, returnFacts(tasks, working));
  assert.deepEqual([...bySeat.keys()], ['T2'], 'every seat at once, judged as openRequests judges each');
  assert.deepEqual(ids(bySeat.get('T2') ?? []), ['work', 'ask']);
  const workerDone = [seatRun, workerRun({ state: 'succeeded', ended_at: time }), childRun({ state: 'running', started_at: time }), ...later];
  assert.deepEqual(ids(openRequests('T2', requests, returnFacts(tasks, workerDone))), ['ask']);
  const childDone = [project, task('T2'), task('T3', { parentId: 'T2', log: [log('Ldone', 5, { toState: 'done' })] })];
  assert.deepEqual(ids(openRequests('T2', requests, returnFacts(childDone, workerDone))), []);
});

test('a wait cycle closes when every Request in it closed, an aborted one aside', () => {
  const tasks = [project, task('T2'), task('T3', { parentId: 'T2' })];
  const facts = returnFacts(tasks, [seatRun, childRun({ state: 'running', started_at: time }),
    workerRun({ state: 'succeeded', ended_at: time }),
    record('R7', { task: 'T3', requestId: 'aborted', caller: { run: 'R2' }, state: 'cancelled', reason: 'stopped', ended_at: time })]);
  const cycle = [request('work', 'T2'), request('aborted', 'T3', 'placement', { deliveryState: 'aborted' })];
  assert.equal(cycleClosed(cycle, facts), true);
  assert.equal(cycleClosed([...cycle, request('ask', 'T3')], facts), false);
});

test('the requester is the user for the user\'s Task or open Request, else the open Request\'s seat, else the parent', () => {
  const facts = (child: Partial<TaskFacts>, ...more: RunRecord[]) => returnFacts([project, task('T2'), task('T4'),
    task('T3', { parentId: 'T2', ...child }), task('T5', { parentId: 'T9' })], [seatRun, childRun(), ...more]);
  const ask = request('ask', 'T3');
  assert.equal(requesterOf('T3', [ask], facts({})), 'T2');
  assert.equal(requesterOf('T3', [ask], facts({ userRequested: true })), null);
  const personRun = record('R5', { task: 'T3', requestId: 'person', state: 'running', started_at: time });
  for (const origin of ['human', 'main', 'review'] as const)
    assert.equal(requesterOf('T3', [ask, request('person', 'T3', origin)], facts({}, personRun)), null, origin);
  assert.equal(requesterOf('T3', [ask, request('person', 'T3', 'human')],
    facts({ log: [log('Ldone', 5, { toState: 'done' })] }, personRun)), 'T2', 'closed Requests leave the parent');
  const otherSeat = [ended('R6', { task: 'T4', requestId: 'top4' }),
    record('R7', { task: 'T3', requestId: 'again', caller: { run: 'R6' } })];
  assert.equal(requesterOf('T3', [request('again', 'T3', 'placement', { submittedAt: at(10) }), ask],
    facts({}, ...otherSeat)), 'T4', 'the latest open Request');
  const own = [record('R8', { task: 'T3', role: 'worker', requestId: 'work3', caller: { run: 'R3' } }),
    record('R9', { task: 'T3', requestId: 'wake3' })];
  assert.equal(requesterOf('T3', [request('work3', 'T3'), request('wake3', 'T3', 'returns')], facts({}, ...own)), 'T2',
    'a worker Request and a continuation are the Task\'s own');
  assert.equal(requesterOf('T2', [], facts({})), null, 'the parent of a top Task is a project');
  assert.throws(() => requesterOf('T5', [], facts({})), { code: 'parent_unavailable' });
  assert.throws(() => requesterOf('T6', [], facts({})), { code: 'not_found' });
});

test('an urgent note goes to a requester seat and is refused when the requester is the user', () => {
  const facts = (userRequested: boolean) => returnFacts([project, task('T2'), task('T3', { parentId: 'T2', userRequested })],
    [seatRun, childRun()]);
  assert.equal(urgentTarget('T3', [request('ask', 'T3')], facts(false)), 'T2');
  assert.throws(() => urgentTarget('T3', [request('ask', 'T3')], facts(true)),
    { code: 'urgent_to_user', message: 'Cannot send an urgent notification when the requester is the user; ask a question instead' });
});

test('the requester, urgent destination and closing return keep their meaning independently of chosen question destinations', () => {
  // T3 is the agent's Task; T4 the user's, asked by T2; T5 the agent's, whose responsible the user also asked; T2 the user's.
  const tasks = [project, task('T2'), task('T3', { parentId: 'T2' }), task('T4', { parentId: 'T2', userRequested: true }),
    task('T5', { parentId: 'T2' })];
  const requests = [request('top', 'T2', 'human'), request('ask3', 'T3'), request('ask4', 'T4'), request('ask5', 'T5'),
    request('person5', 'T5', 'human', { submittedAt: at(5) })];
  const facts = returnFacts(tasks, [seatRun,
    ...['3', '4', '5'].map(n => record(`R${n}`, { task: `T${n}`, requestId: `ask${n}`, caller: { run: 'R2' } })),
    record('R6', { task: 'T5', requestId: 'person5' })]);
  // `by` is the latest open Request to the Task. The user's mark makes the user T4's requester, while the Request its
  // parent sent still closes to the parent (W1).
  const rows = [
    { task: 'T3', by: 'ask3', requester: 'T2', urgent: 'T2', close: 'T2' },
    { task: 'T5', by: 'person5', requester: null, urgent: 'refused', close: null },
    { task: 'T2', by: 'top', requester: null, urgent: 'refused', close: null },
    { task: 'T4', by: 'ask4', requester: null, urgent: 'refused', close: 'T2' },
  ];
  for (const row of rows) {
    const urgent = (() => {
      try { return urgentTarget(row.task, requests, facts); } catch (error) {
        assert.ok(error instanceof Problem && error.code === 'urgent_to_user');
        return 'refused';
      }
    })();
    const by = requests.find(item => item.id === row.by);
    assert.ok(by, row.by);
    assert.deepEqual({ task: row.task, by: row.by, requester: requesterOf(row.task, requests, facts), urgent,
      close: requesterSeat(by, facts) }, row);
  }
});

test('a closing return is named by its Request and a notice by its cause and kind', () => {
  const close = returnIdOf({ requestId: 'ask' });
  assert.match(close, /^RET[0-9a-f]{64}$/);
  assert.equal(returnIdOf({ requestId: 'ask' }), close);
  assert.notEqual(returnIdOf({ requestId: 'ask2' }), close);
  const question = returnIdOf({ causeLogId: 'Lasked', outcome: 'question' });
  assert.equal(returnIdOf({ causeLogId: 'Lasked', outcome: 'question' }), question);
  assert.notEqual(returnIdOf({ causeLogId: 'Lasked', outcome: 'urgent' }), question);
  assert.notEqual(returnIdOf({ causeLogId: 'ask', outcome: 'question' }), close);
});

test('scope-invalidated child work competes with Task closure at its actual boundary time', () => {
  const ask = request('ask', 'T3');
  const cancelled = childRun({ state: 'cancelled', reason: 'scope_invalidated', started_at: time, ended_at: at(20) });
  const close = (run: RunRecord, ...entries: TaskLog[]) => closureOf(ask,
    returnFacts([project, task('T2'), task('T3', { log: entries })], [seatRun, run]));
  assert.deepEqual(close(cancelled), { outcome: 'stopped', runId: cancelled.id, causeLogId: null });
  assert.deepEqual(close(cancelled, log('Lbefore', 10, { toState: 'done' })),
    { outcome: 'succeeded', runId: null, causeLogId: 'Lbefore' });
  assert.deepEqual(close(cancelled, log('Lafter', 30, { toState: 'done' })),
    { outcome: 'stopped', runId: cancelled.id, causeLogId: null });
  assert.equal(close({ ...cancelled, reason: 'stopped' }), null, 'ordinary run stop still waits for the child Task');
  const facts = returnFacts([project, task('T2'), task('T3')], [seatRun, cancelled]);
  assert.equal(openRequests('T2', [ask], facts).length, 0);
  assert.equal(openRequests('T2', [{ ...ask, deliveryState: 'aborted' }], facts).length, 0);
});
