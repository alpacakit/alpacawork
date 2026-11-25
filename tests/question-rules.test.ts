/** Question destinations and applicability have their own Owner, independent of list projection. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialControlDocument, type ControlTask, type TaskLog } from '@alpacawork/raw';
import { taskLogSchema } from '@alpacawork/raw/task-log-schema';
import { openQuestions } from '@alpacawork/raw';
import { questionSnapshot, questionApplicable } from '@alpacawork/backend/test-dist/control/question-rules.js';

type Node = Pick<ControlTask, 'id' | 'meta'>;
const at = (second = 0) => new Date(Date.UTC(2026, 9, 20, 0, 0, second)).toISOString();
const log = (id: string, second: number, fields: Record<string, unknown>): TaskLog => taskLogSchema.parse({
  id, at: at(second), title: null, description: null, actor: { kind: 'placement', placementId: 'Ptest' },
  fromState: null, toState: null, ...fields,
});
const ask = (id: string, second: number, askedTo: string | null) =>
  log(id, second, { kind: 'asked', title: 'Choose', description: 'Question summary', askedTo, decide: [{ decide_kind: 'choose', decide_question: 'Choose' }], runId: 'R1' });
const answer = (id: string, questionId: string) =>
  log(id, 100, { kind: 'answered', actor: { kind: 'human' }, questionId });
function node(id: string, parent: string | null, questions: TaskLog[] = [], options: { project?: boolean; lifecycle?: Node['meta']['lifecycle'] } = {}): Node {
  const meta = initialControlDocument(id, parent, id, { kind: options.project ? 'project' : 'task', userRequested: false, actor: { kind: 'human' } });
  meta.lifecycle = options.lifecycle ?? 'active';
  meta.log = [{ ...meta.log[0]!, id: `created-${id}`, at: at() }, ...questions];
  return { id, meta };
}
function questionsFixture() {
  const leaf = node('T4', 'T3', [
    ask('Q-answered', 1, 'T2'), answer('A1', 'Q-answered'),
    ask('Q-withdrawn', 2, 'T3'), log('W1', 3, { kind: 'question_withdrawn', questionId: 'Q-withdrawn' }),
    ask('Q-expired', 4, 'T2'), log('E1', 5, { kind: 'question_expired', questionId: 'Q-expired', closureReason: 'destination_invalid' }),
    ask('Q-first', 6, 'T2'), ask('Q-second', 7, 'T3'), ask('Q-user', 8, null), ask('Q-shared', 9, 'T2'),
    ask('Q-missing', 10, 'T999'), ask('Q-sibling', 11, 'T5'), ask('Q-self', 12, 'T4'),
    ask('Q-project', 13, 'P1'), ask('Q-other-project', 14, 'T7'),
  ]);
  const parent = node('T2', 'P1'), middle = node('T3', 'T2', [ask('Q-shared', 1, 'T2')]);
  const stopped = node('T11', 'T2', [ask('Q-before-stop', 1, 'T2'),
    log('S1', 2, { kind: 'reported', actor: { kind: 'human' }, fromState: 'todo', toState: 'stopped' })]);
  stopped.meta.baseState = 'stopped';
  // Deliberately not ancestry-sorted; projection and obligation order belong to the input snapshot.
  const tasks = [leaf, parent, node('P1', null, [], { project: true }), middle,
    node('T5', 'P1', [ask('Q-shared', 1, 'T2')]), node('P6', 'P1', [], { project: true }), node('T7', 'P6'),
    node('P8', 'P1', [], { project: true, lifecycle: 'archived' }), node('T9', 'P8', [ask('Q-inactive-project', 1, null)]),
    node('T10', 'T999', [ask('Q-no-project', 1, null)]), stopped,
    node('T12', 'T2', [ask('Q-archived', 1, 'T2')], { lifecycle: 'archived' }),
    node('T13', 'T2', [ask('Q-deleted', 1, 'T2')], { lifecycle: 'deleted' })];
  return { tasks, leaf, parent, middle };
}

function applicable(tasks: Node[]) {
  const snapshot = questionSnapshot(tasks);
  return new Map(tasks.map(task => [task.id, openQuestions(task.meta.log).filter(q => questionApplicable(task.id, q, snapshot))]));
}

test('question applicability preserves destinations, closure and input order', () => {
  const h = questionsFixture(), first = applicable(h.tasks);
  assert.deepEqual(first.get('T4')!.map(q => [q.id, q.askedTo]),
    [['Q-first', 'T2'], ['Q-second', 'T3'], ['Q-user', null], ['Q-shared', 'T2']]);
  for (const id of ['T5', 'T9', 'T10', 'T11', 'T12', 'T13']) assert.deepEqual(first.get(id), [], id);
  assert.deepEqual(applicable([...h.tasks].reverse()).get('T4'), first.get('T4'));
});

test('a new question snapshot observes closure and destination lifecycle changes', () => {
  const h = questionsFixture(), first = applicable(h.tasks);
  h.leaf.meta.log.push(answer('A-first', 'Q-first'));
  assert.deepEqual(applicable(h.tasks).get('T4')!.map(q => q.id), ['Q-second', 'Q-user', 'Q-shared']);
  h.parent.meta.lifecycle = 'archived';
  assert.deepEqual(applicable(h.tasks).get('T4')!.map(q => q.id), ['Q-second', 'Q-user']);
  assert.equal(first.get('T4')!.length, 4, 'earlier output stays detached');
});
