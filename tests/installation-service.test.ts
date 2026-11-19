/** InstallationStore is the sole saved service identity; all filesystem/DB inputs are disposable synthetic copies. */
import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { controlDatabasePath, openControlDatabase, holdControlWriter } from '@alpacawork/db';
import { assertWorkspaceStopped } from '@alpacawork/backend/test-dist/release/switch.js';
import { InstallationStore, installationPath } from '@alpacawork/backend/test-dist/installation/store.js';
import { initializeInstallation, registerInstallation, inspectInstallationService, serviceDefinition, recordInstallationService, readInstallationService, installationService, checkedInstallationService, managedInstallation } from '@alpacawork/backend/test-dist/installation/setup.js';
import { createOriginal, copyWorkspace, removeWorkspace, profiles } from '../scripts/dev-fixtures/fixture.ts';
import { cleanCliEnv } from './helpers/http-cli.ts';
import { preserveTestFailure } from './helpers/failure-workspace.ts';
let suite: string, original: string;
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
before(() => { suite = mkdtempSync(join(tmpdir(), 'installation-service-')); original = createOriginal({ ...profiles.small, seed: 'installation-service' }, join(suite, 'cache')).root; });
after(() => { if (original && existsSync(original)) removeWorkspace(original); if (suite) rmSync(suite, { recursive: true, force: true }); });
async function fixture(t: TestContext, existing = false) {
  const root = mkdtempSync(join(suite, 'case-')), home = join(root, 'home'); mkdirSync(home, { mode: 0o700 });
  const env = cleanCliEnv({ HOME: home, XDG_CONFIG_HOME: join(root, 'custom-config') }); delete env.SUDO_UID; delete env.SUDO_USER;
  const store = new InstallationStore(installationPath(env)), workspace = existing ? join(root, 'existing-data') : join(home, 'alpacawork'), releases = join(root, 'releases');
  const request = { cwd: root, env, explicit: workspace, detectedAgents: [] };
  if (existing) copyWorkspace(original, workspace); else await initializeInstallation(request, store);
  mkdirSync(releases, { mode: 0o700 }); await registerInstallation(request, releases, store);
  t.after(async () => { await preserveTestFailure(t, root, { databaseRoot: workspace }); rmSync(root, { recursive: true, force: true }); });
  const read = (overrides = {}) => readInstallationService({ workspace, releases, env, ...overrides });
  const approve = async (name = 'selected.service') => {
    const definition = await inspectInstallationService(releases, workspace, env, name);
    await recordInstallationService(releases, workspace, definition, env); return definition;
  };
  return { root, home, env, store, workspace, releases, request, read, approve };
}
for (const existing of [false, true]) test(`service identity for ${existing ? 'existing' : 'new'} installation records the approved definition and reads without a caller name`, async t => {
  const f = await fixture(t, existing), db = join(f.workspace, '.alpacawork/alpacawork.sqlite'), before = hash(db), recordBefore = hash(f.store.path);
  assert.throws(() => f.read(), /record is missing.*setup/);
  const definition = await inspectInstallationService(f.releases, f.workspace, f.env, 'selected.service'); assert.equal(hash(f.store.path), recordBefore, 'preview is read-only');
  await recordInstallationService(f.releases, f.workspace, definition, f.env);
  const got = f.read(); assert.deepEqual(got.definition, definition); assert.equal(got.installation.version, 4);
  assert.equal(got.installation.service.name, 'selected.service'); assert(got.port > 0 && got.port <= 65535); assert.equal(got.definition.args.at(-1), String(got.port)); assert.equal(got.installation.releases, realpathSync(f.releases));
  assert.equal(got.installation.nodeExecutable, realpathSync(process.execPath)); assert.equal(got.installation.version, 4);
  assert.equal(hash(db), before); assert.deepEqual(installationService(f.releases, f.workspace, 'selected.service', f.env), definition);
  assert.throws(() => installationService(f.releases, f.workspace, 'other.service', f.env), /name differs/);
  assert.deepEqual(await inspectInstallationService(f.releases, f.workspace, f.env), definition, 'resume keeps its original service name');
  await assert.rejects(f.approve('another.service'), /differs/);
});
for (const version of [1, 2, 3, 99]) test(`old or unknown installation version ${version} is preserved and refused`, async t => {
  const f = await fixture(t, true), old = { ...f.store.read()!, version };
  writeFileSync(f.store.path, JSON.stringify(old)); const before = hash(f.store.path);
  assert.throws(() => f.store.read(), /Invalid installation record/);
  await assert.rejects(f.approve(), /Invalid installation record/);
  assert.equal(hash(f.store.path), before);
});
test('service identity reads known stopped history without migration and refuses changed or unreadable workspaces', async t => {
  const f = await fixture(t); await f.approve();
  const record = f.store.read()!, filename = controlDatabasePath(f.workspace), migrationsFolder = join(f.root, 'old-migrations');
  // The real 94ecb47 release had these two ordinary migrations. Build that image through
  // the standard migrator, rather than deleting receipts from a current schema.
  const names = ['20261031000000_control_baseline', '20261103000000_dependency_history'];
  for (const name of names) cpSync(new URL(`../packages/db/drizzle/control/${name}`, import.meta.url), join(migrationsFolder, name), { recursive: true });
  rmSync(filename);
  const db = new DatabaseSync(filename);
  try {
    migrate(drizzle({ client: db }), { migrationsFolder });
    db.prepare('UPDATE workspace_identity SET id=? WHERE singleton=1').run(record.workspaceIdentity);
    assert.deepEqual(db.prepare('SELECT name FROM __drizzle_migrations ORDER BY id').all().map(row => row.name), names);
  } finally { db.close(); }
  const before = readFileSync(filename), configBefore = hash(join(f.workspace, 'config.yaml')), recordBefore = hash(f.store.path);
  assert.throws(() => openControlDatabase(f.workspace, { busyTimeoutMs: 1000 }, true), /explicit stopped-server maintenance migration/,
    'ordinary readers still require explicit migration');
  const got = f.read();
  assert.deepEqual(got.installation, record); assert.deepEqual(got.definition, serviceDefinition(record, f.store.path));
  assert.deepEqual(readFileSync(filename), before, 'identity read does not advance history or change DB bytes');
  assert.equal(hash(join(f.workspace, 'config.yaml')), configBefore); assert.equal(hash(f.store.path), recordBefore);
  for (const sql of [
    "UPDATE workspace_identity SET id='00000000-0000-4000-8000-000000000000'",
    'DELETE FROM workspace_identity',
    "UPDATE workspace_identity SET id='invalid-uuid'",
    "UPDATE __drizzle_migrations SET hash='" + 'f'.repeat(64) + "' WHERE id=2",
    'DELETE FROM __drizzle_migrations',
    'PRAGMA user_version=999',
  ]) {
    writeFileSync(filename, before);
    const changed = new DatabaseSync(filename); try { changed.exec(sql); } finally { changed.close(); }
    const rejected = readFileSync(filename);
    assert.throws(() => f.read(), { reason: { kind: 'installation_workspace_changed', path: f.workspace } });
    assert.deepEqual(readFileSync(filename), rejected, 'refusal preserves the damaged or changed image');
  }
  writeFileSync(filename, 'corrupt synthetic database'); const corrupt = readFileSync(filename);
  assert.throws(() => f.read(), { reason: { kind: 'installation_workspace_changed', path: f.workspace } });
  assert.deepEqual(readFileSync(filename), corrupt);
  rmSync(filename);
  assert.throws(() => f.read(), { reason: { kind: 'installation_workspace_changed', path: f.workspace } });
  assert.equal(existsSync(filename), false, 'identity read never initializes an absent database');
  assert.equal(hash(join(f.workspace, 'config.yaml')), configBefore); assert.equal(hash(f.store.path), recordBefore);
});
test('missing/unknown records stop read-only with setup guidance and no inferred default', async t => {
  const f = await fixture(t); rmSync(f.store.path); assert.throws(() => f.read(), /record is missing.*setup/); assert.equal(existsSync(f.store.path), false);
  writeFileSync(f.store.path, '{"version":99}', { mode: 0o600 }); const before = hash(f.store.path);
  assert.throws(() => f.read(), /Invalid installation record/); assert.equal(hash(f.store.path), before);
});
test('service read rejects workspace, canonical releases, Node and definition binding mismatches without rewriting', async t => {
  const f = await fixture(t); await f.approve(); const saved = readFileSync(f.store.path, 'utf8');
  assert.throws(() => f.read({ workspace: f.root }), /differs/); assert.throws(() => f.read({ releases: f.root }), /differs/);
  const variants = [
    (v: any) => v.uid = process.getuid!() + 1,
    (v: any) => v.service.workspace = f.root,
    (v: any) => v.service.releases = f.root,
    (v: any) => v.nodeExecutable = '/usr/bin/other-node',
    (v: any) => v.service.definition = {},
    (v: any) => v.service.port = 0,
    (v: any) => v.service.port = 65536,
    (v: any) => v.service.publicHost = 'Upper.Example',
    (v: any) => v.service.version = 1,
  ];
  for (const change of variants) {
    const value = JSON.parse(saved); change(value); writeFileSync(f.store.path, JSON.stringify(value)); const before = hash(f.store.path);
    assert.throws(() => f.read(), /differs|Invalid installation record|another user|Node\.js is now/);
    assert.throws(() => checkedInstallationService({workspace:f.workspace,releases:f.releases,env:f.env}), /differs|Invalid installation record|another user|Node\.js is now/);
    assert.equal(hash(f.store.path), before);
    await assert.rejects(recordInstallationService(f.releases, f.workspace, serviceDefinition(JSON.parse(saved), f.store.path), f.env));
    assert.equal(hash(f.store.path), before, 'explicit setup cannot silently repair a conflicting service binding');
  }
  writeFileSync(f.store.path, saved);
  const alias = join(f.root, 'releases-alias'); symlinkSync(f.releases, alias); const value = JSON.parse(saved); value.releases = alias; writeFileSync(f.store.path, JSON.stringify(value));
  assert.throws(() => readInstallationService({ workspace: f.workspace, env: f.env }), /differs/);
});
test('approval cannot publish another workspace/node definition and recording is not native registration', async t => {
  const f = await fixture(t), proposed = await inspectInstallationService(f.releases, f.workspace, f.env), before = hash(f.store.path);
  await assert.rejects(recordInstallationService(f.releases, f.workspace, { ...proposed, executable: '/usr/bin/other-node' }, f.env), /differs/);
  assert.equal(hash(f.store.path), before); await recordInstallationService(f.releases, f.workspace, proposed, f.env);
  assert.equal(existsSync(join(f.root, 'custom-config/systemd/user/alpacawork.service')), false);
  assert.equal(f.read().definition.name, proposed.name);
});

test('service reads positive port bounds and HTTP default port without rewriting the approved snapshot', async t => {
  const f = await fixture(t); await f.approve(); const saved = readFileSync(f.store.path, 'utf8');
  for (const port of [1, 80, 65535]) {
    const record = JSON.parse(saved); record.service.port = port;
    writeFileSync(f.store.path, JSON.stringify(record)); const before = hash(f.store.path), got = f.read();
    assert.equal(got.port, port); assert.equal(got.definition.args.at(-1), String(port)); assert.equal(hash(f.store.path), before);
  }
});

test('initial service keeps explicit port/public host and the terminal PATH including the recorded Node directory', async t => {
  const f=await fixture(t);f.env.PATH='/synthetic/bin:/usr/bin:/bin';
  const definition=await inspectInstallationService(f.releases,f.workspace,f.env,'selected.service',{port:5499,publicHost:'synthetic.example:8443'});
  assert.equal(definition.args[definition.args.indexOf('--port')+1],'5499');
  assert.equal(definition.args[definition.args.indexOf('--public-host')+1],'synthetic.example:8443');
  assert(definition.environment.PATH!.startsWith(realpathSync(process.execPath).replace(/\/[^/]+$/,'')+':'));
  assert(definition.environment.PATH!.includes('/synthetic/bin'));
  await recordInstallationService(f.releases,f.workspace,definition,f.env);
  assert.deepEqual(await inspectInstallationService(f.releases,f.workspace,f.env),definition,'the same terminal proposes the recorded definition; an omitted port and public host keep the recorded ones');
  assert.deepEqual(await inspectInstallationService(f.releases,f.workspace,f.env,undefined,{port:5499,publicHost:'synthetic.example:8443'}),definition);
});

test('another terminal proposes its own port, public host and PATH, and only a named replacement is recorded', async t => {
  const f=await fixture(t);f.env.PATH='/synthetic/bin:/usr/bin:/bin';
  const definition=await inspectInstallationService(f.releases,f.workspace,f.env,'selected.service',{port:5499});
  await recordInstallationService(f.releases,f.workspace,definition,f.env);const saved=hash(f.store.path);
  f.env.PATH='/different/bin';assert.deepEqual(f.read().definition,definition,'readers keep the approved PATH');
  const proposed=await inspectInstallationService(f.releases,f.workspace,f.env,undefined,{port:5500,publicHost:'synthetic.example'});
  assert.equal(proposed.name,'selected.service');assert.equal(proposed.args.at(-1),'5500');
  assert.equal(proposed.args[proposed.args.indexOf('--public-host')+1],'synthetic.example');assert(proposed.environment.PATH!.endsWith(':/different/bin'));
  assert.equal(hash(f.store.path),saved,'a proposal is read-only');
  // Without the definition it replaces, a different approval is refused as before; a stale one is refused too.
  await assert.rejects(recordInstallationService(f.releases,f.workspace,proposed,f.env),/differs/);
  await assert.rejects(recordInstallationService(f.releases,f.workspace,proposed,f.env,{...definition,args:[...definition.args.slice(0,-1),'5498']}),/differs/);
  await assert.rejects(recordInstallationService(f.releases,f.workspace,{...proposed,name:'renamed.service'},f.env,definition),/differs/);
  assert.equal(hash(f.store.path),saved);
  await recordInstallationService(f.releases,f.workspace,proposed,f.env,definition);
  assert.deepEqual(f.read().definition,proposed);assert.equal(f.read().port,5500);
  for(const bad of [0,65536,1.5])await assert.rejects(inspectInstallationService(f.releases,f.workspace,f.env,undefined,{port:bad}),/1\.\.65535/);
  await assert.rejects(inspectInstallationService(f.releases,f.workspace,f.env,undefined,{publicHost:'Upper.Example'}),/public-host/);
});

test('a record approved under another Node path is refused by readers with the fix, kept by registration and replaced by a named approval', async t => {
  const f=await fixture(t);await f.approve();
  const record=JSON.parse(readFileSync(f.store.path,'utf8')),old='/opt/synthetic-node/22.1.0/bin/node';
  record.nodeExecutable=old;
  writeFileSync(f.store.path,JSON.stringify(record));
  for(const read of [()=>f.read(),()=>checkedInstallationService({workspace:f.workspace,releases:f.releases,env:f.env}),()=>installationService(f.releases,f.workspace,'selected.service',f.env),
    ()=>managedInstallation({...f.env,ALPACAWORK_MANAGED_RELEASES:f.releases})])
    assert.throws(read,new RegExp(`Node\\.js is now .*approved ${old}; run alpacawork setup again from a terminal`));
  // Registration no longer compares Node: the path changes only with the definition that names it.
  const registered=await registerInstallation(f.request,f.releases,f.store),saved=hash(f.store.path);assert.equal(registered.nodeExecutable,old);assert.deepEqual(registered.service,record.service);
  const proposed=await inspectInstallationService(f.releases,f.workspace,f.env);assert.equal(proposed.executable,realpathSync(process.execPath));
  await assert.rejects(recordInstallationService(f.releases,f.workspace,proposed,f.env),/differs/);assert.equal(hash(f.store.path),saved);
  await recordInstallationService(f.releases,f.workspace,proposed,f.env,serviceDefinition(record, f.store.path));
  const got=f.read();assert.deepEqual(got.definition,proposed);assert.equal(got.installation.nodeExecutable,realpathSync(process.execPath));
  assert.deepEqual(serviceDefinition(managedInstallation({...f.env,ALPACAWORK_MANAGED_RELEASES:f.releases})!, f.store.path),proposed);
});

// Confirmation observes the writer; acquiring its lifetime remains the write boundary.
test('stopped workspace observation preserves a missing writer lock and still excludes another writer', async t => {
  const f = await fixture(t), folder = join(f.workspace, '.alpacawork'), lock = join(folder, 'writer.lock');
  assert.equal(existsSync(lock), false);
  const names = readdirSync(folder).sort(), database = hash(join(folder, 'alpacawork.sqlite'));
  await assertWorkspaceStopped(f.workspace);
  assert.deepEqual(readdirSync(folder).sort(), names, 'a preview creates no file');
  assert.equal(hash(join(folder, 'alpacawork.sqlite')), database);
  const release = holdControlWriter(f.workspace);
  try {
    await assert.rejects(assertWorkspaceStopped(f.workspace), /writer/);
    assert.throws(() => holdControlWriter(f.workspace), /writer/);
  } finally { release(); }
  await assertWorkspaceStopped(f.workspace);
  assert.equal(hash(join(folder, 'alpacawork.sqlite')), database);
});
