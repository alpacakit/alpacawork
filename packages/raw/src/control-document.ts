/** Task metadata validation and views shared by the control database. */
import { randomUUID } from 'node:crypto';
import { Problem, PROBLEM_CODE, faultReason } from '@alpacawork/core';
import { fields, text, taskId, taskState, now } from './document.js';
import { parseTaskId } from './task-id.js';
import { TASK_KIND, TASK_BASE_STATES, TASK_LIFECYCLES, effectiveTaskState, type TaskBaseState, type TaskKind, type TaskLifecycle, type TaskState } from './task-enums.js';
import { taskLogSchema, type TaskActor, type TaskLog } from './task-log-schema.js';
export type { TaskActor, TaskLog } from './task-log-schema.js';
import { analysisSubjectSchema, type AnalysisSubject } from './analysis-subject.js';
import { ESTIMATE_MINUTES, MAX_TITLE_LENGTH } from './values.js';

export const CONTROL_TASK_FORMAT = 3n;
export type ControlMetadata = {
  format: bigint; id: string; kind: TaskKind; parentId: string | null; lifecycle: TaskLifecycle;
  title: string; version: bigint; baseState: TaskBaseState; hold: boolean; readonly state: TaskState;
  userRequested: boolean; analysisSubject: AnalysisSubject | undefined; log: TaskLog[];
};
/** Current metadata carries a derived status accessor, never a second mutable state. */
export function taskMetadata(fields: Omit<ControlMetadata, 'state'>): ControlMetadata {
  return Object.defineProperty(fields, 'state', { enumerable: true, configurable: true,
    get() { return effectiveTaskState(fields); } }) as ControlMetadata;
}
/** A project's own color. A task has none. */
export { projectColorSchema, projectSettingsSchema, type ProjectSettings } from './project-settings.js';
import { projectSettingsSchema, type ProjectSettings } from './project-settings.js';
/** The same invariant at creation, save and decode; no fallback for old project rows. */
export function validateTaskSettings(kind: TaskKind, value: unknown): ProjectSettings | null {
  if (kind === 'task' && value === null) return null;
  if (kind === 'project') {
    const parsed = projectSettingsSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  throw kind === 'project'
    ? new Problem(PROBLEM_CODE.invalidInput, 'Project settings require color in the form #rrggbb (^#[0-9a-f]{6}$)', undefined,
      { reason: { kind: 'project_settings_need_color' } })
    : new Problem(PROBLEM_CODE.invalidInput, 'Only a project has settings (its color)', undefined,
      { reason: { kind: 'only_project_has_settings' } });
}
export function validateAnalysisSubject(kind: TaskKind, value: unknown): AnalysisSubject | undefined {
  if (value === undefined) return undefined;
  if (kind !== 'task')
    throw new Problem(PROBLEM_CODE.invalidInput, 'Only a task has an analysis subject');
  if (value === null) return undefined;
  const parsed = analysisSubjectSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Problem(PROBLEM_CODE.invalidInput, 'Invalid analysis subject', undefined, { reason: faultReason(parsed.error) });
}
/** A field's value as stored: a text, a list of texts, an item (member ID to value) or a list of items. */
export type FieldValue = string | string[] | FieldItem | FieldItem[];
export type FieldItem = { [member: string]: FieldValue };
/** A Task's values by field ID (contract task-schema owns their rules); a field without a value has no key. */
export type TaskValues = { [field: string]: FieldValue };
export type ControlTask = { id: string; path: string; meta: ControlMetadata; values: TaskValues;
  settings: ProjectSettings | null; hash: string };

const lifecycles = new Set<string>(TASK_LIFECYCLES);
const kinds = new Set<string>(Object.values(TASK_KIND));
export function estimateMinutes(value: unknown): number {
  const minutes = typeof value === 'bigint' ? Number(value) : value;
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) ||
      minutes < ESTIMATE_MINUTES.min || minutes > ESTIMATE_MINUTES.max)
    throw new Problem(PROBLEM_CODE.invalidInput, `estimateMinutes must be an integer from ${ESTIMATE_MINUTES.min} to ${ESTIMATE_MINUTES.max}`, undefined,
      { reason: { kind: 'estimateminutes_must_integer_from', ESTIMATE_MINUTESMin: String(ESTIMATE_MINUTES.min), ESTIMATE_MINUTESMax: String(ESTIMATE_MINUTES.max) } });
  return minutes;
}
function validateLog(value: unknown): TaskLog {
  const parsed = taskLogSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const first = parsed.error.issues[0];
  throw new Problem(PROBLEM_CODE.invalidInput, first?.path[0] === 'kind' ? 'Unknown log kind' :
      `${first?.path.join('.') ?? 'log entry'}: ${first?.message ?? 'Invalid log entry'}`, undefined,
    { reason: first?.path[0] === 'kind' ? { kind: 'unknown_log_kind' } : faultReason(parsed.error) });
}
/** Whether the user asked for a Task: the log's last creation or mark change says it; metadata and column follow it. */
export function userRequestedOf(log: readonly TaskLog[]): boolean {
  const mark = [...log].reverse().find(entry => entry.userRequested !== undefined)?.userRequested;
  if (mark === undefined) throw new Problem(PROBLEM_CODE.invalidInput, 'Task log has no creation', undefined, { reason: { kind: 'task_log_has_no_creation' } });
  return mark;
}
export function validateControlHead(value: unknown): ControlMetadata {
  const data = fields(value, ['format', 'id', 'kind', 'parentId', 'lifecycle', 'title', 'version', 'baseState', 'hold', 'state', 'userRequested', 'analysisSubject', 'log'],
    'Task metadata');
  if (data.format !== CONTROL_TASK_FORMAT) throw new Problem(PROBLEM_CODE.invalidInput, 'Unsupported task format (expected integer 3)', undefined,
    { reason: { kind: 'unsupported_task_format_expected_integer_3' } });
  const id = taskId(data.id), parentId = data.parentId === null ? null : taskId(data.parentId);
  if (id === parentId) throw new Problem(PROBLEM_CODE.invalidInput, 'A task cannot parent itself', undefined, { reason: { kind: 'task_cannot_parent_itself' } });
  if (typeof data.kind !== 'string' || !kinds.has(data.kind)) throw new Problem(PROBLEM_CODE.invalidInput, 'Unknown task kind', undefined, { reason: { kind: 'unknown_task_kind' } });
  if (parseTaskId(id)?.kind !== data.kind)
    throw new Problem(PROBLEM_CODE.invalidInput, 'Task identity mismatch', undefined, { reason: { kind: 'task_identity_mismatch' } });
  if (typeof data.lifecycle !== 'string' || !lifecycles.has(data.lifecycle))
    throw new Problem(PROBLEM_CODE.invalidInput, 'Unknown task lifecycle', undefined, { reason: { kind: 'unknown_task_lifecycle' } });
  if (typeof data.version !== 'bigint' || data.version < 1n)
    throw new Problem(PROBLEM_CODE.invalidInput, 'version must be a positive integer', undefined, { reason: { kind: 'version_must_positive_integer' } });
  if (!Array.isArray(data.log)) throw new Problem(PROBLEM_CODE.invalidInput, 'log must be an array', undefined, { reason: { kind: 'log_must_array' } });
  const log = data.log as TaskLog[];
  if (typeof data.userRequested !== 'boolean') throw new Error('Current Task requires userRequested');
  const userRequested = data.userRequested;
  const baseState = taskState(data.baseState);
  if (!(TASK_BASE_STATES as readonly string[]).includes(baseState) || typeof data.hold !== 'boolean')
    throw new Error('Current Task requires a base stage and an explicit hold');
  return taskMetadata({ format: CONTROL_TASK_FORMAT, id, kind: data.kind as TaskKind, parentId, lifecycle: data.lifecycle as TaskLifecycle,
    title: text(data.title, 'title', MAX_TITLE_LENGTH), version: data.version, baseState: baseState as TaskBaseState, hold: data.hold,
    userRequested, analysisSubject: validateAnalysisSubject(data.kind as TaskKind, data.analysisSubject), log });
}

export function validateAppendedLog(entries: readonly unknown[]): TaskLog[] { return entries.map(validateLog); }

export function validateControlMetadata(value: unknown): ControlMetadata {
  const meta = validateControlHead(value), log = validateAppendedLog(meta.log);
  if (new Set(log.map(item => item.id)).size !== log.length)
    throw new Problem(PROBLEM_CODE.invalidInput, 'log IDs must be unique within a task', undefined, { reason: { kind: 'log_ids_must_unique_within_task' } });
  if (meta.userRequested !== userRequestedOf(log))
    throw new Problem(PROBLEM_CODE.invalidInput, 'userRequested must be what the log last set', undefined, { reason: { kind: 'userrequested_must_what_log_last_set' } });
  return taskMetadata({ ...meta, log });
}

export function initialControlDocument(id: string, parentId: string | null, title: string,
  created: { kind: TaskKind; userRequested: boolean; actor: TaskActor; analysisSubject?: AnalysisSubject }): ControlMetadata {
  const meta = taskMetadata({ format: CONTROL_TASK_FORMAT, id, kind: created.kind, parentId, lifecycle: 'active',
    title: text(title, 'title', MAX_TITLE_LENGTH), version: 1n, baseState: 'todo', hold: false, userRequested: created.userRequested,
    analysisSubject: created.analysisSubject,
    log: [{ id: `L${randomUUID()}`, kind: 'created', at: now(), title: null, description: null, actor: created.actor,
      fromState: null, toState: 'todo', userRequested: created.userRequested }] });
  return validateControlMetadata(meta);
}
