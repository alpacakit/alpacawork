import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TASK_BASE_STATES } from '@alpacawork/raw';
import { TASK_POLICY, evaluate, type Operation } from '@alpacawork/contract/task-policy';
import * as approved from './fixtures/approved-policy.mjs';

test('parent/child directions and explicit stopped scope match the fixed 216 pair cells', () => {
  let cells = 0;
  for (const parentBase of TASK_BASE_STATES) for (const childBase of TASK_BASE_STATES)
    for (const direction of approved.DIRECTIONS) for (const resumeAuthorized of [false, true]) {
      const facts = { parentBase, childBase, direction, resumeAuthorized };
      const expected = parentBase === 'waiting' && direction !== 'parent_operation'
        ? {kind:'keep',code:'pair_valid',parentBase:undefined} : approved.parentChild(facts), actual = evaluate(TASK_POLICY.parentChild, facts);
      assert.deepEqual([actual.kind, actual.code, actual.baseState], [expected.kind, expected.code, expected.parentBase]);
      cells++;
    }
  assert.equal(cells, 216);
});

test('all stages and holds keep their base on answer/withdraw; only explicit decisions change hold', () => {
  for (const baseState of TASK_BASE_STATES) for (const hold of [false, true])
    for (const action of ['answer', 'withdraw', 'hold', 'unhold', 'run_failed'] as Operation[]) for (const explicit of [false, true]) {
      const facts = { baseState, hold, action, explicit, userRequested: true };
      const expected = action === 'unhold' ? { kind: 'cochange', code: 'unhold', hold: false } : approved.evaluateFace('hold', facts), actual = evaluate(TASK_POLICY.hold, facts);
      assert.deepEqual([actual.kind, actual.code, actual.hold], [expected.kind, expected.code, expected.hold]);
      if (action === 'answer' || action === 'withdraw') assert.equal(evaluate(TASK_POLICY.transition, facts).baseState, undefined);
    }
});

test('finish blockers remain cumulative with unknown facts rejected', () => {
  for (let mask = 0; mask < 32; mask++) for (const known of [false, true]) {
    const counts = ['questions', 'requests', 'undelivered', 'unfinishedBelow', 'otherRuns'] as const;
    const values = Object.fromEntries(counts.map((key, bit) => [key, mask & 1 << bit ? 1 : 0])) as Record<typeof counts[number], number>;
    const old = approved.evaluateFace('finish', { ...values, unknown: !known, needsReview: false });
    const current = evaluate(TASK_POLICY.finish, { ...values, known, needsReview: false, reviewFresh: true, reviewRunEnded: true }, true);
    assert.deepEqual(current.all.filter(row => row.kind === 'reject').map(row => row.code), old.all.filter(row => row.kind === 'reject').map(row => row.code));
  }
});

test('W0-W3 cannot bypass a hold, uncertainty or automatic limit, including work_changed mixed with W0', () => {
  for (let mask = 0; mask < 2048; mask++) {
    const f = Object.fromEntries(['active', 'hold', 'failed', 'serverRequest', 'hasRows', 'profile', 'limit', 'uncertain', 'refused', 'needsReview', 'busy']
      .map((key, bit) => [key, !!(mask & 1 << bit)]));
    const facts = { ...f, baseState: 'doing', workChanged: false };
    const old = approved.evaluateFace('wakeGate', facts), current = evaluate(TASK_POLICY.wake, facts);
    assert.equal(current.rule, old.rule, JSON.stringify(facts));
  }
  assert.equal(evaluate(TASK_POLICY.wake, { active: true, baseState: 'error', hold: false, failed: true, serverRequest: true,
    workChanged: true, hasRows: true, profile: true, limit: false, uncertain: false, refused: false, needsReview: false, busy: false }).rule, 'W03');
});

test('run failure transition detects deliberate rule removal', () => {
  const failure = TASK_POLICY.runEnd.find(row => row.id === 'RE03')!;
  const result = failure.out;
  const boundary = { runState: 'failed' as const, started: true, endedByReport: false, openQuestionAtEnd: false,
    awaitingAtEnd: false, responsibleAtEnd: true, baseState: 'doing' as const };
  assert.equal(evaluate(TASK_POLICY.runEnd, boundary).baseState, 'error');
  try { failure.out = () => ({ kind: 'keep', code: 'broken' }); assert.notEqual(evaluate(TASK_POLICY.runEnd, boundary).baseState, 'error'); }
  finally { failure.out = result; }
});
