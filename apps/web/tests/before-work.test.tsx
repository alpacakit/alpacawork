import { expect, test } from 'vitest';
import type { StartOrderDTO } from '@alpacawork/contract';
import { beforeWork } from '../src/domain/before-work';

const todo = { kind: 'task' as const, state: 'todo' as const, startOrder: null };

test('a task not started shows its AI owner at work once one is placed, and waits for one until then', () => {
  expect(beforeWork(todo, false)).toBe('unassigned');
  expect(beforeWork(todo, true)).toBe('assigned');
});

test('an owned task waiting for others to finish first is not shown at work', () => {
  const startOrder = { after: [{ task: 'T2', title: 'T2', state: 'doing', finished: false, lifecycle: 'active' }], started: false, waiting: true } as StartOrderDTO;
  expect(beforeWork({ ...todo, startOrder }, true)).toBeNull();
});

test('a started task, or a project, is past what it says before work', () => {
  for (const state of ['doing', 'waiting', 'held', 'error', 'done', 'stopped'] as const)
    expect(beforeWork({ ...todo, state }, true)).toBeNull();
  expect(beforeWork({ ...todo, kind: 'project' }, false)).toBeNull();
});
