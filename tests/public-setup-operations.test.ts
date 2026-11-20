import { serviceDefinition } from '../apps/backend/test-dist/installation/setup.js';
import { parse } from 'yaml';


import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { connect } from 'node:net';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { pathToFileURL } from 'node:url';

import { copyWorkspace } from '../scripts/dev-fixtures/fixture.ts';
import { isolatedServe } from './helpers/http-cli.ts';

import { publicSetupSuite } from './helpers/public-setup-fixture.ts';
import { bundledPlatformPreload } from './helpers/backend-bundle.ts';

const s = publicSetupSuite();
const { fixture, publicFixture, hash, evidence } = s;

import { canRestorePreviousApplication } from '../apps/backend/test-dist/release/journal.js';

for (const recorded of [false, true]) test(`deploy refuses a responding workspace before confirmation or any installation write (${recorded ? 'workspace init record' : 'no record'})`, { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const f = publicFixture(t), workspace = join(f.home, 'alpacawork'), generation = randomUUID();
  if (recorded) {
    const setup = await import(pathToFileURL(join(s.library, 'installation/setup.js')).href);
    await setup.initializeInstallation({ cwd: f.root, env: f.env, explicit: workspace });
  } else s.copySetupWorkspace(workspace);
  const recordPath = join(f.home, '.config/alpacawork/installation.json');
  const beforeRecord = recorded ? readFileSync(recordPath, 'utf8') : null;
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url === '/api/identity' ? { root: workspace, generation } : {}));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  f.cleanup.unshift(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  const address = server.address(); assert(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/`;
  writeFileSync(join(workspace, '.alpacawork/connection.json'), JSON.stringify({ url, publicUrl: null, generation, runManager: join(s.image, 'apps/backend/dist/run-manager.js') }));
  f.env.ALPACAWORK_SERVER = url;
  const result = await f.run('enter', ['deploy', resolve('.')]);
  assert.notEqual(result.status, 0, result.transcript);
  assert.match(result.transcript, /Choose another --workspace/);
  assert.match(result.transcript, /"code":"conflict"/);
  assert.equal(result.prompt, false);
  assert.equal(recorded ? readFileSync(recordPath, 'utf8') : null, beforeRecord);
  assert.equal(existsSync(recordPath), recorded);
  assert.equal(existsSync(f.releases), false);
  assert.equal(existsSync(join(f.home, '.agents/skills')), false);
});

test('public setup enters once, overwrites an edited basic skill without old copies, keeps an unselected addon and returns an actual HTTP-ready URL', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const f = publicFixture(t), addon = join(f.home, '.agents/skills/alpacawork-betterquality'); mkdirSync(addon, { recursive: true, mode: 0o700 }); writeFileSync(join(addon, 'SKILL.md'), 'unselected addon');
  const skill = join(f.home, '.agents/skills/alpacawork'); mkdirSync(skill, { recursive: true, mode: 0o700 }); writeFileSync(join(skill, 'SKILL.md'), 'edited original', { mode: 0o600 });
  // An ordinary writable skill root is accepted without hardening it.
  const root = join(f.home, '.agents/skills'); chmodSync(root, 0o777);
  const out = await f.run('enter', ['setup']); const { saved } = await f.ready(out);
  assert.equal(out.confirmations, 1); assert.equal(lstatSync(root).mode & 0o777, 0o777);
  assert.equal(canRestorePreviousApplication(JSON.parse(readFileSync(join(f.releases,'switch.json'),'utf8'))),false,'initial managed skill overwrite also prevents earlier-application recovery');
  assert(out.transcript.includes(skill.replace(f.home, '~')));
  assert.equal(parse(readFileSync(join(f.home, 'alpacawork/config.yaml'), 'utf8')).agents.codex.enabled, false, 'An uncheckable synthetic CLI stays disabled');
  assert.deepEqual(f.receipt().skills.map((s: { name: string }) => s.name), ['alpacawork']);
  assert.equal(readFileSync(join(addon, 'SKILL.md'), 'utf8'), 'unselected addon');
  assert.deepEqual(saved.request.place, ['alpacawork']); assert.deepEqual(saved.request.remove, []);
  assert.notEqual(readFileSync(join(skill, 'SKILL.md'), 'utf8'), 'edited original');
  assert.equal(existsSync(join(f.home,'.agents/alpacawork-recovery')), false);
  assert(!out.transcript.includes('Skill disposal differs'));
});

test('public setup keeps an explicit existing synthetic workspace and ordinary user files', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const f = publicFixture(t), workspace = join(f.root, 'existing data'); copyWorkspace(s.original, workspace);
  const db = join(workspace, '.alpacawork/alpacawork.sqlite'); writeFileSync(join(workspace, 'keep.txt'), 'user data');
  const out = await f.run('enter', ['setup', '--workspace', workspace]); await f.ready(out, workspace);
  assert(out.transcript.includes(workspace)); assert.equal(readFileSync(join(workspace, 'keep.txt'), 'utf8'), 'user data');
  // Same schema maintenance/startup can write runtime state. Compare user records on independent copies.
  const { DatabaseSync } = await import('node:sqlite');
  const rows = (from: string, destination: string) => { cpSync(from, destination); const read = new DatabaseSync(destination, { readOnly: true }); try { return read.prepare('SELECT id, title FROM tasks ORDER BY id').all(); } finally { read.close(); } };
  assert.equal((await f.native('stop', 'alpacawork.service')).status, 0);
  assert.deepEqual(rows(db, join(f.root, 'actual.sqlite')), rows(join(s.original, '.alpacawork/alpacawork.sqlite'), join(f.root, 'expected.sqlite')));
});

test('public setup reports the running server\'s agent readiness', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const f = publicFixture(t);
  // The service manager passes the locale through to the server. The initial config check has only the unit environment.
  const agent = (ready: string) => '#!/bin/sh\nif [ "$1" = --version ]; then echo synthetic-1; exit 0; fi\n' + ready + '\n';
  writeFileSync(join(f.bin, 'codex'), agent('[ "$LC_ALL" != en_US.UTF-8 ]'), { mode: 0o700 });
  writeFileSync(join(f.bin, 'claude'), agent('[ "$LC_ALL" = en_US.UTF-8 ]'), { mode: 0o700 });

  const out = await f.run('enter', ['setup', '--public-host', 'pc.tailnet.example']);
  await f.ready(out);
  const response = await fetch(new URL('/api/config/get?check=true', out.payload!.url!), { headers: { Connection: 'close' } });
  assert.equal(response.status, 200);
  const settings = await response.json();
  assert.notEqual(settings.agents.codex.enabled, false, 'the initial config check found Codex signed in');
  assert.equal(settings.agents.claude.enabled, false, 'the initial config check found Claude Code signed out');
  assert.equal(settings.availability.codex.status, 'signed_out');
  assert.equal(settings.availability.claude.status, 'ready');
  assert.deepEqual(out.transcript.split(/\r?\n/).filter(line => /Agents ready:|is not signed in/.test(line)), [
    'Agents ready: Claude Code',
    `Codex is not signed in. To use it, run: ${settings.availability.codex.nextAction}`,
  ]);
});

for (const answer of ['cancel', 'eof']) test(`public setup ${answer} before Enter preserves HOME and existing skill bytes`, { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const f = publicFixture(t), skill = join(f.home, '.agents/skills/alpacawork'); mkdirSync(skill, { recursive: true, mode: 0o700 }); writeFileSync(join(skill, 'SKILL.md'), 'my edited original', { mode: 0o600 });
  const out = await f.run(answer, ['setup']); assert.equal(out.status, 0, out.transcript); assert.equal(out.payload?.installed, false, out.transcript);
  assert(out.transcript.includes(skill.replace(f.home, '~')));
  assert.equal(readFileSync(join(skill, 'SKILL.md'), 'utf8'), 'my edited original'); assert.equal(existsSync(f.releases), false);
  assert.equal(existsSync(join(f.home, '.config')), false); assert(!/"url"|"installed":\s*true/.test(out.transcript));
});

test('public setup manager stop keeps its HTTP client event loop available', { skip: process.platform !== 'linux' && 'systemd user unit and a linux-x64-glibc fixture image' }, async t => {
  const f = publicFixture(t), script = join(f.root, 'cooperative-service.mjs');
  s.copySetupWorkspace(join(f.home, 'alpacawork'));
  // A managed server can finish closing only after its client handles the last bytes.
  // Blocking the client in systemctl's wait turns that cooperation into a stop timeout.
  writeFileSync(script, `import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
let peer;
const timer = setTimeout(() => process.exit(2), 30000);
const server = createServer(socket => {
  peer = socket;
  socket.write('ready');
  socket.on('data', () => { socket.end(); server.close(() => clearTimeout(timer)); });
  socket.on('end', () => { socket.end(); server.close(() => clearTimeout(timer)); });
});
process.on('SIGTERM', () => peer.write('closing'));
server.listen(0, '127.0.0.1', () => writeFileSync(${JSON.stringify(join(f.root, 'port'))}, String(server.address().port)));
`);
  const unit = join(f.home, '.config/systemd/user/alpacawork.service'); mkdirSync(dirname(unit), { recursive: true });
  writeFileSync(unit, `ExecStart=:"${process.execPath}" "${script}"\nWorkingDirectory=${f.root}\n`);
  assert.equal((await f.native('start', 'alpacawork.service')).status, 0);
  for (let n = 0; !existsSync(join(f.root, 'port')) && n < 100; n++) await delay(10);
  const client = connect(Number(readFileSync(join(f.root, 'port'), 'utf8')), '127.0.0.1');
  let closing = false;
  await new Promise<void>((done, reject) => {
    client.on('data', bytes => {
      if (bytes.toString() === 'ready') done();
      else { closing = true; client.end('acknowledged'); }
    });
    client.once('error', reject);
  });
  try {
    const stopped = await f.native('stop', 'alpacawork.service');
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(closing, true);
    assert.equal((await f.native('status', 'alpacawork.service')).status, 3);
  } finally { client.destroy(); }
});

test('public setup manager unavailability and a conflicting native definition cannot change installation data', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const f = publicFixture(t); writeFileSync(join(f.home, 'manager-unavailable'), '');
  const unavailable = await f.run('enter', ['setup']); assert.notEqual(unavailable.status, 0); assert.match(unavailable.transcript, /User service manager is unavailable/); assert.equal(unavailable.prompt, false);
  rmSync(join(f.home, 'manager-unavailable')); const unit = join(f.home, '.config/systemd/user/alpacawork.service'); mkdirSync(dirname(unit), { recursive: true, mode: 0o700 }); writeFileSync(unit, 'foreign unit', { mode: 0o600 });
  const conflict = await f.run('enter', ['setup']); assert.notEqual(conflict.status, 0); assert.match(conflict.transcript, /definition conflicts/); assert.equal(conflict.prompt, false);
  assert.equal(readFileSync(unit, 'utf8'), 'foreign unit'); assert.equal(existsSync(f.releases), false);
});

// One setup fails at service registration, then at start, and resumes the same journal each time.
test('public setup resumes the same switch journal after fail-register and fail-start without reinstalling successful skills', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const f = publicFixture(t); writeFileSync(join(f.home, 'fail-register'), '');
  const failedAt = (failed: Awaited<ReturnType<typeof f.run>>) => {
    assert.notEqual(failed.status, 0, failed.transcript);
    assert.match(failed.transcript, /The service could not start/); assert.match(failed.transcript, /"message":"Setup did not complete"/);
    assert.match(failed.transcript, /^Reason: Initial target did not become ready;.*Resume the same journal/m);
    assert(!/"url"|"installed":\s*true/.test(failed.transcript));
  };
  failedAt(await f.run('enter', ['setup'])); const saved = f.journal(), operationId = saved.request.operationId;
  const switchId = JSON.parse(readFileSync(join(f.releases, 'switch.json'), 'utf8')).opId;
  writeFileSync(join(f.home, 'unit-bad-setting'), '');
  const invalid = await f.run('enter', ['setup']); assert.notEqual(invalid.status, 0); assert.equal(invalid.prompt, false);
  assert.match(invalid.transcript, /LoadState=bad-setting.*invalid WorkingDirectory/);
  assert.doesNotMatch(invalid.transcript, /User service manager is unavailable/);
  assert.deepEqual(f.journal(), saved, 'an invalid unit must not rewrite setup progress');
  rmSync(join(f.home, 'unit-bad-setting'));
  rmSync(join(f.home, 'fail-register')); writeFileSync(join(f.home, 'fail-start'), '');
  failedAt(await f.run('enter', ['setup']));
  assert.equal(f.journal().request.operationId, operationId); assert.equal(JSON.parse(readFileSync(join(f.releases, 'switch.json'), 'utf8')).opId, switchId);
  const skill = join(f.home, '.agents/skills/alpacawork/SKILL.md'); writeFileSync(skill, readFileSync(skill, 'utf8') + '\nmy later edit\n');
  rmSync(join(f.home, 'fail-start')); const resumed = await f.run('enter', ['setup']); await f.ready(resumed);
  assert.equal(f.receipt().operationId, operationId); assert.equal(JSON.parse(readFileSync(join(f.releases, 'switch.json'), 'utf8')).opId, switchId);
  assert.match(readFileSync(skill, 'utf8'), /my later edit/);
});

test('public setup on an installed PC re-approves a public host, PATH and port through the real unit, and a declined change keeps the running service', { skip: process.platform !== 'linux' && '/proc port range and a linux-x64-glibc fixture image' }, async t => {
  const f = publicFixture(t), recordPath = join(f.home, '.config/alpacawork/installation.json'), unit = join(f.home, '.config/systemd/user/alpacawork.service');
  const first = await f.run('enter', ['setup']); await f.ready(first);
  const url = first.payload!.url!, port = first.payload!.port!, record = readFileSync(recordPath, 'utf8'), definition = readFileSync(unit, 'utf8');
  const generation = async () => (await (await fetch(new URL('/api/runtime/readiness', url), { headers: { Connection: 'close' } })).json()).generation as string;
  const before = await generation();
  const declined = await f.run('cancel', ['setup', '--public-host', 'pc.tailnet.example']);
  assert.equal(declined.status, 0, declined.transcript); assert.equal(declined.payload?.installed, false, declined.transcript);
  assert(declined.transcript.includes('pc.tailnet.example'));
  assert.equal(readFileSync(recordPath, 'utf8'), record); assert.equal(readFileSync(unit, 'utf8'), definition); assert.equal(await generation(), before);
  const hosted = await f.run('enter', ['setup', '--public-host', 'pc.tailnet.example']); await f.ready(hosted);
  assert.equal(hosted.confirmations, 1); assert.equal(hosted.payload!.url, url);
  const withHost = JSON.parse(readFileSync(recordPath, 'utf8')).service;
  assert.deepEqual(serviceDefinition(JSON.parse(readFileSync(recordPath, 'utf8')), recordPath).args.slice(-4), ['--public-host', 'pc.tailnet.example', '--port', String(port)]);
  assert.match(readFileSync(unit, 'utf8'), /"--public-host" "pc\.tailnet\.example"/); assert.notEqual(await generation(), before, 'the service restarted with the new unit');
  // No option keeps what is recorded: the ordinary same-version setup runs and the public host stays.
  const kept = await f.run('enter', ['setup']); await f.ready(kept);
  assert(kept.transcript.includes('pc.tailnet.example'));
  assert.deepEqual(JSON.parse(readFileSync(recordPath, 'utf8')).service, withHost);
  const agents = join(f.root, 'agent-bin'); mkdirSync(agents); f.env.PATH = `${agents}:${f.env.PATH}`;
  const next = await f.reserveServicePort();
  const moved = await f.run('enter', ['setup', '--port', String(next)]); await f.ready(moved);
  assert.equal(moved.confirmations, 1); assert.equal(moved.payload!.port, next);
  assert(moved.transcript.includes(`${port} → ${next}`)); assert(moved.transcript.includes(agents));
  const changed = JSON.parse(readFileSync(recordPath, 'utf8')).service;
  assert.deepEqual(serviceDefinition(JSON.parse(readFileSync(recordPath, 'utf8')), recordPath).args.slice(-4), ['--public-host', 'pc.tailnet.example', '--port', String(next)]);
  assert(changed.environmentPath.split(':').includes(agents));
  await assert.rejects(fetch(url), 'the old port is closed');
});

test('public setup redacts its startup reason before printing real terminal lines', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const f = publicFixture(t), secret = 'sk-SyntheticSecret12345678', preload = join(f.root, 'registration-error.mjs');
  writeFileSync(preload, bundledPlatformPreload(s.image,
    `platform.service.register=()=>{throw new Error('Registration failed with ${secret}\\nCheck manager access');};`));
  f.env.NODE_OPTIONS='--import='+preload;
  const failed = await f.run('enter', ['setup']); assert.notEqual(failed.status, 0, failed.transcript);
  assert.match(failed.transcript, /^Reason: Registration failed with \[redacted\] Check manager access\r?$/m);
  assert(!failed.transcript.includes(secret)); assert.equal(failed.transcript.match(/^Reason: /gm)?.length, 1);
  assert.match(failed.transcript, /"message":"Setup did not complete"/);
});

for (const method of ['install']) test(`public setup reconciles a lost ${method} answer using the same request and original operation`, { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const f = publicFixture(t), preload = join(f.root, 'lose-answer.mjs');
  writeFileSync(preload, `import {registerHooks} from 'node:module';
registerHooks({load(url,context,next){const result=next(url,context),source=String(result.source);if(!url.startsWith(${JSON.stringify(pathToFileURL(join(s.image,'apps/backend/dist/')).href)})||!source.includes('var ManagedSkillsWriter = class'))return result;
return {...result,source:source+"\\nconst install=ManagedSkillsWriter.prototype.install;ManagedSkillsWriter.prototype.install=async function(...args){await install.apply(this,args);throw Error('Lost install response after the real writer returned');};"};}});`);

  const lost = await f.run('enter', ['setup'], preload); assert.notEqual(lost.status, 0, lost.transcript); assert.match(lost.transcript, new RegExp(`Lost ${method} response`));
  const saved = f.journal(), operationId = f.receipt().operationId;
  assert.equal(operationId, saved.request.operationId);
  const resumed = await f.run('enter', ['setup']); await f.ready(resumed);
  assert.deepEqual(f.receipt().request, { release: saved.request.release, ...saved.request.intent });
  assert.equal(f.receipt().operationId, operationId);
});

test('public setup preserves a running manual serve and offers another workspace first', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const f = publicFixture(t), workspace = join(f.root, 'manual'); copyWorkspace(s.original, workspace);
  const preserved = join(workspace, 'keep.txt'); writeFileSync(preserved, 'manual serve data');
  const live = await isolatedServe(workspace, undefined, f.env);
  try {
    const before = await (await fetch(new URL('/api/runtime/readiness', live.url))).json();
    const failed = await f.run('enter', ['setup', '--workspace', workspace]); assert.notEqual(failed.status, 0, failed.transcript);
    assert.match(failed.transcript, /Choose another --workspace/); assert(!/"installed":\s*true|"url":/.test(failed.transcript));
    assert.equal(failed.prompt, false);
    const response = await fetch(new URL('/api/runtime/readiness', live.url)), after = await response.json();
    assert.equal(response.status, 200); assert.equal(after.generation, before.generation); assert.equal(live.child.exitCode, null);
    assert.equal(readFileSync(preserved, 'utf8'), 'manual serve data');
    assert.equal(existsSync(join(f.home, 'fake-manager/pid.json')), false);
  } finally { await live.stop(); }
});

test('public setup retains existing selected addons and their local edits through the shared writer', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const f = publicFixture(t), root = join(f.home, '.agents/skills');
  const { ManagedSkillsWriter } = await import(pathToFileURL(join(s.library, 'installation/skills.js')).href);
  const writer = new ManagedSkillsWriter({ root });
  // The same self-import Owner used by setup prepares an owned sealed copy; never chmod the source image.
  const prepared = await s.owner.prepareSetup(f.request, s.owner.inspectSetup(f.request), () => {}); prepared.unlock();
  const intent = { place: ['alpacawork', 'alpacawork-betterquality'], remove: [] }, request = { version:2, operationId:randomUUID(), release: prepared.release, intent };
  await writer.install(request);
  const addon = join(root, 'alpacawork-betterquality/SKILL.md'); writeFileSync(addon, readFileSync(addon, 'utf8') + '\nmy addon edit\n'); const before = hash(addon);
  const out = await f.run('enter', ['setup']); await f.ready(out); assert(out.transcript.includes('alpacawork-betterquality'));
  assert.equal(hash(addon), before); assert.deepEqual(f.receipt().skills.map((s: { name: string }) => s.name), ['alpacawork', 'alpacawork-betterquality']);
});

test('public setup preserves an unknown caller journal version and stops before approval', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const f = publicFixture(t); mkdirSync(f.releases, { recursive: true, mode: 0o700 });
  const journal = join(f.releases, 'setup-skills.json'); writeFileSync(journal, '{"version":99}', { mode: 0o600 }); const before = hash(journal);
  const out = await f.run('enter', ['setup']); assert.notEqual(out.status, 0); assert.equal(out.prompt, false); assert.match(out.transcript, /Unknown or invalid setup journal/);
  assert.equal(hash(journal), before); assert.equal(existsSync(join(f.home, 'alpacawork')), false); assert.equal(existsSync(join(f.home, '.agents')), false);
});

test('public setup confirms and creates the skills folder and link for a detected claude and for an agent folder in HOME, then reuses the link', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const f = publicFixture(t), parent = join(f.home, '.claude/skills'), link = join(parent, 'alpacawork'), other = join(f.home, '.unrelated-agent/skills/alpacawork');
  writeFileSync(join(f.bin, 'claude'), '#!/bin/sh\nexit 99\n', { mode: 0o700 }); mkdirSync(join(f.home, '.unrelated-agent'));
  rmSync(join(f.bin, 'codex')); f.env.PATH = `${f.bin}:${dirname(process.execPath)}:/usr/bin:/bin`;
  const cancel = await f.run('cancel', ['setup']); assert.equal(cancel.status, 0, cancel.transcript); assert.equal(existsSync(join(f.home, '.claude')), false);
  assert(cancel.transcript.includes(link.replace(f.home, '~'))); assert(!cancel.transcript.includes(other.replace(f.home, '~'))); assert.equal(existsSync(join(f.home, '.unrelated-agent/skills')), false);
  const made = await f.run('enter', ['setup']); await f.ready(made); assert.equal(made.confirmations, 1);
  assert.equal(parse(readFileSync(join(f.home, 'alpacawork/config.yaml'), 'utf8')).agents.claude.enabled, false); assert.equal(readlinkSync(link), join(f.home, '.agents/skills/alpacawork')); assert.equal(existsSync(other), false);

  const inode = lstatSync(link).ino; assert.equal((await f.native('stop', 'alpacawork.service')).status, 0);
  const again = await f.run('enter', ['setup']); await f.ready(again); assert.equal(again.confirmations, 1); assert.equal(lstatSync(link).ino, inode);
  rmSync(link); mkdirSync(link); writeFileSync(join(link, 'keep'), 'existing Claude content');
  f.env.LANG = 'ja'; f.env.LC_ALL = 'ja_JP.UTF-8';
  const conflictCancel = await f.run('cancel', ['setup']); assert.equal(conflictCancel.status, 0, conflictCancel.transcript); assert.equal(readFileSync(join(link, 'keep'), 'utf8'), 'existing Claude content');
  const conflict = await f.run('enter', ['setup']); await f.ready(conflict); assert.equal(conflict.confirmations, 1); assert.equal(readFileSync(join(link, 'keep'), 'utf8'), 'existing Claude content');
});
