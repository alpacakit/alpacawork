/** Packaged SQL and the standard Drizzle migrator own every ordinary schema transition. */
import { DatabaseSync } from 'node:sqlite';
import { databaseAsset } from './assets.js';
import { drizzle, type NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { CONTROL_VERSION } from './control-migrations.js';
import { PROBLEM_CODE, Problem, type ProblemReason } from '@alpacawork/core';

export const MIGRATIONS_TABLE = '__drizzle_migrations';
export type DatabaseKind = 'control' | 'host';
export type MigrationIdentity = { name: string; hash: string };
/** SQL invokes stopped inspection and transformation inside the standard migrator's
 * transaction, before the history receipt commits. */
export type DataMigration = (name: string, db: DatabaseSync) => void;
function unavailable(message: string, reason: ProblemReason): never {
  throw new Problem(PROBLEM_CODE.databaseUnavailable, message + '; existing database is preserved', undefined, { reason });
}
export class ExplicitMigrationRequired extends Problem {
  constructor(_kind: DatabaseKind) {
    super(PROBLEM_CODE.databaseUnavailable, 'Database requires explicit stopped-server maintenance migration; existing database is preserved', undefined,
      { reason: { kind: 'database_migration_required' } });
  }
}
const migrationsFolder = (kind: DatabaseKind) => databaseAsset('drizzle', kind);
// Packaged SQL belongs to this running release; database history is still checked on every open.
const packagedByKind = new Map<DatabaseKind, ReturnType<typeof readMigrationFiles>>();
function packaged(kind: DatabaseKind) {
  const cached = packagedByKind.get(kind);
  if (cached) return cached;
  const migrations = readMigrationFiles({ migrationsFolder: migrationsFolder(kind) });
  if (!migrations.length) unavailable('No migrations are packaged', { kind: 'no_migrations_packaged' });
  if (migrations.some((m, i) => !/^\d{14}_[a-zA-Z0-9_-]+$/.test(m.name) || !Number.isFinite(m.folderMillis) ||
      i > 0 && m.name <= migrations[i - 1]!.name)) throw new Error('Invalid packaged migration order/name');
  packagedByKind.set(kind, migrations); return migrations;
}
export const packagedMigrations = (kind: DatabaseKind): MigrationIdentity[] => packaged(kind).map(({ name, hash }) => ({ name, hash }));
export function parseMigrationHistory(input: unknown): MigrationIdentity[] {
  if (!Array.isArray(input) || input.some(row => !row || typeof row !== 'object' ||
      Object.keys(row).sort().join(',') !== 'hash,name' || typeof row.name !== 'string' || !/^\d{14}_[a-zA-Z0-9_-]+$/.test(row.name) ||
      typeof row.hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.hash)) ||
      input.some((row, i) => i > 0 && row.name <= input[i - 1].name)) throw new Error('Unknown or modified migration history');
  return input.map(({ name, hash }) => ({ name, hash }));
}
export function migrationPrefix(before: MigrationIdentity[], after: MigrationIdentity[]): boolean {
  return before.length <= after.length && before.every((row, i) => row.name === after[i]?.name && row.hash === after[i]?.hash);
}
export function hasMigrationHistory(raw: DatabaseSync): boolean {
  return !!raw.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(MIGRATIONS_TABLE);
}
const normalize = (sql: string) => sql.replace(/\s+/g, '').replaceAll('"', '').toLowerCase();
// Generated from the standard migrator, never a separately maintained history DDL.
const historyDefinitions = new Map<DatabaseKind, string>();
export function standardMigrationHistorySQL(kind: DatabaseKind): string {
  const cached = historyDefinitions.get(kind);
  if (cached) return cached;
  const scratch = new DatabaseSync(':memory:');
  try {
    scratch.function('alpacawork_data_migration', (_name) => 0); // Empty schema derivation has no application data.
    migrate(drizzle({ client: scratch }), { migrationsFolder: migrationsFolder(kind) });
    const sql = String(scratch.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(MIGRATIONS_TABLE)!.sql);
    historyDefinitions.set(kind, sql); return sql;
  } finally { scratch.close(); }
}
/** The reader marker and authenticated standard history identify a control database. */
function assertControlReaderHistory(raw: DatabaseSync): void {
  const version = Number(raw.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  if (version !== CONTROL_VERSION)
    unavailable(`Unsupported control database version ${version}; supported version is ${CONTROL_VERSION}; unknown or mixed control reader marker/history; explicit maintenance migration required`,
      { kind: 'unknown_or_modified_migration_history' });
}
/** Strict prefix validation always precedes the migrator, whose RC implementation checks only names. */
export function databaseMigrationHistory(raw: DatabaseSync, kind: DatabaseKind): MigrationIdentity[] {
  const migrations = packaged(kind);
  if (!hasMigrationHistory(raw)) return [];
  const definition = raw.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(MIGRATIONS_TABLE);
  if (!definition || normalize(String(definition.sql)) !== normalize(standardMigrationHistorySQL(kind)))
    unavailable('Unknown or modified migration history', { kind: 'unknown_or_modified_migration_history' });
  const history = raw.prepare(`SELECT id,name,hash,created_at FROM ${MIGRATIONS_TABLE} ORDER BY id`).all();
  if (history.length > migrations.length || history.some((row, i) => !Number.isSafeInteger(row.id) || Number(row.id) <= 0 ||
      row.name !== migrations[i]?.name || row.hash !== migrations[i]?.hash || row.created_at !== migrations[i]?.folderMillis))
    unavailable('Unknown or modified migration history', { kind: 'unknown_or_modified_migration_history' });
  if (kind === 'control' && history.length) assertControlReaderHistory(raw);
  return history.map(row => ({ name: String(row.name), hash: String(row.hash) }));
}
export function assertCurrentMigrations(raw: DatabaseSync, kind: DatabaseKind): void {
  const history = databaseMigrationHistory(raw, kind);
  if (kind === 'control') assertControlReaderHistory(raw);
  if (history.length !== packaged(kind).length) throw new ExplicitMigrationRequired(kind);
}
export function migrateDatabase(db: NodeSQLiteDatabase & { $client: DatabaseSync }, kind: DatabaseKind, dataMigration?: DataMigration): void {
  try {
    const raw = db.$client, migrations = packaged(kind), history = databaseMigrationHistory(raw, kind);
    if (history.length === migrations.length) return;
    if (!history.length && (raw.prepare('PRAGMA user_version').get()?.user_version !== 0 ||
        raw.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name != ? LIMIT 1").get(MIGRATIONS_TABLE)))
      unavailable('Unsupported database schema', { kind: 'database_schema_unsupported' });
    raw.function('alpacawork_data_migration', (name) => {
      if (!history.length) return 0; // Fresh database: schema only; no saved config or history to transform.
      if (!dataMigration) throw new ExplicitMigrationRequired(kind);
      dataMigration(String(name), raw); return 0;
    });
    migrate(db, { migrationsFolder: migrationsFolder(kind) });
    assertCurrentMigrations(raw, kind);
  } catch (error) {
    // A data step's own refusal says why; the migrator wraps it in its failed query.
    for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) if (cause instanceof Problem) throw cause;
    throw new Problem(PROBLEM_CODE.databaseUnavailable, 'Database migration failed; existing database is preserved', undefined,
      { reason: { kind: 'database_migration_failed_existing_database_preserved' }, cause: error });
  }
}
