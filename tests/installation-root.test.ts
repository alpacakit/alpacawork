/** Real filesystem and backend inputs for the shared installation/root boundary. No actual HOME/service writes. */
import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { appendFileSync, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { InstallationStore, installationPath, type Installation } from '@alpacawork/backend/test-dist/installation/store.js';
import { initializeInstallation, validateNewWorkspace } from '@alpacawork/backend/test-dist/installation/setup.js';
import { findWorkspace, inspectWorkspace, selectWorkspace } from '@alpacawork/backend/test-dist/workspace.js';
import { initializeWorkspace } from '@alpacawork/backend/test-dist/control/initialize.js';
import { createOriginal, copyWorkspace, removeWorkspace, profiles } from '../scripts/dev-fixtures/fixture.ts';
import { cleanCliEnv } from './helpers/http-cli.ts';
import { preserveFailureWorkspace } from './helpers/failure-workspace.ts';
import { DatabaseSync } from 'node:sqlite';
import { ControlStore, controlDatabasePath, openControlMaintenanceDatabase, CONTROL_VERSION, validateControlMigrations, packagedMigrations } from '@alpacawork/db';
import { problemReasonSchema } from '@alpacawork/core';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';

import fs from 'node:fs';

import { syntheticStatusApp } from './helpers/agent-inspection.ts';
let backend: string;
const setupUrl = new URL('../apps/backend/test-dist/installation/setup.js', import.meta.url).href;
const storeUrl = new URL('../apps/backend/test-dist/installation/store.js', import.meta.url).href;
const storageUrl = new URL('../apps/backend/test-dist/raw/storage.js', import.meta.url).href;
let suite: string, original: string;
const children = new Set<ChildProcess>();
const origins = new Map<string, string>();
const stops = new Map<string, () => Promise<void>>();
const capturedAreas = new Set<string>();
async function preserveInstallationFailure(t: TestContext, area: string, failure?: unknown) {
  if ((failure === undefined && (t as TestContext & { passed: boolean }).passed) || capturedAreas.has(area)) return;
  const base = process.env.ALPACAWORK_FAILURE_EVIDENCE_DIR ?? resolve('.local/installation-evidence/failures');
  mkdirSync(base, { recursive: true });
  const destination = mkdtempSync(join(base, 'installation-'));
  const raw = preserveFailureWorkspace(area, join(destination, 'raw'));
  const origin = origins.get(area), http: unknown[] = [];
  if (origin) for (const path of ['/api/workspace/live', '/api/host/status']) {
    try { const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(3000) });
      http.push({ path, status: response.status, body: await response.text() }); }
    catch (error) { http.push({ path, error: String(error) }); }
  }
  writeFileSync(join(destination, 'failure.json'), JSON.stringify({ test: t.fullName,
    error: String(failure ?? (t as TestContext & { error: unknown }).error), raw,
    http: origin ? { state: 'started', origin, responses: http } : { state: 'not_started' } }, null, 2));
  capturedAreas.add(area); t.diagnostic(`First failure rawFS/log/hash: ${destination}`);
  if (raw.files.some(file => file.error)) throw new Error(`Failure rawFS capture incomplete: ${destination}`);
}
function processEvidence(value: unknown) {
  const file = process.env.ALPACAWORK_FAILURE_EVIDENCE_DIR;
  if (file) { mkdirSync(file, { recursive: true }); appendFileSync(join(file, 'installation-processes.jsonl'), JSON.stringify(value) + '\n'); }
}
before(() => {
  suite = realpathSync(mkdtempSync(join(tmpdir(), 'installation-suite-')));
  backend = syntheticStatusApp(resolve('.'), join(suite, 'app'));
  original = createOriginal({ ...profiles.small, seed: 'installation' }, join(suite, 'cache')).root;
});
after(() => {
  assert.equal(children.size, 0, 'all backend/crash processes must be reaped');
  removeWorkspace(original);
  rmSync(suite, { recursive: true, force: true });
});
function fixture(t: TestContext) {
  const area = mkdtempSync(join(suite, 'case-')), home = join(area, '本人 HOME 日本語');
  mkdirSync(home, { mode: 0o700 });
  const env = cleanCliEnv({ HOME: home, PATH: join(area, 'empty-bin'), XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(area, 'unused-xdg-data'), ALPACAWORK_WORKSPACE: '/must-not-be-an-input' });
  delete env.SUDO_USER; delete env.SUDO_UID;
  const request = { cwd: area, env, detectedAgents: [] }, store = new InstallationStore(installationPath(env));
  const copies: string[] = [];
  const copy = (root = join(area, `small-${copies.length}`)) => {
    copyWorkspace(original, root); copies.push(root); return root;
  };
  t.after(async () => {
    await preserveInstallationFailure(t, area);
    await stops.get(area)?.();
    for (const root of copies) if (existsSync(root)) removeWorkspace(root);
    rmSync(area, { recursive: true, force: true });
  });
  return { area, home, env, request, store, copy, copies };
}
function bytes(root: string): Record<string, string> {
  if (!existsSync(root)) return {};
  const result: Record<string, string> = {};
  function visit(directory: string, relative = '') {
    for (const name of readdirSync(directory).sort()) {
      const file = join(directory, name), key = join(relative, name), info = lstatSync(file);
      if (info.isDirectory()) { result[key + '/'] = 'directory'; visit(file, key); }
      else if (info.isFile()) result[key] = createHash('sha256').update(readFileSync(file)).digest('hex');
      else result[key] = 'special';
    }
  }
  visit(root); return result;
}
function run(env: NodeJS.ProcessEnv, cwd: string, args: string[], script?: string) {
  const result = spawnSync(process.execPath, script ? ['--input-type=module', '-e', script] : [backend, ...args],
    { env, cwd, encoding: 'utf8', timeout: 20_000 });
  processEvidence({ pid: result.pid, deadlineMs: 20_000, args, script, cwd, status: result.status,
    signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
  assert.ifError(result.error);
  return result;
}
function child(env: NodeJS.ProcessEnv, cwd: string, args: string[], script?: string) {
  const process = spawn(globalThis.process.execPath, script ? ['--input-type=module', '-e', script] : [backend, ...args],
    { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(process);
  processEvidence({ pid: process.pid, deadlineMs: 20_000, args, script, cwd, event: 'started' });
  let stdout = '', stderr = '';
  process.stdout!.on('data', value => { stdout += value; });
  process.stderr!.on('data', value => { stderr += value; });
  const timer = setTimeout(() => process.kill('SIGKILL'), 20_000);
  const done = once(process, 'close').then(([code, signal]) => ({ code, signal, stdout, stderr }))
    .then(result => { processEvidence({ pid: process.pid, event: 'closed', ...result }); return result; })
    .finally(() => { clearTimeout(timer); children.delete(process); });
  return { process, done, output: () => ({ stdout, stderr }) };
}
async function serve(t: TestContext, env: NodeJS.ProcessEnv, cwd: string, args: string[] = []) {
  const live = child(env, cwd, [...args, 'workspace', 'serve', '--port', '0']);
  const lines = createInterface({ input: live.process.stdout! });
  let stopped = false;
  const stop = async () => {
    if (!stopped) { stopped = true; live.process.kill('SIGTERM'); const result = await live.done; origins.delete(cwd); stops.delete(cwd); assert.equal(result.signal, null, result.stderr); }
  };
  t.after(stop);
  stops.set(cwd, stop);
  try {
    const line = await Promise.race([once(lines, 'line').then(([line]) => line), live.done.then(result => { throw Error(JSON.stringify(result)); })]);
    const info = JSON.parse(line); origins.set(cwd, info.url);
    return { ...info, stop };
  } finally { lines.close(); }
}
/** SQL inspection only opens a disposable copy, after the original raw byte observation. */
function databaseFacts(root: string, copy: string) {
  cpSync(root, copy, { recursive: true });
  const db = new DatabaseSync(controlDatabasePath(copy), { readOnly: true });
  try { return { tasks: db.prepare('SELECT external_id,title FROM tasks ORDER BY number').all().map(row => ({ ...row })),
    journal: db.prepare('PRAGMA journal_mode').get()!.journal_mode,
    history: db.prepare('SELECT name,hash FROM __drizzle_migrations ORDER BY id').all().map(row => ({ ...row })) }; }
  finally { db.close(); }
}

test('fresh acquisition refuses an existing nonempty root without creating metadata or lock', async t => {
  const h = fixture(t), root = join(h.area, 'personal-folder'); mkdirSync(root, { mode: 0o700 });
  writeFileSync(join(root, '本人の資料'), 'keep'); const before = bytes(root);
  await assert.rejects(initializeWorkspace(root), /empty directory/);
  assert.deepEqual(bytes(root), before);
});

test('fresh DELETE image keeps readOnly and explicit maintenance unchanged, then normal writers activate WAL once', async t => {
  const h = fixture(t), result = await initializeInstallation(h.request), root = result.root, before = bytes(root);
  const ro = new ControlStore(root, { busyTimeoutMs: 100 }, true);
  try {
    assert.equal(ro.connection.prepare('PRAGMA journal_mode').get()!.journal_mode, 'delete');
    assert.equal(ro.connection.prepare('PRAGMA user_version').get()!.user_version, CONTROL_VERSION);
    validateControlMigrations(ro.connection);
    assert.deepEqual(ro.connection.prepare('SELECT name,hash FROM __drizzle_migrations ORDER BY id').all().map(row => ({ ...row })),
      packagedMigrations('control'), 'fresh descriptor publication uses the current packaged SQL/history Owner');
    assert.equal(ro.connection.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='control_schema_migrations'").get()!.n, 0,
      'fresh current history does not recreate the legacy ledger');
    assert.deepEqual(ro.connection.prepare('SELECT external_id,settings FROM tasks').all().map(row => ({ ...row })),
      [{ external_id: 'P1', settings: JSON.stringify({ color: '#39659b' }) }]);
    assert.equal(ro.connection.prepare('SELECT count(*) AS n FROM task_log').get()!.n, 1);
  } finally { ro.close(); }
  const inspected = openControlMaintenanceDatabase(root, { busyTimeoutMs: 100 }); inspected.close();
  assert.deepEqual(bytes(root), before, 'readOnly DB and maintenance readers create no files');
  const maintenanceResult = run(h.env, h.area, ['workspace', 'maintenance', '--mode', 'inspect']);
  assert.equal(maintenanceResult.status, 0, maintenanceResult.stderr);
  const afterInspect = bytes(root);
  // The explicit maintenance command's existing exclusion Owner creates its writer lease, even for inspect.
  assert.equal(afterInspect['.alpacawork/writer.lock'], createHash('sha256').update('').digest('hex'));
  delete afterInspect['.alpacawork/writer.lock']; assert.deepEqual(afterInspect, before);
  const unchangedMode = new DatabaseSync(controlDatabasePath(root), { readOnly: true });
  try { assert.equal(unchangedMode.prepare('PRAGMA journal_mode').get()!.journal_mode, 'delete'); }
  finally { unchangedMode.close(); }
  const prepare = DatabaseSync.prototype.prepare; let changes = 0;
  DatabaseSync.prototype.prepare = function (sql: string) { if (/^PRAGMA journal_mode=WAL$/i.test(sql)) changes++; return prepare.call(this, sql); };
  try {
    const writer = new ControlStore(root); assert.equal(writer.connection.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal'); writer.close();
    assert.equal(changes, 1);
    const reopened = new ControlStore(root); reopened.close(); assert.equal(changes, 1, 'existing WAL opens never reissue a mode change');
  } finally { DatabaseSync.prototype.prepare = prepare; }
});

test('first WAL activation obeys reader timeout and writer lease; failed opens perform no business write', async t => {
  const h = fixture(t), { root } = await initializeInstallation(h.request), filename = controlDatabasePath(root);
  const dbModule = new URL('../packages/db/dist/index.js', import.meta.url).href;
  for (const holder of ['reader', 'writer']) {
    const script = holder === 'reader'
      ? `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(${JSON.stringify(filename)},{readOnly:true});db.exec('BEGIN');db.prepare('SELECT count(*) FROM tasks').get();`
      : `import {ControlStore} from ${JSON.stringify(dbModule)};const db=new ControlStore(${JSON.stringify(root)});`;
    const held = child(h.env, h.area, [], `${script} setInterval(()=>{},1000);console.log('held');`);
    const lines = createInterface({ input: held.process.stdout! });
    await Promise.race([once(lines, 'line'), held.done.then(result => { throw Error(JSON.stringify(result)); })]); lines.close();
    try {
      const before = readFileSync(filename), start = performance.now(); let businessWrites = 0;
      assert.throws(() => { const store = new ControlStore(root, { busyTimeoutMs: 40 });
        try { store.write(() => { businessWrites++; }); } finally { store.close(); } }, /locked|Another serve writer/);
      assert.ok(performance.now() - start < 1500, 'failed first open is bounded');
      assert.equal(businessWrites, 0); assert.deepEqual(readFileSync(filename), before);
    } catch (error) { await preserveInstallationFailure(t, h.area, error); throw error; }
    finally { held.process.kill('SIGKILL'); await held.done; }
  }
  const ready = new ControlStore(root);
  try { assert.equal(ready.connection.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
    assert.equal(ready.connection.prepare('SELECT count(*) AS n FROM tasks').get()!.n, 1); }
  finally { ready.close(); }
});

test('unknown DELETE reader marker/history is refused before WAL activation and preserves DB bytes', async t => {
  const h = fixture(t), { root } = await initializeInstallation(h.request), file = controlDatabasePath(root);
  const raw = new DatabaseSync(file); raw.exec(`PRAGMA user_version=${CONTROL_VERSION + 1}`); raw.close();
  const before = readFileSync(file);
  assert.throws(() => new ControlStore(root), /Unsupported|mixed|migration/i);
  assert.deepEqual(readFileSync(file), before);
  const copied = databaseFacts(root, join(h.area, 'analysis-unknown'));
  assert.equal(copied.journal, 'delete'); assert.equal(copied.tasks.length, 1);
});

test('backend omitted init creates HOME/alpacawork, records absolute facts, and restarts at the same root', async t => {
  const h = fixture(t), root = join(h.home, 'alpacawork');
  const result = run(h.env, h.area, ['workspace', 'init']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).root, root);
  assert.equal(JSON.parse(result.stdout).installation.source, 'default');
  const record = h.store.read(); assert(record);
  assert.equal('kind' in record, false);
  assert.equal(record.home, h.home);
  assert.equal(record.nodeExecutable, realpathSync(process.execPath));
  assert.equal(record.releases, null);
  assert.equal(statSync(h.store.path).mode & 0o777, 0o600);
  assert.equal(existsSync(h.env.XDG_DATA_HOME), false);
  const first = await serve(t, h.env, h.area); assert.equal(first.root, root); await first.stop();
  const second = await serve(t, h.env, h.area); assert.equal(second.root, root); await second.stop();
  assert.deepEqual(h.store.read(), record);
  const changedHome = join(h.area, 'service HOME'); mkdirSync(changedHome, { mode: 0o700 });
  const same = selectWorkspace({ ...h.request, env: { ...h.env, HOME: changedHome }, record: new InstallationStore(h.store.path).read(), intent: 'existing' });
  assert.equal(same.root, root);
  assert.equal(existsSync(join(changedHome, 'alpacawork')), false);
});

test('relative explicit override creates missing parents with spaces/Japanese and ignores Run/XDG workspace inputs', async t => {
  const h = fixture(t), target = '別の parent/new root';
  const result = run(h.env, h.area, ['--workspace', target, 'workspace', 'init']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).root, join(h.area, target));
  assert.equal(existsSync(join(h.home, 'alpacawork')), false);
  const before = bytes(join(h.area, target));
  const again = run(h.env, h.area, ['--workspace', target, 'workspace', 'init']);
  assert.notEqual(again.status, 0); assert.deepEqual(bytes(join(h.area, target)), before);
});

test('normal serve discovery failure and explicit empty directory create no files', t => {
  const h = fixture(t), empty = join(h.area, 'empty'); mkdirSync(empty);
  const before = bytes(h.area);
  for (const args of [['workspace', 'serve'], ['--workspace', empty, 'workspace', 'serve']]) {
    const result = run(h.env, h.area, args);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /initialized workspace/);
    assert.deepEqual(bytes(h.area), before);
  }
});

test('unregistered default, ancestor/default disagreement and nested workspaces stop for explicit selection', async t => {
  const h = fixture(t), outer = h.copy(), inner = h.copy(join(outer, 'nested')), fallback = h.copy(join(h.home, 'alpacawork'));
  const before = bytes(h.area);
  assert.throws(() => findWorkspace(inner), /Different workspace candidates/);
  assert.throws(() => selectWorkspace({ ...h.request, record: null, intent: 'existing' }), /Unregistered workspace/);
  assert.throws(() => selectWorkspace({ ...h.request, cwd: outer, record: null, intent: 'existing' }), /Different workspace candidates/);
  assert.throws(() => selectWorkspace({ ...h.request, record: null, intent: 'initialize' }), /Existing data/);
  const selected = selectWorkspace({ ...h.request, cwd: inner, explicit: outer, record: null, intent: 'existing' });
  assert.equal(selected.root, outer); assert.equal('alternatives' in selected, false);
  assert.deepEqual(bytes(h.area), before);
});

test('nonempty same-name folder is preserved and explicit new path remains available', async t => {
  const h = fixture(t), root = join(h.home, 'alpacawork'); mkdirSync(root);
  writeFileSync(join(root, '本人のファイル.txt'), 'keep these bytes');
  const before = bytes(root);
  const result = run(h.env, h.area, ['workspace', 'init']);
  assert.notEqual(result.status, 0); assert.deepEqual(bytes(root), before); assert.equal(h.store.read(), null);
  const override = run(h.env, h.area, ['--workspace', join(h.area, 'new'), 'workspace', 'init']);
  assert.equal(override.status, 0, override.stderr); assert.deepEqual(bytes(root), before);
  const recorded = h.store.read();
  const live = await serve(t, h.env, h.area);
  assert.equal(live.root, join(h.area, 'new')); await live.stop();
  assert.deepEqual(bytes(root), before); assert.deepEqual(h.store.read(), recorded);
  const repeated = run(h.env, h.area, ['workspace', 'init']);
  assert.notEqual(repeated.status, 0); assert.match(repeated.stderr, /already_initialized/);
});

test('documented record backup permits explicit serve after an intentional move without reinitialization', async t => {
  const h = fixture(t); await initializeInstallation(h.request);
  const root = join(h.home, 'alpacawork'), moved = join(h.home, 'restored data'), record = readFileSync(h.store.path);
  renameSync(root, moved);
  const refused = run(h.env, h.area, ['--workspace', moved, 'workspace', 'serve']);
  assert.notEqual(refused.status, 0); assert.ok(refused.stderr.includes(root));
  assert.match(refused.stderr, /troubleshoot\.md#installation-record/);
  const backup = h.store.path + '.before-repair'; renameSync(h.store.path, backup);
  const live = await serve(t, h.env, h.area, ['--workspace', moved]);
  assert.equal(live.root, moved); await live.stop();
  assert.equal(existsSync(root), false); assert.equal(existsSync(h.store.path), false);
  assert.deepEqual(readFileSync(backup), record);
  const db = new ControlStore(moved, { busyTimeoutMs: 100 }, true);
  try { assert.equal(db.connection.prepare('SELECT count(*) AS n FROM tasks').get()!.n, 1); }
  finally { db.close(); }
});

for (const obstruction of ['link', 'incomplete'])
test(`explicit selection never opens an unrelated ${obstruction} at the default path`, async t => {
  const h = fixture(t), existing = h.copy(), fallback = join(h.home, 'alpacawork');
  if (obstruction === 'link') symlinkSync(existing, fallback);
  else mkdirSync(join(fallback, '.alpacawork'), { recursive: true, mode: 0o700 });
  const before = obstruction === 'incomplete' ? bytes(fallback) : null;
  const live = await serve(t, h.env, h.area, ['--workspace', existing]);
  assert.equal(live.root, existing); await live.stop();
  const created = join(h.area, 'new selected root');
  const result = run(h.env, h.area, ['--workspace', created, 'workspace', 'init']);
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).root, created);
  if (before) assert.deepEqual(bytes(fallback), before);
  else assert.equal(lstatSync(fallback).isSymbolicLink(), true);
});

test('interrupted first init can be moved aside before repeating default init without deleting files', async t => {
  const h = fixture(t), root = join(h.home, 'alpacawork'), backup = root + '.interrupted';
  mkdirSync(join(root, '.alpacawork'), { recursive: true, mode: 0o700 });
  const before = bytes(root), refused = run(h.env, h.area, ['workspace', 'init']);
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /Incomplete workspace/);
  assert.match(refused.stderr, /maintenance --mode inspect/); assert.deepEqual(bytes(root), before);
  const inspected = run(h.env, h.area, ['--workspace', root, 'workspace', 'maintenance', '--mode', 'inspect']);
  assert.notEqual(inspected.status, 0); assert.match(inspected.stderr, /Control database is absent/);
  assert.equal(existsSync(controlDatabasePath(root)), false);
  assert.equal(existsSync(join(root, '.alpacawork', 'writer.lock')), true);
  const afterInspect = bytes(root);
  renameSync(root, backup);
  const retried = run(h.env, h.area, ['workspace', 'init']);
  assert.equal(retried.status, 0, retried.stderr); assert.equal(JSON.parse(retried.stdout).root, root);
  assert.deepEqual(bytes(backup), afterInspect);
});

test('an existing empty default directory is usable without path input', async t => {
  const h = fixture(t), root = join(h.home, 'alpacawork'); mkdirSync(root, { mode: 0o700 });
  const result = await initializeInstallation(h.request);
  assert.equal(result.root, root); assert.equal(result.installation.source, 'default');
});

test('an existing installation record cannot be silently changed by an explicit workspace path', async t => {
  const h = fixture(t), root = join(h.area, 'registered'), other = h.copy();
  await initializeInstallation({ ...h.request, explicit: root });
  const before = bytes(h.area);
  assert.throws(() => selectWorkspace({ ...h.request, explicit: other, record: h.store.read(), intent: 'existing' }), /differs from the installation record/);
  for (const args of [['--workspace', other, 'workspace', 'serve'], ['--workspace', other, 'workspace', 'init']]) {
    const result = run(h.env, h.area, args); assert.notEqual(result.status, 0); assert.match(result.stderr, /differs from the installation record/);
    assert.deepEqual(bytes(h.area), before);
  }
  assert.throws(() => selectWorkspace({ ...h.request, cwd: other, record: h.store.read(), intent: 'existing' }), /Different workspace candidates/);
});

test('malformed, unknown, relative and duplicate installation records never fall back', t => {
  const h = fixture(t), root = h.copy(); mkdirSync(dirname(h.store.path), { recursive: true, mode: 0o700 });
  const base = {version:4,home:h.home,uid:process.getuid!(),nodeExecutable:realpathSync(process.execPath),releases:null,workspace:root,workspaceIdentity:'00000000-0000-4000-8000-000000000001',service:null};
  for (const value of ['{', JSON.stringify({ ...base, version: base.version + 1 }), JSON.stringify({ ...base, home: 'relative' }),
    JSON.stringify([base, base]), JSON.stringify({ ...base, kind: 'client' }), JSON.stringify({ ...base, uid: base.uid + 1 })]) {
    writeFileSync(h.store.path, value, { mode: 0o600 });
    const before = bytes(h.area);
    assert.throws(() => h.store.read());
    const result = run(h.env, h.area, ['--workspace', root, 'workspace', 'serve']);
    assert.notEqual(result.status, 0); assert.deepEqual(bytes(h.area), before);
  }

});

test('partial initialization, old marker and corrupt DB never overwrite bytes', async t => {
  const h = fixture(t), root = join(h.area, 'partial'); mkdirSync(join(root, '.alpacawork'), { recursive: true });
  writeFileSync(join(root, 'config.yaml'), 'previous partial bytes');
  const before = bytes(root);
  await assert.rejects(initializeInstallation({ ...h.request, explicit: root })); assert.deepEqual(bytes(root), before);
  writeFileSync(join(root, '.alpacawork/workspace'), '');
  await assert.rejects(initializeWorkspace(root));
  const oldBytes = bytes(root);
  const refused = run(h.env, h.area, ['--workspace', root, 'workspace', 'serve']);
  assert.notEqual(refused.status, 0); assert.deepEqual(bytes(root), oldBytes);
  rmSync(join(root, '.alpacawork/workspace'));
  symlinkSync(join(root, 'config.yaml'), join(root, '.alpacawork/alpacawork.sqlite'));
  assert.throws(() => inspectWorkspace(root));
});

for (const point of ['db_before_replace', 'before_publish', 'after_publish']) test(`process kill at ${point} never reports a false successful installation`, async t => {
  const h = fixture(t);
  const script = `import { initializeInstallation } from ${JSON.stringify(setupUrl)};
    import { InstallationStore } from ${JSON.stringify(storeUrl)};
    import { FileWriter } from ${JSON.stringify(storageUrl)};
    ${point === 'db_before_replace'
      ? "let publishes=0; FileWriter.prototype.checkpoint = p => { if (p === 'before_replace' && ++publishes===2) process.kill(process.pid, 'SIGKILL'); };"
      : `InstallationStore.prototype.checkpoint = p => { if (p === '${point}') process.kill(process.pid, 'SIGKILL'); };`}
    await initializeInstallation({ cwd: process.cwd(), env: process.env, detectedAgents: [] });`;
  const result = run(h.env, h.area, [], script);
  assert.equal(result.signal, 'SIGKILL');
  const root = join(h.home, 'alpacawork');
  if (point === 'after_publish') {
    assert(h.store.read()); assert.equal(inspectWorkspace(root).state, 'initialized');
  } else {
    assert.equal(h.store.read(), null);
    const before = bytes(root), retry = run(h.env, h.area, ['workspace', 'init']);
    assert.notEqual(retry.status, 0); assert.deepEqual(bytes(root), before);
    if (point === 'db_before_replace') {
      assert.equal(existsSync(join(root, 'config.yaml')), true);
      assert.equal(existsSync(controlDatabasePath(root)), false);
      assert.equal(readdirSync(join(root, '.alpacawork')).filter(name => /^pending-/.test(name)).length, 1);
      const released = new FileWriter(root);
      try { await released.exclusive(async () => {}); } finally { released.close(); }
      assert.deepEqual(bytes(root), before, 'terminated RAW holder releases exclusion without draft cleanup');
    }
  }
});

test('concurrent initializers with different HOME/record paths share the RAW lock and produce one P1', async t => {
  const h = fixture(t), secondHome = join(h.area, 'second home'); mkdirSync(secondHome, { mode: 0o700 });
  const env2 = { ...h.env, HOME: secondHome, XDG_CONFIG_HOME: join(secondHome, '.config') }, root = join(h.area, 'shared new root');
  const args = ['--workspace', root, 'workspace', 'init'];
  const a = child(h.env, h.area, args), b = child(env2, h.area, args);
  const results = await Promise.all([a.done, b.done]);
  assert.deepEqual(results.map(result => result.code === 0).sort(), [false, true], JSON.stringify(results));
  const success = results.find(result => result.code === 0)!;
  assert.equal(JSON.parse(success.stdout).initializedProject.id, 'P1');
  const db = new DatabaseSync(controlDatabasePath(root), { readOnly: true });
  try { assert.deepEqual(db.prepare('SELECT external_id FROM tasks').all().map(row => row.external_id), ['P1']); }
  finally { db.close(); }
  assert.equal([h.store.read(), new InstallationStore(installationPath(env2)).read()].filter(Boolean).length, 1);
});

test('installation lock is process-owned and an interrupted holder releases it', async t => {
  const h = fixture(t);
  const script = `import { InstallationStore, installationPath } from ${JSON.stringify(storeUrl)};
    await new InstallationStore(installationPath(process.env)).locked(async () => { console.log('locked'); await new Promise(() => {}); });`;
  // Keep an event-loop handle, so the holder really remains alive.
  const held = child(h.env, h.area, [], `setInterval(() => {}, 1000); ${script}`);
  const lines = createInterface({ input: held.process.stdout! });
  await once(lines, 'line'); lines.close();
  await assert.rejects(initializeInstallation(h.request), /Another installation operation/);
  assert.equal(existsSync(join(h.home, 'alpacawork')), false);
  held.process.kill('SIGKILL'); await held.done;
  const result = await initializeInstallation(h.request); assert.equal(result.root, join(h.home, 'alpacawork'));
});

test('OS/HOME/WSL filesystem adapters reject Windows storage and sudo; fixtures are not OS certification', t => {
  const h = fixture(t);
  const linux = { platform: 'linux', wsl: false, filesystem: () => 0xef53 };
  for (const platform of ['linux', 'darwin']) assert.doesNotThrow(() => validateNewWorkspace(h.home, h.env, { ...linux, platform }));
  assert.doesNotThrow(() => validateNewWorkspace(h.home, h.env, { ...linux, wsl: true }));
  // The server refuses to start as root on Linux, so setup says so before it writes anything.
  assert.throws(() => validateNewWorkspace(h.home, h.env, { ...linux, root: true }), /does not run as root\. Log in as an ordinary user/);
  assert.throws(() => validateNewWorkspace('/mnt/c/Users/test', h.env, { ...linux, wsl: true }), /Linux user HOME/);
  for (const type of [0x01021997, 0x5346544e, 0x4d44, 0xff534d42])
    assert.throws(() => validateNewWorkspace(h.home, h.env, { ...linux, wsl: true, filesystem: () => type }), /filesystem target/);
  assert.throws(() => validateNewWorkspace(h.home, h.env, { ...linux, platform: 'win32' }), /Linux, macOS, or WSL2/);
  assert.throws(() => validateNewWorkspace(h.home, { ...h.env, SUDO_USER: 'someone' }, linux), /without sudo/);
  assert.throws(() => installationPath({ HOME: 'relative' }), /absolute/);
  assert.throws(() => installationPath({ HOME: h.home, XDG_CONFIG_HOME: 'relative' }), /absolute/);
});

test('WSL Windows HOME and unsupported OS are rejected before creating the config directory', async t => {
  const h = fixture(t), before = bytes(h.area);
  await assert.rejects(initializeInstallation({ ...h.request, env: { ...h.env, HOME: '/mnt/c/Users/synthetic' } }, h.store,
    { platform: 'linux', wsl: true, filesystem: () => 0xef53 }), /Linux user HOME/);
  await assert.rejects(initializeInstallation(h.request, h.store,
    { platform: 'win32', wsl: false, filesystem: () => 0 }), /Linux, macOS, or WSL2/);
  assert.deepEqual(bytes(h.area), before);
});

test('explicit inspection keeps recovery/maintenance able to reach damaged DB without opening or changing it', async t => {
  const h = fixture(t), root = h.copy();
  writeFileSync(join(root, '.alpacawork/alpacawork.sqlite'), 'damaged database to diagnose');
  const before = bytes(root);
  assert.equal(selectWorkspace({ ...h.request, explicit: root, record: null, intent: 'inspect' }).root, root);
  assert.throws(() => selectWorkspace({ ...h.request, explicit: root, record: null, intent: 'existing' }), /Invalid workspace database/);
  assert.deepEqual(bytes(root), before);
  const refused = run(h.env, h.area, ['--workspace', root, 'workspace', 'maintenance', '--mode', 'inspect']);
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /file is not a database/);
  assert.deepEqual(bytes(root), before);
  const managed = await initializeInstallation(h.request), record = readFileSync(h.store.path);
  writeFileSync(controlDatabasePath(managed.root), 'managed damaged database');
  const damaged = readFileSync(controlDatabasePath(managed.root));
  const inspected = run(h.env, h.area, ['--workspace', managed.root, 'workspace', 'maintenance', '--mode', 'inspect']);
  assert.notEqual(inspected.status, 0); assert.match(inspected.stderr, /file is not a database/);
  assert.deepEqual(readFileSync(controlDatabasePath(managed.root)), damaged); assert.deepEqual(readFileSync(h.store.path), record);
});

test('real CLI reaches the pending release journal with damaged managed DB and zero service actions', async t => {
  const h = fixture(t), { root } = await initializeInstallation(h.request);
  writeFileSync(controlDatabasePath(root), 'damaged database behind pending journal');
  const releases = join(h.area, 'releases'), sha = 'a'.repeat(40), target = join(releases, sha);
  const server = join(target, 'apps/backend/dist'), web = join(target, 'apps/backend/public');
  mkdirSync(join(server, 'receiver'), { recursive: true }); mkdirSync(join(web, 'assets'), { recursive: true });
  for (const [name, body] of [
    [join(server, 'backend.js'), "import './receiver/server.js';"], [join(server, 'receiver/server.js'), '// fixture server'],
    [join(web, 'index.html'), '<script type="module" src="/assets/app.js"></script>'],
    [join(web, 'assets/app.js'), '// fixture app'], [join(web, 'assets/mermaid.js'), '// fixture mermaid'],
    [join(web, 'asset-manifest.json'), JSON.stringify({ 'index.html': { file: 'assets/app.js' }, 'mermaid-frame.html': { file: 'assets/mermaid.js' } })],
    [join(target, 'SOURCE'), sha], [join(releases, '.release.lock'), ''],
    [join(releases, 'switch.json'), JSON.stringify({ version: 4, skillsWriteStarted: false, opId: 'fixture-pending', workspace: root, old: null,
      target: join(releases, 'different-target'), previous: target, phase: 'prepared', schema: null })],
  ]) writeFileSync(name!, body!);
  // The journal's Owner reads only a private file; the fixture writes it as that Owner does.
  chmodSync(join(releases, 'switch.json'), 0o600);
  symlinkSync(sha, join(releases, 'previous'));
  const beforeRoot = bytes(root), record = readFileSync(h.store.path), journal = readFileSync(join(releases, 'switch.json'));
  const script = `import {platform} from ${JSON.stringify(new URL('../packages/core/dist/index.js', import.meta.url).href)};
    import {main} from ${JSON.stringify(new URL('../apps/backend/test-dist/backend.js', import.meta.url).href)};
    let serviceActions=0;platform.service.known=()=>true;
    for(const method of ['stop','restart','restarts']) platform.service[method]=()=>{serviceActions++;throw Error('Unexpected service action');};
    await main(['--workspace',${JSON.stringify(root)},'release','rollback','--releases',${JSON.stringify(releases)},'--service','fixture-only']);
    console.log(JSON.stringify({serviceActions}));`;
  const result = run(h.env, h.area, [], script);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Finish the pending switch before choosing another target/);
  assert.equal(JSON.parse(result.stdout).serviceActions, 0);
  assert.deepEqual(bytes(root), beforeRoot); assert.deepEqual(readFileSync(h.store.path), record);
  assert.deepEqual(readFileSync(join(releases, 'switch.json')), journal);
});

test('public installation read preserves an expected refusal with its record context and bytes', t => {
  const h = fixture(t);
  mkdirSync(dirname(h.store.path), { recursive: true, mode: 0o700 });
  writeFileSync(h.store.path, '{broken json', { mode: 0o600 });
  const before = bytes(h.area);
  assert.throws(() => h.store.read(), (error: { code?: string; reason?: unknown }) => {
    assert.equal(error.code, 'read_failed');
    assert.deepEqual(problemReasonSchema.parse(error.reason), { kind: 'installation_record_unavailable', path: h.store.path,
      cause: { kind: 'installation_record_invalid' } });
    assert.match((error as unknown as Error).message, /troubleshoot\.md#installation-record/);
    return true;
  });
  assert.deepEqual(bytes(h.area), before);
});

const permissionsApply = { skip: process.getuid?.() === 0 && 'root ignores modes' };
/** The refusal a person reads: the real CLI's last stderr line. */
function refusalOf(result: ReturnType<typeof run>) {
  assert.notEqual(result.status, 0, result.stdout);
  return JSON.parse(result.stderr.trim().split('\n').at(-1)!).error as { code: string; retry: string; message: string; reason: Record<string, unknown> };
}
const documentedChmod = (mode: string, path: string) => assert.equal(spawnSync('chmod', [mode, path]).status, 0);

for (const [name, config, explicit] of [['default config', false, false], ['separate XDG', true, false], ['separate XDG and explicit root', true, true]] as const)
test(`absent HOME refuses init and creates nothing (${name})`, t => {
  const h = fixture(t), home = join(h.area, 'absent home'), env: NodeJS.ProcessEnv = { ...h.env, HOME: home };
  if (config) env.XDG_CONFIG_HOME = join(h.area, 'separate-config'); else delete env.XDG_CONFIG_HOME;
  const before = bytes(h.area);
  const error = refusalOf(run(env, h.area, [...(explicit ? ['--workspace', join(h.area, 'explicit-new')] : []), 'workspace', 'init']));
  assert.equal(error.code, 'invalid_input');
  assert.deepEqual(error.reason, { kind: 'installation_home_missing', path: home });
  assert.equal(existsSync(home), false); assert.deepEqual(bytes(h.area), before);
});
