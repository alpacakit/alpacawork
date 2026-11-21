import { expect, test } from 'vitest';
import { beforeWork } from '../src/domain/before-work';

test('a task not started shows its AI owner at work once one is placed, and waits for one until then', () => {
  expect(beforeWork({ kind: 'task', state: 'todo' }, false)).toBe('unassigned');
  expect(beforeWork({ kind: 'task', state: 'todo' }, true)).toBe('assigned');
});

test('a started task, or a project, is past what it says before work', () => {
  for (const state of ['doing', 'waiting', 'held', 'error', 'done', 'stopped'] as const)
    expect(beforeWork({ kind: 'task', state }, true)).toBeNull();
  expect(beforeWork({ kind: 'project', state: 'todo' }, false)).toBeNull();
});
