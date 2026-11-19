/** Scoped storage faults shared by in-process HTTP and separate real-CLI drivers. */
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { controlDatabasePath } from '@alpacawork/db';
import type { TestContext } from 'node:test';

export function installFault(root: string, mode: string, mock?: TestContext['mock']) {
  let hits = 0;
  const restores: (() => void)[] = [];
  function patch(object: any, key: string, fn: (...args: any[]) => any) {
    if (mock) { const method = mock.method(object, key, fn); restores.push(() => method.mock.restore()); }
    else { const original = object[key]; object[key] = fn; restores.push(() => { object[key] = original; }); }
  }
  if (mode === 'commit' || mode === 'busy') {
    const original = DatabaseSync.prototype.exec;
    patch(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
      if (sql === 'COMMIT' && this.prepare('PRAGMA database_list').all().some(row => row.file === controlDatabasePath(root)) &&
        Number(this.prepare('SELECT count(*) n FROM runs').get()!.n) > 0) {
        hits++; throw Object.assign(new Error(`B8 injected ${mode}`), { errcode: mode === 'busy' ? 5 : 10 });
      }
      return original.call(this, sql);
    });
  } else if (mode !== 'insert') throw new Error(`Unknown fault ${mode}`);
  // INSERT faults are installed by the parent as a SQLite trigger, so they
  // affect the real CLI's independent connection as well.
  syncBuiltinESMExports();
  return { get hits() { return hits; }, restore() { restores.reverse().forEach(restore => restore()); syncBuiltinESMExports(); } };
}
