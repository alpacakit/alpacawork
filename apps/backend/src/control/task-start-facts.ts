import { dependencyStatus } from './dependencies.js';
import type { DatabaseSync } from 'node:sqlite';
import { TaskRepository, TaskTree } from './task-store.js';
import { TASK_POLICY, evaluate, type StartFacts } from '@alpacawork/contract/task-policy';

/** Only the current tree and durable stop epochs, from the caller's transaction. */
export function startPath(db: DatabaseSync, taskId: string): StartFacts['path'] {
  const tree = new TaskTree(new TaskRepository('', db).ancestry(taskId)), task = tree.byId.get(taskId);
  if (!task) throw new Error('Start Task does not exist');
  const path = [task, ...tree.ancestors(taskId)].filter(item => item.meta.kind === 'task');
  const stops = new Map(db.prepare('SELECT task_id,stop_id FROM task_stop_epochs WHERE task_id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(path.map(item => item.id))).map(row => [String(row.task_id), String(row.stop_id)]));
  return path.map(item => ({ taskId: item.id,
    baseState: item.meta.baseState, hold: item.meta.hold,
    stopId: stops.get(item.id) ?? null }));
}
export function startDecision(db: DatabaseSync, requestId: string, taskId: string) {
  const grant = db.prepare('SELECT path,intent FROM task_start_grants WHERE request_id=?').get(requestId);
  const decision = evaluate(TASK_POLICY.resumeScope, { phase: 'queued_start', targetTaskId: taskId, known: !!grant, path: startPath(db, taskId),
    fence: grant ? JSON.parse(String(grant.path)) : null, intent: grant?.intent ? JSON.parse(String(grant.intent)) : null });
  if (decision.kind !== 'reject' && dependencyStatus(db, taskId).waiting)
    return { ...decision, kind: 'wait' as const, code: 'dependencies_unfinished' as const };
  return decision;
}
