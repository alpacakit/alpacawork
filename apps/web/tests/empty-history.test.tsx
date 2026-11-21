import { expect, test } from 'vitest';
import { emptyHistory } from '../src/domain/empty-history';

test('a task not started says whether sending it something also assigns its AI', () => {
  expect(emptyHistory({ kind: 'task', state: 'todo' }, false)).toBe('unowned');
  expect(emptyHistory({ kind: 'task', state: 'todo' }, true)).toBe('idle');
});

test('a started task, or a project, says nothing in place of its rows', () => {
  for (const state of ['doing', 'waiting', 'held', 'error', 'done', 'stopped'] as const)
    expect(emptyHistory({ kind: 'task', state }, true)).toBeNull();
  expect(emptyHistory({ kind: 'project', state: 'todo' }, false)).toBeNull();
});
