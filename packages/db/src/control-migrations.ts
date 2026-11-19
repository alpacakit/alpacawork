import type { DatabaseSync } from 'node:sqlite';
import { assertCurrentMigrations, databaseMigrationHistory, packagedMigrations, parseMigrationHistory, migrationPrefix, type MigrationIdentity } from './migrate.js';
/** Reader boundary for the raw c9 reader. SQL history, not this marker, advances the database. */
export const CONTROL_VERSION = 16;
export type ControlSchema = { version: number; history: MigrationIdentity[] };
export const controlSchemaManifest = () => ({ version: CONTROL_VERSION, history: packagedMigrations('control') });
export function validateControlMigrations(db: DatabaseSync): void {
  assertCurrentMigrations(db, 'control');
}
export function controlSchemaState(db: DatabaseSync): ControlSchema {
  return parseControlSchema({ version: Number(db.prepare('PRAGMA user_version').get()!.user_version), history: databaseMigrationHistory(db, 'control') });
}
export function parseControlSchema(value: unknown): ControlSchema {
  if (!value || typeof value !== 'object' || !('version' in value) || !Number.isSafeInteger(value.version)) throw new Error('Invalid control SCHEMA');
  const version = Number(value.version);
  if (version !== CONTROL_VERSION) throw new Error('Unknown control SCHEMA reader marker');
  if (!('history' in value)) throw new Error('Control SCHEMA history is missing');
  const history = parseMigrationHistory(value.history);
  if (!history.length) throw new Error('Control SCHEMA history is empty');
  return { version, history };
}
export function sameControlSchema(a: ControlSchema, b: ControlSchema): boolean {
  return a.version === b.version && a.history.length === b.history.length && migrationPrefix(a.history, b.history);
}
export function canMigrateControlSchema(before: ControlSchema, after: ControlSchema): boolean {
  return before.version === CONTROL_VERSION && after.version === CONTROL_VERSION &&
    before.history.length > 0 && migrationPrefix(before.history, after.history);
}
