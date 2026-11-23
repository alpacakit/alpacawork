/**
 * The commands about fields: field list/set/delete (the workspace's definitions) and field get (a Task's schema as
 * the JSON Schema writers read). The stored rules are task-values-store's; who may call them is authorize's.
 */
import { createHash } from 'node:crypto';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { DEFAULT_SCHEMA, isDefaultField, isSystemField, valuesJsonSchema, type FieldDef } from '@alpacawork/contract';
import { readControl, TaskRepository } from './task-store.js';
import { withControlWrite } from './task-transition.js';
import { deleteFieldDef, fieldUse, readFieldCatalog, readProjectSchemas, readStoredFields, schemaAlong,
  writeFieldDef, type EffectiveSchema } from './task-values-store.js';
import type { DatabaseSync } from 'node:sqlite';

/** A field as field list shows it (contract fieldViewSchema). */
function fieldView(db: DatabaseSync, def: FieldDef, stored: ReadonlySet<string>) {
  return { ...def, system: isSystemField(def.id), default: isDefaultField(def.id),
    stored: stored.has(def.id), use: fieldUse(db, def.id) };
}
const storedIds = (db: DatabaseSync) => new Set(readStoredFields(db).map(def => def.id));

export function listFields(root: string) {
  return readControl(root, db => {
    const stored = storedIds(db);
    return { fields: [...readFieldCatalog(db).values()].map(def => fieldView(db, def, stored)) };
  });
}

/** What a new field takes for a key left out: one text of about 100 characters. */
const NEW_FIELD = { many: false, maxChars: 100, maxItems: null, hint: '', members: [], required: false } satisfies Partial<FieldDef>;
export type FieldSetInput = { field: string; title?: string; type?: FieldDef['type']; many?: boolean; required?: boolean;
  maxChars?: number | null; maxItems?: number | null; hint?: string; members?: string[]; create?: boolean };
const DEFINITION_KEYS = ['title', 'type', 'many', 'maxChars', 'maxItems', 'hint', 'members', 'required'] as const satisfies readonly (keyof FieldSetInput)[];
/** Adds a field or changes the keys given of one; the store checks the whole definition and the catalog it makes. */
export function setField(root: string, input: FieldSetInput, at: string) {
  return withControlWrite(root, (_, db) => {
    const current = readFieldCatalog(db).get(input.field);
    if (current && input.create)
      throw new Problem(PROBLEM_CODE.conflict, `Field ${input.field} already exists`, { field: input.field },
        { reason: { kind: 'field_exists', field: input.field } });
    if (!current && (input.title === undefined || input.type === undefined))
      throw new Problem(PROBLEM_CODE.invalidInput, 'A new field needs --title and --type', { field: input.field },
        { reason: { kind: 'field_definition_invalid', field: input.field },
          issues: [{ path: input.title === undefined ? 'title' : 'type', code: 'required', message: 'Required for a new field' }] });
    const base: Omit<FieldDef, 'id' | 'title' | 'type'> = current ?? { ...NEW_FIELD,
      ...(input.type === 'schema' ? { maxChars: null } : {}) };
    // Only the definition's own keys: a write's record words (--quote, --source-request) are not part of it.
    const given = Object.fromEntries(DEFINITION_KEYS.flatMap(key => input[key] === undefined ? [] : [[key, input[key]]]));
    const merged = { ...base, ...current, ...given, id: input.field };
    // Turning a value into a list, or back, brings its limit along unless the write names one.
    if (merged.many && merged.maxItems === null && input.maxItems === undefined) merged.maxItems = 5;
    if (!merged.many && input.maxItems === undefined) merged.maxItems = null;
    if (merged.type === 'schema' && input.maxChars === undefined) merged.maxChars = null;
    const def = writeFieldDef(db, merged, at);
    return { field: fieldView(db, def, storedIds(db)) };
  });
}

export function deleteField(root: string, field: string) {
  return withControlWrite(root, (_, db) => deleteFieldDef(db, field));
}

/**
 * field get: the fields Tasks use (tasksSchema) at the Task named (none named: the default schema), where they come
 * from, and the JSON Schema of a write's values; `version` is that JSON Schema's digest, and a matching `held` version
 * leaves it out. A project named answers for the Tasks below it.
 */
export function readSchema(root: string, task: string | null, held?: string) {
  return readControl(root, db => {
    const catalog = readFieldCatalog(db);
    const schema: EffectiveSchema = task === null ? { fields: DEFAULT_SCHEMA, from: null }
      : schemaAlong(new TaskRepository(root, db).ancestry(task), readProjectSchemas(db));
    const fields = schema.fields;
    const json = valuesJsonSchema(fields, catalog);
    const version = createHash('sha256').update(JSON.stringify(json)).digest('hex');
    return { task, from: schema.from, fields: [...fields], version, schema: held === version ? null : json };
  });
}
