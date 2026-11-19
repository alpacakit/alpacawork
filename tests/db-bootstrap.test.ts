/** Standard Drizzle history through the production database and maintenance entry points. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { type TestContext } from 'node:test';
import { evidenceTest as test, rememberEvidenceWorkspace } from './helpers/failure-workspace.ts';
import { DatabaseSync } from 'node:sqlite';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { controlDatabasePath, controlSchemaManifest, databaseState, openControlDatabase, openControlMaintenanceDatabase, openDatabase, openDatabaseReadOnly, migrateExistingDatabase, inspectDatabaseHistory, packagedMigrations, sameControlSchema } from '@alpacawork/db';
import { cleanCliEnv } from './helpers/http-cli.ts';

const options = { busyTimeoutMs: 1000 };
function workspace(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'alpacawork-drizzle-'));
  rememberEvidenceWorkspace(t, root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.alpacawork'), { mode: 0o700 });
  return root;
}
function snapshot(root: string) {
  const db = new DatabaseSync(controlDatabasePath(root), { readOnly: true });
  try { return databaseState(db); } finally { db.close(); }
}
function edit(root: string, sql: string) {
  const db = new DatabaseSync(controlDatabasePath(root));
  try { db.exec(sql); } finally { db.close(); }
}
function command(root: string, mode = 'migrate') {
  return spawnSync(process.execPath, ['apps/backend/dist/maintenance.js', mode, root], { encoding: 'utf8', env: cleanCliEnv(), timeout: 30_000 });
}
for (const sql of [
  "UPDATE __drizzle_migrations SET hash=printf('%064d',1);", "UPDATE __drizzle_migrations SET name='20990101000000_unknown';",
  'UPDATE __drizzle_migrations SET created_at=0;',
  'INSERT INTO __drizzle_migrations(hash,created_at,name,applied_at) SELECT hash,created_at,name,applied_at FROM __drizzle_migrations;',
  'DELETE FROM __drizzle_migrations;', 'DROP TABLE __drizzle_migrations;', 'PRAGMA user_version=15;',
]) test(`control read/write/maintenance reject malformed history before mutation: ${sql}`, async t => {
  const root = workspace(t); openControlDatabase(root, options, false, true).close(); edit(root, sql);
  const before = snapshot(root);
  for (const readOnly of [true, false]) assert.throws(() => openControlDatabase(root, options, readOnly, true));
  const result = command(root); assert.notEqual(result.status, 0); assert.deepEqual(snapshot(root), before);
});
for (const kind of ['control', 'host'] as const) for (const content of ['', 'broken sqlite file']) {
  test(`${kind} existing ${content ? 'corrupt' : 'empty'} file is never mistaken for fresh`, t => {
    const root = workspace(t), file = kind === 'control' ? controlDatabasePath(root) : join(root, 'host.sqlite');
    writeFileSync(file, content); const before = readFileSync(file);
    assert.throws(() => kind === 'control' ? openControlDatabase(root, options, false, true) : openDatabase(file, kind, options));
    assert.deepEqual(readFileSync(file), before);
  });
}
test('host ordinary read/write refuse missing/modified/duplicate history and preserve all rows', t => {
  const root = workspace(t);
  for (const sql of ['DELETE FROM __drizzle_migrations', "UPDATE __drizzle_migrations SET hash=printf('%064d',1)",
    'INSERT INTO __drizzle_migrations(hash,created_at,name) SELECT hash,created_at,name FROM __drizzle_migrations']) {
    const file = join(root, String(Math.random())+'.sqlite'), db = openDatabase(file, 'host', options);
    db.$client.exec(sql); const before = databaseState(db.$client); db.$client.close();
    assert.throws(() => openDatabase(file, 'host', options)); assert.throws(() => openDatabaseReadOnly(file, 'host', options));
    assert.throws(() => migrateExistingDatabase(file, 'host', options));
    const raw = new DatabaseSync(file); assert.deepEqual(databaseState(raw), before); raw.close();
  }
});
async function extendedPackage(t: TestContext, migrationSQL = 'CREATE TABLE added_by_history (id INTEGER PRIMARY KEY) STRICT;\n') {
  const root = workspace(t), pkg = join(root, 'db'); mkdirSync(pkg);
  cpSync(new URL('../packages/db/dist', import.meta.url), join(pkg, 'dist'), { recursive: true });
  cpSync(new URL('../packages/db/drizzle', import.meta.url), join(pkg, 'drizzle'), { recursive: true });
  symlinkSync(new URL('../node_modules', import.meta.url).pathname, join(root, 'node_modules'));
  for (const kind of ['control','host']) {
    const folder = join(pkg, 'drizzle', kind, '20990101000000_added'); mkdirSync(folder);
    writeFileSync(join(folder, 'migration.sql'), migrationSQL);
  }
  return await import(pathToFileURL(join(pkg, 'dist/index.js')).href) as typeof import('@alpacawork/db');
}
test('same marker16 with a longer packaged history requires explicit maintenance; prefix guard rejects future, non-prefix and reordered histories', async t => {
  const next = await extendedPackage(t), root = workspace(t);
  openControlDatabase(root, options, false, true).close();
  assert.throws(() => next.openControlDatabase(root, options), /maintenance/);
  assert.throws(() => next.openControlDatabase(root, options, true), /maintenance/);
  for (const open of [next.openDatabase, next.openDatabaseReadOnly]) assert.throws(() => open(controlDatabasePath(root), 'control', options), /maintenance/);
  assert.deepEqual(next.inspectDatabaseHistory(controlDatabasePath(root), 'control', options), controlSchemaManifest().history);
  assert.equal(sameControlSchema(controlSchemaManifest(), next.controlSchemaManifest()), false);
  next.migrateExistingDatabase(controlDatabasePath(root), 'control', options);
  const db = next.openControlDatabase(root, options); assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='added_by_history'").get() !== undefined, true); db.close();
  assert.throws(() => openControlDatabase(root, options), /history/);
  for (const open of [next.openDatabase, next.openDatabaseReadOnly]) open(controlDatabasePath(root), 'control', options).$client.close();
  const commonRoot = workspace(t), commonFile = controlDatabasePath(commonRoot);
  openDatabase(commonFile, 'control', options).$client.close();
  next.migrateExistingDatabase(commonFile, 'control', options);
  next.openControlDatabase(commonRoot, options).close();
  assert.equal(next.inspectDatabaseHistory(commonFile, 'control', options).length, controlSchemaManifest().history.length + 1);
  for (const sql of ['DELETE FROM __drizzle_migrations WHERE id=1', 'UPDATE __drizzle_migrations SET id=id+10 WHERE id=1']) {
    const other = workspace(t); next.openControlDatabase(other, options, false, true).close(); edit(other, sql); const before = snapshot(other);
    assert.throws(() => next.migrateExistingDatabase(controlDatabasePath(other), 'control', options), /history/); assert.deepEqual(snapshot(other), before);
  }
  const file = join(root, 'host.sqlite'); openDatabase(file, 'host', options).$client.close();
  assert.throws(() => next.openDatabase(file, 'host', options), /maintenance/);
  next.migrateExistingDatabase(file, 'host', options);
  next.openDatabaseReadOnly(file, 'host', options).$client.close();
  assert.throws(() => openDatabaseReadOnly(file, 'host', options), /history/);
});

test('the standard fresh migrator rolls back marker16 and DDL together on an SQL failure', async t => {
  const root = workspace(t), pkg = join(root, 'failing-db'); mkdirSync(pkg);
  cpSync(new URL('../packages/db/dist', import.meta.url), join(pkg, 'dist'), { recursive: true });
  cpSync(new URL('../packages/db/drizzle', import.meta.url), join(pkg, 'drizzle'), { recursive: true });
  symlinkSync(new URL('../node_modules', import.meta.url).pathname, join(root, 'node_modules'));
  const baseline = join(pkg, 'drizzle/control', packagedMigrations('control')[0]!.name, 'migration.sql');
  writeFileSync(baseline, readFileSync(baseline, 'utf8')+'\n--> statement-breakpoint\nSELECT * FROM deliberate_missing_table;\n');
  const subject = await import(pathToFileURL(join(pkg, 'dist/index.js')).href) as typeof import('@alpacawork/db');
  assert.throws(() => subject.openControlDatabase(root, options, false, true));
  const db = new DatabaseSync(controlDatabasePath(root));
  try {
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='tasks'").get()!.n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM __drizzle_migrations').get()!.n, 0);
  } finally { db.close(); }
});

test('removing the actual common hash guard makes the normal-opener regression detect the bypass', async t => {
  const root = workspace(t), pkg = join(root, 'mutant-db'); mkdirSync(pkg);
  cpSync(new URL('../packages/db/dist', import.meta.url), join(pkg, 'dist'), {recursive:true});
  cpSync(new URL('../packages/db/drizzle', import.meta.url), join(pkg, 'drizzle'), {recursive:true});
  symlinkSync(new URL('../node_modules', import.meta.url).pathname, join(root, 'node_modules'));
  const file = join(pkg,'dist/index.js'), source = readFileSync(file,'utf8');
  const mutant = source.replace('row.hash !== migrations[i]?.hash', 'false');
  assert.notEqual(mutant, source, 'remove the production guard, not the test harness'); writeFileSync(file, mutant);
  const subject = await import(pathToFileURL(file).href) as typeof import('@alpacawork/db');
  openControlDatabase(root, options, false, true).close(); edit(root, "UPDATE __drizzle_migrations SET hash=printf('%064d',1)");
  assert.throws(() => openControlDatabase(root,options), /history/);
  const regression = () => assert.throws(() => subject.openControlDatabase(root,options).close(), /history/);
  assert.throws(regression, {code:'ERR_ASSERTION'}, 'the same detector must fail against the removed hash guard');
});

test('the shared explicit migrator also refuses a15 marker combined with standard16 history before writes', async t => {
  const {drizzle}=await import('drizzle-orm/node-sqlite'); const {migrateDatabase}=await import('@alpacawork/db');
  const root=workspace(t);openControlDatabase(root,options,false,true).close();edit(root,'PRAGMA user_version=15');
  const before=snapshot(root),db=new DatabaseSync(controlDatabasePath(root));
  try {assert.throws(()=>migrateDatabase(drizzle({client:db}),'control'),/mixed/);}finally{db.close();}
  assert.deepEqual(snapshot(root),before);
});

for (const marker of [0, 15, 17, 999]) test(`one marker/history recognition rejects mixed control marker${marker} at every public boundary without DB changes`, async t => {
  const { drizzle } = await import('drizzle-orm/node-sqlite');
  const { migrateDatabase } = await import('@alpacawork/db');
  const root = workspace(t), file = controlDatabasePath(root);
  openControlDatabase(root, options, false, true).close(); edit(root, `PRAGMA user_version=${marker}`);
  const before = snapshot(root), bytes = readFileSync(file);
  const refusals = {
    dedicatedWrite: () => openControlDatabase(root, options).close(),
    dedicatedRead: () => openControlDatabase(root, options, true).close(),
    commonWrite: () => openDatabase(file, 'control', options).$client.close(),
    commonRead: () => openDatabaseReadOnly(file, 'control', options).$client.close(),
    stoppedHistory: () => inspectDatabaseHistory(file, 'control', options),
    stoppedControl: () => openControlMaintenanceDatabase(root, options).close(),
    commonMaintenance: () => migrateExistingDatabase(file, 'control', options),
    explicitMigrator: () => { const raw = new DatabaseSync(file); try { migrateDatabase(drizzle({ client: raw }), 'control'); } finally { raw.close(); } },
  };
  for (const [name, operation] of Object.entries(refusals)) {
    assert.throws(operation, undefined, name);
    assert.deepEqual(snapshot(root), before, name); assert.deepEqual(readFileSync(file), bytes, name);
  }
  for (const mode of ['inspect', 'migrate']) {
    const result = command(root, mode); assert.notEqual(result.status, 0, mode);
    assert.deepEqual(snapshot(root), before, mode); assert.deepEqual(readFileSync(file), bytes, mode);
  }
});

test('regular control16 and fresh/empty standard history use the same public recognition and migrator', async t => {
  const { drizzle } = await import('drizzle-orm/node-sqlite');
  const { migrateDatabase, standardMigrationHistorySQL } = await import('@alpacawork/db');
  const root = workspace(t), file = controlDatabasePath(root);
  // A failed fresh migration can leave an empty standard history table at marker0.
  const raw = new DatabaseSync(file); raw.exec(standardMigrationHistorySQL('control'));
  assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 0);
  migrateDatabase(drizzle({ client: raw }), 'control'); raw.close();
  const before = snapshot(root);
  for (const readOnly of [false, true]) openControlDatabase(root, options, readOnly).close();
  for (const open of [openDatabase, openDatabaseReadOnly]) open(file, 'control', options).$client.close();
  openControlMaintenanceDatabase(root, options).close(); migrateExistingDatabase(file, 'control', options);
  assert.deepEqual(inspectDatabaseHistory(file, 'control', options), controlSchemaManifest().history);
  for (const mode of ['inspect', 'migrate']) { const result = command(root, mode); assert.equal(result.status, 0, result.stderr); }
  assert.deepEqual(snapshot(root), before);
});

test('removing the shared marker guard makes the common-opener M1 regression fail', async t => {
  const root = workspace(t), pkg = join(root, 'marker-mutant-db'); mkdirSync(pkg);
  cpSync(new URL('../packages/db/dist', import.meta.url), join(pkg, 'dist'), { recursive: true });
  cpSync(new URL('../packages/db/drizzle', import.meta.url), join(pkg, 'drizzle'), { recursive: true });
  symlinkSync(new URL('../node_modules', import.meta.url).pathname, join(root, 'node_modules'));
  const file = join(pkg, 'dist/index.js'), source = readFileSync(file, 'utf8');
  const start = source.indexOf('function assertControlReaderHistory('), end = source.indexOf('\n}', start);
  assert(start >= 0 && end > start, 'locate the actual production marker Owner');
  const guard = source.slice(start, end), mutant = guard.replace(/version !== (?:CONTROL_VERSION\w*|16)/, 'false');
  assert.notEqual(mutant, guard); writeFileSync(file, source.slice(0, start) + mutant + source.slice(end));
  const subject = await import(pathToFileURL(file).href) as typeof import('@alpacawork/db');
  openControlDatabase(root, options, false, true).close(); edit(root, 'PRAGMA user_version=15');
  const database = controlDatabasePath(root);
  const detector = (open: typeof openDatabase) => assert.throws(() => open(database, 'control', options).$client.close());
  detector(openDatabase);
  assert.throws(() => detector(subject.openDatabase), { code: 'ERR_ASSERTION' }, 'same M1 detector must fail when the guard is removed');
});

/** Missing birth time disables the sound-file cache; it never means a file is absent. */
function withoutBirthtime(t: TestContext, root: string, check: () => void) {
  const filename = controlDatabasePath(root), lstat = fs.lstatSync;
  const hook = t.mock.method(fs, 'lstatSync', function (path, options) {
    const stat = lstat(path, options);
    if (String(path) === filename && typeof options === 'object' && options?.bigint)
      Object.defineProperty(stat, 'birthtimeNs', { value: 0n });
    return stat;
  });
  syncBuiltinESMExports();
  try { check(); } finally { hook.mock.restore(); syncBuiltinESMExports(); }
}
function detectsExistingSource(open: typeof openControlDatabase, root: string) {
  const bytes = readFileSync(controlDatabasePath(root));
  assert.throws(() => open(root, options, false, true).close(), /maintenance/);
  assert.deepEqual(readFileSync(controlDatabasePath(root)), bytes);
}
test('an existing prefix DB with no birth time is refused before writable setup even with create requested', t => {
  const root = workspace(t); openControlDatabase(root, options, false, true).close(); edit(root, 'DELETE FROM __drizzle_migrations WHERE id=(SELECT MAX(id) FROM __drizzle_migrations)');
  withoutBirthtime(t, root, () => detectsExistingSource(openControlDatabase, root));
});
test('substituting cache identity for existence makes the same public-opener preservation check fail', async t => {
  const root = workspace(t), pkg = join(root, 'mutant-existence');
  openControlDatabase(root, options, false, true).close(); edit(root, 'DELETE FROM __drizzle_migrations WHERE id=(SELECT MAX(id) FROM __drizzle_migrations)'); mkdirSync(pkg);
  for (const part of ['dist', 'drizzle'])
    cpSync(new URL('../packages/db/' + part, import.meta.url), join(pkg, part), { recursive: true });
  symlinkSync(new URL('../node_modules', import.meta.url).pathname, join(root, 'node_modules'));
  const file = join(pkg, 'dist/index.js'), code = readFileSync(file, 'utf8');
  const mutant = code.replace('const creating = !existed && create && !readOnly;', 'const creating = before === null && create && !readOnly;');
  assert.notEqual(mutant, code, 'substitute the production creation decision'); writeFileSync(file, mutant);
  const subject = await import(pathToFileURL(file).href) as typeof import('@alpacawork/db');
  withoutBirthtime(t, root, () => assert.throws(() => detectsExistingSource(subject.openControlDatabase, root), { code: 'ERR_ASSERTION' }));
});
