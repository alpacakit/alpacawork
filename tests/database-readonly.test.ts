/** Real SQLite snapshots must survive a writer's last close without copying live files. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { RunStore } from '@alpacawork/runs';
import { controlDatabasePath } from '@alpacawork/db';

function database(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'alpacawork-readonly-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // A different process initializes the file so the reader has no cached validation.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import { openControlDatabase } from '@alpacawork/db'; openControlDatabase(process.argv[1], {busyTimeoutMs:0}, false, true).close();", root],
    { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  const file = controlDatabasePath(root), writer = new DatabaseSync(file);
  writer.prepare("INSERT INTO agents(id,created_at) VALUES('A1','2026-10-05')").run();
  return { root, file, writer };
}

for (const point of ['before-read', 'during-read'] as const) test(`last writer closes ${point} and a fresh reader sees committed data`, t => {
  const h = database(t);
  let closed = false;
  const close = () => { if (!closed) { h.writer.close(); closed = true; } };
  t.after(close);
  const open = fs.openSync, prepare = DatabaseSync.prototype.prepare;
  // Closing at either read boundary must preserve the committed snapshot.
  const fileRead = t.mock.method(fs, 'openSync', function (path, ...args) {
    if (point === 'before-read' && path === h.file + '-wal') close();
    return open(path, args[0], args[1]);
  });
  const sqlRead = t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (this.location() === h.file && (point === 'before-read' ? sql === 'PRAGMA quick_check' : sql === 'PRAGMA user_version')) close();
    return prepare.call(this, sql);
  });
  syncBuiltinESMExports();
  let reader: RunStore | null = null;
  try {
    reader = RunStore.openReadable(h.root, { busyTimeoutMs: 0 });
    assert.equal(closed, true, 'writer closed inside the validation boundary');
    assert.equal(reader!.connection.prepare("SELECT created_at FROM agents WHERE id='A1'").get()!.created_at, '2026-10-05');
    assert.throws(() => reader!.connection.exec("UPDATE agents SET created_at='forbidden'"), /readonly/);
  } finally {
    reader?.close(); fileRead.mock.restore(); sqlRead.mock.restore(); syncBuiltinESMExports();
  }
});

test('read-only validation sees committed history and rows while a writer has uncommitted changes', t => {
  const h = database(t);
  t.after(() => h.writer.close());
  h.writer.exec('BEGIN IMMEDIATE');
  h.writer.exec("UPDATE agents SET created_at='uncommitted'; PRAGMA user_version=999");
  const reader = RunStore.openReadable(h.root, { busyTimeoutMs: 0 })!;
  try {
    assert.equal(reader.connection.prepare("SELECT created_at FROM agents WHERE id='A1'").get()!.created_at, '2026-10-05');
  } finally { reader.close(); h.writer.exec('ROLLBACK'); }
});

test('incompatible WAL version is refused without changing the main file or committed WAL bytes', t => {
  const h = database(t);
  t.after(() => h.writer.close());
  h.writer.exec('PRAGMA user_version=999');
  const files = [h.file, h.file + '-wal'], before = files.map(file => fs.readFileSync(file));
  assert.throws(() => RunStore.openReadable(h.root, { busyTimeoutMs: 0 }), /Unsupported control database version/);
  files.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), before[i]));
  assert.equal(h.writer.prepare("SELECT created_at FROM agents WHERE id='A1'").get()!.created_at, '2026-10-05');
});

test('on a filesystem without birth times every open is checked, as a new file there can take a freed inode', t => {
  const h = database(t); h.writer.close();
  const lstat = fs.lstatSync, prepare = DatabaseSync.prototype.prepare;
  let checks = 0;
  const hook = t.mock.method(fs, 'lstatSync', function (path, options) {
    const info = lstat(path, options);
    if (path === h.file && options?.bigint) Object.defineProperty(info, 'birthtimeNs', { value: 0n });
    return info;
  });
  const sql = t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, text: string) {
    if (text === 'PRAGMA quick_check') checks++;
    return prepare.call(this, text);
  });
  syncBuiltinESMExports();
  try {
    for (let i = 0; i < 2; i++) RunStore.openReadable(h.root, { busyTimeoutMs: 0 })!.close();
    assert.equal(checks, 2);
  } finally { hook.mock.restore(); sql.mock.restore(); syncBuiltinESMExports(); }
});
