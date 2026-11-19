/** Fresh control databases retain the migration evidence guards. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controlDatabasePath, databaseMigrationHistory, openControlMaintenanceDatabase, openDatabase } from '@alpacawork/db';
import { validateMigrationEvidence } from '../packages/db/src/control-migration-snapshot.ts';
const DROP_EVIDENCE_SQL = '20261108010000_drop_task_values_evidence';

test('a new database takes the step with no record to remove and keeps the delete guards', t => {
  const root = mkdtempSync(join(tmpdir(), 'task-values-fresh-'));
  mkdirSync(join(root, '.alpacawork')); t.after(() => rmSync(root, { recursive: true, force: true }));
  openDatabase(controlDatabasePath(root), 'control', { busyTimeoutMs: 1000 }).$client.close();
  const db = openControlMaintenanceDatabase(root, { busyTimeoutMs: 1000 }, true);
  try {
    assert.ok(databaseMigrationHistory(db, 'control').some(row => row.name === DROP_EVIDENCE_SQL));
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'control_migration_%_delete' ORDER BY name").all()
      .map(row => String(row.name)), ['control_migration_evidence_delete', 'control_migration_sources_delete']);
    validateMigrationEvidence(db);
  } finally { db.close(); }
});
