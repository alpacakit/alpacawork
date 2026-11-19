/** One control database owns Task and Run facts from its first committed baseline. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CONTROL_VERSION, openControlDatabase, controlDatabasePath } from '@alpacawork/db';
import { RunStore } from '@alpacawork/runs';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { initializeControlFixture } from './helpers/control-fixture.ts';

function fresh(t: import('node:test').TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-publication-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const open = (root: string) => openControlDatabase(root, { busyTimeoutMs: 1000 }, false, true);

test('a read cannot create an absent control database', t => {
  const root = fresh(t);
  assert.throws(() => openControlDatabase(root, { busyTimeoutMs: 0 }, true), { code: 'ENOENT' });
  assert.equal(readdirSync(root).length, 0);
});

test('first writer publishes one baseline for Task and Run readers', async t => {
  const root = fresh(t);
  const db = open(root);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, CONTROL_VERSION);
    assert.equal(db.prepare('PRAGMA foreign_key_check').get(), undefined);
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  } finally { db.close(); }
  const project = initializeControlFixture(root);
  const task = (await new ControlTaskCommands(root, { kind: 'human' }).create({ parentId: project, userRequested: null,
    tasks: [{ title: 'Saved' }] })).tasks[0];
  const runs = new RunStore(root, { busyTimeoutMs: 0 });
  try {
    assert.deepEqual(runs.read(), []);
    assert.equal(runs.connection.prepare('SELECT external_id FROM tasks WHERE external_id=?').get(task.id)!.external_id, task.id);
  } finally { runs.close(); }
  const reader = openControlDatabase(root, { busyTimeoutMs: 0 }, true);
  try {
    assert.equal(reader.prepare('SELECT title FROM tasks WHERE external_id=?').get(task.id)!.title, 'Saved');
    assert.throws(() => reader.exec("UPDATE tasks SET title='changed'"), /readonly/);
  } finally { reader.close(); }
});

test('a failed standard baseline transaction rolls back marker and domain DDL; the existing file is preserved until explicitly evacuated', t => {
  const root = fresh(t), original = DatabaseSync.prototype.prepare;
  let faults = 0;
  const hook = t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (sql === 'COMMIT') { faults++; throw new Error('injected standard commit fault'); }
    return original.call(this, sql);
  });
  try { assert.throws(() => open(root), /Database migration failed/); }
  finally { hook.mock.restore(); }
  assert.equal(faults, 1, 'fault injection reaches the standard migrator commit');
  const filename = controlDatabasePath(root), raw = new DatabaseSync(filename);
  try {
    assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 0);
    assert.equal(raw.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='tasks'").get()!.n, 0);
    assert.equal(raw.prepare('SELECT count(*) n FROM __drizzle_migrations').get()!.n, 0);
  } finally { raw.close(); }
  const before = readFileSync(filename);
  assert.throws(() => open(root), /Unsupported control database version 0/);
  assert.deepEqual(readFileSync(filename), before);
  rmSync(filename); // Only this synthetic failed-creation file is explicitly evacuated.
  const db = open(root);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, CONTROL_VERSION);
    assert.equal(db.prepare('SELECT next_number FROM task_sequence').get()!.next_number, 1);
  } finally { db.close(); }
});
