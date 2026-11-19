// The ORM lives inside this package's bundle, so its query helpers are
// re-exported here: a second copy imported directly by a caller would be a
// second set of drizzle classes over the same tables.
export { and, count, eq, sql } from 'drizzle-orm';
export { checkDatabaseFiles, openDatabase, openDatabaseReadOnly, migrateExistingDatabase, inspectDatabaseHistory } from './sqlite.js';
export type { Database, DatabaseOptions } from './sqlite.js';
export * from './migrate.js';
export * from './control.js';
export * from './change-key.js';
export * from './change-log.js';
export * from './change-scope.js';
export * from './control-image.js';
export { holdControlWriter, assertControlWriterAvailable, controlConnectionLease, assertControlQuiescent } from './control-writer.js';
export * from './control-migrations.js';
export * from './control-maintenance-schema.js';
export { writeMigrationEvidence } from './control-migration-snapshot.js';
export { databaseState, rawSchemaShape, rowsDigest } from './database-evidence.js';

export * from './maintenance-files.js';
export * from './recovery-snapshot.js';
export * from './recovery-evidence.js';
