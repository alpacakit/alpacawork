/** SIGKILL occurs inside the real transaction/manager boundary, never in product code. */
import fs from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RunStore } from '@alpacawork/runs';
import { controlDatabasePath } from '@alpacawork/db';
import { readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { settleTransaction } from '@alpacawork/backend/test-dist/runs/scheduler.js';

const [root, mode] = process.argv.slice(2);
type CommitBoundary = { database: string; write: true; state: 'running' };
const crash = (point: string, boundary?: CommitBoundary) => {
  fs.writeFileSync(join(root, 'crash-reached'), JSON.stringify({ point, pid: process.pid, boundary }));
  process.kill(process.pid, 'SIGKILL');
};
if (mode.startsWith('settle-')) {
  const store = new RunStore(root, { busyTimeoutMs: 10_000 });
  const exec = DatabaseSync.prototype.exec;
  const runsDb = controlDatabasePath(root);
  const writing = new WeakSet<DatabaseSync>();
  DatabaseSync.prototype.exec = function (sql) {
    if (sql === 'BEGIN IMMEDIATE' && this.location() === runsDb) writing.add(this);
    if (sql === 'ROLLBACK') writing.delete(this);
    if (sql === 'COMMIT' && writing.has(this) && this.location() === runsDb) {
      const state = this.prepare("SELECT json_extract(record, '$.state') AS state FROM runs ORDER BY id LIMIT 1")
        .get() as { state: string } | undefined;
      if (state?.state !== 'running') throw new Error('Settle crash hook reached before the launch decision');
      const boundary: CommitBoundary = { database: runsDb, write: true, state: 'running' };
      if (mode === 'settle-before-commit') crash(mode, boundary);
      const result = exec.call(this, sql); crash(mode, boundary); return result;
    }
    return exec.call(this, sql);
  };
  await settleTransaction(store, readAgentsSettings(root));
  throw new Error('settle crash hook missed');
}
throw new Error('Unknown scheduler fault point');
