import type { DatabaseSync } from 'node:sqlite';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { MAX_TASK_NUMBER } from '@alpacawork/raw';

export function nextWorkspaceNumber(db: DatabaseSync): number {
  const number = Number(db.prepare(`UPDATE task_sequence SET next_number = next_number + 1
    WHERE singleton = 1 RETURNING next_number - 1 AS number`).get()!.number);
  if (number > MAX_TASK_NUMBER) throw new Problem(PROBLEM_CODE.idExhausted, 'Task number limit reached', undefined,
    { reason: { kind: 'task_number_limit_reached' } });
  return number;
}
