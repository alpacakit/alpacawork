/** Stopped readers accept authenticated Drizzle prefixes without advancing them. */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CONTROL_VERSION } from './control-migrations.js';
import { databaseMigrationHistory } from './migrate.js';
import { validateMigrationEvidence } from './control-migration-snapshot.js';

function controlSchemaRows(db: DatabaseSync) {
  return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(row => [row.type, row.name, row.tbl_name, String(row.sql).replace(/\s+/g, ' ').trim()]);
}
export function controlSchemaFingerprint(db: DatabaseSync): string {
  const rows = controlSchemaRows(db).map(row => row.map(value => typeof value === 'string'
    ? value.replace(/\s*([(),])\s*/g, '$1') : value));
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
export function validateMaintenanceControlSchema(db: DatabaseSync): number {
  if (!databaseMigrationHistory(db, 'control').length) throw new Error('Existing control database has no migration history');
  validateMigrationEvidence(db);
  if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get())
    throw new Error('Control database integrity check failed');
  return CONTROL_VERSION;
}
