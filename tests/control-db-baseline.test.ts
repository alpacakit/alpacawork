/** Only the current control database version opens, and rejected databases remain unchanged. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { maintenance } from '@alpacawork/backend/test-dist/maintenance.js';
import { CONTROL_VERSION, packagedMigrations, ControlStore, controlDatabasePath, openControlDatabase } from '@alpacawork/db';

function fresh(t: import('node:test').TestContext, name: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `alpacawork-control-${name}-`)));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('a fresh control database has the current baseline: no projects table, both sequences, standard migration history', t => {
  const root = fresh(t, 'baseline');
  const db = openControlDatabase(root, { busyTimeoutMs: 1000 }, false, true);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, CONTROL_VERSION);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'projects'").get()!.n, 0);
    // Numbers start at 1; the root project P1 is the workspace's (initializeWorkspace), not the baseline's.
    for (const sequence of ['task_sequence', 'run_sequence'])
      assert.deepEqual(db.prepare(`SELECT singleton, next_number FROM ${sequence}`).all().map(row => ({ ...row })),
        [{ singleton: 1, next_number: 1 }], sequence);
    assert.equal(db.prepare('SELECT count(*) AS n FROM tasks').get()!.n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='control_schema_migrations'").get()!.n, 0);
    assert.deepEqual(db.prepare('SELECT name,hash FROM __drizzle_migrations ORDER BY id').all().map(row => ({ ...row })), packagedMigrations('control'));
    assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.throws(() => db.prepare(`INSERT INTO task_log(id,task_id,ordinal,entry) VALUES ('bad','missing',1,'{"id":"bad","kind":"reported"}')`).run(),
      /FOREIGN KEY constraint failed/);
  } finally { db.close(); }
  const reopened = new ControlStore(root);
  try { assert.equal(reopened.connection.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='control_schema_migrations'").get()!.n, 0); }
  finally { reopened.close(); }
});

test('an older or an unknown version is refused by every opener, and its bytes stay as they were', async t => {
  for (const version of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 99]) await t.test(`version ${version}`, async t => {
    const root = fresh(t, `version-${version}`);
    const refusal = new RegExp(`Unsupported control database version ${version}; supported version is ${CONTROL_VERSION}`);
    const created = openControlDatabase(root, { busyTimeoutMs: 1000 }, false, true);
    // Without a WAL beside it, the file alone is the database whose bytes are compared.
    created.exec(`PRAGMA journal_mode=DELETE; PRAGMA user_version=${version}`);
    created.close();
    const file = controlDatabasePath(root), before = readFileSync(file);
    assert.throws(() => openControlDatabase(root, { busyTimeoutMs: 0 }, true), refusal, 'a read');
    assert.throws(() => openControlDatabase(root, { busyTimeoutMs: 0 }), refusal, 'a write');
    assert.throws(() => new ControlStore(root), refusal, 'the store');
    await assert.rejects(maintenance(root, 'inspect'), /Unknown|Unsupported/, 'maintenance inspection');
    await assert.rejects(maintenance(root, 'migrate'), refusal, 'maintenance migration refuses retired or unknown history');
    assert.deepEqual(readFileSync(file), before);
    const unchanged = new DatabaseSync(file, { readOnly: true });
    try { assert.equal(unchanged.prepare('PRAGMA user_version').get()!.user_version, version); }
    finally { unchanged.close(); }
  });
});
