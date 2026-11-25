/**
 * The stored side of Task values (contract task-schema): the workspace's field definitions (`field_defs`, over the
 * shipped defaults), each project's own schema (`project_fields`) and each Task's values (`task_values`, one row per
 * field with a value). Every function works in the caller's connection, inside its write when it writes; Task and
 * project IDs are public IDs (T…/P…). Who may call a write is the server's authorization, not this module's.
 */
import type { DatabaseSync } from 'node:sqlite';
import { touch } from '@alpacawork/db';
import { Problem, PROBLEM_CODE, toIssues, type Issue } from '@alpacawork/core';
import { catalogProblems, DEFAULT_SCHEMA, PROJECT_SCHEMA, fieldCatalog, fieldDefSchema, isDefaultField, shippedField,
  missingRequired, schemaOf, schemaProblems, applyValues, type FieldCatalog, type FieldDef, type FieldProblem, type TaskValues } from '@alpacawork/contract';
import { now, type TaskKind } from '@alpacawork/raw';
import type { BranchTask } from '@alpacawork/contract/branch';
import type { TaskTree } from './task-store.js';

const issuesOf = (problems: readonly FieldProblem[]): Issue[] =>
  problems.map(({ path, message }) => ({ path, code: 'custom', message }));

/** The definitions stored for the workspace, each checked as it is read. */
export function readStoredFields(db: DatabaseSync): FieldDef[] {
  return db.prepare('SELECT definition FROM field_defs ORDER BY id').all()
    .map(row => fieldDefSchema.parse(JSON.parse(String(row.definition))));
}
/** The workspace's fields: the defaults with the stored definitions over them (contract fieldCatalog). */
export function readFieldCatalog(db: DatabaseSync): FieldCatalog {
  return fieldCatalog(readStoredFields(db));
}

/** Where a field is used: projects whose own schema names it, fields it is a member of, and the default schema. */
export type FieldUse = { projects: string[]; fields: string[]; defaultSchema: boolean };
export function fieldUse(db: DatabaseSync, id: string): FieldUse {
  const projects = db.prepare(`SELECT t.external_id AS project FROM project_fields f JOIN tasks t ON t.id=f.project_task_id
    WHERE f.field_id=? ORDER BY t.number`).all(id).map(row => String(row.project));
  const fields = [...readFieldCatalog(db).values()].filter(def => def.members.includes(id)).map(def => def.id);
  return { projects, fields, defaultSchema: DEFAULT_SCHEMA.includes(id) };
}

/**
 * Adds or changes one definition. A shipped field takes only a change of `required` (contract shippedField); the
 * resulting catalog must stay sound (members exist, the first member names an item, no cycle). Values already stored
 * are not rewritten: a new limit applies to the next write of that field.
 */
export function writeFieldDef(db: DatabaseSync, input: unknown, at: string): FieldDef {
  const parsed = fieldDefSchema.safeParse(input);
  const field = typeof (input as { id?: unknown })?.id === 'string' ? String((input as { id: string }).id) : '';
  if (!parsed.success) throw new Problem(PROBLEM_CODE.invalidInput, 'The field definition is invalid', { field },
    { reason: { kind: 'field_definition_invalid', field }, issues: toIssues(parsed.error.issues) });
  const before = readFieldCatalog(db).get(parsed.data.id);
  const def = isDefaultField(parsed.data.id) ? shippedField(parsed.data) : parsed.data;
  if (!def) throw new Problem(PROBLEM_CODE.invalidInput, `Field ${parsed.data.id} comes with the app; only whether it is required can change`,
    { field: parsed.data.id }, { reason: { kind: 'field_locked', field: parsed.data.id } });
  if (before && (before.type !== def.type || before.many !== def.many || before.members.join() !== def.members.join())) {
    const values = storedValuesOf(db, readFieldCatalog(db), def.id);
    if (values) throw new Problem(PROBLEM_CODE.conflict, `Field ${def.id} has ${values} stored values; its shape cannot change`,
      { field: def.id, values }, { reason: { kind: 'field_has_values', field: def.id, values } });
  }
  const stored = readStoredFields(db).filter(each => each.id !== def.id);
  const problems = catalogProblems(fieldCatalog([...stored, def]));
  if (problems.length) throw new Problem(PROBLEM_CODE.invalidInput, 'The field definition is invalid', { field: def.id },
    { reason: { kind: 'field_definition_invalid', field: def.id }, issues: issuesOf(problems) });
  db.prepare(`INSERT INTO field_defs(id,definition,updated_at) VALUES (?,?,?)
    ON CONFLICT(id) DO UPDATE SET definition=excluded.definition, updated_at=excluded.updated_at`)
    .run(def.id, JSON.stringify(def), at);
  touch(db, { kind: 'field_def', id: def.id });
  return def;
}

/**
 * How many stored values hold `id`: its own, and those of every field it is a member of (at any depth), whose items
 * carry it. A field's shape (type, list, members) changes only while this is 0: no value is converted.
 */
function storedValuesOf(db: DatabaseSync, catalog: FieldCatalog, id: string): number {
  const holders = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const def of catalog.values()) if (!holders.has(def.id) && def.members.some(member => holders.has(member))) { holders.add(def.id); grew = true; }
  }
  return Number(db.prepare('SELECT count(*) AS n FROM task_values WHERE field_id IN (SELECT value FROM json_each(?))')
    .get(JSON.stringify([...holders]))!.n);
}

/**
 * Deletes a field the workspace added, with every value stored for it. A field that comes with the app is never
 * deleted (field_locked); a field still named by a project's schema or another field's members is refused until it is taken out there.
 */
export function deleteFieldDef(db: DatabaseSync, id: string): { field: string; values: number } {
  if (isDefaultField(id)) throw new Problem(PROBLEM_CODE.invalidInput, `Field ${id} comes with the app; it cannot be deleted`,
    { field: id }, { reason: { kind: 'field_locked', field: id } });
  if (!db.prepare('SELECT 1 FROM field_defs WHERE id=?').get(id))
    throw new Problem(PROBLEM_CODE.notFound, `Field ${id} does not exist`, { field: id }, { reason: { kind: 'field_not_found', field: id } });
  const use = fieldUse(db, id), users = [...use.projects, ...use.fields];
  if (users.length) throw new Problem(PROBLEM_CODE.invalidInput, `Field ${id} is in use`, { field: id, users },
    { reason: { kind: 'field_in_use', field: id, users: users.join(', ') } });
  const removed = db.prepare('SELECT task_id,value FROM task_values WHERE field_id=?').all(id), at = now();
  for (const row of removed) replaceValue(db, String(row.task_id), id, String(row.value), null, at);
  const values = removed.length;
  db.prepare('DELETE FROM field_defs WHERE id=?').run(id);
  touch(db, { kind: 'field_def', id });
  return { field: id, values };
}

/** Each project's own schema by project ID, in order; a project without one is absent. */
export function readProjectSchemas(db: DatabaseSync): Map<string, string[]> {
  const schemas = new Map<string, string[]>();
  for (const row of db.prepare(`SELECT t.external_id AS project, f.field_id FROM project_fields f JOIN tasks t ON t.id=f.project_task_id
    ORDER BY t.number, f.position`).all()) {
    const project = String(row.project);
    schemas.set(project, [...schemas.get(project) ?? [], String(row.field_id)]);
  }
  return schemas;
}
/**
 * Replaces a project's own schema with `fields` in order, or with null removes it so the project takes the nearest
 * project above's. The list must name known fields once each and every system field. Values of a field left out stay
 * stored and show again when it comes back.
 */
export function writeProjectSchema(db: DatabaseSync, project: string, fields: readonly string[] | null): void {
  const row = db.prepare('SELECT id, kind FROM tasks WHERE external_id=?').get(project);
  if (!row) throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist', { task: project }, { reason: { kind: 'task_does_not_exist' } });
  if (row.kind !== 'project') throw new Problem(PROBLEM_CODE.invalidInput, `${project} is not a project`, { project },
    { reason: { kind: 'project_schema_invalid', project } });
  if (fields !== null) {
    const problems = schemaProblems(fields, readFieldCatalog(db));
    if (problems.length) throw new Problem(PROBLEM_CODE.invalidInput, `The fields of ${project} are invalid`, { project },
      { reason: { kind: 'project_schema_invalid', project }, issues: issuesOf(problems) });
  }
  const previous = db.prepare('SELECT position FROM project_fields WHERE project_task_id=?').all(String(row.id));
  db.prepare('DELETE FROM project_fields WHERE project_task_id=?').run(String(row.id));
  for (const old of previous) touch(db, { kind: 'project_field', id: JSON.stringify([row.id, old.position]) });
  const insert = db.prepare('INSERT INTO project_fields(project_task_id,position,field_id) VALUES (?,?,?)');
  (fields ?? []).forEach((field, position) => {
    insert.run(String(row.id), position, field);
    touch(db, { kind: 'project_field', id: JSON.stringify([row.id, position]) });
  });
}

/** What reads of values need beside them: the workspace's fields and each project's own schema. */
export type TaskFields = { catalog: FieldCatalog; schemas: ReadonlyMap<string, readonly string[]> };
export function readTaskFields(db: DatabaseSync): TaskFields {
  return { catalog: readFieldCatalog(db), schemas: readProjectSchemas(db) };
}

/** A list of fields and the project whose own schema it is (null: the default schema, or a project's own values). */
export type EffectiveSchema = { fields: readonly string[]; from: string | null };
/** The fixed schema of a project's own values, whatever its Tasks use. */
export const PROJECT_VALUES: EffectiveSchema = { fields: PROJECT_SCHEMA, from: null };
type SchemaTree = TaskTree<{ id: string; meta: BranchTask & { kind: TaskKind } }>;
/**
 * The fields the Tasks in and below `taskId` use: its nearest project's own schema, else the nearest above with one,
 * else the default. For a project, the schema its Tasks use (not its own values).
 */
export function tasksSchema(tree: SchemaTree, schemas: ReadonlyMap<string, readonly string[]>, taskId: string): EffectiveSchema {
  return schemaAlong([...tree.projects(taskId)].reverse(), schemas);
}
/** The fields of a Task's own values: the fixed project schema, or the schema a task uses (tasksSchema). */
export function schemaFor(tree: SchemaTree, schemas: ReadonlyMap<string, readonly string[]>, taskId: string): EffectiveSchema {
  return tree.byId.get(taskId)?.meta.kind === 'project' ? PROJECT_VALUES : tasksSchema(tree, schemas, taskId);
}
/** tasksSchema along a path upward (TaskRepository.ancestry: the Task first, then each one above it). */
export function schemaAlong(path: readonly { id: string; meta: { kind: TaskKind } }[],
  schemas: ReadonlyMap<string, readonly string[]>): EffectiveSchema {
  for (const project of path) {
    const own = project.meta.kind === 'project' ? schemas.get(project.id) : undefined;
    if (own) return { fields: own, from: project.id };
  }
  return { fields: DEFAULT_SCHEMA, from: null };
}

/** The values of the named Tasks (all Tasks when left out) by Task ID; a Task without values maps to `{}`. */
export function readTaskValues(db: DatabaseSync, taskIds?: readonly string[]): Map<string, TaskValues> {
  const rows = db.prepare(`SELECT t.external_id AS task, v.field_id, v.value FROM tasks t
    LEFT JOIN task_values v ON v.task_id=t.id ${taskIds === undefined ? '' : 'WHERE t.external_id IN (SELECT value FROM json_each(?))'}
    ORDER BY t.number, v.field_id`).all(...taskIds === undefined ? [] : [JSON.stringify(taskIds)]);
  const values = new Map<string, TaskValues>();
  for (const row of rows) {
    const task = String(row.task), own = values.get(task) ?? {};
    if (row.field_id !== null) own[String(row.field_id)] = JSON.parse(String(row.value));
    values.set(task, own);
  }
  return values;
}
/**
 * Stores a Task's values whole as of `at` (the time of the log record the write goes with, else now): a row per field with a value,
 * none for the rest. Only the fields whose value changes are written, each through replaceValue, so the value it had
 * before stays in task_value_versions.
 */
export function writeTaskValues(db: DatabaseSync, taskId: string, values: TaskValues, at: string = now()): void {
  const row = db.prepare('SELECT id FROM tasks WHERE external_id=?').get(taskId);
  if (!row) throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist', { task: taskId }, { reason: { kind: 'task_does_not_exist' } });
  const uuid = String(row.id);
  const previous = new Map(db.prepare('SELECT field_id,value FROM task_values WHERE task_id=?').all(uuid)
    .map(old => [String(old.field_id), String(old.value)]));
  const next = new Map(Object.entries(values).map(([field, value]) => [field, JSON.stringify(value)]));
  for (const field of new Set([...previous.keys(), ...next.keys()]))
    if (previous.get(field) !== next.get(field)) replaceValue(db, uuid, field, previous.get(field) ?? null, next.get(field) ?? null, at);
}
/**
 * The only change of one stored value (task_values): keeps what the field held (`previous`, JSON or null for none) as a
 * version replaced at `at`, then stores `next` (JSON, or null to remove the field's value).
 */
function replaceValue(db: DatabaseSync, taskUuid: string, field: string, previous: string | null, next: string | null, at: string): void {
  db.prepare('INSERT INTO task_value_versions(task_id,field_id,replaced_at,value) VALUES (?,?,?,?)').run(taskUuid, field, at, previous);
  if (next === null) db.prepare('DELETE FROM task_values WHERE task_id=? AND field_id=?').run(taskUuid, field);
  else db.prepare('INSERT INTO task_values(task_id,field_id,value) VALUES (?,?,?) ON CONFLICT(task_id,field_id) DO UPDATE SET value=excluded.value')
    .run(taskUuid, field, next);
  touch(db, { kind: 'task_value', id: JSON.stringify([taskUuid, field]) });
}

/**
 * A Task's values as they were at `at`: its current values with each later change undone (task_value_versions, newest
 * first). `values` is null when they are not known: before the Task existed (`not-created`), or before versions began to
 * be kept for a Task created earlier (`not-recorded`). `recordedSince` is when the Task's values are known from.
 */
export function readValuesAt(db: DatabaseSync, taskId: string, at: string): ValuesAt {
  // A Task begins at its created record; its row's created_at is taken a moment later in the same write.
  const task = db.prepare(`SELECT t.id,coalesce((SELECT l.at FROM task_log l WHERE l.task_id=t.id AND l.kind='created'),t.created_at) AS created_at
    FROM tasks t WHERE t.external_id=?`).get(taskId);
  if (!task) throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist', { task: taskId }, { reason: { kind: 'task_does_not_exist' } });
  const since = db.prepare('SELECT at FROM task_value_versions_since').get();
  const created = String(task.created_at), time = Date.parse(at);
  const recordedSince = since && Date.parse(String(since.at)) > Date.parse(created) ? String(since.at) : created;
  if (time < Date.parse(created)) return { task: taskId, at, values: null, reason: 'not-created', recordedSince };
  if (time < Date.parse(recordedSince)) return { task: taskId, at, values: null, reason: 'not-recorded', recordedSince };
  const values: Record<string, string> = Object.fromEntries(db.prepare('SELECT field_id,value FROM task_values WHERE task_id=?')
    .all(String(task.id)).map(row => [String(row.field_id), String(row.value)]));
  for (const version of db.prepare('SELECT field_id,replaced_at,value FROM task_value_versions WHERE task_id=? ORDER BY id DESC')
    .all(String(task.id))) {
    if (Date.parse(String(version.replaced_at)) <= time) continue;
    if (version.value === null) delete values[String(version.field_id)];
    else values[String(version.field_id)] = String(version.value);
  }
  return { task: taskId, at, values: Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))
    .map(([field, value]) => [field, JSON.parse(value)])), recordedSince };
}
export type ValuesAt = { task: string; at: string; values: TaskValues | null; reason?: 'not-created' | 'not-recorded'; recordedSince: string };

/**
 * A write's values checked against the fields the Task uses (contract schemaOf) and applied to `current`; a refusal
 * names each wrong value in its issues (`conditions.2`). A field outside the schema cannot be written.
 */
export function patchedValues(taskId: string, current: TaskValues, patch: unknown, schema: EffectiveSchema,
  catalog: FieldCatalog): TaskValues {
  const parsed = schemaOf(schema.fields, catalog).safeParse(patch);
  if (!parsed.success) throw new Problem(PROBLEM_CODE.invalidInput, `${taskId}'s values do not fit its fields`, { task: taskId },
    { reason: { kind: 'values_invalid', task: taskId }, issues: toIssues(parsed.error.issues.flatMap((issue): typeof parsed.error.issues =>
      // A field the schema does not have is named at its own path, as a wrong value is.
      issue.code === 'unrecognized_keys' ? issue.keys.map(key => ({ ...issue, path: [...issue.path, key], message: `Unknown field ${key}` }))
        : [issue])) });
  return applyValues(current, parsed.data, catalog);
}
/**
 * Refuses a done report while a required field of the Task's schema has no value (`values`: what the Task has once the
 * report's own values are written), naming each such field at its own path. A write of some fields never asks this.
 */
export function assertRequiredValues(db: DatabaseSync, path: readonly { id: string; meta: { kind: TaskKind } }[],
  taskId: string, values: TaskValues): void {
  const { catalog, schemas } = readTaskFields(db), missing = missingRequired(schemaAlong(path, schemas).fields, values, catalog);
  if (missing.length) throw new Problem(PROBLEM_CODE.invalidInput,
    `${taskId} cannot be reported done until ${missing.join(', ')} ${missing.length === 1 ? 'has a value' : 'have values'}`, { task: taskId, fields: missing },
    { reason: { kind: 'required_values_missing', task: taskId, fields: missing.join(', ') },
      issues: missing.map(id => ({ path: id, code: 'required', message: `${catalog.get(id)!.title} is required before the done report` })) });
}
/**
 * The values of an existing Task after a write: `patch` checked against the schema the Task uses (read along `path`,
 * its TaskRepository.ancestry) and applied to its current values.
 */
export function writtenValues(db: DatabaseSync, path: readonly { id: string; meta: { kind: TaskKind } }[],
  task: { id: string; values: TaskValues }, patch: unknown): TaskValues {
  const { catalog, schemas } = readTaskFields(db);
  return patchedValues(task.id, task.values, patch, path[0]?.meta.kind === 'project' ? PROJECT_VALUES : schemaAlong(path, schemas), catalog);
}
