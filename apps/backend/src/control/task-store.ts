import { nextWorkspaceNumber } from './workspace-number.js';
import { returnCauseIds, returnCauses } from '@alpacawork/runs';
import { liveEndpoints, liveRequestIds } from './live-endpoints.js';
import { taskLogs, taskEvent, routingHistory, TASK_RECORD_COLUMNS, TASK_RECORD_JOINS } from './task-history.js';
import { controlTaskView } from './task-dto.js';
/** Task snapshots are read from the control database; the task hash is derived from identity and revision. */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { deliveryStateSchema, requestPurposeSchema } from '@alpacawork/contract/control';
import { storedTaskLogSchema, TASK_VALUE_WRITE_KINDS } from '@alpacawork/raw/task-log-schema';
import { ControlStore, taskHash, touch } from '@alpacawork/db';
import { PROJECT_SUMMARY, type FieldValue } from '@alpacawork/contract';
import { CONTROL_TASK_FORMAT, MAX_TASK_NUMBER, publicTaskId, validateControlMetadata, validateControlHead, validateAppendedLog, validateTaskSettings, userRequestedOf,
  taskMetadata, validateAnalysisSubject, type ControlMetadata, type ControlTask, type ProjectSettings, type TaskKind, type TaskLog, type TaskValues } from '@alpacawork/raw';
import { readTaskFields, valuesWriteTime, writeTaskValues, type TaskFields } from './task-values-store.js';
import type { BranchTask } from '@alpacawork/contract/branch';
import type { TaskWriter } from './task-transition.js';
import type { RoutingTask } from './routing-facts.js';
import { awaitsClosure } from './return-rules.js';
import { finishRoutingRead, type RoutingReadContext, type RoutingReadSteps } from './routing-read-work.js';
import { controlReadContext, type ControlReadContext } from './read-context.js';

export type ControlSnapshot<Values extends TaskValues | undefined = TaskValues> = {
  root: string; tasks: (Omit<ControlTask, 'values'> & { values: Values })[];
  /** The workspace's fields and each project's own schema at the same read point (task-values-store). */
  fields: TaskFields;
};
/** A view independently selects Task values and immutable history. */
type TaskValuesSelection = 'all' | { task: string };
/** A Task's values (task_values) as one JSON object column, `{}` without any. */
const VALUES_COLUMN = `(SELECT json_group_object(v.field_id, json(v.value)) FROM task_values v WHERE v.task_id = t.id)`;
const decodeValues = (column: unknown): TaskValues => JSON.parse(String(column)) as TaskValues;
export type TaskListContents =
  | { mode: 'search'; values: ReadonlyMap<string, TaskValues> }
  | { mode: 'summary'; summaries: ReadonlyMap<string, FieldValue> };
const MAX_TASK_DEPTH = 32;
/** The logical parentId graph in one Task snapshot. Physical folders are unrelated. */
export class TaskTree<T extends { id: string; meta: BranchTask & { kind: TaskKind } } = ControlTask> {
  readonly byId: ReadonlyMap<string, T>;
  private readonly childrenByParent = new Map<string, T[]>();
  constructor(readonly tasks: readonly T[]) {
    this.byId = new Map(tasks.map(task => [task.id, task]));
    for (const task of tasks) {
      const parent = task.meta.parentId;
      if (parent !== null) this.childrenByParent.set(parent, [...(this.childrenByParent.get(parent) ?? []), task]);
    }
  }
  children(id: string): T[] { return this.childrenByParent.get(id) ?? []; }
  descendants(id: string): T[] {
    const result: T[] = [], pending = [...this.children(id)], seen = new Set([id]);
    while (pending.length) {
      const task = pending.pop()!;
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      result.push(task); pending.push(...this.children(task.id));
    }
    return result;
  }
  /** Also validates missing parents, cycles, and the depth limit. */
  ancestors(id: string): T[] { return [...this.upward(id)]; }
  /** The parents from `id` up, validated (missing parents, cycles, the depth limit) as far as they are read. */
  private *upward(id: string): Generator<T> {
    const seen = new Set([id]);
    let count = 0, parent = this.byId.get(id)?.meta.parentId ?? null;
    while (parent !== null) {
      const task = this.byId.get(parent);
      if (!task) throw new Problem(PROBLEM_CODE.parentUnavailable, 'Logical parent cannot be read', undefined, { reason: { kind: 'logical_parent_cannot_read' } });
      if (seen.has(parent)) throw new Problem(PROBLEM_CODE.conflict, 'Logical parent cycle', undefined, { reason: { kind: 'logical_parent_cycle' } });
      if (++count + 1 > MAX_TASK_DEPTH) throw new Problem(PROBLEM_CODE.tooDeep, 'Logical task depth exceeds 32 levels', undefined, { reason: { kind: 'logical_task_depth_exceeds_32_levels' } });
      yield task;
      seen.add(parent); parent = task.meta.parentId;
    }
  }
  /** Root depth is 1. */
  depth(id: string): number { return this.ancestors(id).length + 1; }
  height(id: string): number {
    return Math.max(1, ...this.children(id).filter(child => child.meta.lifecycle !== 'deleted')
      .map(child => 1 + this.height(child.id)));
  }
  /** The projects holding this Task, itself included when it is one: from the root project down to the nearest. */
  projects(id: string): T[] {
    const task = this.byId.get(id);
    if (!task) throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist', { task: id }, { reason: { kind: 'task_does_not_exist' } });
    return [task, ...this.ancestors(id)].filter(item => item.meta.kind === 'project').reverse();
  }
  /**
   * The ID of the project a Task belongs to: the nearest of its `projects`, itself for a project. Only the path up to it
   * is read, so a tree without the projects above it (the screen's, which holds no archived project) still answers.
   */
  owningProject(id: string): string {
    const task = this.byId.get(id);
    if (!task) throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist', { task: id }, { reason: { kind: 'task_does_not_exist' } });
    if (task.meta.kind === 'project') return task.id;
    for (const ancestor of this.upward(id)) if (ancestor.meta.kind === 'project') return ancestor.id;
    throw new Problem(PROBLEM_CODE.parentUnavailable, 'Task has no project', { task: id }, { reason: { kind: 'task_has_no_project' } });
  }
}

export function controlSnapshotView<Values extends TaskValues | undefined>(snapshot: Pick<ControlSnapshot<Values>, 'root' | 'tasks'>) {
  return { root: snapshot.root, tasks: snapshot.tasks.map(controlTaskView) };
}

/** The refusal of a write to a Task no longer active. */
export function assertActive(task: Pick<ControlTask, 'id' | 'meta'>): void {
  if (task.meta.lifecycle !== 'active')
    throw new Problem(PROBLEM_CODE.conflict, 'Task is not active', { task: task.id }, { reason: { kind: 'task_not_active' } });
}
/** The refusal of a write to a Task changed since its caller read it. */
export function assertAtHash(task: Pick<ControlTask, 'id' | 'hash'>, expectedHash: string): void {
  if (task.hash !== expectedHash)
    throw new Problem(PROBLEM_CODE.conflict, 'Task changed; reload before retrying', { task: task.id, hash: task.hash }, { reason: { kind: 'task_changed' } });
}

/** One read at its own read point on its own read-only connection, waiting out a writer as a Task read does. */
export function readControl<T>(root: string, read: (db: DatabaseSync) => T): T {
  const store = new ControlStore(root, { busyTimeoutMs: 10_000 }, true);
  try { return store.read(read); } finally { store.close(); }
}

/** A Task's folder in the data directory, `tasks/T42`: the only place that says where a Task's files are. */
export function taskFolder(id: string) { return `tasks/${id}`; }
/**
 * The Tasks a read of one project takes: the project's own (index tasks_project) and every project Task, as settings
 * and ancestry cross projects and projects are few. A project is the Task without a project, so both halves use the
 * index. The one parameter is the project Task's ID.
 */
const PROJECT_READ = 't.project_task_id IS NULL OR t.project_task_id = (SELECT id FROM tasks WHERE external_id = ?)';
const scoped = (project: string | undefined): { where: string; parameters: string[] } =>
  project === undefined ? { where: '', parameters: [] } : { where: `WHERE ${PROJECT_READ}`, parameters: [project] };
const TASK_METADATA_COLUMNS = `t.id,t.kind,t.number,t.external_id,t.parent_id,t.project_task_id,t.title,
  t.lifecycle,t.base_state,t.hold,t.state,t.user_requested,t.settings,t.analysis_subject,t.revision,t.created_at,t.updated_at`;

/** The projects above `project`, nearest first. */
export function projectsAbove(db: DatabaseSync, project: string): string[] {
  return db.prepare(`WITH RECURSIVE up(id, depth) AS (
      SELECT parent_id, 1 FROM tasks WHERE external_id = ? AND parent_id IS NOT NULL
      UNION ALL SELECT t.parent_id, up.depth + 1 FROM tasks t JOIN up ON t.id = up.id WHERE t.parent_id IS NOT NULL AND up.depth < 32)
    SELECT t.external_id FROM up JOIN tasks t ON t.id = up.id WHERE t.kind = 'project' ORDER BY up.depth`).all(project)
    .map(row => String(row.external_id));
}

function readTaskRows(db: DatabaseSync, project: string | undefined, taskIds: readonly string[] | undefined,
  content: string, parameters: readonly string[]) {
  const scope = taskIds === undefined ? scoped(project)
    : { where: `WHERE t.external_id IN (SELECT value FROM json_each(?))${project === undefined ? '' : ` AND (${PROJECT_READ})`}`,
      parameters: [JSON.stringify(taskIds), ...(project === undefined ? [] : [project])] };
  // Keep every metadata column so conversion failures are part of the whole-read failure.
  return db.prepare(`SELECT ${TASK_METADATA_COLUMNS}, ${content}, parent.external_id AS parent_external_id FROM tasks t
    LEFT JOIN tasks parent ON parent.id = t.parent_id ${scope.where} ORDER BY t.number`).all(...parameters, ...scope.parameters);
}

function readTaskList(db: DatabaseSync, root: string, mode: TaskListContents['mode'], project: string | undefined) {
  const [column, content, ...contentParameters] = mode === 'search' ? ['task_values', VALUES_COLUMN]
    : ['project_summary', '(SELECT v.value FROM task_values v WHERE v.task_id = t.id AND v.field_id = ?)', PROJECT_SUMMARY];
  // Every project can lead the path. Its values follow the same project and ancestor grant as task get.
  const permission = project === undefined ? '1'
    : "(t.kind = 'task' OR t.external_id IN (SELECT value FROM json_each(?)))";
  const permissionParameters = project === undefined ? [] : [JSON.stringify([project, ...projectsAbove(db, project)])];
  const selection = mode === 'search' ? permission : `${permission} AND t.kind = 'project'`;
  const rows = readTaskRows(db, project, undefined, `CASE WHEN ${selection} THEN ${content} END AS ${column}`,
    [...permissionParameters, ...contentParameters]);
  const tasks = rows.map(row => ({ ...decodeTaskMetadata(row, []), values: undefined }));
  const contents: TaskListContents = mode === 'search'
    ? { mode, values: new Map(rows.flatMap(row => row.task_values === null ? []
      : [[String(row.external_id), decodeValues(row.task_values)]])) }
    : { mode, summaries: new Map(rows.flatMap(row => row.project_summary === null ? []
      : [[String(row.external_id), JSON.parse(String(row.project_summary)) as FieldValue]])) };
  return { root, tasks, contents };
}
/** Current raw metadata is shared at one guarded DB read point; documents and values remain caller-owned. */
export function readTaskMetadataRows(db: DatabaseSync, ids: readonly string[],
  context: Pick<ControlReadContext, 'many'> | undefined = controlReadContext(db)): Map<string, Readonly<Record<string, unknown>>> {
  const load = (missing: readonly string[]) => new Map(db.prepare(`SELECT ${TASK_METADATA_COLUMNS},parent.external_id AS parent_external_id
    FROM tasks t LEFT JOIN tasks parent ON parent.id=t.parent_id
    WHERE t.external_id IN (SELECT value FROM json_each(?)) ORDER BY t.number`).all(JSON.stringify(missing))
    .map(row => [String(row.external_id), Object.freeze(row)]));
  return context ? context.many('task_metadata', ids, load) : load(ids);
}
/** One project's Tasks with every project Task (`PROJECT_READ`), or without a project the whole workspace's. */
function readTasks(db: DatabaseSync, root: string, project: string | undefined,
  values?: 'all', taskIds?: readonly string[], history?: 'all' | 'none' | readonly string[]): ControlSnapshot;
function readTasks(db: DatabaseSync, root: string, project: string | undefined,
  values: TaskValuesSelection, taskIds?: readonly string[], history?: 'all' | 'none' | readonly string[]): ControlSnapshot<TaskValues | undefined>;
function readTasks(db: DatabaseSync, root: string, project: string | undefined,
  values: TaskValuesSelection = 'all', taskIds?: readonly string[],
  history: 'all' | 'none' | readonly string[] = 'all'): ControlSnapshot<TaskValues | undefined> {
  const [body, ...parameters] = values === 'all' ? [VALUES_COLUMN] : [`CASE WHEN t.external_id = ? THEN ${VALUES_COLUMN} END`, values.task];
  const rows = readTaskRows(db, project, taskIds, `${body} AS task_values`, parameters);
  const selectedHistory = history === 'all' ? rows.map(row => String(row.id)) : history === 'none' ? []
    : rows.filter(row => history.includes(String(row.external_id))).map(row => String(row.id));
  const logs = taskLogs(db, root, selectedHistory);
  const tasks = rows.map(row => ({ ...decodeTaskMetadata(row, logs.get(String(row.id)) ?? []),
    values: row.task_values === null ? undefined : decodeValues(row.task_values) }));
  return { root, tasks, fields: readTaskFields(db) };
}
/**
 * Sparse Requests need the preceding state once per Task, then only changes between their first and last ordinal.
 * Read state columns without decoding unrelated events, as the old indexed predecessor lookup did.
 */
function requestStates(db: DatabaseSync, rows: readonly Record<string, unknown>[]): Map<string, TaskLog['fromState']> {
  const ordinal = (row: Record<string, unknown>) => BigInt(String(row.ordinal));
  const requests = rows.filter(row => row.request_id !== null).sort((a, b) => ordinal(a) < ordinal(b) ? -1 : ordinal(a) > ordinal(b) ? 1 : 0);
  const result = new Map<string, TaskLog['fromState']>();
  if (!requests.length) return result;
  const changes = db.prepare(`WITH selected AS (
      SELECT task_id,min(ordinal) AS first,max(ordinal) AS last FROM task_log
      WHERE id IN (SELECT value FROM json_each(?)) GROUP BY task_id
    ) SELECT p.task_id,CAST(p.ordinal AS TEXT) AS ordinal,
      CASE WHEN json_extract(p.entry,'$.stage.version')=1 THEN
        CASE WHEN json_extract(p.entry,'$.stage.hold') THEN 'held' ELSE json_extract(p.entry,'$.stage.baseState') END
        ELSE json_extract(p.entry,'$.toState') END AS state
      FROM selected s CROSS JOIN task_log p ON p.task_id=s.task_id
      WHERE p.ordinal>=coalesce((SELECT prior.ordinal FROM task_log prior
        WHERE prior.task_id=s.task_id AND prior.ordinal<s.first AND json_extract(prior.entry,'$.toState') IS NOT NULL
        ORDER BY prior.ordinal DESC LIMIT 1),s.first)
        AND p.ordinal<s.last AND json_extract(p.entry,'$.toState') IS NOT NULL
      ORDER BY p.task_id,p.ordinal`).all(JSON.stringify(requests.map(row => row.id)));
  const byTask = new Map<string, typeof changes>();
  for (const change of changes) {
    const id = String(change.task_id), group = byTask.get(id) ?? [];
    group.push(change); byTask.set(id, group);
  }
  const positions = new Map<string, number>();
  for (const row of requests) {
    const id = String(row.task_id), states = byTask.get(id) ?? [];
    let position = positions.get(id) ?? 0;
    while (position < states.length && ordinal(states[position]!) < ordinal(row)) position++;
    positions.set(id, position);
    result.set(String(row.id), position === 0 ? null : states[position - 1]!.state as TaskLog['fromState']);
  }
  return result;
}
/** Shared codec for a snapshot and a targeted read; both include the same immutable history. */
function decodeTask(row: Record<string, unknown>, log: TaskLog[]): ControlTask {
  return { ...decodeTaskMetadata(row, log), values: decodeValues(row.task_values) };
}
function decodeTaskMetadata(row: Record<string, unknown>, log: TaskLog[]): Omit<ControlTask, 'values'> {
  const id = String(row.external_id), uuid = String(row.id), revision = Number(row.revision);
  const kind = String(row.kind) as TaskKind;
  const analysisSubject = row.analysis_subject === null ? undefined : validateAnalysisSubject(kind, JSON.parse(String(row.analysis_subject)));
  const meta = taskMetadata({ format: CONTROL_TASK_FORMAT, id, kind,
    parentId: row.parent_id === null ? null : String(row.parent_external_id),
    lifecycle: String(row.lifecycle) as ControlMetadata['lifecycle'], title: String(row.title),
    version: BigInt(revision), baseState: String(row.base_state) as ControlMetadata['baseState'], hold: Boolean(row.hold),
    userRequested: Boolean(row.user_requested), analysisSubject, log });
  return { id, path: taskFolder(id), meta,
    settings: validateTaskSettings(meta.kind, row.settings === null ? null : JSON.parse(String(row.settings))),
    hash: taskHash(uuid, revision) };
}
/** Only routing-relevant history and fixed return causes cross this read boundary; documents and values do not. */
export function readRoutingTasks(db: DatabaseSync, ids: readonly string[], seats: readonly string[], root: string, context?: RoutingReadContext): RoutingTask[] {
  return finishRoutingRead(readRoutingTaskSteps(db, ids, seats, root, context));
}
/** The caller owns one SQLite read point across every checkpoint; no business decision crosses that boundary. */
export function* readRoutingTaskSteps(db: DatabaseSync, ids: readonly string[], seats: readonly string[], root: string, context: RoutingReadContext | undefined = controlReadContext(db)): RoutingReadSteps<RoutingTask[]> {
  if (!ids.length) return [];
  const selected = JSON.stringify(ids);
  const metadata = readTaskMetadataRows(db, ids, context);
  const rows = [...metadata.values()].sort((a, b) => Number(a.number) - Number(b.number));
  yield;
  const history = new Set(seats);
  const pendingIds = liveRequestIds(db, root, seats);
  const pending = db.prepare(`SELECT q.task_id,q.purpose,q.delivery_state FROM requests q
    WHERE q.id IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM returns closed WHERE closed.request_id=q.id)`).all(JSON.stringify(pendingIds));
  yield;
  for (const request of pending) {
    if (awaitsClosure({ purpose: requestPurposeSchema.parse(request.purpose),
      deliveryState: deliveryStateSchema.parse(request.delivery_state) })) history.add(String(request.task_id));
    yield;
  }
  const questionOrigins = db.prepare(`SELECT DISTINCT t.external_id FROM task_log l JOIN tasks t ON t.id=l.task_id
    WHERE l.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify([...returnCauseIds(db, root, seats, true)]));
  yield;
  for (const row of questionOrigins) { history.add(String(row.external_id)); yield; }
  // Question applicability reads historical lifecycle only at its origin and containing project.
  // Intermediate ancestors supply current parent/kind/lifecycle metadata, never their history.
  for (const id of [...history]) {
    const seen = new Set<string>();
    let current = metadata.get(id);
    while (current && !seen.has(String(current.external_id))) {
      seen.add(String(current.external_id));
      if (current.kind === 'project') { history.add(String(current.external_id)); break; }
      current = current.parent_external_id === null ? undefined : metadata.get(String(current.parent_external_id));
    }
    yield;
  }
  const causes = returnCauses(db, seats);
  const logs = taskLogs(db, root, rows.map(row => String(row.id)));
  for (const row of rows) {
    const uuid = String(row.id), relevant = history.has(String(row.external_id));
    logs.set(uuid, routingHistory(logs.get(uuid)!, relevant, causes.get(uuid) ?? new Set()));
    yield;
  }
  const byId = new Map<string, RoutingTask>();
  for (const row of rows) {
    const id = String(row.external_id);
    const meta: RoutingTask['meta'] = {
      id, kind: String(row.kind) as ControlMetadata['kind'], parentId: row.parent_id === null ? null : String(row.parent_external_id),
      lifecycle: String(row.lifecycle) as ControlMetadata['lifecycle'], title: String(row.title),
      baseState: String(row.base_state) as ControlMetadata['baseState'], hold: Boolean(row.hold),
      state: String(row.state) as ControlMetadata['state'], userRequested: Boolean(row.user_requested), log: logs.get(String(row.id)) ?? [],
    };
    byId.set(id, { id, meta, hash: taskHash(String(row.id), Number(row.revision)) });
    yield;
  }
  return ids.map(id => {
    const task = byId.get(id);
    if (!task) throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist', { task: id }, { reason: { kind: 'task_does_not_exist' } });
    return task;
  });
}
export function readTask(db: DatabaseSync, id: string, values?: 'all', root?: string): ControlTask;
export function readTask(db: DatabaseSync, id: string, values: 'none', root?: string): Omit<ControlTask, 'values'> & { values: undefined };
export function readTask(db: DatabaseSync, id: string, values: 'all' | 'none' = 'all', root?: string): Omit<ControlTask, 'values'> & { values: TaskValues | undefined } {
  const task = readTaskDocuments(db, [id], values, root)[0];
  if (!task) throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist', { task: id }, { reason: { kind: 'task_does_not_exist' } });
  return task;
}
/** Current rows own membership; decoding is shared across selected documents at this read point. */
function readTaskDocuments(db: DatabaseSync, ids: readonly string[], values: 'all', root?: string): ControlTask[];
function readTaskDocuments(db: DatabaseSync, ids: readonly string[], values: 'all' | 'none', root?: string):
  (Omit<ControlTask, 'values'> & { values: TaskValues | undefined })[];
function readTaskDocuments(db: DatabaseSync, ids: readonly string[], values: 'all' | 'none', root?: string):
  (Omit<ControlTask, 'values'> & { values: TaskValues | undefined })[] {
  const selected = JSON.stringify(ids);
  const rows = [...readTaskMetadataRows(db, ids).values()];
  const taskValues = values === 'all' ? new Map(db.prepare(`SELECT t.external_id,${VALUES_COLUMN} AS task_values
    FROM tasks t WHERE t.external_id IN (SELECT value FROM json_each(?))`).all(selected)
    .map(row => [String(row.external_id), row.task_values])) : undefined;
  const logs = taskLogs(db, root, rows.map(row => String(row.id)));
  return rows.map(row => values === 'all' ? decodeTask({ ...row, task_values: taskValues!.get(String(row.external_id)) }, logs.get(String(row.id)) ?? [])
    : { ...decodeTaskMetadata(row, logs.get(String(row.id)) ?? []), values: undefined });
}

type TaskBranchRecord = { id: string; meta: BranchTask & { kind: TaskKind; baseState: ControlMetadata['baseState']; hold: boolean } };
function decodeTaskBranch(row: Record<string, unknown>): TaskBranchRecord {
  const id = String(row.external_id);
  return { id, meta: { id, kind: String(row.kind) as TaskKind, parentId: row.parent_id === null ? null : String(row.parent_id),
    lifecycle: String(row.lifecycle) as BranchTask['lifecycle'], baseState: String(row.base_state) as ControlMetadata['baseState'],
    hold: Boolean(row.hold), state: String(row.state) as BranchTask['state'] } };
}
/**
 * Reads Task documents in the caller's transaction (ControlStore.write's) and numbers new ones. Saving a Task is
 * TaskTransition's alone, through `taskWriter`.
 */
export class TaskRepository {
  constructor(readonly root: string, readonly connection: DatabaseSync) {}
  get(id: string): ControlTask { return readTask(this.connection, id, 'all', this.root); }
  /** Read selected documents together, without warming unrelated workspace history. */
  getMany(ids: readonly string[]): ControlTask[] {
    const byId = new Map(readTaskDocuments(this.connection, ids, 'all', this.root).map(task => [task.id, task]));
    return ids.map(id => {
      const task = byId.get(id);
      if (!task) throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist', { task: id }, { reason: { kind: 'task_does_not_exist' } });
      return task;
    });
  }
  /** A history consumer needs complete metadata and events, without the unrelated values. */
  metadataWithHistory(id: string): Omit<ControlTask, 'values'> & { values: undefined } {
    return readTask(this.connection, id, 'none', this.root);
  }
  /** Coordinator write receipts consume the same events as every Task reader. */
  events(ids: readonly string[]): Map<string, TaskLog> {
    const rows = this.connection.prepare(`SELECT l.task_id,CAST(l.ordinal AS TEXT) AS ordinal,${TASK_RECORD_COLUMNS} FROM task_log l ${TASK_RECORD_JOINS}
      WHERE l.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids));
    const states = requestStates(this.connection, rows);
    return new Map(rows.map(row => {
      const event = taskEvent(row, states.get(String(row.id)) ?? null); return [event.id, event];
    }));
  }
  /** One project's Tasks with every project Task, or without a project the whole workspace's (`PROJECT_READ`). */
  snapshot(project?: string, taskIds?: readonly string[]): ControlSnapshot {
    return readTasks(this.connection, this.root, project, 'all', taskIds);
  }
  /** The write's branch, the endpoints of its Requests and returns, and their ancestry. */
  related(id: string, extra: readonly string[] = []): ControlSnapshot {
    return this.snapshot(undefined, this.relatedIds([id, ...extra]));
  }
  relatedIds(taskIds: readonly string[]): string[] {
    return liveEndpoints(this.connection, this.root, taskIds, true);
  }
  /** The project a write about this Task reads (`snapshot`): the one it belongs to, itself for a project. */
  projectFor(id: string): string {
    const row = this.connection.prepare(`SELECT ifnull(p.external_id, t.external_id) AS project FROM tasks t
      LEFT JOIN tasks p ON p.id = t.project_task_id WHERE t.external_id = ?`).get(id);
    if (!row) throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist', { task: id }, { reason: { kind: 'task_does_not_exist' } });
    return String(row.project);
  }
  /** The branch rule needs identity, kind, ancestry and state, not unrelated Task text or history. */
  branch(project?: string): TaskBranchRecord[] {
    const scope = scoped(project);
    return this.connection.prepare(`SELECT t.external_id,t.kind,parent.external_id AS parent_id,t.lifecycle,t.state,t.base_state,t.hold
      FROM tasks t LEFT JOIN tasks parent ON parent.id=t.parent_id ${scope.where} ORDER BY t.number`)
      .all(...scope.parameters).map(decodeTaskBranch);
  }
  /** Only the upward path's branch facts. One extra level lets TaskTree reject an overdeep path itself. */
  ancestry(id: string): TaskBranchRecord[] {
    return this.connection.prepare(`WITH RECURSIVE path(id,depth) AS (
      SELECT id,1 FROM tasks WHERE external_id=?
      UNION ALL SELECT t.parent_id,path.depth+1 FROM tasks t JOIN path ON t.id=path.id
        WHERE t.parent_id IS NOT NULL AND path.depth<=?
    ) SELECT t.external_id,t.kind,parent.external_id AS parent_id,t.lifecycle,t.state,t.base_state,t.hold,
      t.parent_id IS NOT NULL AND parent.id IS NULL AS missing_parent
      FROM path JOIN tasks t ON t.id=path.id LEFT JOIN tasks parent ON parent.id=t.parent_id ORDER BY path.depth`)
      .all(id, MAX_TASK_DEPTH).map(row => {
        if (row.missing_parent) throw new Problem(PROBLEM_CODE.parentUnavailable, 'Logical parent cannot be read', undefined,
          { reason: { kind: 'logical_parent_cannot_read' } });
        return decodeTaskBranch(row);
      });
  }
  /**
   * Takes the next shared public number in this transaction and inserts the Task `document` makes for it. A task belongs to its parent if that is a project, else to its
   * parent's project; a project belongs to none.
   */
  create(kind: ControlMetadata['kind'], document: (id: string) => { meta: ControlMetadata; values: TaskValues; settings?: ProjectSettings }): string {
    const number = nextWorkspaceNumber(this.connection);
    const id = publicTaskId(kind, number), { meta, values, settings } = document(id);
    const checkedSettings = validateTaskSettings(meta.kind, settings ?? null);
    const checkedMeta = validateControlMetadata(meta);
    if (meta.id !== id || meta.kind !== kind) throw new Problem(PROBLEM_CODE.invalidInput, 'Task identity mismatch', undefined, { reason: { kind: 'task_identity_mismatch' } });
    const parent = meta.parentId === null ? null
      : this.connection.prepare('SELECT id,kind,project_task_id FROM tasks WHERE external_id = ?').get(meta.parentId);
    if (meta.parentId !== null && !parent) throw new Problem(PROBLEM_CODE.parentUnavailable, 'Parent Task does not exist', undefined, { reason: { kind: 'parent_task_does_not_exist' } });
    const project = meta.kind === 'project' || !parent ? null
      : parent.kind === 'project' ? String(parent.id) : String(parent.project_task_id);
    const uuid = randomUUID(), at = new Date().toISOString();
    this.connection.prepare(`INSERT INTO tasks(id,kind,number,parent_id,project_task_id,title,lifecycle,base_state,hold,
      user_requested,settings,analysis_subject,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(uuid, meta.kind, number,
      parent ? String(parent.id) : null, project, meta.title, meta.lifecycle, meta.baseState, meta.hold ? 1 : 0,
      userRequestedOf(meta.log) ? 1 : 0, checkedSettings === null ? null : JSON.stringify(checkedSettings),
      checkedMeta.analysisSubject ? JSON.stringify(checkedMeta.analysisSubject) : null, 1, at, at);
    touch(this.connection, { kind: 'task', id });
    insertLogs(this.connection, uuid, 0, meta.log);
    if (Object.keys(values).length) writeTaskValues(this.connection, id, values, valuesWriteTime(meta.log), meta.log[0]?.id);
    return id;
  }
}

/**
 * The writes of Task documents and their log, for TaskTransition alone: task-transition.ts is the only importer, and
 * tests/no-legacy-identifiers.test.ts (WRITER_PORTS) refuses any other caller of what it returns.
 */
export function taskWriter(connection: DatabaseSync): TaskWriter {
  return {
    save: (id, expectedHash, meta, previousLength, values, settings, texts) =>
      saveTask(connection, id, expectedHash, meta, previousLength, values, settings, texts),
    saveBatch: changes => {
      for (const change of changes) saveTask(connection, change.id, change.expectedHash, change.meta, change.previousLength);
    },
    insertLogs: (taskUuid, previous, entries, texts) => insertLogs(connection, taskUuid, previous, entries, texts),
  };
}
/**
 * Writes the Task's next revision (`meta.version`) and returns its new hash. The user's-request column follows the
 * log, its only source. `values` replace the Task's values whole and `settings` a project's own settings; left out,
 * they stay.
 */
function saveTask(db: DatabaseSync, id: string, expectedHash: string | null, meta: ControlMetadata, previousLength: number, values?: TaskValues,
  settings?: ProjectSettings | null, texts?: ReadonlyMap<string, string>): string {
  const checkedMeta = validateControlHead(meta);
  if (meta.id !== id) throw new Problem(PROBLEM_CODE.invalidInput, 'Task identity mismatch', undefined, { reason: { kind: 'task_identity_mismatch' } });
  const row = db.prepare('SELECT id,revision,settings FROM tasks WHERE external_id = ?').get(id);
  if (!row) throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist', undefined, { reason: { kind: 'task_does_not_exist' } });
  const revision = Number(row.revision);
  if (expectedHash !== null && taskHash(String(row.id), revision) !== expectedHash)
    throw new Problem(PROBLEM_CODE.conflict, 'Task changed; reload before retrying', undefined, { reason: { kind: 'task_changed' } });
  if (meta.version !== BigInt(revision + 1))
    throw new Problem(PROBLEM_CODE.conflict, 'Task revision must advance once', undefined, { reason: { kind: 'task_revision_must_advance_once' } });
  const parent = meta.parentId ? db.prepare('SELECT id FROM tasks WHERE external_id = ?').get(meta.parentId) : null;
  if (meta.parentId && !parent) throw new Problem(PROBLEM_CODE.parentUnavailable, 'Parent Task does not exist', undefined, { reason: { kind: 'parent_task_does_not_exist' } });
  const last = db.prepare('SELECT id FROM task_log WHERE task_id=? ORDER BY task_log.ordinal DESC LIMIT 1').get(String(row.id));
  if (last ? last.id !== meta.log[previousLength - 1]?.id : previousLength !== 0)
    throw new Problem(PROBLEM_CODE.conflict, 'Task history cannot be rewritten', undefined, { reason: { kind: 'task_history_cannot_rewritten' } });
  const checkedSettings = validateTaskSettings(meta.kind, settings === undefined
    ? row.settings === null ? null : JSON.parse(String(row.settings)) : settings);
  db.prepare(`UPDATE tasks SET parent_id=?,kind=?,title=?,lifecycle=?,base_state=?,hold=?,user_requested=?,settings=?,analysis_subject=?,
    revision=?,updated_at=? WHERE id=?`).run(parent ? String(parent.id) : null, meta.kind, meta.title, meta.lifecycle,
    meta.baseState, meta.hold ? 1 : 0, userRequestedOf(meta.log) ? 1 : 0,
    checkedSettings === null ? null : JSON.stringify(checkedSettings),
    checkedMeta.analysisSubject ? JSON.stringify(checkedMeta.analysisSubject) : null,
    revision + 1, new Date().toISOString(), String(row.id));
  touch(db, { kind: 'task', id });
  insertLogs(db, String(row.id), previousLength, meta.log, texts);
  if (values !== undefined) {
    const appended = meta.log.slice(previousLength);
    const valueLog = appended.find(entry => TASK_VALUE_WRITE_KINDS.includes(entry.kind));
    writeTaskValues(db, id, values, valuesWriteTime(appended), valueLog?.id);
  }
  return taskHash(String(row.id), revision + 1);
}
/** SQLite's extended result code for a UNIQUE constraint. */
const SQLITE_CONSTRAINT_UNIQUE = 2067;
/**
 * Appends the entries after the `previous` log IDs, with each answer's or withdrawal's question (task_log_question:
 * its UNIQUE lets only the first close a question) and the full text `texts` holds for a new answer
 * (log_texts, fixed as written).
 */
function insertLogs(db: DatabaseSync, taskUuid: string, previousLength: number, entries: readonly TaskLog[],
  texts: ReadonlyMap<string, string> = new Map()): void {
  const added = validateAppendedLog(entries.slice(previousLength));
  const stray = [...texts.keys()].filter(id => !added.some(entry => entry.id === id));
  if (stray.length) throw new Error(`A full text belongs to a log entry written with it: ${stray.join(', ')}`);
  const position=db.prepare('SELECT max(ordinal) n FROM task_log WHERE task_id=?');position.setReadBigInts(true);
  const nextOrdinal=BigInt(String(position.get(taskUuid)!.n ?? -1))+1n;
  const insert = db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry) VALUES (?,?,?,?)');
  for (const [index, entry] of added.entries()) {
    try {
    if (entry.kind === 'request_accepted' || entry.kind === 'review_sent_back') {
      db.prepare('INSERT INTO task_log(id,task_id,ordinal,request_id,note_title,note_description) VALUES (?,?,?,?,?,?)')
        .run(entry.id, taskUuid, nextOrdinal + BigInt(index), entry.id, entry.title, entry.description);
    } else insert.run(entry.id, taskUuid, nextOrdinal + BigInt(index), JSON.stringify(storedTaskLogSchema.parse(entry)));
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'errcode' in error && [1555, 2067].includes(Number(error.errcode)))
        throw new Problem(PROBLEM_CODE.invalidInput, 'log IDs must be unique within a task', undefined, { reason: { kind: 'log_ids_must_unique_within_task' }, cause: error });
      throw error;
    }
    touch(db, { kind: 'log', id: entry.id });
    if (entry.questionId !== undefined) {
      try { db.prepare('INSERT INTO task_log_question(log_id,question_log_id) VALUES (?,?)').run(entry.id, entry.questionId); }
      catch (error) {
        if (typeof error === 'object' && error !== null && 'errcode' in error && error.errcode === SQLITE_CONSTRAINT_UNIQUE)
          throw new Problem(PROBLEM_CODE.questionClosed, 'The question is already closed', { question: entry.questionId }, { cause: error });
        throw error;
      }
    }
    const text = texts.get(entry.id);
    if (text !== undefined) db.prepare('INSERT INTO log_texts(log_id,text) VALUES (?,?)').run(entry.id, text);
  }
}

export class ControlTaskStore {
  constructor(readonly root: string) {}
  async get(id: string): Promise<ControlTask> {
    return readControl(this.root, db => readTask(db, id));
  }
  /** One project's Tasks with every project Task, or without a project the whole workspace's (`PROJECT_READ`). */
  async snapshot(project?: string, taskIds?: readonly string[]): Promise<ControlSnapshot> {
    return readControl(this.root, db => readTasks(db, this.root, project, 'all', taskIds));
  }
  /**
   * Same read point, scope and diagnostics as snapshot (a Run's read scope is its project); unread values are never
   * represented as no values.
   */
  async viewSnapshot(values: TaskValuesSelection, project?: string, taskIds?: readonly string[],
    history: 'all' | 'none' | readonly string[] = 'all'): Promise<ControlSnapshot<TaskValues | undefined>> {
    return readControl(this.root, db => readTasks(db, this.root, project, values, taskIds, history));
  }
  /** List metadata and a separate read of the contents the caller may see. */
  async listSnapshot(mode: TaskListContents['mode'], project?: string) {
    return readControl(this.root, db => readTaskList(db, this.root, mode, project));
  }
}

/** Projection reads keep field definitions and schemas separate and share the canonical history reader. */
export function readProjectionTask(db: DatabaseSync, id: string, previous?: ControlTask,
  parts: { log?: boolean; values?: boolean } = { log: true, values: true }, root?: string): ControlTask | undefined {
  const row = readTaskMetadataRows(db, [id]).get(id);
  if (!row) return undefined;
  const log = !previous || parts.log ? taskLogs(db, root, [String(row.id)]).get(String(row.id))! : previous.meta.log;
  const values = !previous || parts.values ? Object.fromEntries(db.prepare('SELECT field_id,value FROM task_values WHERE task_id=? ORDER BY field_id')
    .all(String(row.id)).map(value => [String(value.field_id), JSON.parse(String(value.value))])) : previous.values;
  return { ...decodeTaskMetadata(row, log), values };
}
