/** Fresh control databases retain the migration evidence guards. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { requestActionReasonSchema } from '@alpacawork/raw';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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

test('the reason migration preserves legacy fix topics and restores immutable history', () => {
  const db = new DatabaseSync(':memory:');
  db.function('alpacawork_data_migration', _name => 0);
  try {
    const source = new URL('../packages/db/drizzle/control/', import.meta.url);
    const migration = '20261126020000_action_reasons';
    const sql = (name: string) => readFileSync(new URL(`${name}/migration.sql`, source), 'utf8');
    for (const name of readdirSync(source).sort()) if (name < migration) db.exec(sql(name));
    const at = '2026-11-26T00:00:00.000Z';
    db.prepare(`INSERT INTO tasks(id,kind,number,parent_id,project_task_id,title,lifecycle,base_state,hold,revision,created_at,updated_at)
      VALUES ('project','project',1,NULL,NULL,'Project','active','todo',0,1,?,?)`).run(at, at);
    db.prepare(`INSERT INTO tasks(id,kind,number,parent_id,project_task_id,title,lifecycle,base_state,hold,revision,created_at,updated_at,analysis_subject)
      VALUES ('task','task',2,'project','project','Task','active','todo',0,1,?,?,?)`)
      .run(at, at, JSON.stringify({ kind: 'cause', key: 'review_flow' }));
    db.prepare("INSERT INTO agents(id,created_at) VALUES ('agent',?)").run(at);
    db.prepare(`INSERT INTO placements(id,task_id,agent_id,profile_key,responsible,revision,started_at)
      VALUES ('placement','T2','agent','codex',1,1,?)`).run(at);
    db.prepare(`INSERT INTO requests(id,task_id,placement_id,placement_revision,task_hash,mode,body,purpose,author,submitted_at,delivery_state)
      VALUES ('request','T2','placement',1,'hash','new','Work','instruction','{"kind":"human"}',?,'queued')`).run(at);
    const old = { id: 'request:label', kind: 'request_labeled', at, actor: { kind: 'human' }, title: null, description: null,
      fromState: null, toState: null, label: { request: 'request', kind: 'fix', fixes: ['look_feel', 'review_flow'] } };
    db.prepare("INSERT INTO task_log(id,task_id,ordinal,entry) VALUES (?,'task',0,?)").run(old.id, JSON.stringify(old));
    db.exec(sql(migration));
    const row = db.prepare("SELECT reason FROM requests WHERE id='request'").get()!;
    assert.equal(db.prepare('SELECT id FROM task_log WHERE id=?').get(old.id), undefined);
    assert.deepEqual(requestActionReasonSchema.parse(JSON.parse(String(row.reason))), { taken: { code: 'fix', cause: 'other',
      aspects: ['look_feel', 'presentation'], note: 'migrated', of: null } });
    assert.equal(db.prepare("SELECT json_extract(analysis_subject,'$.key') AS key FROM tasks WHERE id='task'").get()?.key, 'presentation');
    assert.throws(() => db.prepare("UPDATE requests SET reason=NULL WHERE id='request'").run(), /immutable/);
    db.prepare("INSERT INTO task_log(id,task_id,ordinal,entry) VALUES ('history','task',0,?)")
      .run(JSON.stringify({ ...old, id: 'history', kind: 'body_updated', label: undefined }));
    assert.throws(() => db.prepare("DELETE FROM task_log WHERE id='history'").run(), /immutable/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});
