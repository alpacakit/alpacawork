/** The stored side of Task values on a fresh synthetic control database: definitions, project schemas and values. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { packagedMigrations } from '@alpacawork/db';
import { DEFAULT_SCHEMA, renderContext, SYSTEM_FIELDS } from '@alpacawork/contract';
import * as storeRuntime from '@alpacawork/backend/test-dist/control/task-values-store.js';
const { readFieldCatalog, writeFieldDef, deleteFieldDef, readProjectSchemas, writeProjectSchema, readTaskValues,
  writeTaskValues, patchedValues } = storeRuntime as typeof import('../apps/backend/src/control/task-values-store.js');

const at = '2026-11-08T00:00:00Z';
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const item of packagedMigrations('control'))
    db.exec(readFileSync(`packages/db/drizzle/control/${item.name}/migration.sql`, 'utf8')
      .replaceAll(/SELECT alpacawork_data_migration\('[^']*'\);/g, ''));
  db.prepare(`INSERT INTO tasks(id,kind,number,parent_id,project_task_id,title,lifecycle,base_state,hold,settings,revision,created_at,updated_at)
    VALUES('p','project',1,NULL,NULL,'Synthetic','active','todo',0,'{"color":"#39659b"}',1,?,?),
          ('t','task',2,'p','p','Synthetic','active','doing',0,NULL,1,?,?)`).run(at, at, at, at);
  return db;
}
const problem = (kind: string) => (error: unknown) => (error as { reason?: { kind: string } }).reason?.kind === kind;

test('values are one row per field, written whole and read back by Task ID', () => {
  const db = database();
  writeTaskValues(db, 'T2', { goal: 'g', conditions: ['a', 'b'] });
  assert.equal(Number(db.prepare('SELECT count(*) AS n FROM task_values').get()!.n), 2);
  assert.deepEqual(readTaskValues(db, ['T2']).get('T2'), { conditions: ['a', 'b'], goal: 'g' });
  writeTaskValues(db, 'T2', { goal: 'h' });
  assert.deepEqual(readTaskValues(db).get('T2'), { goal: 'h' });
  assert.deepEqual(readTaskValues(db).get('P1'), {});
});

test('a write checked against the schema keeps unsent fields and refuses with issues at the wrong value', () => {
  const catalog = readFieldCatalog(database()), schema = { fields: DEFAULT_SCHEMA, from: null };
  assert.deepEqual(patchedValues('T2', { goal: 'g', notes: 'n' }, { notes: null, pr: ['u'] }, schema, catalog), { goal: 'g', pr: ['u'] });
  assert.throws(() => patchedValues('T2', {}, { conditions: ['x'.repeat(801)] }, schema, catalog),
    (error: { reason?: { kind: string }; issues?: { path: string }[] }) =>
      error.reason?.kind === 'values_invalid' && error.issues?.[0]?.path === 'conditions.0');
});

test('a value saved under a longer limit stays readable and shown, other fields still write, and only rewriting it is refused (with the aim)', () => {
  const db = database(), catalog = readFieldCatalog(db), schema = { fields: DEFAULT_SCHEMA, from: null };
  // Saved before the limits came down: a 3000-character body and eight policy items.
  const notes = 'n'.repeat(3000), policy = Array.from({ length: 8 }, (_, i) => `方針${i}`);
  writeTaskValues(db, 'T2', { notes, policy });
  const stored = readTaskValues(db).get('T2')!;
  assert.equal(stored.notes, notes);
  assert.ok(renderContext(DEFAULT_SCHEMA, stored, catalog).includes(`## Notes\n${notes}`), 'the launch text and the tab show it whole');
  // A write names only the fields it changes: the long ones it leaves are not checked again.
  assert.deepEqual(patchedValues('T2', stored, { goal: 'g' }, schema, catalog), { ...stored, goal: 'g' });
  const refusal = (patch: object) => {
    try { patchedValues('T2', stored, patch, schema, catalog); } catch (error) { return (error as { issues: { path: string; message: string }[] }).issues; }
    assert.fail('the write went through');
  };
  assert.deepEqual(refusal({ notes }).map(issue => [issue.path, issue.message]), [['notes', 'At most 780 characters (aim for about 600)']]);
  assert.deepEqual(refusal({ policy: [...policy, '足す'] }).map(issue => [issue.path, issue.message]), [['policy', 'At most 7 items (aim for about 5)']]);
});

test('a project schema replaces whole, keeps every system field, and null inherits again', () => {
  const db = database();
  writeProjectSchema(db, 'P1', ['notes', 'goal', ...SYSTEM_FIELDS.filter(id => id !== 'notes')]);
  assert.deepEqual(readProjectSchemas(db).get('P1')?.slice(0, 2), ['notes', 'goal']);
  assert.throws(() => writeProjectSchema(db, 'P1', ['goal']), problem('project_schema_invalid'));
  assert.throws(() => writeProjectSchema(db, 'T2', [...SYSTEM_FIELDS]), problem('project_schema_invalid'));
  writeProjectSchema(db, 'P1', null);
  assert.equal(readProjectSchemas(db).has('P1'), false);
});

test('definitions: a shipped field changes only whether it is required, a used field cannot go', () => {
  const db = database();
  const goal = readFieldCatalog(db).get('goal')!;
  writeFieldDef(db, { ...goal, required: true }, at);
  assert.deepEqual(readFieldCatalog(db).get('goal'), { ...goal, required: true });
  assert.throws(() => writeFieldDef(db, { ...goal, hint: '書き方を変えた' }, at), problem('field_locked'));
  assert.throws(() => writeFieldDef(db, { ...readFieldCatalog(db).get('notes')!, many: true, maxItems: 3 }, at), problem('field_locked'));
  assert.throws(() => writeFieldDef(db, { id: 'bad', title: 'B', type: 'schema', many: false, maxChars: null, maxItems: null, hint: '',
    members: ['missing'] }, at), problem('field_definition_invalid'));
  writeFieldDef(db, { id: 'risk', title: 'リスク', type: 'text', many: true, maxChars: 200, maxItems: 5, hint: '', members: [] }, at);
  writeProjectSchema(db, 'P1', [...DEFAULT_SCHEMA, 'risk']);
  writeTaskValues(db, 'T2', { risk: ['r'] });
  assert.throws(() => deleteFieldDef(db, 'risk'), problem('field_in_use'));
  for (const id of ['notes', 'goal', 'decide_note', 'project_policy']) assert.throws(() => deleteFieldDef(db, id), problem('field_locked'));
  writeProjectSchema(db, 'P1', null);
  assert.deepEqual(deleteFieldDef(db, 'risk'), { field: 'risk', values: 1 });
  assert.equal(readFieldCatalog(db).has('risk'), false);
});

test('a field with stored values keeps its type, list shape and members; with none they may change', () => {
  const db = database();
  const risk = { id: 'risk', title: 'Risk', type: 'text', many: true, maxChars: 200, maxItems: 10, hint: '', members: [] };
  writeFieldDef(db, risk, at);
  writeTaskValues(db, 'T2', { risk: ['late'] });
  assert.throws(() => writeFieldDef(db, { ...risk, many: false, maxItems: null }, at), problem('field_has_values'));
  // A member's shape is held by the values of the field it is in, as well.
  const part = { id: 'risk_note', title: 'Note', type: 'text', many: false, maxChars: 10, maxItems: null, hint: '', members: [] };
  writeFieldDef(db, part, at);
  writeFieldDef(db, { id: 'risk_items', title: 'Risks', type: 'schema', many: true, maxChars: null, maxItems: 3, hint: '', members: ['risk_note'] }, at);
  writeTaskValues(db, 'T2', { risk: ['late'], risk_items: [{ risk_note: 'n' }] });
  assert.throws(() => writeFieldDef(db, { ...part, many: true, maxItems: 2 }, at), problem('field_has_values'));
  writeFieldDef(db, { ...risk, title: 'Risks', maxChars: 300 }, at);
  writeTaskValues(db, 'T2', {});
  writeFieldDef(db, { ...risk, many: false, maxItems: null }, at);
  assert.equal(readFieldCatalog(db).get('risk')?.many, false);
});
