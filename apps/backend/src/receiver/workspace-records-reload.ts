/** Discover complete owner bundles by indexed identities, including rows absent from the published projection. */
import type { DatabaseSync } from 'node:sqlite';
import type { ChangeKey } from '@alpacawork/db';

export function bundleReloadKeys(db: DatabaseSync, tasks: readonly string[]): ChangeKey[] {
  const keys: ChangeKey[] = [];
  const add = (kind: ChangeKey['kind'], sql: string, id: string) => {
    for (const row of db.prepare(sql).all(id)) keys.push({ kind, id: String(row.id) });
  };
  for (const id of tasks) {
    for (const kind of ['task', 'task_value', 'dependency', 'files'] as const) keys.push({ kind, id });
    if (db.prepare('SELECT kind FROM tasks WHERE external_id=?').get(id)?.kind === 'project') keys.push({ kind: 'project_field', id });
    add('log', 'SELECT id FROM task_log WHERE task_id=(SELECT id FROM tasks WHERE external_id=?)', id);
    for (const [kind, table] of [['placement', 'placements'], ['request', 'requests'], ['wait_cycle', 'wait_cycles']] as const)
      add(kind, `SELECT id FROM ${table} WHERE task_id=?`, id);
    add('run', "SELECT 'R'||id AS id FROM runs WHERE task_id=?", id);
    add('attempt', 'SELECT a.attempt_id AS id FROM runs r JOIN run_attempts a ON a.run_no=r.id WHERE r.task_id=?', id);
    add('input', `SELECT i.input_id AS id FROM runs r JOIN run_attempts a ON a.run_no=r.id
      JOIN run_inputs i USING(attempt_id) WHERE r.task_id=?`, id);
    add('return', 'SELECT id FROM returns WHERE to_task_id=?', id);
    add('dialogue', "SELECT task_uuid||':'||request_id AS id FROM task_dialogues WHERE task_uuid=(SELECT id FROM tasks WHERE external_id=?)", id);
    // Refusals are indexed by message. The Task's linked messages bound the lookup.
    add('refusal', `SELECT f.request_id||':'||f.task_uuid AS id FROM task_dialogues d
      JOIN coordinator_refusals f ON f.request_id=d.request_id AND f.task_uuid=d.task_uuid
      WHERE d.task_uuid=(SELECT id FROM tasks WHERE external_id=?)`, id);
  }
  return keys;
}

/** Conversation records have no Task bundle. Read only that conversation's Requests and Runs. */
export function conversationReloadKeys(db: DatabaseSync, conversation: string): ChangeKey[] {
  return [{ kind: 'conversation', id: conversation },
    ...db.prepare('SELECT id FROM requests WHERE conversation_id=?').all(conversation).map(row => ({ kind: 'request' as const, id: String(row.id) })),
    ...db.prepare("SELECT 'R'||id AS id FROM runs WHERE conversation_id=?").all(conversation).map(row => ({ kind: 'run' as const, id: String(row.id) }))];
}
