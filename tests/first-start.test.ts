/** First managed start through the normal distribution, installation and switch Owners. Never an OS service. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { before, after, test, type TestContext } from 'node:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { appendFileSync, readlinkSync, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { ControlStore } from '@alpacawork/db';
import { platform, type ServiceDefinition, type ServiceObservation } from '@alpacawork/core';
import { initializeInstallation, registerInstallation, installationService, managedInstallation, inspectInstallationService, recordInstallationService } from '@alpacawork/backend/test-dist/installation/setup.js';
import { InstallationStore, installationPath } from '@alpacawork/backend/test-dist/installation/store.js';
import { assembleDistribution } from '@alpacawork/backend/test-dist/release/distribution.js';
import { switchTo } from '@alpacawork/backend/test-dist/release/switch.js';
import { readManagedSwitch } from '@alpacawork/backend/test-dist/release/update-record.js';
import { loadJournal, saveJournal, assertServeAdmission } from '@alpacawork/backend/test-dist/release/journal.js';
import { linkTarget } from '@alpacawork/backend/test-dist/release/layout.js';
import { createOriginal, copyWorkspace, profiles } from '../scripts/dev-fixtures/fixture.ts';
import { cleanCliEnv } from './helpers/http-cli.ts';
import { preserveTestFailure } from './helpers/failure-workspace.ts';
import { createSystemdService, systemdDefinition } from '../packages/core/dist/platform/systemd-service.js';
import { createLaunchdService, launchdDefinition } from '../packages/core/dist/platform/launchd-service.js';
let suite: string, image: string, source: string, original: string;
const children = new Set<ChildProcess>();
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const snapshot = (root: string) => ['.', ...readdirSync(root, { recursive: true, encoding: 'utf8' }).sort()].map(path => {
  const file = join(root, path), info = lstatSync(file);
  return { path, mode: info.mode, bytes: info.size, hash: info.isFile() ? hash(file) : null };
});
let originalSnapshot: ReturnType<typeof snapshot>;
const evidence = (value: unknown) => { if (process.env.FIRST_START_EVIDENCE) { mkdirSync(dirname(process.env.FIRST_START_EVIDENCE), { recursive: true }); appendFileSync(process.env.FIRST_START_EVIDENCE, JSON.stringify(value) + '\n'); } };
before(() => {
  suite = mkdtempSync(join(tmpdir(), 'first-start-')); const built = join(suite, 'built'); mkdirSync(built);
  if (process.env.ALPACAWORK_TEST_DISTRIBUTION_IMAGE) {
    image = realpathSync(process.env.ALPACAWORK_TEST_DISTRIBUTION_IMAGE);
    source = readFileSync(join(image, 'SOURCE'), 'utf8').trim();
  } else {
  // Ordinary local copies. All workspace links still resolve within this same independent build input.
  for (const path of ['node_modules', ...['backend', 'cli', 'agent-cli'].map(name => 'apps/' + name), ...readdirSync(resolve('packages')).map(name => 'packages/' + name)]) {
    const from = resolve(path); if (!existsSync(from)) continue;
    if (path === 'node_modules') cpSync(from, join(built, path), { recursive: true, verbatimSymlinks: true });
    else {
      mkdirSync(join(built, path), { recursive: true });
      for (const name of ['dist', 'drizzle', 'legacy', 'node_modules', 'package.json']) if (existsSync(join(from, name))) cpSync(join(from, name), join(built, path, name), { recursive: true, verbatimSymlinks: true });
    }
  }
  const rebase = (directory: string) => { for (const name of readdirSync(directory)) { const file = join(directory, name), info = lstatSync(file); if (info.isSymbolicLink()) { const target = resolve(dirname(file), readlinkSync(file)); if (target.startsWith(resolve('.') + '/')) { rmSync(file); symlinkSync(join(built, target.slice(resolve('.').length + 1)), file); } } else if (info.isDirectory()) rebase(file); } }; rebase(built);
  for (const path of ['apps/backend/public', 'apps/launcher', 'skills', 'docs', 'package.json']) cpSync(resolve(path), join(built, path), { recursive: true });
  source = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(built, 'SOURCE'), source + '\n');
  for (const [file, script] of [['FORMAT', 'storage-format.js'], ['SCHEMA.json', 'schema-manifest.js']]) {
    const out = spawnSync(process.execPath, [join(built, 'apps/backend/dist', script!)], { encoding: 'utf8' }); assert.equal(out.status, 0, out.stderr); writeFileSync(join(built, file!), out.stdout);
  }
  image = join(suite, 'image'); assembleDistribution(built, image, { source, edition: 'production', targets: ['linux-x64-glibc'] });
  }
  // Keep the immutable input outside the disposable suite; only copyWorkspace copies are used or removed.
  const input = createOriginal({ ...profiles.small, seed: 'first-managed-start' }, resolve('.local/first-start-fixture-cache'));
  original = input.root; originalSnapshot = snapshot(original);
  evidence({ kind: 'original-before', original, bytes: input.bytes, snapshot: originalSnapshot });
});
after(() => {
  assert.equal(children.size, 0);
  if (!process.env.FIRST_START_RETAIN) rmSync(suite, { recursive: true, force: true });
  const after = snapshot(original); assert.deepEqual(after, originalSnapshot);
  evidence({ kind: 'original-after', original, snapshot: after, suiteRemoved: !existsSync(suite) });
});
async function fixture(t: TestContext, existing = false) {
  const root = mkdtempSync(join(suite, 'case-')), home = join(root, 'home'); mkdirSync(home);
  const env = cleanCliEnv({ HOME: home, XDG_CONFIG_HOME: join(root, 'custom-config'), ALPACAWORK_SERVER: 'http://127.0.0.1:1' });
  delete env.SUDO_USER; delete env.SUDO_UID;
  const request = { cwd: root, env, detectedAgents: [] }, store = new InstallationStore(installationPath(env));
  const workspace = existing ? join(root, 'explicit-data') : join(home, 'alpacawork');
  if (existing) { copyWorkspace(original, workspace); const seats = new ControlStore(workspace); try { seats.write(db => db.prepare("UPDATE placements SET ended_at='2026-11-03T00:00:00.000Z'").run()); } finally { seats.close(); } } else await initializeInstallation(request, store);
  const releases = join(root, 'releases'), target = join(releases, source); mkdirSync(releases); cpSync(image, target, { recursive: true });
  const before = existing ? hash(join(workspace, '.alpacawork/alpacawork.sqlite')) : null;
  await registerInstallation({ ...request, explicit: workspace }, releases, store);
  if (existing) assert.equal(hash(join(workspace, '.alpacawork/alpacawork.sqlite')), before, 'registration never initializes existing DB');
  const oldEnv = { ...process.env }; Object.assign(process.env, env); delete process.env.ALPACAWORK_RUN; delete process.env.ALPACAWORK_RUN_TOKEN;
  await recordInstallationService(releases, workspace, await inspectInstallationService(releases, workspace, env, 'first-start.service'), env);
  const definition = installationService(releases, workspace, 'first-start.service', env);
  let state: ServiceObservation['state'] = 'absent', child: ChildProcess | null = null, registrationStarts = true, fail = false, failedStarts = 0;
  const events: unknown[] = [], actual = platform.service;
  const running = () => !!child && child.exitCode === null && child.signalCode === null;
  const stop = () => {
    if (!running()) return true;
    const pid = child!.pid!, started = platform.run.started(pid), boot = platform.run.bootId();
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', `import{platform}from'@alpacawork/core';import{readFileSync}from'node:fs';const p=${pid},s=${JSON.stringify(started)},b=${JSON.stringify(boot)};
const live=()=>{try{const f=readFileSync('/proc/'+p+'/stat','utf8').split(') ')[1].split(' ');return f[19]===s&&!['Z','X'].includes(f[0]);}catch(e){if(e.code==='ENOENT'||e.code==='ESRCH')return false;throw e;}};
if(platform.run.bootId()!==b||!live())process.exit(0);
try{process.kill(p,'SIGTERM');}catch(e){if(e.code==='ESRCH'&&!live())process.exit(0);throw e;}
for(let n=0;n<300;n++){if(!live())process.exit(0);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}process.exit(1)`], { encoding: 'utf8', cwd: resolve('.') });
    const observation = { stop: pid, status: out.status, signal: out.signal, error: out.error?.message, stdout: out.stdout, stderr: out.stderr };
    events.push(observation); evidence({ kind: 'service-stop', ...observation }); return out.status === 0;
  };
  const start = () => {
    events.push({ startPhase: loadJournal({ releases, workspace })?.phase });
    assert.equal(loadJournal({ releases, workspace })?.phase, 'target_selected');
    if (fail) return false;
    if (running()) return true;
    child = spawn(definition.executable, definition.args, { cwd: '/', env: { ...env, ...definition.environment, HOME: definition.environment.HOME }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child); const owned = child; owned.once('close', () => children.delete(owned));
    let stdout = '', stderr = ''; child.stdout!.on('data', data => stdout += data); child.stderr!.on('data', data => stderr += data);
    child.once('close', (code, signal) => { if (code !== 0) failedStarts++; events.push({ pid: owned.pid, code, signal, stdout, stderr }); });
    return true;
  };
  platform.service = { observe: () => ({ state, running: running(), registrationStarts }), register: () => { if (!['absent', 'matching'].includes(state)) return false; state = 'matching'; return !registrationStarts || start(); },
    unregister: () => { if (state !== 'matching' || !stop()) return false; state = 'absent'; return true; }, known: () => state === 'matching', stop, restart: start, restarts: () => failedStarts };
  const place = { releases, workspace, service: definition.name, say: (line: string) => events.push({ line }) };
  t.after(async () => {
    try { await preserveTestFailure(t, root, { databaseRoot: workspace, diagnostics: () => ({ events, journal: loadJournal(place) }) }); }
    finally {
      try { if (running()) { const done = once(child!, 'close'); const stopped = stop(); await done; assert(stopped); }
      else if (child && children.has(child)) await once(child, 'close'); } finally {
        platform.service = actual; for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key]; Object.assign(process.env, oldEnv);
        evidence({ suite, root, events, journal: loadJournal(place), format: readFileSync(join(target, 'FORMAT'), 'utf8') });
        if (!process.env.FIRST_START_RETAIN) rmSync(root, { recursive: true, force: true });
      }
    }
  });
  return { root, env, store, workspace, releases, target, place, definition, events, stop, setState: (next: ServiceObservation['state']) => state = next, fail: (next: boolean) => fail = next, immediate: (next: boolean) => registrationStarts = next };
}
for (const existing of [false, true]) test(`first start ${existing ? 'existing explicit' : 'new default'} workspace reaches real readiness and one committed journal`, { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const h = await fixture(t, existing), ready = await switchTo(h.place, h.target);
  const response = await fetch(new URL('/api/runtime/readiness', ready.url)), body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.workspace, h.workspace); assert.equal(body.generation, ready.generation); assert.equal(body.state, 'accepting'); const schema = JSON.parse(readFileSync(join(h.target, 'SCHEMA.json'), 'utf8')); assert.equal(body.schema, schema.control.version); assert.deepEqual(body.control, { version: schema.control.version, history: schema.control.history }); assert.deepEqual(body.host, schema.host);
  assert.equal(loadJournal(h.place)!.phase, 'committed'); assert.equal(readManagedSwitch(h.releases, h.workspace, h.target).current, h.target);
  const observedEvents = h.events.length; const again = await switchTo(h.place, h.target); assert.equal(again.generation, ready.generation); assert.equal(h.events.length, observedEvents);
  assert(platform.service.stop(h.definition.name)); assert(platform.service.unregister(h.definition)); assert(existsSync(h.workspace)); assert(existsSync(h.target));
});
test('service manager absence/conflict and invalid current cannot become first start', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const h = await fixture(t);
  for (const state of ['unavailable', 'conflict'] as const) { h.setState(state); await assert.rejects(switchTo(h.place, h.target), new RegExp(state)); assert.equal(loadJournal(h.place), null); }
  h.setState('absent'); writeFileSync(join(h.releases, 'current'), 'not a link'); await assert.rejects(switchTo(h.place, h.target)); assert.equal(loadJournal(h.place), null);
  rmSync(join(h.releases, 'current')); symlinkSync('/tmp', join(h.releases, 'current')); assert.throws(() => linkTarget(h.releases, 'current'), /Invalid/);
});
test('failed authorized registration/start preserves the same journal and resumes forward', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const h = await fixture(t); h.fail(true); await assert.rejects(switchTo(h.place, h.target), /did not become ready/);
  const journal = loadJournal(h.place)!; assert.equal(journal.phase, 'target_selected'); assert.equal(journal.old, null); assert.throws(() => readManagedSwitch(h.releases, h.workspace, h.target));
  h.fail(false); const ready = await switchTo(h.place, h.target); assert(ready.generation); assert.equal(loadJournal(h.place)!.opId, journal.opId);
});
test('managed service requires the same custom-config record despite another HOME/cwd; missing/replaced record refuses fallback', async t => {
  const h = await fixture(t), env = { ...h.env, ...h.definition.environment };
  assert.equal(managedInstallation(env)!.workspace, h.workspace);
  const saved = readFileSync(h.store.path); rmSync(h.store.path); assert.throws(() => managedInstallation(env), /missing or differs/);
  const cli = spawnSync(process.execPath, [join(h.target, 'bin/backend.mjs'), '--workspace', h.workspace, 'workspace', 'serve', '--port', '0'], { env, cwd: '/', encoding: 'utf8', timeout: 20000 });
  evidence({ kind: 'missing-record-real-cli', status: cli.status, signal: cli.signal, stdout: cli.stdout, stderr: cli.stderr }); assert.equal(cli.status, 1, cli.stderr); assert(!existsSync(join(h.workspace, '.alpacawork/connection.json')));
  writeFileSync(h.store.path, saved, { mode: 0o600 }); const value = JSON.parse(saved.toString()); value.releases = h.root; writeFileSync(h.store.path, JSON.stringify(value), { mode: 0o600 }); assert.throws(() => managedInstallation(env), /missing or differs/);
  writeFileSync(h.store.path, saved, { mode: 0o600 }); assert.throws(() => managedInstallation({ ...env, HOME: h.root }), /missing or differs/);
  value.releases = h.releases; value.uid = process.getuid!() + 1; writeFileSync(h.store.path, JSON.stringify(value), { mode: 0o600 }); assert.throws(() => managedInstallation(env), (error: { reason?: { cause?: { kind?: string } } }) => {
    assert.equal(error.reason?.cause?.kind, 'installation_user_mismatch'); return true;
  }); writeFileSync(h.store.path, saved, { mode: 0o600 });
});
test('first journal prepared/selected admission and same journal resume retain Run pin terminal gate', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const h = await fixture(t); const observe = platform.service.observe; platform.service.observe = definition => { const result = observe(definition); if (loadJournal(h.place)?.phase === 'prepared') throw Error('interrupt prepared'); return result; };
  await assert.rejects(switchTo(h.place, h.target), /interrupt prepared/); const journal = loadJournal(h.place)!; assert.equal(journal.phase, 'prepared'); assert.throws(() => assertServeAdmission(h.workspace, h.target));
  platform.service.observe = observe; const register = platform.service.register; platform.service.register = () => { throw Error('interrupt selected'); };
  await assert.rejects(switchTo(h.place, h.target), /interrupt selected/); assert.equal(loadJournal(h.place)!.phase, 'target_selected'); assert.doesNotThrow(() => assertServeAdmission(h.workspace, h.target)); assert.throws(() => readManagedSwitch(h.releases, h.workspace, h.target));
  platform.service.register = register; await switchTo(h.place, h.target); assert.equal(loadJournal(h.place)!.opId, journal.opId);
});
for (const os of ['systemd', 'launchd']) test(`${os} native definition observation, registration, stop completion and exact removal use fake commands`, () => {
  const root = mkdtempSync(join(tmpdir(), 'service-definition-')); mkdirSync(join(root, 'home'));
  try {
    const definition: ServiceDefinition = { name: 'fixture.service', executable: process.execPath, args: ['--', '/tmp/current/backend.js'], workingDirectory: root, environment: { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config') } };
    const native = os === 'systemd' ? systemdDefinition(definition) : launchdDefinition(definition);
    let reachable = true, loaded = false, running = false;
    const command = (_file: string, args: string[]) => {
      if (!reachable) return { status: 1, stdout: '' };
      if (args.includes('show-environment') || args.join(' ') === `print gui/${process.getuid!()}`) return { status: 0, stdout: '' };
      if (args.includes('show')) return { status: 0, stdout: `LoadState=${loaded ? 'loaded' : 'not-found'}\nActiveState=${running ? 'active' : 'inactive'}\nFragmentPath=${loaded ? native.path : ''}` };
      if (args[0] === 'print') return { status: loaded ? 0 : 113, stderr: loaded ? '' : 'Could not find service', stdout: loaded ? `path = ${native.path}\n${running ? 'pid = 1234567' : ''}` : '' };
      if (args[0] === '-p') return { status: running ? 0 : 1, stdout: running ? 'stable-start' : '' };
      if (args.includes('enable') || args[0] === 'bootstrap') { loaded = true; running = os === 'launchd'; }
      if (args.includes('stop') || args[0] === 'bootout') { running = false; if (os === 'launchd') loaded = false; }
      if (args.includes('disable')) loaded = false; if (args.includes('restart') || args[0] === 'kickstart') running = true;
      return { status: 0, stdout: '' };
    };
    const service = os === 'systemd' ? createSystemdService(command) : createLaunchdService(command);
    assert.equal(service.observe(definition).state, 'absent'); assert(!existsSync(native.path)); reachable = false; assert.equal(service.observe(definition).state, 'unavailable'); reachable = true;
    assert(service.register(definition)); assert.equal(service.observe(definition).state, 'matching');
    const other = { ...definition, args: ['different'] }; assert.equal(service.observe(other).state, 'conflict'); assert.equal(service.register(other), false); assert.equal(service.unregister(other), false); assert.equal(service.stop(other), false); assert.equal(service.restart(other), false);
    assert(service.stop(definition)); assert(service.restart(definition)); assert(service.stop(definition)); assert(service.unregister(definition)); assert(!existsSync(native.path)); assert(existsSync(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('registration alone, a connection file, or a current link never prove readiness', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const h = await fixture(t); platform.service.register = () => { writeFileSync(join(h.workspace, '.alpacawork/connection.json'), JSON.stringify({ url: 'http://127.0.0.1:1/', publicUrl: null, generation: randomUUID(), runManager: join(h.target, 'apps/backend/dist/run-manager.js') })); return true; }; platform.service.restart = () => false;
  await assert.rejects(switchTo(h.place, h.target), /did not become ready/);
  assert.equal(loadJournal(h.place)!.phase, 'target_selected'); assert.equal(linkTarget(h.releases, 'current'), h.target);
});
test('foreign HTTP and unreadable current preserve stopped DB and select nothing', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const h = await fixture(t), server = createServer((_req, res) => { res.end('{}'); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    writeFileSync(join(h.workspace, '.alpacawork/connection.json'), JSON.stringify({ url, publicUrl: null, generation: randomUUID(), runManager: join(h.target, 'apps/backend/dist/run-manager.js') }));
    await assert.rejects(switchTo(h.place, h.target), /running server/); assert.equal(loadJournal(h.place), null);
    rmSync(join(h.workspace, '.alpacawork/connection.json')); chmodSync(h.releases, 0);
    try { await assert.rejects(switchTo(h.place, h.target)); } finally { chmodSync(h.releases, 0o700); }
    assert.equal(loadJournal(h.place), null);
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});
for (const phase of ['prepared', 'target_selected']) test(`SIGKILL after durable ${phase} resumes one first-start journal`, { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const h = await fixture(t), script = join(h.root, 'kill-driver.mjs');
  writeFileSync(script, `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';import{platform}from'@alpacawork/core';import{switchTo}from ${JSON.stringify(new URL('../apps/backend/test-dist/release/switch.js', import.meta.url).href)};const rename=fs.renameSync;fs.renameSync=(a,b)=>{rename(a,b);if(b===${JSON.stringify(join(h.releases, 'switch.json'))}&&JSON.parse(fs.readFileSync(b,'utf8')).phase===${JSON.stringify(phase)})process.kill(process.pid,'SIGKILL');};syncBuiltinESMExports();platform.service={...platform.service,observe:()=>({state:'absent',running:false,registrationStarts:true}),stop:()=>true,register:()=>false,restarts:()=>0};await switchTo({releases:${JSON.stringify(h.releases)},workspace:${JSON.stringify(h.workspace)},service:${JSON.stringify(h.definition.name)},say:()=>{}},${JSON.stringify(h.target)});`);
  // Resolve only this checkout's already-built runtime; no package acquisition or native manager.
  symlinkSync(resolve('node_modules'), join(h.root, 'node_modules'));
  const killed = spawnSync(process.execPath, [script], { env: h.env, encoding: 'utf8', timeout: 60000 });
  evidence({ kind: 'SIGKILL', phase, pid: killed.pid, status: killed.status, signal: killed.signal, stdout: killed.stdout, stderr: killed.stderr });
  assert.equal(killed.signal, 'SIGKILL', killed.stderr); const journal = loadJournal(h.place)!; assert.equal(journal.phase, phase);
  assert.throws(() => readManagedSwitch(h.releases, h.workspace, h.target)); await switchTo(h.place, h.target); assert.equal(loadJournal(h.place)!.opId, journal.opId);
});
test('ordinary workspace permissions preserve the occupied DB writer exclusion', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const h = await fixture(t); chmodSync(h.workspace, 0o775);
  assert.equal(loadJournal(h.place), null);
  const script = join(h.root, 'writer.mjs'); symlinkSync(resolve('node_modules'), join(h.root, 'node_modules'));
  writeFileSync(script, `import{holdControlWriter}from'@alpacawork/db';const close=holdControlWriter(${JSON.stringify(h.workspace)});console.log('held');setTimeout(()=>{close();process.exit(0)},20000);process.on('SIGTERM',()=>{close();process.exit(0)});`);
  const child = spawn(process.execPath, [script], { env: h.env, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(child);
  try { assert.equal(String((await once(child.stdout!, 'data'))[0]).trim(), 'held'); await assert.rejects(switchTo(h.place, h.target), /writer owns/); assert.equal(loadJournal(h.place), null); }
  finally { const done = once(child, 'close'); child.kill('SIGTERM'); await done; children.delete(child); }
  const ready = await switchTo(h.place, h.target); assert(ready.generation);
  assert.equal(loadJournal(h.place)!.phase, 'committed');
  assert.equal(linkTarget(h.releases, 'current'), h.target);
  assert.equal(lstatSync(h.workspace).mode & 0o777, 0o775);
});

test('non-starting registration uses the same selected-target start and matching stopped definition', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const h = await fixture(t); h.immediate(false); h.setState('matching'); const ready = await switchTo(h.place, h.target); assert(ready.generation); assert.equal(loadJournal(h.place)!.phase, 'committed');
});
test('definition takeover during registration never stops a foreign service by its name', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const h = await fixture(t); let foreignStops = 0;
  platform.service.register = () => { h.setState('conflict'); return false; };
  platform.service.stop = service => { if (typeof service === 'string') foreignStops++; return false; };
  await assert.rejects(switchTo(h.place, h.target), /could not be stopped/); assert.equal(foreignStops, 0); assert.equal(loadJournal(h.place)!.phase, 'target_selected');
});

test('real backend startup failure stops and resumes the same selected journal without another DB', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const h = await fixture(t, true), saved = readFileSync(h.store.path), register = platform.service.register;
  const tasks = () => { const store = new ControlStore(h.workspace); try { return store.read(db => db.prepare(`SELECT t.id, t.title, (SELECT json_group_object(v.field_id, json(v.value)) FROM task_values v WHERE v.task_id=t.id) AS task_values FROM tasks t ORDER BY t.id`).all()); } finally { store.close(); } };
  const before = tasks(); assert.equal(before.length, profiles.small.tasks);
  platform.service.register = definition => { rmSync(h.store.path); return register(definition); };
  try { await assert.rejects(switchTo(h.place, h.target), /did not become ready/); }
  finally { writeFileSync(h.store.path, saved, { mode: 0o600 }); platform.service.register = register; }
  const journal = loadJournal(h.place)!; assert.equal(journal.phase, 'target_selected'); assert.equal(journal.old, null);
  assert(!existsSync(join(h.workspace, '.alpacawork/connection.json')));
  const ready = await switchTo(h.place, h.target), response = await fetch(new URL('/api/runtime/readiness', ready.url)), body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.state, 'accepting'); assert.equal(body.workspace, h.workspace); assert.equal(body.generation, ready.generation);
  assert.equal(loadJournal(h.place)!.phase, 'committed'); assert.equal(loadJournal(h.place)!.opId, journal.opId); assert(platform.service.stop(h.definition)); assert(platform.service.unregister(h.definition)); assert.deepEqual(tasks(), before);
  evidence({ kind: 'real-startup-failure-resumed', opId: journal.opId, ready: body, retainedTasks: before.length });
});

for (const phase of ['old_stopped', 'maintenance_complete'] as const) for (const link of ['current', 'previous'] as const)
test(`initial ${phase} resume preserves a foreign ${link}`, { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const h = await fixture(t), rename = fs.renameSync; let interrupted = false;
  fs.renameSync = (from, to) => { rename(from, to); if (to === join(h.releases, 'switch.json') && loadJournal(h.place)?.phase === phase) { interrupted = true; throw Error('durable phase interrupt'); } };
  syncBuiltinESMExports();
  try { await assert.rejects(switchTo(h.place, h.target), /durable phase interrupt/); }
  finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert(interrupted); const journal = readFileSync(join(h.releases, 'switch.json')), before = hash(join(h.workspace, '.alpacawork/alpacawork.sqlite'));
  const foreign = join(h.releases, 'foreign'); mkdirSync(foreign); symlinkSync(foreign, join(h.releases, link));
  await assert.rejects(switchTo(h.place, h.target), /links disagree/);
  assert.equal(linkTarget(h.releases, link), foreign); assert.deepEqual(readFileSync(join(h.releases, 'switch.json')), journal);
  assert.equal(hash(join(h.workspace, '.alpacawork/alpacawork.sqlite')), before);
});
test('initial current rename before journal save resumes the same selected generation', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const h = await fixture(t), rename = fs.renameSync; let interrupted = false;
  fs.renameSync = (from, to) => { rename(from, to); if (to === join(h.releases, 'current')) { interrupted = true; throw Error('current rename interrupt'); } };
  syncBuiltinESMExports();
  try { await assert.rejects(switchTo(h.place, h.target), /current rename interrupt/); }
  finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert(interrupted); const journal = loadJournal(h.place)!; assert.equal(journal.phase, 'maintenance_complete'); assert.equal(linkTarget(h.releases, 'current'), h.target);
  const ready = await switchTo(h.place, h.target); assert.equal(loadJournal(h.place)!.opId, journal.opId); assert(ready.generation);
});
test('same installation record derives identical service environment from another HOME/cwd and XDG values', async t => {
  const h = await fixture(t);
  const changed = { ...h.env, HOME: h.root, XDG_DATA_HOME: join(h.root, 'other-data'), XDG_STATE_HOME: join(h.root, 'other-state'), XDG_CACHE_HOME: join(h.root, 'other-cache') };
  assert.deepEqual(installationService(h.releases, h.workspace, h.definition.name, changed), h.definition);
});
test('native adapters reject partial observations, process probe faults and name-only macOS stop', () => {
  const root = mkdtempSync(join(tmpdir(), 'service-faults-')); const home = join(root, 'pid = 9876543'); mkdirSync(home, { mode: 0o700 });
  const definition: ServiceDefinition = { name: 'fault.service', executable: process.execPath, args: [], workingDirectory: root, environment: { HOME: home } };
  try {
    const native = launchdDefinition(definition); mkdirSync(dirname(native.path), { recursive: true, mode: 0o700 }); writeFileSync(native.path, native.text, { mode: 0o600 });
    let loaded = true, probes = 0; const calls: { file: string; args: string[] }[] = [];
    const command = (file: string, args: string[]) => {
      calls.push({ file, args });
      if (file === 'ps') { probes++; return probes === 1 ? { status: 0, stdout: 'stable-start' } : { status: 2, stdout: '', stderr: 'process table unavailable' }; }
      if (args.join(' ') === `print gui/${process.getuid!()}`) return { status: 0, stdout: '' };
      if (args[0] === 'bootout') { loaded = false; return { status: 0, stdout: '' }; }
      return loaded ? { status: 0, stdout: `job = {\n path = ${native.path}\n pid = 9876500\n environment = {\n pid = 9876544\n }\n}` } : { status: 113, stdout: '', stderr: 'Could not find service' };
    };
    const mac = createLaunchdService(command); assert.equal(mac.stop(definition.name), false); assert.equal(calls.length, 0);
    assert.equal(mac.stop(definition), false); assert.deepEqual(calls.filter(c => c.file === 'ps').map(c => c.args[1]), ['9876500', '9876500']);
    const linux = systemdDefinition(definition); mkdirSync(dirname(linux.path), { recursive: true, mode: 0o700 }); writeFileSync(linux.path, linux.text, { mode: 0o600 });
    let partialObservations = 0;
    const service = createSystemdService((_file, args) => { if (args.includes('show-environment')) return { status: 0, stdout: '' }; partialObservations++; return { status: 1, stdout: `LoadState=loaded\nActiveState=active\nFragmentPath=${linux.path}`, stderr: 'partial response' }; });
    assert.throws(() => service.observe(definition), /Cannot inspect systemd user unit.*partial response/);
    assert.throws(() => service.register(definition), /Cannot inspect systemd user unit.*partial response/);
    assert.equal(partialObservations, 2);
    evidence({ kind: 'native-fault-paths', processProbes: probes, partialObservations });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
