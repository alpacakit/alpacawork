/** Kill the HTTP receiver after Request admission commits, before its reply reaches the CLI. */
import { DatabaseSync } from 'node:sqlite';
import { controlDatabasePath } from '@alpacawork/db';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { main as cliMain } from '../../apps/cli/dist/cli.js';

const [root, task, bodyFile, opId, taskHash, placementRevision] = process.argv.slice(2);
const app = await startServer(root!, 0);
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  const admitted = sql === 'COMMIT' && this.location() === controlDatabasePath(root!) &&
    !!this.prepare('SELECT 1 FROM runs WHERE request_id = ?').get(opId!);
  const result = exec.call(this, sql);
  if (admitted) process.kill(process.pid, 'SIGKILL');
  return result;
};
await cliMain(['--server', app.url, 'task', 'request', '--task', task!, '--instruction-file', bodyFile!,
  '--op-id', opId!, '--expected-task-hash', taskHash!, '--expected-placement-revision', placementRevision!]);
throw new Error('Request admission crash hook missed');
