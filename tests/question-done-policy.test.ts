import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasOpenUserQuestion, type TaskLog, type TaskBaseState } from '@alpacawork/raw';
import { awaitsReview } from '@alpacawork/contract';
import { TASK_POLICY, evaluate, taskActionsOf } from '@alpacawork/contract/task-policy';
import { decide, type Caller, type TaskFacts } from '@alpacawork/contract/command-access';

test('one log fold distinguishes open user questions from closed questions and questions to ancestors', () => {
  const asked = (askedTo: string | null): TaskLog => ({ id: 'Q1', kind: 'asked', at: '2026-10-31T00:00:00Z',
    title: 'Which?', description: 'A or B', actor: { kind: 'placement', placementId: 'P1' }, fromState: null, toState: null, askedTo,
    decide: [{ decide_kind: 'choose', decide_question: 'Which?' }] });
  assert.equal(hasOpenUserQuestion([]), false);
  assert.equal(hasOpenUserQuestion([asked('T2')]), false);
  assert.equal(hasOpenUserQuestion([asked(null)]), true);
  for (const kind of ['answered', 'question_withdrawn', 'question_expired'] as const)
    assert.equal(hasOpenUserQuestion([asked(null), { id: 'C1', kind, at: '2026-10-31T00:00:01Z',
      actor: { kind: 'human' }, fromState: null, toState: null, questionId: 'Q1' }]), false);
});

test('only doing with an open user question gains human completion, without becoming review', () => {
  for (const baseState of ['todo', 'doing', 'waiting', 'error', 'done', 'stopped'] as TaskBaseState[])
    for (const openUserQuestion of [false, true]) for (const userRequested of [false, true]) {
      const facts = { baseState, hold: false, openUserQuestion, userRequested };
      const allowed = baseState === 'waiting' || baseState === 'doing' && openUserQuestion;
      assert.equal(taskActionsOf(facts).includes('confirm'), allowed);
      assert.equal(evaluate(TASK_POLICY.intent, { ...facts, state: 'done', reporter: 'outside', confirmation: false }).code,
        allowed ? 'confirm' : 'invalid_report_intent');
      const transition = evaluate(TASK_POLICY.transition, { ...facts, action: 'confirm', explicit: true });
      assert.equal(transition.kind !== 'reject', allowed);
      if (allowed) {
        assert.equal(transition.baseState, 'done'); assert.equal(transition.needsFinish, true);
        assert.equal(transition.needsReview, baseState === 'waiting');
      }
      assert.equal(awaitsReview(facts), baseState === 'waiting');
    }
  assert.equal(evaluate(TASK_POLICY.transition, { baseState: 'doing', hold: false, userRequested: true,
    action: 'confirm', explicit: false, openUserQuestion: true }).kind, 'reject');
});

test('existing person and coordinator confirm grants accept question completion while other Runs cannot confirm it', () => {
  const task: TaskFacts = { id: 'T2', kind: 'task', parentId: 'P1', project: 'P1', state: 'doing', baseState: 'doing',
    hold: false, userRequested: true, openUserQuestion: true };
  const callers: Caller[] = [{ kind: 'human' }, { kind: 'coordinator', conversation: 'test', source: 'codex' }];
  for (const caller of callers) assert.ok(!(decide(caller, { name: 'task.report', state: 'done' },
    { task, runProject: null, runState: null, quote: null }) instanceof Error));
  const other: Caller = { kind: 'run', runId: 'R1', placementId: 'P1', taskId: 'T1', role: 'owner', responsible: true };
  assert.ok(decide(other, { name: 'task.report', state: 'done' },
    { task, runProject: 'P1', runState: 'doing', quote: null }) instanceof Error);
});
