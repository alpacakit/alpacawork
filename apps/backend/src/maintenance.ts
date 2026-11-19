import { join } from 'node:path';
import { controlDatabasePath, checkDatabaseFiles, openControlMaintenanceDatabase, holdControlWriter, assertControlQuiescent,
  migrateExistingDatabase, packagedMigrations } from '@alpacawork/db';
import { FileWriter } from './raw/storage.js';
import { snapshotGroup, inspectRecoveryFiles } from './release/recovery-data.js';
import { inspectExecution } from './runs/execution-control.js';
import { AGENT_SETTINGS_MIGRATION, applyAgentSettingsMigration, resumeAgentSettingsConfig } from './agents/migration-storage.js';
import { applyTaskValuesMigration, planTaskValues, TASK_VALUES_MIGRATION } from './control/task-values-migration.js';
import type { DatabaseSync } from 'node:sqlite';

/** The data step a packaged control migration names, run inside its SQL transaction. */
export function applyDataMigration(name: string, db: DatabaseSync, config: Buffer | null): void {
  if (name === TASK_VALUES_MIGRATION) { applyTaskValuesMigration(name, db); return; }
  if (name !== AGENT_SETTINGS_MIGRATION) throw new Error(`Unknown data migration ${name}`);
  if (!config) throw new Error('config.yaml is required for agent migration');
  applyAgentSettingsMigration(name, db, config);
}

/** One capacity-reclamation path for a just-committed migration and explicit stopped upkeep. */
function compactControl(root: string): void {
  assertControlQuiescent(root);
  const db = openControlMaintenanceDatabase(root, { busyTimeoutMs: 1000 }, false);
  try {
    const checkpoint = () => {
      if (db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy !== 0)
        throw new Error('Control compaction checkpoint is busy');
    };
    checkpoint(); db.exec('VACUUM'); checkpoint();
  } finally { db.close(); }
}

/** Serve's stopped modes acquire the same writer lifetime before opening SQLite. */
export async function maintenance(root: string, mode: 'inspect' | 'migrate' | 'compact' | 'recovery-snapshot' | 'recovery-files', destination?: string, snapshotFiles: readonly string[] = []) {
  if (mode === 'recovery-snapshot') {
    if (!destination) throw new Error('Snapshot destination required');
    return snapshotGroup(root, destination, snapshotFiles);
  }
  const release = holdControlWriter(root);
  try {
    if (mode === 'recovery-files') {
      const writer = new FileWriter(root);
      try { return await writer.exclusive(async () => inspectRecoveryFiles(root)); } finally { writer.close(); }
    }
    const inspect = () => {
      checkDatabaseFiles(join(root, '.alpacawork', 'host.sqlite'), false);
      const db = openControlMaintenanceDatabase(root, { busyTimeoutMs: 1000 }, true);
      const writer = new FileWriter(root);
      try { return { ...inspectExecution({ root, connection: db }), agentSettingsPending: resumeAgentSettingsConfig(db, writer, false),
        taskValues: planTaskValues(db) }; }
      finally { writer.close(); db.close(); }
    };
    // Authenticate both histories before any writable opening. A same-schema switch is
    // a true no-op even with live Runs; either pending history requires natural completion.
    const before = inspect();
    const controlPending = before.control.history.length !== packagedMigrations('control').length;
    const hostPending = before.host !== null && before.host.length !== packagedMigrations('host').length;
    if ((mode === 'compact' || mode === 'migrate' && (controlPending || hostPending || before.agentSettingsPending)) && before.unfinishedRuns.length)
      throw new Error('Database maintenance deferred until all Runs naturally end: ' + before.unfinishedRuns.join(', '));
    if (mode === 'compact') {
      if (controlPending || hostPending || before.agentSettingsPending) throw new Error('Complete database migration before explicit compaction');
      compactControl(root);
      return inspect();
    }
    if (mode === 'migrate') {
      if (controlPending || before.agentSettingsPending) {
        if (before.contractUsers.length || before.runtimeUsers.length || before.unpublishedStops)
          throw new Error('Database migration deferred until execution receipts/import/leases are settled');
        const writer = new FileWriter(root);
        try { await writer.exclusive(async () => {
          const config = writer.read('config.yaml');
          if (controlPending) migrateExistingDatabase(controlDatabasePath(root), 'control', { busyTimeoutMs: 1000 },
            (name, db) => applyDataMigration(name, db, config));
          const current = openControlMaintenanceDatabase(root, { busyTimeoutMs: 1000 }, true);
          try { resumeAgentSettingsConfig(current, writer, true); } finally { current.close(); }
        }); } finally { writer.close(); }
      }
      if (controlPending) {
        try { compactControl(root); }
        catch (cause) {
          throw new Error('Control migration committed but compaction failed; resume the same release switch to restore service, then use stopped maintenance compact to reclaim space', { cause });
        }
      }
      if (hostPending) migrateExistingDatabase(join(root, '.alpacawork', 'host.sqlite'), 'host', { busyTimeoutMs: 1000 });
      if (controlPending || hostPending || before.agentSettingsPending) return inspect();
    }
    return before;
  } finally { release(); }
}
