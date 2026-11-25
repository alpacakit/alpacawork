/** Questions open and close only through a Task's own log; the log schema keeps each new field on its own kinds. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openQuestions, questionsOf } from '@alpacawork/raw/questions';
import { speaksForUser, taskActorSchema, taskLogSchema } from '@alpacawork/raw/task-log-schema';

const at = (second: number) => new Date(Date.UTC(2026, 9, 19, 0, 0, second)).toISOString().replace('Z', '+00:00');
const fields = (id: string, second: number, more: Record<string, unknown>) => ({ id, at: at(second), title: null,
  description: null, actor: { kind: 'placement', placementId: 'P1' }, fromState: null, toState: null, ...more });
const entry = (id: string, second: number, more: Record<string, unknown>) => taskLogSchema.parse(fields(id, second, more));
const valid = (more: Record<string, unknown>) => taskLogSchema.safeParse(fields('L1', 1, more)).success;
const asked = (id: string, second: number, askedTo: string | null = null) =>
  entry(id, second, { kind: 'asked', title: 'Which layout?', description: 'Pick one of two layouts', askedTo, decide: [{ decide_kind: 'choose', decide_question: 'Which layout?' }] });
const answered = (id: string, second: number, questionId: string) =>
  entry(id, second, { kind: 'answered', actor: { kind: 'human' }, questionId });
const withdrawn = (id: string, second: number, questionId: string) =>
  entry(id, second, { kind: 'question_withdrawn', questionId });
const stopped = (id: string, second: number, kind: 'reported' | 'linked' = 'reported') =>
  entry(id, second, { kind, actor: { kind: 'human' }, fromState: 'doing', toState: 'stopped' });

test('a question closes on the first answer or withdrawal that names it, and only that one', () => {
  const first = asked('Q1', 1), second = asked('Q2', 2, 'T3');
  const answer = answered('A1', 3, 'Q1'), late = answered('A2', 4, 'Q1'), withdrawal = withdrawn('W1', 5, 'Q2');
  assert.deepEqual(questionsOf([first, second, answer, late, withdrawal]),
    [{ asked: first, closing: answer }, { asked: second, closing: withdrawal }]);
  assert.deepEqual(questionsOf([first, second, answer]), [{ asked: first, closing: answer }, { asked: second, closing: null }]);
  assert.equal(questionsOf([first, second, answer])[1]?.asked.askedTo, 'T3', 'the destination stays as asked');
});

test('a stop expires every question asked before it and none asked after it', () => {
  for (const kind of ['reported', 'linked'] as const) {
    const first = asked('Q1', 1), stop = stopped('S1', 2, kind), second = asked('Q2', 3), answer = answered('A1', 4, 'Q1');
    assert.deepEqual(questionsOf([first, stop, second, answer]),
      [{ asked: first, closing: stop }, { asked: second, closing: null }], `${kind} to stopped`);
  }
});

test('an answer to a question this log never asked closes nothing', () => {
  const question = asked('Q1', 1);
  assert.deepEqual(questionsOf([answered('A0', 0, 'Q1'), question, answered('A1', 2, 'Q9')]),
    [{ asked: question, closing: null }]);
  assert.deepEqual(questionsOf([]), []);
});

test('open questions are read now or at a past moment', () => {
  const first = asked('Q1', 1), second = asked('Q2', 3), answer = answered('A1', 5, 'Q1');
  const log = [first, second, answer];
  assert.deepEqual(openQuestions(log), [second]);
  assert.deepEqual(openQuestions(log, at(0)), [], 'nothing was asked yet');
  assert.deepEqual(openQuestions(log, at(1)), [first], 'a question is open from the moment it is asked');
  assert.deepEqual(openQuestions(log, at(4)), [first, second]);
  assert.deepEqual(openQuestions(log, at(5)), [second], 'a question answered at that moment is closed');
  assert.deepEqual(openQuestions([first, stopped('S1', 2)], at(1)), [first]);
  assert.deepEqual(openQuestions([first, stopped('S1', 2)]), []);
});

test('a question log keeps the state, comes from a placement, carries a summary and fixes its destination and what it asks', () => {
  const question = { kind: 'asked', description: 'Pick one', askedTo: null, decide: [{ decide_kind: 'choose', decide_question: 'Which layout?' }] };
  assert.equal(valid(question), true);
  assert.equal(valid({ ...question, askedTo: 'T2', runId: 'R1' }), true);
  assert.equal(valid({ ...question, askedTo: undefined }), false, 'askedTo is required');
  assert.equal(valid({ ...question, askedTo: 'project' }), false, 'askedTo is a Task ID or null');
  assert.equal(valid({ ...question, toState: 'waiting' }), false);
  assert.equal(valid({ ...question, fromState: 'doing' }), false);
  assert.equal(valid({ ...question, actor: { kind: 'human' } }), false);
  assert.equal(valid({ ...question, description: null }), false);
  assert.equal(valid({ kind: 'reported', askedTo: null }), false, 'askedTo belongs to a question only');
  assert.equal(valid({ ...question, decide: undefined }), false, 'decide is required');
  assert.equal(valid({ ...question, decide: [] }), false, 'a question asks at least one thing');
  assert.equal(valid({ kind: 'reported', decide: question.decide }), false, 'decide belongs to a question only');
  assert.equal(valid({ kind: 'answered', actor: { kind: 'human' }, questionId: 'Q1', decide: question.decide }), false, 'an answer fixes no question');
});

test('an answer or a withdrawal names its question and keeps the state', () => {
  for (const kind of ['answered', 'question_withdrawn']) {
    assert.equal(valid({ kind, questionId: 'Q1' }), true, kind);
    assert.equal(valid({ kind }), false, `${kind} without questionId`);
    assert.equal(valid({ kind, questionId: 'Q1', fromState: 'held', toState: 'doing' }), false, `${kind} with a state`);
  }
  assert.equal(valid({ kind: 'question_withdrawn', questionId: 'Q1', runId: 'R1' }), true);
  assert.equal(valid({ kind: 'answered', questionId: 'Q1', runId: 'R1' }), false);
  assert.equal(valid({ kind: 'reported', questionId: 'Q1' }), false, 'questionId belongs to an answer or a withdrawal only');
});

test('an urgent reason belongs to a placement comment or done report', () => {
  assert.equal(valid({ kind: 'reported', urgentReason: 'Production is down' }), true, 'comment');
  assert.equal(valid({ kind: 'reported', fromState: 'doing', toState: 'done', urgentReason: 'Deadline moved' }), true);
  assert.equal(valid({ kind: 'reported', fromState: 'doing', toState: 'waiting', urgentReason: 'Deadline moved' }), false);
  assert.equal(valid({ kind: 'reported', actor: { kind: 'human' }, urgentReason: 'Deadline moved' }), false);
  assert.equal(valid({ kind: 'reported', urgentReason: '' }), false);
  assert.equal(valid({ kind: 'asked', description: 'Pick one', askedTo: null, decide: [{ decide_kind: 'choose', decide_question: 'Which layout?' }], urgentReason: 'Now' }), false);
});

test('a removed log kind or field is refused, not read', () => {
  for (const kind of ['report_restored', 'manual_correction', 'review_stopped']) {
    const result = taskLogSchema.safeParse(fields('L1', 1, { kind, actor: { kind: 'human' } }));
    assert.equal(result.success, false, kind);
    assert.ok(result.error?.issues.some(issue => issue.path[0] === 'kind'), kind);
  }
  for (const [key, value] of [['waitingIntent', 'review'], ['restoredReportId', 'L0']] as const) {
    const result = taskLogSchema.safeParse(fields('L1', 1, { kind: 'reported', actor: { kind: 'human' }, fromState: 'doing',
      toState: 'waiting', [key]: value }));
    assert.equal(result.success, false, key);
    assert.ok(result.error?.issues.some(issue => issue.code === 'unrecognized_keys' && issue.keys.includes(key)), key);
  }
  assert.equal(valid({ kind: 'reported', actor: { kind: 'human' }, fromState: 'doing', toState: 'waiting' }), true);
});

test('the user request mark is set by a creation or a mark change only', () => {
  assert.equal(valid({ kind: 'created', toState: 'todo', userRequested: false }), true);
  assert.equal(valid({ kind: 'created', toState: 'todo' }), false, 'a creation sets the mark');
  assert.equal(valid({ kind: 'user_request_changed', actor: { kind: 'human' }, userRequested: true }), true);
  assert.equal(valid({ kind: 'user_request_changed', actor: { kind: 'human' } }), false);
  assert.equal(valid({ kind: 'reported', userRequested: true }), false);
});

test('a person or a main conversation speaks for the user independently of optional quote records', () => {
  const main = { kind: 'main', provider: 'claude', conversationId: 'C1' } as const;
  const utterance = 'Ship it';
  const policy = 'Merge when the checks pass';
  assert.equal(speaksForUser({ kind: 'human' }), true);
  assert.equal(speaksForUser(main), true);
  assert.equal(speaksForUser({ kind: 'placement', placementId: 'P1' }), false);
  assert.equal(speaksForUser(taskActorSchema.parse({ ...main, quote: utterance })), true);
  assert.equal(speaksForUser(taskActorSchema.parse({ ...main, quote: policy })), true);
  for (const quote of [{ text: 'Ship it' }, 'x'.repeat(1001), 17, null])
    assert.equal(taskActorSchema.safeParse({ ...main, quote }).success, false, JSON.stringify(quote));
  assert.equal(taskActorSchema.safeParse({ ...main, quote: 'x'.repeat(1000) }).success, true);
  assert.equal(taskActorSchema.safeParse({ ...main, quote: '😀'.repeat(1000) }).success, true);
  assert.equal(taskActorSchema.safeParse({ ...main, quote: '😀'.repeat(1001) }).success, false);
  assert.equal(taskActorSchema.safeParse({ kind: 'placement', placementId: 'P1', quote: utterance }).success, false,
    'only a main conversation quotes the user');
  assert.equal(valid({ kind: 'reported', actor: { ...main, quote: utterance } }), true);
});
