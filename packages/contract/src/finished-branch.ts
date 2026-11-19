import type { TaskLifecycle, TaskState } from '@alpacawork/raw';

/** Only facts the finished-branch rule reads; independent of storage and screen DTOs. */
export type BranchTask = { id: string; parentId: string | null; lifecycle: TaskLifecycle; state: TaskState };
/** Why a Task cannot take a state: unfinished Tasks below a finished one, or a finished Task above an unfinished one. */
export type FinishedBranchIssue = { kind: 'below'; tasks: string[] } | { kind: 'above'; task: BranchTask };

export { terminal as isFinished } from './task-policy.js';

/** Active Tasks below `id`, nearest first. An inactive Task excludes its entire branch. */
export function activeBelow(id: string, tasks: Iterable<BranchTask>): BranchTask[] {
  const children = new Map<string | null, BranchTask[]>();
  for (const task of tasks) {
    if (task.lifecycle !== 'active') continue;
    children.set(task.parentId, [...(children.get(task.parentId) ?? []), task]);
  }
  const below: BranchTask[] = [], seen = new Set([id]), pending = [...(children.get(id) ?? [])];
  while (pending.length) {
    const task = pending.shift()!;
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    below.push(task);
    pending.push(...(children.get(task.id) ?? []));
  }
  return below;
}
