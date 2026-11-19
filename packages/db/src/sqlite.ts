/** Local SQLite storage. Never recreates a corrupt existing database. */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, openSync, closeSync, constants, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { checkDatabaseFiles } from './database-family.js';
import { FILE_MODE, PROBLEM_CODE, Problem, tryLock } from '@alpacawork/core';
import { controlRootFromDatabasePath } from './control-files.js';
import { connectControlDatabase, controlConnectionLease } from './control-writer.js';
import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { assertCurrentMigrations, databaseMigrationHistory, hasMigrationHistory, migrateDatabase, type DatabaseKind, type DataMigration } from './migrate.js';

export type Database = NodeSQLiteDatabase & { $client: DatabaseSync };
export type DatabaseOptions = { busyTimeoutMs: number };
export function validBusyTimeout(options: DatabaseOptions): boolean {
  return Number.isInteger(options.busyTimeoutMs) && options.busyTimeoutMs >= 0 && options.busyTimeoutMs <= 2_147_483_647;
}
function validateOptions(options: DatabaseOptions): void {
  if (!validBusyTimeout(options))
    throw new Problem(PROBLEM_CODE.invalidInput, 'Busy timeout must be a nonnegative 32-bit integer', undefined,
      { reason: { kind: 'busy_timeout_must_nonnegative_32_bit_integer' } });
}
/** Set the SQLite busy handler at connection creation, before any validation or SQL. */
function connectDatabase(filename: string, kind: DatabaseKind, options: DatabaseOptions, readOnly = false): DatabaseSync {
  if (kind === 'control') return connectControlDatabase(controlRootFromDatabasePath(filename), options, readOnly);
  if (!readOnly && !existsSync(filename)) closeSync(openSync(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, FILE_MODE));
  return new DatabaseSync(filename, { readOnly, timeout: options.busyTimeoutMs });
}
export function openDatabase(filename: string, kind: DatabaseKind, options: DatabaseOptions): Database {
  validateOptions(options);
  try { return initializeDatabase(filename, kind, options); }
  catch (error) {
    if (error instanceof Problem) throw error;
    throw new Problem(PROBLEM_CODE.databaseUnavailable, 'Database could not be opened; existing files are preserved', undefined,
      { reason: { kind: 'database_could_not_opened_existing_files_preserved' }, cause: error });
  }
}
function initializeDatabase(filename: string, kind: DatabaseKind, options: DatabaseOptions, maintenance = false, dataMigration?: DataMigration): Database {
  statSync(dirname(filename));
  // Control borrows the workspace writer for the entire connection, including maintenance.
  // Only host initialization uses a separate startup lock.
  if (kind === 'control') {
    const release = controlConnectionLease(controlRootFromDatabasePath(filename));
    try { return openLockedDatabase(filename, kind, options, maintenance, dataMigration); } finally { release(); }
  }
  // Drizzle reads migration history before BEGIN. Serialize open + migration across
  // processes opening the same database, including the first WAL setup. Never unlink a lock inode.
  const lock = openSync(filename + '.lock', constants.O_RDWR | constants.O_CREAT, FILE_MODE);
  try {
    const deadline = performance.now() + 3000;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      if (tryLock(lock)) break;
      if (performance.now() >= deadline)
        throw new Problem(PROBLEM_CODE.databaseUnavailable, 'Database initialization is busy; retry after the current opener', undefined,
          { reason: { kind: 'database_initialization_busy_retry_after_current_opener' } });
      Atomics.wait(sleeper, 0, 0, 10);
    }
    return openLockedDatabase(filename, kind, options, maintenance, dataMigration);
  } finally { closeSync(lock); }
}
export { DATABASE_SUFFIXES, checkDatabaseFiles } from './database-family.js';
/** SQLite owns the read snapshot; readOnly forbids changes to durable data, including migration. */
export function openDatabaseReadOnly(filename: string, kind: DatabaseKind, options: DatabaseOptions): Database {
  validateOptions(options);
  try {
    statSync(dirname(filename));
    checkDatabaseFiles(filename);
    const client = connectDatabase(filename, kind, options, true);
    try {
      client.exec('BEGIN');
      if (client.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
        throw new Error('SQLite integrity check failed');
      assertCurrentMigrations(client, kind);
      client.exec('COMMIT');
      return drizzle({ client });
    } catch (error) { client.close(); throw error; }
  } catch (error) {
    if (error instanceof Problem) throw error;
    throw new Problem(PROBLEM_CODE.databaseUnavailable, 'Database could not be read; existing files are preserved', undefined,
      { reason: { kind: 'database_could_not_read_existing_files_preserved' }, cause: error });
  }
}

function openLockedDatabase(filename: string, kind: DatabaseKind, options: DatabaseOptions, maintenance: boolean, dataMigration?: DataMigration): Database {
  checkDatabaseFiles(filename);
  let db: DatabaseSync | undefined;
  try {
    const creating = !existsSync(filename);
    if (!creating && maintenance) {
      const current = connectDatabase(filename, kind, options, true);
      try { authenticateMaintenanceHistory(current, kind); } finally { current.close(); }
    }
    db = connectDatabase(filename, kind, options);
    if (!creating) {
      if (maintenance) {
        authenticateMaintenanceHistory(db, kind);
      } else assertCurrentMigrations(db, kind);
    }
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
      throw new Error('SQLite integrity check failed');
    const orm = drizzle({ client: db });
    if (creating || maintenance) migrateDatabase(orm, kind, dataMigration);
    return orm;
  } catch (error) {
    db?.close();
    throw error;
  }
}

/** Explicit maintenance only, under the same writer ownership as ordinary open. Existing empty files are never fresh. */
export function migrateExistingDatabase(filename: string, kind: DatabaseKind, options: DatabaseOptions, dataMigration?: DataMigration): void {
  validateOptions(options); checkDatabaseFiles(filename, true);
  const db = initializeDatabase(filename, kind, options, true, dataMigration);
  db.$client.close();
}
/** Stopped inspection accepts a valid prefix without advancing it. */
export function inspectDatabaseHistory(filename: string, kind: DatabaseKind, options: DatabaseOptions) {
  validateOptions(options); checkDatabaseFiles(filename, true);
  const db = connectDatabase(filename, kind, options, true);
  try {
    if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Database integrity check failed');
    const history = databaseMigrationHistory(db, kind);
    if (!history.length) throw new Error('Existing database has no migration history');
    return history;
  } finally { db.close(); }
}

function authenticateMaintenanceHistory(db: DatabaseSync, kind: DatabaseKind): void {
  if (!hasMigrationHistory(db) || !databaseMigrationHistory(db, kind).length)
    throw new Error('Existing database has no migration history');
}
