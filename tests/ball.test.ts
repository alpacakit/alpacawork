/**
 * The ball: one pure derivation, applied from the top row down, of whose move a Task waits on, and its
 * facts as ballFactsOf assembles them from one read point.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ballSchema, reviewTarget, userTurn, type Ball } from '@alpacawork/contract';
import type { ControlTask, TaskLog } from '@alpacawork/raw';
import type { StoredPlacement } from '@alpacawork/runs';
import { ballOf, type BallFacts } from '@alpacawork/backend/test-dist/control/ball.js';
import { ballsOf, ballSourceOf } from './helpers/ball-source.ts';
import { seatSourceOf, type SeatWait, type WakeBlock } from '@alpacawork/backend/test-dist/control/wake.js';
import { ended } from './runs-fixtures.ts';

const time = (minute: number) => `2026-10-19T09:${String(minute).padStart(2, '0')}:00.000Z`;
const facts = (overrides: Partial<BallFacts> = {}): BallFacts => ({ lifecycle: 'active', state: 'doing', baseState: overrides.baseState ?? (overrides.state === 'held' ? 'doing' : overrides.state ?? 'doing'),
  review: null, failure: null, openQuestions: [], requester: 'user', requesterAskedUser: false, block: null, openRequests: 0, ...overrides });
/** A wake the user is asked to let go on, keyed and dated by wake.ts from the first return it stops. */
const asks = (code: string, key: string, count: number | null = null): WakeBlock => ({ code, human: true, key, at: time(5), count });
const waits = (code: SeatWait): WakeBlock => ({ code, human: false, key: null, at: null, count: null });
const review = { logId: 'L-report', at: time(1), runId: 'R7', taskSnapshot: false };
const failure = { logId: 'L-failed', at: time(2) };
const toUser = { id: 'L-ask-user', askedTo: null, at: time(3) };
const toParent = { id: 'L-ask-parent', askedTo: 'P1', at: time(4) };
type UserBall = Extract<Ball, { holder: 'user' }>;
const user = (reason: UserBall['reason'], at: string, key: string, details: Partial<UserBall> = {}): UserBall =>
  ({ holder: 'user', reason, at, key, questionId: null, aboutRunId: null, count: null, code: null, failure: null, ...details });
/** Every ball the derivation gives is one the wire accepts. */
const ball = (input: BallFacts): Ball | null => {
  const result = ballOf(input);
  if (result) ballSchema.parse(result);
  return result;
};

test('a Task not started, finished or no longer active awaits nobody, whatever else is open', () => {
  const open = { review, failure, openQuestions: [toUser, toParent], block: asks('automatic_limit', 'limit:D1', 2), openRequests: 1 };
  for (const state of ['todo', 'done', 'stopped'] as const) assert.equal(ball(facts({ ...open, state })), null, state);
  for (const lifecycle of ['archived', 'deleted'] as const)
    for (const state of ['doing', 'waiting', 'held', 'error'] as const)
      assert.equal(ball(facts({ ...open, lifecycle, state, baseState: 'waiting' })), null, `${lifecycle} ${state}`);
});

test("a review is the user's turn from the report that asked for it, about the Run it confirms", () => {
  assert.deepEqual(ball(facts({ state: 'waiting', review, block: asks('automatic_limit', 'limit:D1', 1) })),
    user('review', review.at, review.logId, { aboutRunId: 'R7' }));
  // Before the Run that reported has finished there is nothing to confirm, and its responsible is still at work.
  const moving = facts({ state: 'waiting', review: { ...review, runId: null } });
  assert.deepEqual(ball(moving), { holder: 'owner' });
});

test("a question asked of the user is their turn from when it was asked, the oldest open one first", () => {
  const later = { id: 'L-ask-later', askedTo: null, at: time(6) };
  assert.deepEqual(ball(facts({ openQuestions: [toParent, toUser, later], openRequests: 1 })),
    user('question', toUser.at, toUser.id, { questionId: toUser.id }));
  // A question asked of the parent's responsible is the parent's move, never the user's.
  assert.deepEqual(ball(facts({ openQuestions: [toParent], openRequests: 1 })), { holder: 'parent', reason: 'question' });
});

test('a hold keeps the turn it set aside: the same key and time while held and after the return', () => {
  const waiting = facts({ state: 'waiting', review });
  const heldReview = facts({ state: 'held', baseState: 'waiting', review, block: waits('held') });
  assert.deepEqual(ball(heldReview), ball(waiting));
  const asking = facts({ openQuestions: [toParent, toUser] });
  const heldQuestion = facts({ state: 'held', baseState: 'doing', openQuestions: [toParent, toUser],
    block: waits('held') });
  assert.deepEqual(ball(heldQuestion), ball(asking));
  assert.equal(userTurn(ballOf(heldQuestion))?.key, toUser.id);
});

test("automatic wakes stopped at the limit are the user's turn, counted, from the first return they hold back, ahead of a question", () => {
  assert.deepEqual(ball(facts({ block: asks('automatic_limit', 'limit:D1', 3), openQuestions: [toUser], openRequests: 1 })),
    user('limit', time(5), 'limit:D1', { count: 3 }));
  // Below the limit nothing blocks the seat, and the open Request keeps the ball below.
  assert.deepEqual(ball(facts({ openRequests: 1 })), { holder: 'child' });
});

test("a delivery whose receipt is unknown, and each refusal only the user can clear, is the user's turn with its reason", () => {
  assert.deepEqual(ball(facts({ block: asks('uncertain', 'uncertain:D1') })), user('unconfirmed', time(5), 'uncertain:D1'));
  for (const code of ['no_profile', 'too_deep', 'too_many_children', 'not_resumable', 'responsible_missing'])
    assert.deepEqual(ball(facts({ block: asks(code, `${code}:D1`) })), user('blocked', time(5), `${code}:D1`, { code }), code);
  // A seat that is busy, waits on its own Requests, is held or has nothing to take is not stopped for the user.
  for (const code of ['busy', 'outstanding', 'needs_review', 'held', 'nothing'] as const)
    assert.deepEqual(ball(facts({ block: waits(code), openRequests: 1 })), { holder: 'child' }, code);
});

test("a failure is the user's turn when they asked for the work, and the parent's when the parent did", () => {
  const failed = { state: 'error' as const, failure, block: waits('failed'), openRequests: 1 };
  assert.deepEqual(ball(facts(failed)), user('failed', failure.at, failure.logId));
  assert.deepEqual(ball(facts({ ...failed, requester: 'parent' })), { holder: 'parent', reason: 'failed' });
  // A question stays open through a failure: the user's is still theirs to answer first, and the parent's comes first
  // for the parent, while a failure of the user's work is theirs before any question of the parent's.
  // The question carries the failure the user also decides (its Retry and Stop under the title); a parent's failure
  // is never carried.
  assert.deepEqual(ball(facts({ ...failed, openQuestions: [toUser] })),
    user('question', toUser.at, toUser.id, { questionId: toUser.id, failure: { at: failure.at, key: failure.logId } }));
  assert.deepEqual(ball(facts({ ...failed, requester: 'parent', openQuestions: [toUser] })),
    user('question', toUser.at, toUser.id, { questionId: toUser.id }));
  assert.deepEqual(ball(facts({ ...failed, requester: 'parent', requesterAskedUser: true, openQuestions: [toUser] })),
    user('question', toUser.at, toUser.id, { questionId: toUser.id, failure: { at: failure.at, key: failure.logId } }));
  assert.deepEqual(ball(facts({ openQuestions: [toUser] })), user('question', toUser.at, toUser.id, { questionId: toUser.id }));
  assert.deepEqual(ball(facts({ ...failed, openQuestions: [toParent] })), user('failed', failure.at, failure.logId));
  assert.deepEqual(ball(facts({ ...failed, requester: 'parent', openQuestions: [toParent] })),
    { holder: 'parent', reason: 'question' });
});

test('each row of design 4.2 gives its ball ahead of the rows below it that hold with it: user, parent, child, owner', () => {
  const questions = { openQuestions: [toParent, toUser], openRequests: 2 };
  const failedBy = (requester: BallFacts['requester']) => ({ state: 'error' as const, failure, requester, block: waits('failed') });
  const reviewed = user('review', review.at, review.logId, { aboutRunId: 'R7' });
  const rows: [string, Partial<BallFacts>, Ball][] = [
    ['Awaiting review', { state: 'waiting', review, block: asks('automatic_limit', 'limit:D1', 2), ...questions }, reviewed],
    ['Held', { state: 'held', baseState: 'waiting', review, block: waits('held'), ...questions }, reviewed],
    ['Automatic limit', { block: asks('automatic_limit', 'limit:D1', 2), ...questions }, user('limit', time(5), 'limit:D1', { count: 2 })],
    ['Delivery with an uncertain receipt', { block: asks('uncertain', 'uncertain:D1'), ...questions }, user('unconfirmed', time(5), 'uncertain:D1')],
    ['Question for the user', { ...failedBy('user'), ...questions },
      user('question', toUser.at, toUser.id, { questionId: toUser.id, failure: { at: failure.at, key: failure.logId } })],
    ['Failure requested by the user', { ...failedBy('user'), openQuestions: [toParent], openRequests: 2 }, user('failed', failure.at, failure.logId)],
    ['Question for the parent', { ...failedBy('parent'), openQuestions: [toParent], openRequests: 2 }, { holder: 'parent', reason: 'question' }],
    ['Failure requested by the parent', { ...failedBy('parent'), openRequests: 2 }, { holder: 'parent', reason: 'failed' }],
    ['Open request', { block: waits('outstanding'), openRequests: 2 }, { holder: 'child' }],
    ['Other work in progress', { block: waits('nothing') }, { holder: 'owner' }],
  ];
  for (const [row, overrides, expected] of rows) assert.deepEqual(ball(facts(overrides)), expected, row);
});

// One read point: P1 is the project; T2 the user's Task, whose responsible (P2) reported it for review from Run R1 and
// then ran R2, the head of its conversation; T3 a child T2's responsible made, which failed.
const entry = (id: string, minute: number, fields: Partial<TaskLog>): TaskLog => ({ id, kind: 'linked', at: time(minute),
  title: null, description: null, actor: { kind: 'placement', placementId: 'P2' }, fromState: null, toState: null, ...fields });
const task = (id: string, fields: Partial<ControlTask['meta']>): Pick<ControlTask, 'id' | 'meta'> => ({ id,
  meta: { format: 3n, id, kind: 'task', parentId: 'P1', lifecycle: 'active', title: id, version: 1n, baseState: fields.baseState ?? (fields.state === 'held' ? 'doing' : fields.state ?? 'doing'), hold: fields.hold ?? fields.state === 'held', state: 'doing',
    userRequested: false, log: [], ...fields } });
const reported = [entry('L2-created', 0, { kind: 'created', actor: { kind: 'human' }, toState: 'todo', userRequested: true }),
  entry('L2-started', 1, { fromState: 'todo', toState: 'doing', runId: 'R1' }),
  entry('L-report', 2, { kind: 'reported', fromState: 'doing', toState: 'waiting', runId: 'R1' })];
const hold = entry('L-hold', 5, { kind: 'reported', actor: { kind: 'human' }, fromState: 'waiting', toState: 'held' });
const unhold = entry('L-unhold', 6, { kind: 'reported', actor: { kind: 'human' }, fromState: 'held', toState: 'waiting' });
const childLog = (userRequested: boolean) => [entry('L3-created', 1, { kind: 'created', toState: 'todo', userRequested }),
  entry('L3-started', 2, { fromState: 'todo', toState: 'doing' }), entry('L-failed', 4, { fromState: 'doing', toState: 'error' })];
const placement: StoredPlacement = { id: 'P2', taskId: 'T2', agentId: 'A2', profileKey: 'fake', responsible: true,
  active: true, revision: 1, startedAt: time(0), endedAt: null };
const finished = [ended('R1', { task: 'T2', placementId: 'P2', requestId: 'first' }),
  ended('R2', { task: 'T2', placementId: 'P2', requestId: 'second', resumes: 'R1' })];
const read = (t2: Partial<ControlTask['meta']> = {}, childRequested = false, records = finished.slice(0, 1)) => {
  const tasks = [task('P1', { kind: 'project', parentId: null, state: 'todo' }),
    task('T2', { state: 'waiting', userRequested: true, log: reported, ...t2 }),
    task('T3', { parentId: 'T2', state: 'error', userRequested: childRequested, log: childLog(childRequested) })];
  const seats = seatSourceOf(tasks, { records, runError: null, agents: [], placements: [placement], requests: [], returns: [],
    waitCycles: [], headRunIds: new Map([['P2', records.at(-1)?.id ?? null]]), resultStates: new Map(), questionClosures: new Map(),
    uncertainInputs: new Map(), inputClosed: new Set() }, { profiles: new Set(['fake']), automaticLimit: 20 });
  return { tasks, source: ballSourceOf(seats, tasks) };
};

test("a review keeps the reporting Run and cannot substitute a later finished owner head", () => {
  const { tasks, source } = read();
  const balls = ballsOf(source);
  assert.deepEqual(balls, { T2: user('review', time(2), 'L-report', { aboutRunId: 'R1' }), T3: { holder: 'parent', reason: 'failed' } },
    'the project has no ball');
  assert.equal(userTurn(balls.T2)?.aboutRunId, reviewTarget(tasks[1].meta, finished[0]));
  assert.deepEqual(ballsOf(read({}, false, finished).source, ['T2']), { T2: { holder: 'owner' } },
    'a later completed head never becomes the submitted review Run');
  const moving = [finished[0], { ...finished[1], state: 'running' as const, ended_at: null }];
  assert.deepEqual(ballsOf(read({}, false, moving).source, ['T2']), { T2: { holder: 'owner' } },
    'nothing is confirmed while the head still runs');
});

test('a hold and its return derive the ball from the state held from, with the same key and time', () => {
  const waiting = ballsOf(read().source, ['T2']);
  assert.deepEqual(ballsOf(read({ state: 'held', baseState: 'waiting', log: [...reported, hold] }).source, ['T2']), waiting);
  assert.deepEqual(ballsOf(read({ state: 'waiting', log: [...reported, hold, unhold] }).source, ['T2']), waiting);
});

test("a hold's return to a failure names the record of the failure, not the return", () => {
  const log = [...childLog(true),
    entry('L-hold', 5, { kind: 'reported', actor: { kind: 'human' }, fromState: 'error', toState: 'held' }),
    entry('L-unhold', 6, { kind: 'reported', actor: { kind: 'human' }, fromState: 'held', toState: 'error' })];
  assert.deepEqual(ballsOf(read({ state: 'error', baseState: 'error', log }).source, ['T2']), { T2: user('failed', time(4), 'L-failed') });
});

test("a Task's failure goes to whoever asked for its work, read from the same facts its Requests are", () => {
  assert.deepEqual(ballsOf(read().source, ['T3']), { T3: { holder: 'parent', reason: 'failed' } });
  assert.deepEqual(ballsOf(read({}, true).source, ['T3']), { T3: user('failed', time(4), 'L-failed') });
});


test('B05: a failed child reaches the user only when its requester has an open user question and no queued or running Run', () => {
  const question = entry('L-parent-user', 5, { kind: 'asked', askedTo: null, title: 'Cannot repair child', decide: [{ decide_kind: 'choose', decide_question: 'Cannot repair child' }] });
  for (const state of ['succeeded', 'queued', 'running'] as const) {
    const records = [{ ...finished[0], state, ended_at: state === 'succeeded' ? finished[0].ended_at : null }];
    const source = read({ state: 'doing', baseState: 'doing', log: [...reported.slice(0, 2), question] }, false, records).source;
    assert.deepEqual(ballsOf(source, ['T3']).T3, state === 'succeeded'
      ? user('failed', time(4), 'L-failed') : { holder: 'parent', reason: 'failed' }, state);
  }
  const noQuestion = read({ state: 'doing', baseState: 'doing', log: reported.slice(0, 2) }).source;
  assert.deepEqual(ballsOf(noQuestion, ['T3']).T3, { holder: 'parent', reason: 'failed' });
});
