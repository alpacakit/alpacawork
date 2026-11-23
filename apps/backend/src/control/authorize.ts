/** Database facts and authorization on the entry's own connection. Pure permission rules live in contract. */
import type { DatabaseSync } from 'node:sqlite';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import type { TaskActor, TaskKind, TaskState, TaskBaseState } from '@alpacawork/raw';
import { decide, type Caller, type Action, type Decision, type Quote, type TaskFacts } from '@alpacawork/contract/command-access';
import { hasOpenUserQuestion } from '@alpacawork/raw/questions';
import { projectsAbove, readTask } from './task-store.js';
export * from '@alpacawork/contract/command-access';

/**
 * What an entry names: the Task acted on and optional words and screen Request to record.
 */
export type Target = { task: string | null; quote: Quote | null; message?: string };
/** A file write's grant: the actor decided for it and the Task whose files it may write. */
export type AuthorizedWriter = { actor: TaskActor; task: string };

/** One Task's facts as the table reads them, on the entry's connection. */
function taskFacts(db: DatabaseSync, id: string): TaskFacts {
  const row = db.prepare(`SELECT t.id, t.kind, t.state, t.base_state, t.hold, t.user_requested, parent.external_id AS parent_id,
      ifnull(project.external_id, t.external_id) AS project FROM tasks t
    LEFT JOIN tasks parent ON parent.id = t.parent_id LEFT JOIN tasks project ON project.id = t.project_task_id
    WHERE t.external_id = ?`).get(id);
  if (!row) throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist', { task: id }, { reason: { kind: 'task_does_not_exist' } });
  const kind = String(row.kind) as TaskKind, state = String(row.state) as TaskState;
  const parentId = row.parent_id === null ? null : String(row.parent_id), project = String(row.project);
  // A task belongs to its parent when that is a project (TaskRepository.create).
  return { id, kind, parentId, project, state,
    userRequested: Number(row.user_requested) === 1, baseState: String(row.base_state) as TaskBaseState, hold: Boolean(row.hold) };
}

/** A Task's facts as a state report reads them: with whether the user has an open question on it. */
export function reportTaskFacts(db: DatabaseSync, id: string): TaskFacts {
  const task = taskFacts(db, id);
  task.openUserQuestion = hasOpenUserQuestion(readTask(db, task.id, 'none').meta.log);
  return task;
}

/**
 * Reads the facts on `db`, the entry's own connection (in a write, writeOperationAsync's; it opens no other), and
 * decides; throws the refusal. A Run's own Task is always read, so that it acts and reads only in its project, and
 * only as its hold lets it. A file write returns its AuthorizedWriter, which FileJournal and task-files take.
 * server.ts's write, screen, file, coordinator, quiesce and config entries and the admin entries call it.
 */
export function authorize(db: DatabaseSync, caller: Caller, action: Extract<Action, { name: 'file.write' }>,
  target: Target): AuthorizedWriter;
export function authorize(db: DatabaseSync, caller: Caller, action: Action, target: Target): Decision;
export function authorize(db: DatabaseSync, caller: Caller, action: Action, target: Target): Decision | AuthorizedWriter {
  const task = target.task === null ? null : action.name === 'task.report' ? reportTaskFacts(db, target.task) : taskFacts(db, target.task);
  const own = caller.kind !== 'run' ? null : task !== null && caller.taskId === task.id ? task : taskFacts(db, caller.taskId);
  const decision = decide(caller, action, { task, runProject: own?.project ?? null,
    runProjectsAbove: own === null ? [] : projectsAbove(db, own.project), runState: own?.state ?? null,
    quote: target.quote, message: target.message });
  if (decision instanceof Problem) throw decision;
  if (action.name !== 'file.write') return decision;
  if (target.task === null) throw new Error('A file write names the Task whose files it writes');
  return { actor: decision.actor, task: target.task };
}
