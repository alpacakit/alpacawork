/** Key identity reads at the caller's SQLite read point; old identities are retained by WorkspaceRecords. */
import type { DatabaseSync } from 'node:sqlite';
import type { ChangeKey } from '@alpacawork/db';
import type { DatabaseChangeKind, KeyOwner, OwnerLookup } from './projection-contract.js';
const text = (value: unknown) => value == null ? null : String(value);
const runNumber = (id: string) => /^R?\d+$/.test(id) ? Number(id.replace(/^R/, '')) : null;
const single = (read: (db: DatabaseSync, id: string) => KeyOwner | undefined) => (db: DatabaseSync, ids: readonly string[]) =>
  new Map(ids.flatMap(id => { const owner = read(db, id); return owner ? [[id, owner] as const] : []; }));
const ownTask = single((db, id) => db.prepare('SELECT 1 FROM tasks WHERE external_id=?').get(id) ? { task: id, coordinator: null } : undefined);
const byTaskColumn = (table: string, column = 'id') => single((db, id) => {
  const row = db.prepare(`SELECT task_id FROM ${table} WHERE ${column}=?`).get(id);
  return row ? { task: text(row.task_id), coordinator: null } : undefined;
});
const request = single((db, id) => {
  const row = db.prepare('SELECT task_id,conversation_id FROM requests WHERE id=?').get(id);
  return row ? { task: text(row.task_id), coordinator: row.task_id == null ? id : null } : undefined;
});
const run = single((db, id) => {
  const row = db.prepare('SELECT task_id,request_id FROM runs WHERE id=?').get(runNumber(id));
  return row ? { task: text(row.task_id), coordinator: row.task_id == null ? text(row.request_id) : null } : undefined;
});
const attempt = single((db, id) => {
  const row = db.prepare(`SELECT r.task_id,r.request_id FROM run_attempts a JOIN runs r ON r.id=a.run_no WHERE a.attempt_id=?`).get(id);
  return row ? { task: text(row.task_id), coordinator: row.task_id == null ? text(row.request_id) : null } : run(db, [id]).get(id);
});
const returnOwner = single((db, id) => {
  const row = db.prepare('SELECT to_task_id FROM returns WHERE id=?').get(id);
  return row ? { task: String(row.to_task_id), coordinator: null } : undefined;
});
const uuidOwner = (id: string, last = false) => last ? id.slice(id.lastIndexOf(':') + 1) : id.slice(0, id.indexOf(':'));
const taskUuid = (uuid: string, db: DatabaseSync) => {
  const row = db.prepare('SELECT external_id FROM tasks WHERE id=?').get(uuid);
  return row ? { task: String(row.external_id), coordinator: null } : undefined;
};
export const ownerLookup: OwnerLookup = {
  task: ownTask, task_value: ownTask, dependency: ownTask, stop_epoch: ownTask, project_field: ownTask,
  log: single((db, id) => { const row = db.prepare('SELECT t.external_id FROM task_log l JOIN tasks t ON t.id=l.task_id WHERE l.id=?').get(id);
    return row ? { task: String(row.external_id), coordinator: null } : undefined; }),
  placement: byTaskColumn('placements'), wait_cycle: byTaskColumn('wait_cycles'), request, start_grant: request, run, attempt,
  input: single((db, id) => {
    const row = db.prepare(`SELECT r.task_id,r.request_id FROM run_inputs i JOIN run_attempts a USING(attempt_id)
      JOIN runs r ON r.id=a.run_no WHERE i.input_id=?`).get(id);
    return row ? { task: text(row.task_id), coordinator: row.task_id == null ? text(row.request_id) : null } : undefined;
  }),
  return: returnOwner, resolution: returnOwner,
  delivery: (db, ids) => new Map(ids.flatMap(id => {
    const owner = returnOwner(db, [id.slice(0, id.indexOf(':'))]).values().next().value;
    return owner ? [[id, owner] as const] : [];
  })),
  dialogue: single((db, id) => taskUuid(uuidOwner(id), db)),
  refusal: single((db, id) => taskUuid(uuidOwner(id, true), db)),
  conversation: (_db, ids) => new Map(ids.map(id => [id, { task: null, coordinator: id }])),
  field_def: () => new Map(),
  automation: () => new Map(), automation_run: () => new Map(), automation_signal: () => new Map(),
};
/**
 * A committed write's keys in the form these records read them. A writer names a row of a compound key as the JSON
 * array of its parts (packages/db touch sites: a Task value by its Task's UUID and field, a dependency by its Task and
 * the Task after, a project's field by the project's UUID and position, a delivery by its return and wake Request, a
 * dialogue by its Task's UUID and Request, a refusal by its Request and Task's UUID); the records name Task rows by
 * their public ID and pairs as `a:b`. A key already in that form, or of a single part, passes as it is.
 */
export function recordKeys(db: DatabaseSync, keys: readonly ChangeKey[]): ChangeKey[] {
  const external = (uuid: string) => { const row = db.prepare('SELECT external_id FROM tasks WHERE id=?').get(uuid); return row ? String(row.external_id) : uuid; };
  return keys.map(key => {
    if (!key.id.startsWith('[')) return key;
    let parts: unknown;
    try { parts = JSON.parse(key.id); } catch { return key; }
    if (!Array.isArray(parts) || parts.length !== 2) return key;
    const [first, second] = parts.map(String) as [string, string];
    switch (key.kind) {
      case 'task_value': case 'project_field': return { kind: key.kind, id: external(first) };
      case 'dependency': return { kind: key.kind, id: first };
      case 'delivery': case 'dialogue': case 'refusal': return { kind: key.kind, id: `${first}:${second}` };
      default: return key;
    }
  });
}
/** All row identities are read once at startup; ordinary advances select only the supplied keys. */
export function databaseKeys(db: DatabaseSync): ChangeKey[] {
  const sources: readonly [DatabaseChangeKind, string][] = [
    ['task', 'SELECT external_id AS id FROM tasks'], ['log', 'SELECT id FROM task_log'],
    ['placement', 'SELECT id FROM placements'], ['wait_cycle', 'SELECT id FROM wait_cycles'],
    ['request', 'SELECT id FROM requests'], ['run', "SELECT 'R'||id AS id FROM runs"],
    ['attempt', 'SELECT attempt_id AS id FROM run_attempts'], ['input', 'SELECT input_id AS id FROM run_inputs'], ['return', 'SELECT id FROM returns'],
    ['dialogue', "SELECT task_uuid||':'||request_id AS id FROM task_dialogues"],
    ['refusal', "SELECT request_id||':'||task_uuid AS id FROM coordinator_refusals"],
    ['conversation', 'SELECT id FROM coordinator_conversations'],
  ];
  return sources.flatMap(([kind, sql]) => db.prepare(sql).all().map(row => ({ kind, id: String(row.id) })));
}
export function inputInstruction(db: DatabaseSync, id: string): KeyOwner | undefined {
  const row = db.prepare(`SELECT r.task_id,r.request_id FROM run_inputs i JOIN runs r ON r.id=i.instruction_run_no WHERE i.input_id=?`).get(id);
  return row ? { task: text(row.task_id), coordinator: row.task_id == null ? text(row.request_id) : null } : undefined;
}
export function readPoint<T>(db: DatabaseSync, read: () => T): T {
  if (db.isTransaction) return read();
  db.exec('BEGIN');
  try { const value = read(); db.exec('COMMIT'); return value; }
  catch (error) {
    try { db.exec('ROLLBACK'); } catch (rollback) { throw new AggregateError([error, rollback], 'Record read and rollback failed'); }
    throw error;
  }
}
