/** The sole Owner of execution-order edges, first-start eligibility and deadlock checks. */
import type { DatabaseSync } from 'node:sqlite';
import { touch } from '@alpacawork/db';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { RUN_ENDED_STATES } from '@alpacawork/contract/run';
import { isFinished } from '@alpacawork/contract/branch';
import { TaskRepository } from './task-store.js';

const STARTED_OWNER = "json_extract(record,'$.role')='owner' AND json_extract(record,'$.started_at') IS NOT NULL";
function startedTasks(db: DatabaseSync): Set<string> {
  return new Set(db.prepare(`SELECT DISTINCT task_id FROM runs WHERE ${STARTED_OWNER}`).all().map(row => String(row.task_id)));
}
function hasStarted(db: DatabaseSync, taskId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM runs WHERE task_id=? AND ${STARTED_OWNER} LIMIT 1`).get(taskId);
}
/** All requested start orders from two statements on the caller's read/write transaction. */
export function dependencyStatuses(db: DatabaseSync, taskIds: readonly string[]) {
  const selected = JSON.stringify(taskIds);
  const started = new Set(db.prepare(`SELECT DISTINCT task_id FROM runs WHERE ${STARTED_OWNER}
    AND task_id IN (SELECT value FROM json_each(?))`).all(selected).map(row => String(row.task_id)));
  const rows = db.prepare(`SELECT d.task_id,t.external_id AS task,t.title,t.state,t.base_state,t.hold,t.lifecycle,
    EXISTS(SELECT 1 FROM runs r WHERE r.task_id=t.external_id
      AND r.state NOT IN (SELECT value FROM json_each(?))) AS unfinished
    FROM task_dependencies d JOIN tasks t ON t.external_id=d.after_task_id
    WHERE d.task_id IN (SELECT value FROM json_each(?)) ORDER BY t.number`)
    .all(JSON.stringify(RUN_ENDED_STATES), selected);
  const after = new Map<string, AfterFacts[]>();
  for (const row of rows) {
    const group = after.get(String(row.task_id)) ?? [];
    group.push({ task: String(row.task), title: String(row.title), state: String(row.state), baseState: String(row.base_state),
      hold: !!row.hold, lifecycle: String(row.lifecycle), unfinished: !!row.unfinished });
    after.set(String(row.task_id), group);
  }
  return new Map(taskIds.map(id => [id, startOrderOf(started.has(id), after.get(id) ?? [])]));
}
/** What a Task's start order reads of a Task it starts after; `unfinished`: one of its Runs, any role, has not ended. */
export type AfterFacts = { task: string; title: string; state: string; baseState: string; hold: boolean; lifecycle: string; unfinished: boolean };
/**
 * A Task's start order from whether its first owner Run started and the Tasks it starts after, in their number order:
 * the one rule dependencyStatuses and the screen's projection apply.
 */
export function startOrderOf(started: boolean, after: readonly AfterFacts[]) {
  const order = { after: [] as { task: string; title: string; state: string; lifecycle: string; finished: boolean }[], started, waiting: false };
  for (const item of after) {
    const finished = (item.lifecycle !== 'active' || !item.hold && isFinished(item.baseState)) && !item.unfinished;
    order.after.push({ task: item.task, title: item.title, state: item.state, lifecycle: item.lifecycle, finished });
    if (!started && !finished) order.waiting = true;
  }
  return order;
}
export function dependencyStatus(db: DatabaseSync, taskId: string) {
  return dependencyStatuses(db, [taskId]).get(taskId)!;
}

/** All prerequisites share the same start/end graph. Ordinary owner requests to children are tree edges. */
export function assertDependencyAcyclic(db: DatabaseSync, proposed?: { requester: string; target: string }): void {
  const started = startedTasks(db);
  const tasks = db.prepare("SELECT t.external_id AS id,p.external_id AS parent FROM tasks t LEFT JOIN tasks p ON p.id=t.parent_id WHERE t.kind='task'")
    .all().map(row => ({ id: String(row.id), parent: String(row.parent) }));
  const parents = new Map(tasks.map(task => [task.id, task.parent]));
  const graph = new Map<string, Set<string>>();
  const edge = (from: string, to: string) => {
    if (!graph.has(from)) graph.set(from, new Set());
    graph.get(from)!.add(to);
  };
  for (const task of tasks) {
    if (!started.has(task.id)) edge(`start:${task.id}`, `end:${task.id}`);
    if (parents.has(task.parent)) edge(`end:${task.id}`, `end:${task.parent}`);
    for (let ancestor: string | undefined = task.parent; ancestor && parents.has(ancestor); ancestor = parents.get(ancestor))
      if (!started.has(ancestor)) edge(`start:${ancestor}`, `end:${task.id}`);
  }
  for (const row of db.prepare('SELECT task_id,after_task_id FROM task_dependencies').all())
    if (!started.has(String(row.task_id))) edge(`end:${row.after_task_id}`, `start:${row.task_id}`);
  for (const row of db.prepare(`SELECT coalesce(q.return_task_id,c.task_id) AS requester,q.task_id AS target
    FROM requests q JOIN wait_cycles c ON c.id=q.wait_cycle_id
    JOIN tasks sender ON sender.external_id=c.task_id
    WHERE (q.loan_request_id IS NOT NULL OR sender.kind='project' AND EXISTS (
      SELECT 1 FROM runs r WHERE r.request_id=q.id AND json_extract(r.record,'$.role')='owner'))
      AND q.delivery_state NOT IN ('aborted','recorded_unconfirmed')
      AND NOT EXISTS (SELECT 1 FROM returns r WHERE r.request_id=q.id)`).all())
    edge(`end:${row.target}`, `end:${row.requester}`);
  if (proposed) edge(`end:${proposed.target}`, `end:${proposed.requester}`);
  // Kahn's algorithm avoids recursion even for long dependency chains.
  const incoming = new Map<string, number>();
  for (const [from, tos] of graph) {
    if (!incoming.has(from)) incoming.set(from, 0);
    for (const to of tos) incoming.set(to, (incoming.get(to) ?? 0) + 1);
  }
  const ready = [...incoming].filter(([, count]) => count === 0).map(([id]) => id);
  for (let i = 0; i < ready.length; i++) for (const to of graph.get(ready[i]!) ?? []) {
    const count = incoming.get(to)! - 1;
    incoming.set(to, count);
    if (count === 0) ready.push(to);
  }
  if (ready.length !== incoming.size) throw new Problem(PROBLEM_CODE.conflict,
    proposed ? 'This request would make tasks wait for each other' : 'Dependencies would create a deadlock', undefined,
    { reason: { kind: proposed ? 'loan_wait_cycle' : 'dependency_cycle' } });
}

/** Replaces canonical edges on the caller's write transaction; its existing command path records History. */
export function replaceDependencies(db: DatabaseSync, input: { task: string; after: readonly string[]; expectedTaskHash: string }) {
  const repository = new TaskRepository('', db), task = repository.get(input.task);
  if (task.hash !== input.expectedTaskHash) throw new Problem(PROBLEM_CODE.conflict, 'Task changed; reload before retrying', undefined,
    { reason: { kind: 'task_changed' } });
  const project = repository.projectFor(task.id);
  if (task.meta.kind !== 'task' || input.after.some(id => {
    const after = repository.get(id);
    return after.meta.kind !== 'task' || repository.projectFor(id) !== project;
  })) throw new Problem(PROBLEM_CODE.invalidInput, 'Dependencies require Tasks in the same project', undefined,
    { reason: { kind: 'dependency_requires_same_project_tasks' } });
  if (hasStarted(db, task.id)) throw new Problem(PROBLEM_CODE.conflict, 'Dependencies cannot change after the Task first starts', undefined,
    { reason: { kind: 'dependency_task_started' } });
  const previous = dependencyStatus(db, task.id).after.map(item => item.task);
  if (previous.length === input.after.length && previous.every(id => input.after.includes(id)))
    return { changed: false, previous };
  db.prepare('DELETE FROM task_dependencies WHERE task_id=?').run(task.id);
  for (const after of previous) touch(db, { kind: 'dependency', id: JSON.stringify([task.id, after]) });
  const insert = db.prepare('INSERT INTO task_dependencies(task_id,after_task_id) VALUES (?,?)');
  for (const after of input.after) {
    insert.run(task.id, after);
    touch(db, { kind: 'dependency', id: JSON.stringify([task.id, after]) });
  }
  assertDependencyAcyclic(db);
  return { changed: true, previous };
}
