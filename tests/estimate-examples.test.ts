import { fieldCatalog } from '@alpacawork/contract';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateExamples } from '@alpacawork/backend/test-dist/control/estimate-examples.js';
import { taskView } from '@alpacawork/backend/test-dist/control/task-views.js';
import type { ControlSource } from '@alpacawork/backend/test-dist/control/task-views.js';

const at = (minute: number) => new Date(Date.UTC(2026, 9, 8, 0, minute)).toISOString();
/** A state change; a done report to a Task the user asked for leads to waiting for their review. */
const state = (minute: number, toState: string, fromState: string | null = null) =>
  ({ kind: 'reported', at: at(minute), fromState, toState });
const estimate = (minute: number, minutes: number, runId: string | undefined, placementId: string) =>
  ({ kind: 'reported', at: at(minute), fromState: 'doing', toState: 'doing',
    estimateMinutes: minutes, runId, actor: { kind: 'placement', placementId } });
/** A record that keeps the state: a question, its answer, an accepted instruction, a send-back. */
const record = (minute: number, kind: string) => ({ kind, at: at(minute), fromState: null, toState: null,
  ...['request_accepted', 'review_sent_back'].includes(kind) ? { startsEstimateRound: true } : {} });
const condition = { agent: 'claude', values: { model: 'opus', effort: 'high', speed: 'fast' } };
const run = (id: string, taskId: string, values: Record<string, string> = condition.values, agent = condition.agent) =>
  ({ id, task: taskId, placementId: `P${taskId}`, agent, launch: { values } });
const task = (id: string, log: object[]) => ({ id, log });
const query = (tasks: object[], runs: object[], errors: object[] = []) =>
  ({ tasks, runRecords: runs, errors }) as unknown as Pick<ControlSource, 'tasks' | 'runRecords' | 'errors'>;

test('recent estimate outcomes use the last declaration, doing time, exact launch choices, and one outcome per Task', () => {
  const tasks = [
    task('T1', [state(0, 'doing'), estimate(1, 120, 'R1', 'PT1'), estimate(5, 40, 'R1', 'PT1'),
      state(15, 'held', 'doing'), state(75, 'doing', 'held'), state(95, 'waiting', 'doing'),
      state(100, 'doing', 'waiting'), estimate(101, 30, 'R1', 'PT1'), state(111, 'waiting', 'doing')]),
    task('T2', [state(0, 'doing'), estimate(2, 55, 'R2', 'PT2'), state(108, 'done', 'doing')]),
    task('T3', [state(0, 'doing'), estimate(3, 80, 'R3', 'PT3'), state(107, 'waiting', 'doing')]),
    task('T4', [state(0, 'doing'), estimate(4, 90, 'R4', 'PT4'), state(106, 'waiting', 'doing')]),
    task('T5', [state(0, 'doing'), estimate(5, 100, 'R5', 'PT5'), state(112, 'waiting', 'doing')]),
    task('T6', [state(0, 'doing'), estimate(6, 100, 'R6', 'PT6'), state(113, 'waiting', 'doing')]),
    task('T7', [state(0, 'doing'), estimate(7, 100, undefined, 'PT7'), state(114, 'waiting', 'doing')]),
    task('T8', [state(0, 'doing'), estimate(8, 100, 'R8', 'PT8'), state(115, 'stopped', 'doing')]),
  ];
  const runs = [run('R1', 'T1'), run('R2', 'T2'), run('R3', 'T3'), run('R4', 'T4'),
    run('R5', 'T5', { ...condition.values, effort: 'low' }),
    run('R6', 'T6', { ...condition.values, model: 'gpt-6-sol' }),
    run('R7', 'T7'), run('R8', 'T8')];
  const result = estimateExamples(query(tasks, runs), condition);
  assert.deepEqual(result.examples.map(example =>
    [example.taskId, example.estimateMinutes, example.actualMinutes]),
  [['T1', 30, 10], ['T2', 55, 106], ['T3', 80, 104]]);
  assert.equal(result.examples[0]?.reportedAt, at(111));
  assert.deepEqual(estimateExamples(query(tasks, runs), { ...condition, values: { ...condition.values, effort: 'low' } })
    .examples.map(example => example.taskId), ['T5']);
  assert.deepEqual(estimateExamples(query(tasks, runs), { ...condition, values: { ...condition.values, effort: 'medium' } }).examples, []);
});

test('a done report hands the work over, to done or to the user\'s review; a question does not', () => {
  // A question keeps the Task doing, and the round goes on until the work is handed over.
  const tasks = [task('T1', [state(0, 'doing'), estimate(1, 40, 'R1', 'PT1'), record(10, 'asked'),
    record(20, 'answered'), state(30, 'done', 'doing')]),
  task('T2', [state(0, 'doing'), estimate(1, 50, 'R2', 'PT2'), record(10, 'asked'),
    record(20, 'question_withdrawn'), state(40, 'waiting', 'doing'), { ...state(50, 'done', 'waiting'), kind: 'review_approved' }])];
  assert.deepEqual(estimateExamples(query(tasks, [run('R1', 'T1'), run('R2', 'T2')]), condition).examples
    .map(example => [example.taskId, example.estimateMinutes, example.actualMinutes, example.reportedAt]),
  [['T2', 50, 39, at(40)], ['T1', 40, 29, at(30)]], 'the user\'s confirmation of the review hands over nothing more');
  // A hold's return to the review is not a hand-over of its own.
  const returned = [task('T1', [state(0, 'doing'), estimate(1, 40, 'R1', 'PT1'), state(10, 'waiting', 'doing'),
    state(15, 'held', 'waiting'), state(20, 'waiting', 'held')])];
  assert.deepEqual(estimateExamples(query(returned, [run('R1', 'T1')]), condition).examples
    .map(example => example.reportedAt), [at(10)]);
});

test('held time is excluded from an outcome; read errors cannot look like an empty history', () => {
  const tasks = [task('T1', [state(0, 'doing'), estimate(5, 40, 'R1', 'PT1'), record(10, 'asked'),
    state(15, 'held', 'doing'), state(75, 'doing', 'held'), state(95, 'waiting', 'doing')])];
  const runs = [run('R1', 'T1')];
  assert.equal(estimateExamples(query(tasks, runs), condition).examples[0]?.actualMinutes, 30);
  const errors = [{ code: 'runs_unavailable', message: 'Database unavailable', path: '.alpacawork/alpacawork.sqlite' }];
  assert.deepEqual(estimateExamples(query(tasks, runs, errors), condition),
    { ...condition, examples: [], errors });
});

test('a new instruction invalidates the previous estimate until the owner reports a new one', () => {
  const tasks = [task('T1', [state(0, 'doing'), estimate(1, 40, 'R1', 'PT1'), record(10, 'request_accepted'),
    state(20, 'waiting', 'doing')]),
  task('T2', [state(0, 'doing'), estimate(1, 50, 'R2', 'PT2'), record(10, 'review_sent_back'),
    estimate(11, 20, 'R2', 'PT2'), state(25, 'waiting', 'doing')])];
  assert.deepEqual(estimateExamples(query(tasks, [run('R1', 'T1'), run('R2', 'T2')]), condition).examples
    .map(example => [example.taskId, example.estimateMinutes, example.actualMinutes]), [['T2', 20, 14]]);
});

test('latest is ordered by instant even when stored timestamps use different UTC offsets', () => {
  const tasks = [task('T1', [state(0, 'doing'), estimate(1, 30, 'R1', 'PT1'),
    { ...state(30, 'waiting', 'doing'), at: '2026-10-08T09:30:00+09:00' }]),
  task('T2', [state(0, 'doing'), estimate(1, 30, 'R2', 'PT2'),
    state(31, 'waiting', 'doing')])];
  assert.deepEqual(estimateExamples(query(tasks, [run('R1', 'T1'), run('R2', 'T2')]), condition).examples
    .map(example => example.taskId), ['T2', 'T1']);
});

test('agent, speed, and newly added launch choices all separate reference outcomes', () => {
  const tasks = ['T1', 'T2', 'T3', 'T4', 'T5'].map((id, index) =>
    task(id, [state(0, 'doing'), estimate(1, 20 + index, `R${index + 1}`, `P${id}`),
      state(10 + index, 'waiting', 'doing')]));
  const runs = [
    run('R1', 'T1'),
    run('R2', 'T2', { ...condition.values, speed: 'standard' }),
    run('R3', 'T3', { ...condition.values, sandbox: 'strict' }),
    run('R4', 'T4', condition.values, 'codex'),
    run('R5', 'T5', { model: 'opus', effort: 'high' }),
  ];
  const source = query(tasks, runs);
  assert.deepEqual(estimateExamples(source, condition).examples.map(item => item.taskId), ['T1']);
  assert.deepEqual(estimateExamples(source, { ...condition, values: runs[1]!.launch.values }).examples
    .map(item => item.taskId), ['T2']);
  assert.deepEqual(estimateExamples(source, { ...condition, values: runs[2]!.launch.values }).examples
    .map(item => item.taskId), ['T3']);
  assert.deepEqual(estimateExamples(source, { ...condition, agent: 'codex' }).examples
    .map(item => item.taskId), ['T4']);
  assert.deepEqual(estimateExamples(source, { ...condition, values: runs[4]!.launch.values }).examples
    .map(item => item.taskId), ['T5']);
});

test('task get uses the latest Run of the active responsible placement when placements differ', () => {
  const tasks = [
    task('T1', [state(0, 'doing'), estimate(1, 20, 'R1', 'PT1'), state(10, 'waiting', 'doing')]),
    task('T2', [state(0, 'doing'), estimate(1, 30, 'R2', 'PT2'), state(11, 'waiting', 'doing')]),
    task('T3', []),
  ].map(item => ({ ...item, parentId: null, path: `${item.id}/index.md`, lifecycle: 'active',
    title: item.id, state: 'doing', hash: '0'.repeat(64), values: {} }));
  const runRecords = [run('R1', 'T1'),
    run('R2', 'T2', { ...condition.values, speed: 'standard' }),
    { ...run('R3', 'T3', { ...condition.values, speed: 'standard' }), placementId: 'Powner' },
    { ...run('R4', 'T3'), placementId: 'Powner' },
    { ...run('R5', 'T3', { ...condition.values, speed: 'standard' }), placementId: 'Pworker' },
  ];
  const source = { root: '/synthetic', tasks, runRecords, runs: [], errors: [],
    fields: { catalog: fieldCatalog([]), schemas: new Map() },
    questions: new Map(tasks.map(item => [item.id, item])),
    heads: new Map(), conversationHeads: new Map([['Powner', 'R4'], ['Pworker', 'R5']]),
    openObligations: () => ({ requests: [], returns: [] }), said: new Map(), answerTexts: new Map(),
    tree: { owningProject: () => 'P0', projects: () => [], byId: new Map(), tasks: [{ id: 'P0', hash: '0'.repeat(64),
      settings: { color: '#39659b' }, meta: { id: 'P0', kind: 'project', parentId: null, lifecycle: 'active', title: 'Project' } }] },
    placements: [
      { id: 'Powner', taskId: 'T3', responsible: true, active: true },
      { id: 'Pworker', taskId: 'T3', responsible: false, active: true },
    ] } as unknown as ControlSource;
  assert.deepEqual(taskView(source, 'T3', { include: ['estimateExamples'] as const }).estimateExamples?.examples
    .map(item => item.taskId), ['T1']);
  assert.equal(taskView(source, 'T1', { include: ['estimateExamples'] as const }).estimateExamples, null);
});
