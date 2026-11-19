/** The local SQLite opener and its packaged migrations, on the host database it opens beside the control database. */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { openDatabase } from '@alpacawork/db';

const project = resolve(import.meta.dirname, '..');
let area: string;
beforeEach(() => { area = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-db-'))); });
afterEach(() => { rmSync(area, {recursive: true, force: true}); });
function inspect<T>(path: string, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try { return run(db); } finally { db.close(); }
}
const open = (path: string) => openDatabase(path, 'host', { busyTimeoutMs: 3000 });
const tables = (db: DatabaseSync) => db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);

test('a fresh database has only its current tables and one migration, also after reopening', () => {
  const path = join(area, 'host.sqlite');
  open(path).$client.close();
  inspect(path, db => db.exec("INSERT INTO minutes(at,memory_free_average,memory_free_min) VALUES(1,0.5,0.4)"));
  open(path).$client.close();
  inspect(path, db => {
    assert.deepEqual(tables(db), ['__drizzle_migrations', 'episodes', 'minutes']);
    assert.equal(db.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()!.n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM minutes').get()!.n, 1);
  });
});

test('modified or foreign migration history is refused without losing facts', () => {
  const path = join(area, 'host.sqlite');
  open(path).$client.close();
  inspect(path, db => db.exec("INSERT INTO minutes(at,memory_free_average,memory_free_min) VALUES(1,0.5,0.4)"));
  const before = inspect(path, db => db.prepare('SELECT * FROM minutes').all());
  const original = inspect(path, db => db.prepare('SELECT hash FROM __drizzle_migrations').get()!.hash);
  inspect(path, db => db.exec("UPDATE __drizzle_migrations SET hash='modified'"));
  assert.throws(() => open(path), /migration history/);
  inspect(path, db => {
    db.prepare('UPDATE __drizzle_migrations SET hash=?').run(original!);
    db.exec("INSERT INTO __drizzle_migrations(hash,created_at,name) VALUES('foreign',9999999999999,'foreign')");
  });
  assert.throws(() => open(path), /migration history/);
  assert.deepEqual(inspect(path, db => db.prepare('SELECT * FROM minutes').all()), before);
});

for (const schema of [
  "CREATE TABLE old_facts(value TEXT); INSERT INTO old_facts VALUES('keep')",
  'PRAGMA user_version=1',
  'CREATE VIEW old_view AS SELECT 1',
]) test(`an unversioned nonempty database is refused: ${schema}`, () => {
  const path = join(area, 'host.sqlite');
  const before = inspect(path, db => {
    db.exec(schema);
    return db.prepare('SELECT type,name,sql FROM sqlite_schema').all();
  });
  assert.throws(() => open(path), /explicit stopped-server maintenance migration/);
  inspect(path, db => {
    assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_schema').all(), before);
    if (schema.includes('old_facts')) assert.equal(db.prepare('SELECT value FROM old_facts').get()!.value, 'keep');
    if (schema.includes('user_version')) assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 1);
  });
  // Refusal releases its handle and startup lock; the evacuated path can start fresh.
  rmSync(path);
  open(path).$client.close();
});

test('concurrent first opens apply one migration', async () => {
  const path = join(area, 'host.sqlite');
  const script = "import {openDatabase} from '@alpacawork/db'; process.send('ready'); process.once('message', () => {openDatabase(process.argv[1],'host',{busyTimeoutMs:3000}).$client.close(); process.disconnect();});";
  const children = Array.from({length: 3}, () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, path], {cwd: project, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    return {child, ready: once(child, 'message'), done: once(child, 'exit'), stderr: () => stderr};
  });
  try {
    await Promise.all(children.map(item => item.ready));
    for (const {child} of children) child.send('open');
    for (const item of children) assert.equal((await item.done)[0], 0, item.stderr());
    inspect(path, db => assert.equal(db.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()!.n, 1));
  } finally {
    for (const {child, done} of children) if (child.exitCode === null) { child.kill(); await done; }
  }
});
