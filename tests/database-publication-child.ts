/** A bounded initializer, never an agent; parent owns termination by ChildProcess PID. */
import { DatabaseSync } from 'node:sqlite';
import { RunStore } from '@alpacawork/runs';
const [root, mode] = process.argv.slice(2);
if (mode !== 'open') {
  const original = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql: string) {
    if (sql === 'COMMIT') {
      if (mode === 'after-commit') original.call(this, sql);
      process.send!('paused');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
      throw new Error('Parent did not terminate the paused initializer');
    }
    return original.call(this, sql);
  };
}
process.send!('ready');
process.once('message', () => {
  // Concurrent writers request SQLite lock waiting; zero-budget readers are tested separately.
  const store = new RunStore(root, { busyTimeoutMs: mode === 'open' ? 3000 : 0 });
  try { process.send!(store.read()); }
  finally { store.close(); process.disconnect(); }
});
