/** The ball's wire shape and the contract's pure readers of it: whose turn, what may be held, what a review confirms. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  awaitsReview, ballSchema, historyEventSchema, homeRowSchema, isNotice, isReviewMark,
  isSeatContinuation, reportTitleSchema, RETURN_CLOSURES, RETURN_NOTICES, RETURN_OUTCOMES, reviewTarget,
  urgentReasonSchema, userTurn, type Ball,
} from '@alpacawork/contract';

const at = '2026-10-19T09:00:00.000Z';
const user = (reason: string, details: Record<string, unknown> = {}) => ({ holder: 'user', reason, at, key: `K-${reason}`,
  questionId: null, aboutRunId: null, count: null, code: null, failure: null, ...details });

test('a user ball carries each detail with its own reason only', () => {
  for (const ball of [user('review', { aboutRunId: 'R7' }), user('question', { questionId: 'L-ask' }), user('limit', { count: 3 }),
    user('question', { questionId: 'L-ask', failure: { at, key: 'L-failed' } }),
    user('review'), user('blocked', { code: 'refused' }), user('unconfirmed'), user('failed'),
    { holder: 'parent', reason: 'question' }, { holder: 'parent', reason: 'failed' }, { holder: 'child' }, { holder: 'owner' }])
    assert.equal(ballSchema.safeParse(ball).success, true, JSON.stringify(ball));
  for (const [ball, path] of [
    [user('question'), 'questionId'], [user('limit'), 'count'], [user('blocked'), 'code'],
    [user('failed', { aboutRunId: 'R7' }), 'aboutRunId'], [user('review', { aboutRunId: 'R7', questionId: 'L-ask' }), 'questionId'],
    [user('question', { questionId: 'L-ask', count: 1 }), 'count'], [user('unconfirmed', { code: 'refused' }), 'code'],
    [user('failed', { failure: { at, key: 'L-failed' } }), 'failure'],
  ] as const) {
    const result = ballSchema.safeParse(ball);
    assert.equal(result.success, false, JSON.stringify(ball));
    assert.deepEqual(result.error?.issues.map(issue => issue.path.join('.')), [path]);
  }
  for (const ball of [{ holder: 'parent', reason: 'review' }, { holder: 'child', reason: 'question' }, { holder: 'owner', key: 'K' },
    user('waiting'), user('limit', { count: 0 }), { ...user('failed'), key: '' }])
    assert.equal(ballSchema.safeParse(ball).success, false, JSON.stringify(ball));
});

test("only the user's ball is their turn", () => {
  const review = ballSchema.parse(user('review', { aboutRunId: 'R7' }));
  const question = ballSchema.parse(user('question', { questionId: 'L-ask' }));
  const others: (Ball | null)[] = [{ holder: 'parent', reason: 'question' }, { holder: 'child' }, { holder: 'owner' }, null];
  assert.equal(userTurn(review), review);
  for (const ball of others) assert.equal(userTurn(ball), null);

});

const created = { fromState: null, toState: 'todo' } as const;
const started = { fromState: 'todo', toState: 'doing' } as const;
const comment = { fromState: null, toState: null } as const;

test('the current review stage is explicit even while held', () => {
  assert.equal(awaitsReview({ baseState: 'waiting' }), true);
  assert.equal(awaitsReview({ baseState: 'doing' }), false);
});

test('a review begins with the report that put the Task to waiting, never with a hold returning to it', () => {
  assert.equal(isReviewMark({ kind: 'reported', fromState: 'doing', toState: 'waiting' }), true);
  assert.equal(isReviewMark({ kind: 'reported', fromState: 'held', toState: 'waiting' }), false);
  assert.equal(isReviewMark({ kind: 'reported', fromState: 'doing', toState: 'done' }), false);
  assert.equal(isReviewMark({ kind: 'linked', fromState: 'doing', toState: 'waiting' }), false);
});

test("a review confirms the responsible's finished head Run, and nothing while the Task does not await review", () => {
  const waiting = { baseState: 'waiting', state: 'waiting', log: [
    { ...created, kind: 'created' }, { ...started, kind: 'linked' },
    { kind: 'reported', fromState: 'doing', toState: 'waiting', runId: 'R7' }] } as const;
  const held = { baseState: 'waiting', state: 'held', log: [...waiting.log, { kind: 'reported', fromState: 'waiting', toState: 'held' }] } as const;
  assert.equal(reviewTarget(waiting, { id: 'R7', state: 'succeeded' }), 'R7');
  assert.equal(reviewTarget(held, { id: 'R7', state: 'succeeded' }), 'R7');
  for (const state of ['queued', 'running'] as const) assert.equal(reviewTarget(waiting, { id: 'R7', state }), null);
  assert.equal(reviewTarget(waiting, null), null);
  assert.equal(reviewTarget({ baseState: 'doing', log: waiting.log.slice(0, 2) }, { id: 'R7', state: 'succeeded' }), null);
  assert.equal(reviewTarget({ baseState: 'doing', log: [...waiting.log.slice(0, 2), { kind: 'reported', fromState: 'doing', toState: 'held' }] },
    { id: 'R7', state: 'succeeded' }), null);
});

test('closing returns and notices split every outcome once; only the server wakes a seat to go on by itself', () => {
  assert.deepEqual([...RETURN_OUTCOMES], [...RETURN_CLOSURES, ...RETURN_NOTICES]);
  assert.equal(new Set(RETURN_OUTCOMES).size, RETURN_OUTCOMES.length);
  assert.deepEqual(RETURN_OUTCOMES.filter(isNotice), [...RETURN_NOTICES]);
  assert.deepEqual((['instruction', 'review_send_back', 'return_continuation'] as const).filter(isSeatContinuation), ['return_continuation']);
});

test('an urgent reason is one line as a report title is, and the projections keep their rows to their own facts', () => {
  for (const value of ['Stop the deploy', '漢'.repeat(40)]) assert.equal(urgentReasonSchema.safeParse(value).success, true, value);
  for (const value of ['', '  ', 'one\ntwo', '漢'.repeat(41)]) assert.equal(urgentReasonSchema.safeParse(value).success, false, value);
  assert.equal(reportTitleSchema.safeParse(' ').success, false);
  const row = { taskId: 'T4', section: 'review', summary: { done: 1, total: 3 } };
  assert.equal(homeRowSchema.safeParse(row).success, true);
  for (const required of ['taskId', 'section', 'summary'])
    assert.equal(homeRowSchema.safeParse({ ...row, [required]: undefined }).success, false, required);
  for (const removed of ['workBelow', 'waitReason', 'targets', 'exception', 'policy'])
    assert.equal(homeRowSchema.safeParse({ ...row, [removed]: null }).success, false, removed);
  assert.equal(homeRowSchema.safeParse({ ...row, summary: { ...row.summary, consulting: 1 } }).success, false);
  const event = { id: 'L1', kind: 'question', taskId: 'T5', fromChild: true, at, open: true, state: null, by: null,
    title: 'Which port?', summary: '' };
  assert.equal(historyEventSchema.safeParse(event).success, true);
  assert.equal(historyEventSchema.safeParse({ ...event, open: undefined }).success, false);
  assert.equal(historyEventSchema.safeParse({ ...event, kind: 'comment' }).success, false, 'only a question says whether it is open');
  assert.equal(historyEventSchema.safeParse({ ...event, kind: 'comment', open: undefined }).success, true);
  assert.equal(historyEventSchema.safeParse({ ...event, by: 'placement' }).success, false, 'only the user or the coordinator is named');
});

test('review target stays fixed to its report and rejects a newer conversation head', () => {
  const task = { baseState: 'waiting', log: [
    { kind: 'reported', fromState: 'doing', toState: 'waiting', runId: 'R7' },
  ] } as const;
  assert.equal(reviewTarget(task, { id: 'R8', state: 'succeeded' }), null);
  assert.equal(reviewTarget(task, { id: 'R7', state: 'succeeded' }, true), null);
});
