import { createOriginal, copyWorkspace, removeWorkspace } from '../scripts/dev-fixtures/fixture.ts';
/** Public control connections share stopped-maintenance ownership and history recognition. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import * as db from '@alpacawork/db';
import { RunStore } from '@alpacawork/runs';
import { TaskRepository } from '@alpacawork/backend/test-dist/control/task-store.js';
import { cleanCliEnv } from './helpers/http-cli.ts';
import { evidenceTest as test, rememberEvidenceWorkspace } from './helpers/failure-workspace.ts';

const options = { busyTimeoutMs: 1000 };
const moduleUrl = new URL('../packages/db/dist/index.js', import.meta.url).href;
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
function workspace(t: TestContext): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-control-public-'))), root = join(base, 'data');
  const original = createOriginal({tasks:14,logs:19,runs:7,seed:'control-public'},join(base,'originals'));
  copyWorkspace(original.root,root);
  rememberEvidenceWorkspace(t, root); t.after(() => { removeWorkspace(root); removeWorkspace(original.root); rmSync(base, { recursive: true, force: true }); });
  return root;
}
function maintenance(root: string, command = 'migrate', receipt?: string) {
  return spawnSync(process.execPath, ['apps/backend/dist/maintenance.js', command, root, ...(receipt ? [receipt] : [])],
    { encoding: 'utf8', env: cleanCliEnv(), timeout: 30_000 });
}
function childOpen(root: string, entry = 'common', subject = moduleUrl) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    const m=await import(process.argv[1]),root=process.argv[2],entry=process.argv[3],o={busyTimeoutMs:1000};
    if(entry==='wal') { if(!m.restoreControlWal(root)) throw Error('WAL restore refused'); }
    else if(entry==='maintenance') m.migrateExistingDatabase(m.controlDatabasePath(root),'control',o);
    else { const c=entry==='dedicated'?m.openControlDatabase(root,o):m.openDatabase(m.controlDatabasePath(root),'control',o).$client;
      try {c.exec("UPDATE tasks SET title=title||' writer-bypass' WHERE number=1");} finally {c.close();} }
  `, subject, root, entry], { encoding: 'utf8', env: cleanCliEnv(), timeout: 15_000 });
}
function detectsWriterBypass(root: string, subject = moduleUrl) {
  const before = hash(db.controlDatabasePath(root)), result = childOpen(root, 'common', subject);
  assert.notEqual(result.status, 0, 'a separate common writer must be refused');
  assert.match(result.stderr, /Another serve writer/);
  assert.equal(hash(db.controlDatabasePath(root)), before, 'rejected writer preserves the DB');
}
async function mutant(t: TestContext, change: (source: string) => string) {
  const root = workspace(t), pkg = join(dirname(root), 'subject'); mkdirSync(pkg);
  for (const part of ['dist', 'drizzle'])
    cpSync(new URL('../packages/db/' + part, import.meta.url), join(pkg, part), { recursive: true });
  symlinkSync(new URL('../node_modules', import.meta.url).pathname, join(dirname(root), 'node_modules'));
  const file = join(pkg, 'dist/index.js'), source = readFileSync(file, 'utf8'), changed = change(source);
  assert.notEqual(changed, source, 'mutate the actual production guard'); writeFileSync(file, changed);
  return { subject: await import(pathToFileURL(file).href) as typeof db, url: pathToFileURL(file).href };
}

test('all public control writers reject another process owner and can reopen after its close', t => {
  const root = workspace(t), release = db.holdControlWriter(root);
  try {
    detectsWriterBypass(root);
    for (const entry of ['dedicated', 'maintenance', 'wal']) {
      const result = childOpen(root, entry); assert.notEqual(result.status, 0); assert.match(result.stderr, /Another serve writer/);
    }
  } finally { release(); }
  for (const entry of ['common', 'dedicated', 'maintenance', 'wal']) {
    const result = childOpen(root, entry); assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(existsSync(db.controlDatabasePath(root) + '.lock'), false, 'control never creates a second startup lock');
});

test('a common connection owns the writer until close, and failed validation also releases it', t => {
  const root = workspace(t), c = db.openDatabase(db.controlDatabasePath(root), 'control', options);
  try { detectsWriterBypass(root); } finally { c.$client.close(); }
  assert.equal(childOpen(root).status, 0, 'close must release the connection lease');
  const invalid = workspace(t), raw = db.openControlDatabase(invalid, options);
  raw.exec("UPDATE __drizzle_migrations SET hash='unknown' WHERE id=(SELECT max(id) FROM __drizzle_migrations)"); raw.close();
  assert.throws(() => db.openDatabase(db.controlDatabasePath(invalid), 'control', options));
  const release = db.holdControlWriter(invalid); release();
  const a = db.openDatabase(db.controlDatabasePath(root), 'control', options), b = db.openControlDatabase(root, options);
  a.$client.close();
  try { detectsWriterBypass(root); } finally { b.close(); }
  assert.equal(childOpen(root).status, 0, 'the final borrowed connection releases the writer');
});

const publicEntries = (subject: typeof db, root: string) => {
  const file = subject.controlDatabasePath(root);
  return {
    dedicatedWrite: () => subject.openControlDatabase(root, options).close(),
    dedicatedRead: () => subject.openControlDatabase(root, options, true).close(),
    dedicatedMaintenance: () => subject.openControlMaintenanceDatabase(root, options).close(),
    commonWrite: () => subject.openDatabase(file, 'control', options).$client.close(),
    commonRead: () => subject.openDatabaseReadOnly(file, 'control', options).$client.close(),
    stoppedHistory: () => subject.inspectDatabaseHistory(file, 'control', options),
    commonMaintenance: () => subject.migrateExistingDatabase(file, 'control', options),
  };
};
function detectsInvalidHistory(subject: typeof db, root: string) {
  const file = db.controlDatabasePath(root), before = hash(file);
  for (const [name, open] of Object.entries(publicEntries(subject, root))) {
    assert.throws(open, undefined, name); assert.equal(hash(file), before, name + ' preserves original bytes');
  }
}
test('every public control entry rejects modified standard history before writes, including warm dedicated readers', t => {
  const root = workspace(t), c = db.openControlDatabase(root, options);
  c.exec("UPDATE __drizzle_migrations SET hash='unknown' WHERE id=(SELECT max(id) FROM __drizzle_migrations)"); c.close();
  detectsInvalidHistory(db, root);
  for (const mode of ['inspect', 'migrate']) { const result = maintenance(root, mode); assert.notEqual(result.status, 0); }
});

test('normal16 and fresh common creation use the same public history contract', t => {
  const root = workspace(t);
  for (const open of Object.values(publicEntries(db, root))) open();
  const fresh = join(root, 'fresh'); mkdirSync(join(fresh, '.alpacawork'), {recursive:true});
  db.openDatabase(db.controlDatabasePath(fresh), 'control', options).$client.close();
  assert.deepEqual(db.inspectDatabaseHistory(db.controlDatabasePath(fresh), 'control', options), db.controlSchemaManifest().history);
  assert.throws(() => db.openDatabase(join(root, 'arbitrary.sqlite'), 'control', options), /workspace path/);
  assert.equal(existsSync(join(root, 'arbitrary.sqlite')), false);
});

test('removing actual connection ownership makes the same separate-process writer detector fail', async t => {
  const { url } = await mutant(t, code => code.replace('return holdControlWriter(root, false);', 'return () => {};'));
  const root = workspace(t), release = db.holdControlWriter(root);
  try {
    detectsWriterBypass(root);
    assert.throws(() => detectsWriterBypass(root, url), { code: 'ERR_ASSERTION' });
  } finally { release(); }
});

test('main WAL repair recognizes control history before any journal change', t => {
  const root = workspace(t), c = db.openControlDatabase(root, options);
  c.exec("UPDATE __drizzle_migrations SET hash='unknown' WHERE id=(SELECT max(id) FROM __drizzle_migrations)"); c.close();
  const original = hash(db.controlDatabasePath(root)), error = t.mock.method(console, 'error', () => {});
  try { assert.equal(db.restoreControlWal(root), false); assert.equal(hash(db.controlDatabasePath(root)), original); }
  finally { error.mock.restore(); }
});

/** The formal server readers: no second cache or connection wiring in this integration check. */
function keptSnapshot(root: string, readOnly = true) {
  const store = new db.ControlStore(root, options, readOnly);
  try { return store.read(connection => new TaskRepository(root, connection).snapshot()); }
  finally { store.close(); }
}
function keptRequests(root: string) {
  const store = new RunStore(root, options, true);
  try { return store.readRequests(); } finally { store.close(); }
}
function detectsCommittedReadonlyCache(root: string, readOnly = true) {
  const release = db.keepControlTables(root);
  try {
    const a = keptSnapshot(root, readOnly), b = keptSnapshot(root, readOnly);
    const first = a.tasks.flatMap(task => task.meta.log)[0]!;
    assert.ok(first, 'the common dummy has task history');
    assert.equal(b.tasks.flatMap(task => task.meta.log)[0], first, 'readonly committed entries are shared');
    assert.ok(Object.isFrozen(first), 'the shared committed entry is frozen');
  } finally { release(); }
}

test('current history reaches main committed-read caching; substituting writable reads fails the same detector', t => {
  const root = workspace(t);
  detectsCommittedReadonlyCache(root);
  assert.throws(() => detectsCommittedReadonlyCache(root, false), { code: 'ERR_ASSERTION' });
});

test('kept formal callers preserve common writer rollback and warm-cache modified-history refusal', t => {
  const root = workspace(t), release = db.keepControlTables(root);
  t.after(release);
  const before = keptSnapshot(root), requests = keptRequests(root);
  const writer = db.openDatabase(db.controlDatabasePath(root), 'control', options);
  try {
    detectsWriterBypass(root);
    writer.$client.exec("BEGIN IMMEDIATE; UPDATE tasks SET title=title||' pending transaction' WHERE number=1");
    assert.deepEqual(keptSnapshot(root), before, 'formal readonly readers keep their committed snapshot');
    assert.deepEqual(keptRequests(root), requests);
    writer.$client.exec('ROLLBACK');
  } finally { writer.$client.close(); }
  assert.equal(childOpen(root, 'maintenance').status, 0, 'common close releases its writer with kept readers enabled');
  assert.deepEqual(keptSnapshot(root), before);
  const c = db.openDatabase(db.controlDatabasePath(root), 'control', options);
  try { c.$client.exec("UPDATE __drizzle_migrations SET hash='unknown' WHERE id=(SELECT max(id) FROM __drizzle_migrations)"); }
  finally { c.$client.close(); }
  detectsInvalidHistory(db, root);
  const bytes = hash(db.controlDatabasePath(root));
  assert.throws(() => keptSnapshot(root)); assert.throws(() => keptRequests(root));
  assert.equal(hash(db.controlDatabasePath(root)), bytes, 'warm formal cache never masks modified history or writes the DB');
});
