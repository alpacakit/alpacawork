/** The orders Tasks are listed in (contract/moved): the list and the search both sort by them. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byMoved, byTaskNumber, movedAt } from '@alpacawork/contract/moved';

const task = (id: string, updatedAt: string | null, parentId: string | null = null) => ({ id, parentId, updatedAt });
const run = (taskId: string, state: string, startedAt: string | null, endedAt: string | null = null) => ({ taskId, state, startedAt, endedAt });
const order = (tasks: ReturnType<typeof task>[], runs: ReturnType<typeof run>[] = []) =>
  [...tasks].sort(byMoved(movedAt(tasks, runs))).map(each => each.id);

test('a Task moves with its record, a Run\'s start or end, and anything under it', () => {
  const tasks = [task('T1', '2026-01-01T00:00:00Z'), task('T2', '2026-01-02T00:00:00Z'), task('T3', '2026-01-03T00:00:00Z'),
    task('T4', '2026-01-01T00:00:00Z'), task('T5', '2026-01-04T00:00:00Z', 'T4')];
  // T4's child moved last, so T4 moves with it; T1's Run ended after everything else.
  assert.deepEqual(order(tasks, [run('T1', 'succeeded', '2026-01-02T00:00:00Z', '2026-01-05T00:00:00Z')]), ['T1', 'T4', 'T5', 'T3', 'T2']);
  // Running is not a priority: a newer durable change stays ahead of an old live Run.
  assert.deepEqual(order(tasks, [run('T2', 'running', '2025-12-01T00:00:00Z')]), ['T4', 'T5', 'T3', 'T2', 'T1']);
  // An older Run does not move a Task back.
  assert.deepEqual(order(tasks, [run('T3', 'succeeded', '2025-12-01T00:00:00Z', '2025-12-02T00:00:00Z')]), ['T4', 'T5', 'T3', 'T2', 'T1']);
});

test('Tasks that moved at the same time keep the order they were made in, by number', () => {
  const at = '2026-01-01T00:00:00Z';
  assert.deepEqual(order([task('T10', at), task('T2', at), task('T1', null), task('T9', at)]), ['T2', 'T9', 'T10', 'T1']);
  assert.deepEqual(['T10', 'T2', 'T1'].map(id => ({ id })).sort(byTaskNumber).map(each => each.id), ['T1', 'T2', 'T10']);
});

test('live and ended Runs use actual timestamps, independent of iteration order', () => {
  const tasks = [task('T1', '2026-10-20T00:00:00Z'), task('T2', '2026-10-01T00:00:00Z'),
    task('T10', null), task('T20', '2026-10-21T00:00:00Z')];
  const runs = [run('T1', 'running', '2026-10-01T00:00:00.000Z'),
    run('T2', 'running', '2026-10-01T00:00:00.001Z'),
    run('T10', 'running', '2026-10-01T00:00:00.001Z')];
  assert.deepEqual(order(tasks, runs), ['T20', 'T1', 'T2', 'T10']);
  assert.deepEqual(order(tasks, [...runs].reverse()), ['T20', 'T1', 'T2', 'T10']);
  const ended = [...runs, run('T2', 'succeeded', '2026-10-01T00:00:00Z', '2026-10-22T00:00:00Z')];
  assert.deepEqual(order(tasks, ended), ['T2', 'T20', 'T1', 'T10']);
  assert.equal(movedAt(tasks, runs).get('T2'), Date.parse('2026-10-01T00:00:00.001Z'));
});

test('parents inherit descendant updates and Run starts/ends without running priority', () => {
  const tasks = [task('T1', null), task('T2', null), task('T3', null, 'T1'), task('T4', null, 'T3')];
  const runs = [run('T1', 'running', '2026-10-01T00:00:00Z'), run('T2', 'running', '2026-10-02T00:00:00Z'),
    run('T4', 'running', '2026-10-03T00:00:00Z')];
  assert.deepEqual(order(tasks, runs), ['T1', 'T3', 'T4', 'T2']);
  assert.deepEqual(order(tasks, runs.map(each => each.taskId === 'T4'
    ? { ...each, state: 'succeeded', endedAt: '2026-10-04T00:00:00Z' } : each)), ['T1', 'T3', 'T4', 'T2']);
  assert.deepEqual(order(tasks, [...runs, run('T2', 'running', '2026-10-05T00:00:00Z')]), ['T2', 'T1', 'T3', 'T4']);
});

test('a scoped list without its ancestor computes the same descendant timestamps', () => {
  const tasks = [task('T1', '2026-01-01T00:00:00Z', 'T999'), task('T2', '2026-01-02T00:00:00Z', 'T999'),
    task('T3', '2026-01-03T00:00:00Z', 'T1')];
  assert.deepEqual(order(tasks), ['T1', 'T3', 'T2']);
  const full = movedAt([task('T999', null), ...tasks], []);
  assert.deepEqual([...movedAt(tasks, [])], [...full].filter(([id]) => id !== 'T999'));
});
