/** The oracle reads committed table rows independently of the writer, its scopes and its touch calls. */
import assert from 'node:assert/strict';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { controlDatabasePath, type ChangeKey, type ChangeLog } from '@alpacawork/db';
import { unobservedColumns, unobservedTables } from './control-write-inventory.ts';

type Row = Record<string, SQLOutputValue>;
const keyOf: Record<string, (row: Row) => ChangeKey> = {
  tasks: r => ({ kind: 'task', id: String(r.external_id) }),
  task_log: r => ({ kind: 'log', id: String(r.id) }),
  task_log_question: r => ({ kind: 'log', id: String(r.log_id) }),
  log_texts: r => ({ kind: 'log', id: String(r.log_id) }),
  task_values: r => ({ kind: 'task_value', id: JSON.stringify([r.task_id, r.field_id]) }),
  task_dependencies: r => ({ kind: 'dependency', id: JSON.stringify([r.task_id, r.after_task_id]) }),
  placements: r => ({ kind: 'placement', id: String(r.id) }),
  // A compaction is its Run's fact.
  compactions: r => ({ kind: 'run', id: `R${r.run_no}` }),
  wait_cycles: r => ({ kind: 'wait_cycle', id: String(r.id) }),
  requests: r => ({ kind: 'request', id: String(r.id) }),
  task_start_grants: r => ({ kind: 'start_grant', id: String(r.request_id) }),
  task_stop_epochs: r => ({ kind: 'stop_epoch', id: String(r.task_id) }),
  runs: r => ({ kind: 'run', id: `R${r.id}` }),
  run_attempts: r => ({ kind: 'attempt', id: String(r.attempt_id) }),
  run_inputs: r => ({ kind: 'input', id: String(r.input_id) }),
  returns: r => ({ kind: 'return', id: String(r.id) }),
  return_deliveries: r => ({ kind: 'delivery', id: JSON.stringify([r.return_id, r.wake_request_id]) }),
  return_resolutions: r => ({ kind: 'resolution', id: String(r.return_id) }),
  task_dialogues: r => ({ kind: 'dialogue', id: JSON.stringify([r.task_uuid, r.request_id]) }),
  coordinator_resets: r => ({ kind: 'conversation', id: String(r.conversation_id) }),
  coordinator_conversations: r => ({ kind: 'conversation', id: String(r.id) }),
  coordinator_refusals: r => ({ kind: 'refusal', id: JSON.stringify([r.request_id, r.task_uuid]) }),
  field_defs: r => ({ kind: 'field_def', id: String(r.id) }),
  project_fields: r => ({ kind: 'project_field', id: JSON.stringify([r.project_task_id, r.position]) }),
};
const identify = (key: ChangeKey) => JSON.stringify([key.kind, key.id]);
type Snapshot = Map<string, Map<string, { text: string; key: ChangeKey }>>;
function snapshot(root: string): Snapshot {
  const db = new DatabaseSync(controlDatabasePath(root), { readOnly: true });
  try {
    db.exec('BEGIN');
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => String(r.name));
    for (const table of tables) assert.notEqual(Boolean(keyOf[table]), unobservedTables.has(table),
      `Table must be classified exactly once: ${table}`);
    assert.deepEqual(tables.filter(t => keyOf[t]).sort(), Object.keys(keyOf).sort(), 'tracked tables must exist');
    const all: Snapshot = new Map();
    for (const table of tables.filter(t => keyOf[t])) {
      const rows = new Map<string, { text: string; key: ChangeKey }>();
      for (const row of db.prepare(`SELECT rowid AS __rowid, * FROM "${table}"`).all()) {
        const ignored = new Set(unobservedColumns[table] ?? []);
        const data = Object.fromEntries(Object.entries(row).filter(([column]) => column !== '__rowid' && !ignored.has(column)));
        rows.set(String(row.__rowid), { text: JSON.stringify(data), key: keyOf[table]!(row) });
      }
      all.set(table, rows);
    }
    return all;
  } finally { db.close(); }
}
export function changeAudit(root: string, log: ChangeLog) {
  let before = snapshot(root), serial = 0;
  const stop = log.register('audit');
  return {
    close: stop,
    async step<T>(name: string, operation: () => T | Promise<T>, pendingKinds: readonly string[] = []): Promise<{ result: T; pending: string[] }> {
      let result!: T, failure: unknown;
      try { result = await operation(); } catch (error) { failure = error; }
      const after = snapshot(root), read = log.read('audit');
      assert.equal(read.kind, 'changes', `${name}: audit journal overflow`);
      if (read.kind !== 'changes') throw new Error('Audit overflow');
      const touched = new Set(read.batches.flatMap(batch => batch.keys.map(identify))), pending: string[] = [];
      for (const [table, oldRows] of before) {
        const rows = after.get(table)!;
        for (const id of new Set([...oldRows.keys(), ...rows.keys()])) {
          const old = oldRows.get(id), next = rows.get(id);
          if (old?.text === next?.text) continue;
          const changedKeys = new Map([old, next].filter(row => row !== undefined).map(row => [identify(row!.key), row!]));
          for (const row of changedKeys.values()) {
            if (touched.has(identify(row.key))) continue;
            const message = `${++serial}: ${name}: missing ${table} ${identify(row.key)}`;
            if (pendingKinds.includes(row.key.kind)) pending.push(message);
            else assert.fail(message);
          }
        }
      }
      before = after;
      log.acknowledge('audit', read.through);
      if (failure !== undefined) throw failure;
      return { result, pending };
    },
  };
}
