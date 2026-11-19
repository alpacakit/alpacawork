/** Fresh control databases are completed without ever connecting SQLite to a filesystem target. */
import { DatabaseSync } from 'node:sqlite';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrateDatabase } from './migrate.js';
import { validateControlMigrations } from './control-migrations.js';

export function buildControlDatabaseImage<T>(seed: (db: DatabaseSync) => T): { image: Buffer; value: T } {
  const db = new DatabaseSync(':memory:');
  try {
    // Node >=24.16 provides serialize; the repository's older Node declarations omit it.
    const serialize = (db as DatabaseSync & { serialize?: () => Uint8Array }).serialize;
    if (typeof serialize !== 'function') throw new Problem(PROBLEM_CODE.unsupportedPlatform, 'Node with SQLite serialization support is required', undefined,
      { reason: { kind: 'sqlite_serialization_required' } });
    db.exec('PRAGMA foreign_keys=ON');
    // The packaged migrator owns current SQL and its history, for both disk and fresh memory databases.
    migrateDatabase(drizzle({ client: db }), 'control');
    db.exec('BEGIN IMMEDIATE');
    let value: T;
    try { value = seed(db); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
    validateControlMigrations(db);
    if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get())
      throw new Error('Fresh control database integrity check failed');
    // This is a complete DELETE-format image. The ordinary writable DB Owner activates WAL on first use.
    return { image: Buffer.from(serialize.call(db)), value };
  } finally { db.close(); }
}
