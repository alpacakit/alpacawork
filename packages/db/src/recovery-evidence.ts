/** Recovery raises the existing sequences; this evidence is a frozen observation, never another allocator. */
import type { DatabaseSync } from 'node:sqlite';
export type RecoveryEvidence = { taskNext: number; runNext: number; taskMax: number; runMax: number;
  // Bodies already live in the frozen control database. The group keeps only the
  // index used for authorization and old-operation admission after restoration.
  operations: { opId: string; state: string; status?: number; tasks: string[] }[] };
const integer = (value: unknown) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('Recovery sequence evidence is absent or unsafe');
  return n;
};
export function controlRecoveryEvidence(db: DatabaseSync): RecoveryEvidence {
  const taskNext = integer(db.prepare('SELECT next_number FROM task_sequence WHERE singleton=1').get()?.next_number);
  const runNext = integer(db.prepare('SELECT next_number FROM run_sequence WHERE singleton=1').get()?.next_number);
  let taskMax = 0, runMax = 0;
  const scan = (text: string) => {
    for (const match of text.matchAll(/\b([TPR])([1-9][0-9]*)\b/g)) {
      const number = integer(match[2]);
      if (match[1] === 'R') runMax = Math.max(runMax, number); else taskMax = Math.max(taskMax, number);
    }
  };
  // Include deleted/history/JSON/public identifiers, rather than only surviving Task rows.
  for (const row of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
    const table = String(row.name).replaceAll('"','""');
    for (const value of db.prepare(`SELECT * FROM "${table}"`).iterate())
      for (const field of Object.values(value)) if (typeof field === 'string') scan(field);
  }
  taskMax = Math.max(taskMax, Number(db.prepare('SELECT coalesce(max(number),0) n FROM tasks').get()!.n));
  runMax = Math.max(runMax, Number(db.prepare('SELECT coalesce(max(id),0) n FROM runs').get()!.n));
  const tasksFor = (body: unknown): string[] => {
    if (!body || typeof body !== 'object') return [];
    const b = body as Record<string, unknown>, ids: string[] = [];
    for (const item of [b.task, ...Array.isArray(b.tasks) ? b.tasks : []])
      if (item && typeof item === 'object' && 'id' in item && /^[TP][1-9][0-9]*$/.test(String(item.id))) ids.push(String(item.id));
    for (const id of [...Array.isArray(b.cancelled) ? b.cancelled : [], ...Array.isArray(b.stop_requested) ? b.stop_requested : []]) {
      if (typeof id !== 'string' || !/^R[1-9][0-9]*$/.test(id)) throw new Error('Unknown operation Run reference');
      const task = db.prepare('SELECT task_id FROM runs WHERE id=?').get(integer(id.slice(1)))?.task_id;
      if (task !== null && task !== undefined) ids.push(String(task));
    }
    return ids;
  };
  const operations: RecoveryEvidence['operations'] = [];
  for (const row of db.prepare(`SELECT o.*,t.external_id task FROM file_operations o LEFT JOIN tasks t ON t.id=o.task_uuid`).iterate()) {
    const receipt = row.result_json === null ? null : JSON.parse(String(row.result_json));
    operations.push({ opId: String(row.op_id), state: row.state === 'published' ? 'committed' : String(row.state),
      ...(row.state === 'published' ? { status: receipt.status } : {}), tasks: row.task === null ? [] : [String(row.task)] });
  }
  const recorded=new Set(operations.map(op=>op.opId));
  for (const row of db.prepare('SELECT * FROM cli_operations').iterate()) {
    const body = JSON.parse(String(row.response_json));
    if (!recorded.has(String(row.op_id))) operations.push({ opId: String(row.op_id), state: 'committed',
      status: Number(row.status), tasks: tasksFor(body) });
  }
  return { taskNext, runNext, taskMax, runMax, operations };
}
export function raiseRecoverySequences(db: DatabaseSync, evidence: Pick<RecoveryEvidence,'taskNext'|'runNext'|'taskMax'|'runMax'>): void {
  const task = Math.max(integer(evidence.taskNext), integer(evidence.taskMax + 1));
  const run = Math.max(integer(evidence.runNext), integer(evidence.runMax + 1));
  if (task > 1_000_000_000) throw new Error('Recovery Task number range exhausted');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('UPDATE task_sequence SET next_number=max(next_number,?) WHERE singleton=1').run(task).changes !== 1 ||
      db.prepare('UPDATE run_sequence SET next_number=max(next_number,?) WHERE singleton=1').run(run).changes !== 1) throw new Error('Missing recovery sequence');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
