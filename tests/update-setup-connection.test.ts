import { installSetupSystemctl } from './helpers/setup-systemctl.ts';
import {backendBundleWith,fixturePlatformEntry,fixtureUpdateRuntime,prependBackendInstrumentation} from './helpers/backend-bundle.ts';
import {backendUnitLibrary} from './helpers/backend-unit-library.ts';
/** Real public setup -> recorded service3 -> a real changed distribution, over formal HTTP. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { platform } from '@alpacawork/core';
import { holdReleases } from '../apps/backend/test-dist/release/layout.js';
import { controllerAlive } from '../apps/backend/test-dist/release/update-record.js';
import { assembleFixtureDistribution, fixtureCommit, fixtureSource, npmTarball } from './helpers/distribution-fixture.ts';
import { cleanCliEnv } from './helpers/http-cli.ts';
import { stopUpdateFixtureProcesses } from './helpers/update-service.ts';
import { createOriginal, copyWorkspace, removeWorkspace, profiles } from '../scripts/dev-fixtures/fixture.ts';

async function until(read: () => Promise<any>, accept: (value: any) => boolean, timeout = 180_000): Promise<any> {
  let last: unknown;
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    try { last = await read(); if (accept(last)) return last; } catch (error) { last = String(error); }
    await delay(50);
  }
  throw new Error('Timed out: ' + JSON.stringify(last));
}

/** Only transport and detached process groups are synthetic. Installation and native service definition stay real. */
function prepareRuntime(built: string) {
 const platformEntry=fixturePlatformEntry(built);
 const discovery=backendBundleWith(built,'function monitorUpdates(');
 let code=readFileSync(discovery,'utf8');assert(code.includes('next = 6e4'));
 code=code.replace('next = 6e4','next = 100').replace('timer = setTimeout(tick, next)','timer = __fixtureTimer(tick, next)');
 writeFileSync(discovery,code);
 prependBackendInstrumentation(discovery,`
import {readFileSync as __fixtureRead,appendFileSync as __fixtureAppend} from 'node:fs';
import {join as __fixtureJoin,dirname as __fixtureDirname} from 'node:path';
import {spawn as __fixtureSpawn} from 'node:child_process';
const __trace=event=>__fixtureAppend(__fixtureJoin(process.env.HOME,'discovery-timers.jsonl'),JSON.stringify({pid:process.pid,...event})+'\\n');
const __schedule=globalThis.setTimeout,__cancel=globalThis.clearTimeout,__owned=new Set();let __closing=false;
function __fixtureTimer(callback,ms,...args){const timer=__schedule(callback,ms,...args);__owned.add(timer);__trace({kind:'scheduled',ms,closing:__closing});return timer;}
globalThis.clearTimeout=function(timer){if(__owned.has(timer))__trace({kind:'cancelled',closing:__closing});return __cancel(timer);};
process.once('SIGTERM',()=>{__closing=true;__trace({kind:'closing'});});
`);
 const runtimeModule=backendBundleWith(built,'function resolveUpdateRuntime(');
 prependBackendInstrumentation(runtimeModule,'import {platform as __fixturePlatform} from '+JSON.stringify('./'+relative(dirname(runtimeModule),platformEntry))+';');
 if(runtimeModule!==discovery)prependBackendInstrumentation(runtimeModule,`
import {appendFileSync as __fixtureAppend} from 'node:fs';
import {join as __fixtureJoin,dirname as __fixtureDirname} from 'node:path';
import {spawn as __fixtureSpawn} from 'node:child_process';
`);
 fixtureUpdateRuntime(built,`
 const runtime=fixtureRuntimeOwner(workspace,env);
 __fixturePlatform.run.spawnDetached=(command,args,options)=>{const child=__fixtureSpawn(command,args,{...options,detached:true});__fixtureAppend(__fixtureJoin(__fixtureDirname(env.HOME),'processes.jsonl'),JSON.stringify({pid:child.pid,started:__fixturePlatform.run.started(child.pid),argv:[command,...args]})+'\\n');return child;};
 return runtime;
 `);
}

test('public setup3 naturally discovers and updates changed skill bytes, retries the same authorization, and refuses unknown receipt before stopping', { skip: process.platform !== 'linux' && 'GNU tar --transform and a linux-x64-glibc fixture image', timeout: 600_000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'setup-update-'))), home = join(root, 'home');
  mkdirSync(home); const bin = join(root, 'bin'); mkdirSync(bin);
  const native = join(bin, 'systemctl'); installSetupSystemctl(native);
  // No user scope manager is contacted; the production service adapter runs this isolated native command.
  const env = cleanCliEnv({ HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
    XDG_STATE_HOME: join(home, '.local/state'), XDG_CACHE_HOME: join(home, '.cache'), PATH: bin + ':' + dirname(process.execPath) + ':/usr/bin:/bin', LANG: 'en', LC_ALL: 'en_US.UTF-8' });
  delete env.XDG_RUNTIME_DIR; delete env.SUDO_UID; delete env.SUDO_USER;
  const original = createOriginal({ ...profiles.small, seed: 'setup-update3' }, join(root, 'cache')).root;
  const workspace = join(home, 'alpacawork'); copyWorkspace(original, workspace);
  writeFileSync(join(workspace,'config.yaml'),readFileSync(join(workspace,'config.yaml'),'utf8')+'limits:\n  automatic_per_placement: 0\n');
  const releases = join(home, '.local/share/alpacawork/releases'), source = fixtureSource(resolve('.')), pkg = join(root, 'package');
  let registry: ReturnType<typeof createServer> | undefined;
  t.after(async () => {
    if (!(t as any).passed) { const log=join(home,'fake-manager/backend.log'); if(existsSync(log)) console.error(readFileSync(log,'utf8').slice(-18000)); }
    try {
      const trace = join(root, 'processes.jsonl');
      const controllers: {pid: number; started: string}[] = existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
      const servicePid = join(home, 'fake-manager/pid.json');
      if (existsSync(servicePid)) { const saved = JSON.parse(readFileSync(servicePid, 'utf8')); controllers.push({pid: saved.pid, started: saved.start}); }
      // Capture the owned descendants before their parents stop, including maintenance and Run-manager children.
      const owned = new Map<number, {pid: number; started: string}>();
      for (const saved of controllers) if (platform.run.started(saved.pid) === saved.started)
        for (const child of platform.run.commandProcesses(saved.pid, null)) owned.set(child.pid, child);
      for (const child of owned.values()) appendFileSync(trace, JSON.stringify({...child, argv: []}) + '\n');
      execFileSync(native, ['--user', 'stop', 'alpacawork.service'], { env });
      await stopUpdateFixtureProcesses(root);
      // A request a stray process still holds open must not keep this file's process alive.
      if (registry) { registry.closeAllConnections(); await new Promise<void>((done, reject) => registry!.close(error => error ? reject(error) : done())); }
      removeWorkspace(workspace); removeWorkspace(original);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  assembleFixtureDistribution(resolve('.'), join(root, 'source-build'), pkg, source, prepareRuntime);
  const changes = { 'package.json': JSON.stringify({ ...JSON.parse(readFileSync(resolve('package.json'), 'utf8')), version: '0.3.1' }),
    'skills/alpacawork/SKILL.md': readFileSync(resolve('skills/alpacawork/SKILL.md'), 'utf8') + '\nSynthetic next release skill change.\n' };
  const sha = fixtureCommit(resolve('.'), join(root, 'objects'), 'setup-next', changes), candidate = join(root, 'candidate');
  assembleFixtureDistribution(resolve('.'), join(root, 'candidate-build'), candidate, sha, built => {
    prepareRuntime(built); for (const [file, bytes] of Object.entries(changes)) writeFileSync(join(built, file), bytes);
  });
  const manifest = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'));
  const archive = join(root, 'next.tgz'); npmTarball(archive, ['--format=ustar', '--transform=s,^,package/,', ...readdirSync(candidate)], candidate);
  const bytes = readFileSync(archive); let origin = '', failMetadata = false, holdMetadata = false, held = 0, aborted = 0, requests = 0;
  let firstMetadataReply: (() => void) | undefined;
  registry = createServer((req, res) => {
    if (req.url?.endsWith('.tgz')) { res.end(bytes); return; }
    requests++;
    assert(req.url?.startsWith('/mirror/'), 'production runtime must use the npmrc registry path');
    if (holdMetadata) { held++; res.once('close', () => { held--; aborted++; }); return; }
    if (failMetadata) { res.writeHead(503); res.end('{}'); return; }
    const version = { ...manifest, dist: { tarball: origin + '/next.tgz', integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') } };
    const reply = () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ name: manifest.name, 'dist-tags': { latest: version.version }, versions: { [version.version]: version } })); };
    if (requests === 1) firstMetadataReply = reply; else reply();
  });
  await new Promise<void>(done => registry!.listen(0, '127.0.0.1', done)); const address = registry.address(); assert(address && typeof address === 'object'); origin = 'http://127.0.0.1:' + address.port;
  writeFileSync(join(home, '.npmrc'), 'registry=' + origin + '/mirror/\n');
  env.npm_config_registry = origin + '/mirror/';
  env.npm_config_globalconfig = join(root, 'global.npmrc'); writeFileSync(env.npm_config_globalconfig, '');
  const terminal = join(root, 'terminal.json');
  writeFileSync(terminal, JSON.stringify({ home, cwd: root, env, output: join(root, 'terminal-result.json'), answer: 'enter', umask: 0o002,
    command: [process.execPath, join(pkg, 'bin/alpacawork.mjs'), 'setup', '--no-open', '--workspace', workspace] }));
  const child = spawn(process.execPath, [resolve('tests/helpers/setup-terminal.ts'), terminal], { env });
  let stdout = '', stderr = ''; child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
  const exit = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', done); }); assert.equal(exit, 0, stderr + stdout);
  const setup = JSON.parse(stdout); assert.equal(setup.status, 0, setup.transcript); assert.equal(setup.confirmations, 1); assert.equal(setup.unchangedBeforeEnter, true);
  const installation = JSON.parse(readFileSync(join(home, '.config/alpacawork/installation.json'), 'utf8'));
  assert.equal(installation.version, 4); assert.match(installation.workspaceIdentity, /^[a-f0-9-]{36}$/);
  const active = realpathSync(join(releases, 'current')); assert.equal(readFileSync(join(active, 'SOURCE'), 'utf8').trim(), source);
  const sourceSkills = readFileSync(join(active, 'skills/alpacawork/SKILL.md'), 'utf8'); assert.notEqual(sourceSkills, changes['skills/alpacawork/SKILL.md']);
  const skills = join(home, '.agents/skills'), basic = join(skills, 'alpacawork/SKILL.md'); assert.equal(readFileSync(basic, 'utf8'), sourceSkills);
  mkdirSync(join(skills, 'custom')); writeFileSync(join(skills, 'custom/SKILL.md'), 'untouched custom');
  mkdirSync(join(skills, 'alpacawork-betterquality')); writeFileSync(join(skills, 'alpacawork-betterquality/SKILL.md'), 'unselected addon');
  writeFileSync(basic, 'local edit to be overwritten'); writeFileSync(join(skills, 'alpacawork/obsolete.txt'), 'obsolete local member');
  const url = JSON.parse(readFileSync(join(workspace, '.alpacawork/connection.json'), 'utf8')).url;
  const call = async (path: string, input?: object) => { const response = await fetch(new URL(path, url), { method: input ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: input ? JSON.stringify(input) : undefined, signal: AbortSignal.timeout(5000) }); const body = await response.json() as any; assert.equal(response.status, 200, JSON.stringify(body)); return body; };
  const status = () => call('/api/update/status');
  const timerLog = join(home, 'discovery-timers.jsonl');
  const timers = () => existsSync(timerLog) ? readFileSync(timerLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  // Keep the actual setup-time observation pending, then publish while the same release lock is held.
  // A lock collision must use the existing deferred timer and discover naturally after release, without restart.
  const unlock = holdReleases(releases);
  try {
    await until(async () => firstMetadataReply, value => typeof value === 'function', 20_000);
    const deferredBefore = timers().filter(row => row.kind === 'scheduled' && row.ms === 100).length;
    firstMetadataReply!();
    await until(async () => timers(), rows => rows.filter(row => row.kind === 'scheduled' && row.ms === 100).length > deferredBefore, 10_000);
    assert.equal(timers().some(row => row.kind === 'scheduled' && row.ms === 60 * 60 * 1000), false, 'publication contention never reserves the hourly period');
    assert.notEqual((await status()).kind, 'available');
  } finally { unlock(); }
  const offered = await until(status, value => value.kind === 'available', 20_000);
  await until(async () => timers(), rows => rows.some(row => row.kind === 'scheduled' && row.ms === 60 * 60 * 1000), 10_000);
  assert(timers().some(row => row.kind === 'scheduled' && row.ms === 100), 'the unfinished setup switch was retried');
  const regularRequests = requests; await delay(400); assert.equal(requests, regularRequests, 'a successful discovery keeps the hourly period');

  const review = await call('/api/update/review?candidateId=' + offered.candidateId); assert.ok(review.skills.length > 0);
  const input = { opId: randomUUID(), candidateId: review.candidateId, reviewDigest: review.reviewDigest };
  const writerFile = join(skills, '.alpacawork/installed.json'), writerBytes = readFileSync(writerFile);
  const journalBefore = readFileSync(join(releases, 'switch.json')), pidBefore = readFileSync(join(home, 'fake-manager/pid.json'));
  writeFileSync(writerFile, JSON.stringify({ ...JSON.parse(writerBytes.toString()), version: 999 }));
  const refused = await fetch(new URL('/api/update/confirm', url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  assert.notEqual(refused.status, 200); assert.deepEqual(readFileSync(join(releases, 'switch.json')), journalBefore); assert.deepEqual(readFileSync(join(home, 'fake-manager/pid.json')), pidBefore);
  assert.equal(existsSync(join(releases, '.updates', input.opId, 'approval.json')), false);
  assert.equal(JSON.parse(readFileSync(writerFile, 'utf8')).version, 999); writeFileSync(writerFile, writerBytes);
  failMetadata = true; await call('/api/update/confirm', input); await until(status, value => value.kind === 'failed');
  const saved = JSON.parse(readFileSync(join(releases, '.updates', 'state.json'),'utf8')).operation.skills;
  assert.deepEqual(saved, { root: skills, place: ['alpacawork'] });
  const resumed = await call('/api/update/review'); assert.deepEqual(resumed.resume, input); failMetadata = false;
  // A published failure is visible before the old controller's finally releases L.
  // Wait for that owned executor to finish, as the other managed-update fixtures do.
  const controllers = readFileSync(join(root, 'processes.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    .filter(row => row.argv.includes(input.opId));
  assert.equal(controllers.length, 1, 'the failed acquisition has exactly one owned controller');
  assert.equal(typeof controllers[0].started, 'string', 'the wait uses the recorded process incarnation');
  await until(async () => controllers, rows => rows.every((row: { pid: number; started: string }) => !controllerAlive({ controller: row })), 10_000);
  await call('/api/update/confirm', input); await until(status, value => value.kind === 'done');
  assert.equal(readFileSync(basic, 'utf8'), changes['skills/alpacawork/SKILL.md']); assert.equal(existsSync(join(skills, 'alpacawork/obsolete.txt')), false);
  assert.equal(readFileSync(join(skills, 'custom/SKILL.md'), 'utf8'), 'untouched custom'); assert.equal(readFileSync(join(skills, 'alpacawork-betterquality/SKILL.md'), 'utf8'), 'unselected addon');
  assert.equal(existsSync(join(home, '.agents/alpacawork-recovery')), false); assert.equal(JSON.parse(readFileSync(join(releases, 'switch.json'),'utf8')).skillsWriteStarted, true);
  const connection = JSON.parse(readFileSync(join(workspace, '.alpacawork/connection.json'), 'utf8')); assert.equal(connection.url, url);
  assert.equal(realpathSync(join(releases, 'current')), join(releases, sha));
  const service = await import(pathToFileURL(join(backendUnitLibrary(resolve('.'),join(root,'unit-library'),join(releases,sha)), 'installation/setup.js')).href);
  const read = service.readInstallationService({ workspace, releases, env }); assert.equal(read.installation.workspaceIdentity, installation.workspaceIdentity); assert.equal(read.port, installation.service.port);
  assert.deepEqual(readdirSync(join(home, '.agents')).sort(), ['skills']);
  // Observe the actual monitor while transport is in flight, then close the real server through its native boundary.
  const scheduledService = JSON.parse(readFileSync(join(home, 'fake-manager/pid.json'), 'utf8'));
  await until(async () => timers(), rows => rows.some(row => row.pid === scheduledService.pid && row.kind === 'scheduled' && row.ms === 60 * 60 * 1000), 10_000);
  for (const child of platform.run.commandProcesses(scheduledService.pid, null))
    appendFileSync(join(root, 'processes.jsonl'), JSON.stringify({...child, argv: []}) + '\n');
  holdMetadata = true; execFileSync(native, ['--user', 'restart', 'alpacawork.service'], { env });
  await until(async () => held, value => value === 1, 20_000);
  assert(timers().some(row => row.pid === scheduledService.pid && row.kind === 'cancelled'), 'shutdown clears the previous hourly reservation');
  const pendingRequests = requests; await delay(400); assert.equal(requests, pendingRequests, 'discovery does not overlap an in-flight request');
  const pendingService = JSON.parse(readFileSync(join(home, 'fake-manager/pid.json'), 'utf8'));
  for (const child of platform.run.commandProcesses(pendingService.pid, null))
    appendFileSync(join(root, 'processes.jsonl'), JSON.stringify({...child, argv: []}) + '\n');
  execFileSync(native, ['--user', 'stop', 'alpacawork.service'], { env });
  await until(async () => held, value => value === 0, 5000); assert.equal(aborted, 1, 'shutdown aborts the pending registry request');
  assert(timers().some(row => row.pid === pendingService.pid && row.kind === 'closing'));
  assert.equal(timers().some(row => row.pid === pendingService.pid && row.kind === 'scheduled'), false, 'close awaits the request without reserving another tick');
  holdMetadata = false;
  assert.equal(timers().some(row => row.kind === 'scheduled' && row.closing), false, 'a closed monitor never reserves a later tick');
  console.log(JSON.stringify({ kind: 'setup-update-connection', source, target: sha, sourceVersion: JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version,
    targetVersion: manifest.version, installation: installation.version, service: installation.service.name, port: read.port,
    confirmations: setup.confirmations, sameUrl: connection.url === url, changedSkill: true, sameOperationResume: true,
    unknownReceiptRefusedBeforeStop: true, unselectedSkillsUnchanged: true }));
});
