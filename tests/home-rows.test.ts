import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TASK_BASE_STATES, type TaskBaseState } from '@alpacawork/raw';
import { projectHome, homeRowSchema, type Ball, type HomeSection } from '@alpacawork/contract';

type Task = Parameters<typeof projectHome>[0][number];
type Reason = Extract<Ball, { holder: 'user' }>['reason'];
const task = (id = 'T1', fields: Partial<Task> = {}): Task => ({ id, parentId: 'P1', kind: 'task', lifecycle: 'active',
  baseState: 'doing', hold: false, summary: { done: 2, total: 3 }, ...fields });
const ball = (reason: Reason): Ball => ({ holder: 'user', reason, at: '2026-10-30T00:00:00Z', key: 'L1',
  questionId: reason === 'question' ? 'L1' : null, aboutRunId: null, count: reason === 'limit' ? 1 : null,
  code: reason === 'blocked' ? 'no_profile' : null, failure: null });
// Independent prose oracle: no product rule, section table or derived result supplies an expectation.
function oracle(top: boolean, state: TaskBaseState, hold: boolean, turn: Reason | null, working: boolean): HomeSection | null {
  const turnSection = turn === 'review' || turn === 'question' ? 'review' : 'error';
  if (!top) return turn === null ? null : turnSection;
  if (hold) return 'held';
  if (turn !== null) return turnSection;
  if (state === 'error') return 'error';
  if (state === 'waiting') return 'review';
  if (state === 'todo') return 'todo';
  if (state === 'done' || state === 'stopped') return 'done';
  return working ? 'doing' : 'awaited';
}

test('all 336 top/child, state, hold, turn and work combinations match the independent oracle', () => {
  let cells = 0;
  for (const top of [true, false]) for (const baseState of TASK_BASE_STATES) for (const hold of [false, true])
    for (const turn of [null, 'review', 'question', 'failed', 'limit', 'unconfirmed', 'blocked'] as const)
      for (const working of [false, true]) {
        const input = task('T2', { parentId: top ? 'P1' : 'T1', baseState, hold });
        const tasks = top ? [input] : [task(), input];
        const actual = projectHome(tasks, turn === null ? {} : { T2: ball(turn) }, new Set(working ? ['T2'] : []));
        assert.equal(actual.find(row => row.taskId === 'T2')?.section ?? null, oracle(top, baseState, hold, turn, working),
          JSON.stringify({ top, baseState, hold, turn, working }));
        for (const row of actual) assert.deepEqual(homeRowSchema.parse(row), row);
        cells++;
      }
  assert.equal(cells, 336);
});

test('work propagates from a grandchild through a held child, regardless of input order', () => {
  for (const reverse of [false, true]) {
    const tasks = [task(), task('T2', { parentId: 'T1', hold: true }), task('T3', { parentId: 'T2' })];
    if (reverse) tasks.reverse();
    assert.deepEqual(projectHome(tasks, {}, new Set(['T3'])), [{ taskId: 'T1', section: 'doing', summary: { done: 2, total: 3 } }]);
  }
});

test('work is listed once, on the highest Task no doing row above lists it', () => {
  // T1 awaits the user's answer; T2 works (and T3 under it); T4 has a question of its own above working T5.
  const tasks = [task(), task('T2', { parentId: 'T1' }), task('T3', { parentId: 'T2' }), task('T4', { parentId: 'T1' }),
    task('T5', { parentId: 'T4' })];
  const rows = (balls: Record<string, Ball>, hold = false) => projectHome(tasks.map(t => t.id === 'T1' ? { ...t, hold } : t), balls,
    new Set(['T3', 'T5'])).map(row => [row.taskId, row.section]);
  assert.deepEqual(rows({ T1: ball('question'), T4: ball('question') }), [['T1', 'review'], ['T2', 'doing'], ['T4', 'review'], ['T5', 'doing']]);
  assert.deepEqual(rows({ T4: ball('question') }, true), [['T1', 'held'], ['T2', 'doing'], ['T4', 'review'], ['T5', 'doing']]);
  // While the top Task works, its row lists all of it: subtasks show only for the user's turn.
  assert.deepEqual(rows({ T4: ball('question') }), [['T1', 'doing'], ['T4', 'review']]);
});

test('inactive branches and project boundaries stop work propagation; every project has top rows', () => {
  const tasks = [task(), task('T2', { parentId: 'T1', lifecycle: 'archived' }), task('T3', { parentId: 'T2' }),
    task('P2', { parentId: 'T1', kind: 'project' }), task('T4', { parentId: 'P2' }), task('T5', { parentId: 'T999' })];
  assert.deepEqual(projectHome(tasks, {}, new Set(['T3', 'T4'])).map(row => [row.taskId, row.section]),
    [['T1', 'awaited'], ['T3', 'doing'], ['T4', 'doing'], ['T5', 'awaited']]);
});

test('held children with turns remain rows and input order is preserved, independently of their parent', () => {
  const tasks = [task('T3', { parentId: 'T1', hold: true }), task('T2', { parentId: 'T1' }), task('T1', { baseState: 'done' })];
  assert.deepEqual(projectHome(tasks, { T3: ball('question'), T2: ball('blocked') }, new Set()).map(row => [row.taskId, row.section]),
    [['T3', 'review'], ['T2', 'error'], ['T1', 'done']]);
});

test('non-user balls do not expose children and top rows ignore the old userRequested mark', () => {
  for (const ownBall of [{ holder: 'owner' }, { holder: 'child' }, { holder: 'parent', reason: 'question' }, { holder: 'parent', reason: 'failed' }] as Ball[])
    assert.deepEqual(projectHome([task(), task('T2', { parentId: 'T1' })], { T2: ownBall }, new Set()).map(row => row.taskId), ['T1']);
});

test('cycles, including a disconnected cycle, are rejected', () => {
  assert.throws(() => projectHome([task('T1', { parentId: 'T1' })], {}, new Set()), /Cyclic/);
  assert.throws(() => projectHome([task('T1'), task('T2', { parentId: 'T3' }), task('T3', { parentId: 'T2' })], {}, new Set()), /Cyclic/);
});
