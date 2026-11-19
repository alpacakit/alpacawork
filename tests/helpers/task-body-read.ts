/** Observe Task values' bytes actually returned by SQLite during a read on this thread (their JSON text).
 * Unrelated server maintenance has a separate async context and is not counted.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';

export async function taskBodyRead<T>(work: () => Promise<T>) {
  const reads = { bytes: 0, rows: 0 };
  const scope = new AsyncLocalStorage<boolean>();
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function(sql: string) {
    const statement = prepare.call(this, sql);
    const all = statement.all;
    statement.all = function(...args: Parameters<typeof all>) {
      const rows = all.apply(this, args);
      if (scope.getStore()) for (const row of rows) if ('external_id' in row && 'task_values' in row) {
        reads.rows++;
        if (typeof row.task_values === 'string') reads.bytes += Buffer.byteLength(row.task_values);
      }
      return rows;
    };
    return statement;
  };
  try { return { result: await scope.run(true, work), reads }; }
  finally { DatabaseSync.prototype.prepare = prepare; }
}
