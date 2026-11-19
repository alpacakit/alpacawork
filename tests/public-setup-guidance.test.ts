import { serviceDefinition } from '../apps/backend/test-dist/installation/setup.js';


import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { watch } from 'node:fs/promises';
import { join } from 'node:path';

import { createServer, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { publicSetupSuite } from './helpers/public-setup-fixture.ts';
import { installationTerminal } from './helpers/installation-terminal.ts';

const s = publicSetupSuite();
const { fixture, publicFixture, hash, evidence } = s;

test('WSL setup explains a refused Windows workspace in the terminal language and preserves the machine refusal',
  { skip: process.platform !== 'linux' && 'WSL host detection runs on Linux' }, async t => {
  for (const language of ['ja_JP.UTF-8', 'en_US.UTF-8']) {
    const f = publicFixture(t);
    Object.assign(f.env, { WSL_DISTRO_NAME: 'Synthetic-Ubuntu', LANG: language, LC_ALL: language });
    const out = await f.run('cancel', ['setup', '--workspace', '/mnt/c/synthetic-alpacawork-data']);
    assert.equal(out.status, 2, out.transcript);
    assert.match(out.transcript, language.startsWith('ja') ? /Windows 側のフォルダは使えません/ : /Windows folders such as \/mnt\/c are not supported/);
    assert.match(out.transcript, language.startsWith('ja') ? /Linux 側のホーム/ : /Linux home/);
    assert.match(out.transcript, /cd ~\r?\nalpacawork setup/);
    const errors = out.transcript.split(/\r?\n/).flatMap(line => {
      try { const value = JSON.parse(line); return value.error ? [value.error] : []; } catch { return []; }
    });
    assert.deepEqual(errors, [{ code: 'unsafe_path', message: 'WSL2 workspace must use the Linux user HOME/filesystem',
      retry: 'fix', reason: { kind: 'installation_wsl_filesystem_refused' } }]);
    assert.equal(existsSync(join(f.home, '.config')), false);
    assert.equal(existsSync(join(f.home, 'alpacawork')), false);
    assert.equal(existsSync(f.releases), false);
    assert.deepEqual(out.beforeEnterChanges, [], 'refusal writes nothing in HOME');
    evidence({ kind: 'wsl-refused-workspace', language, ...out });
  }
});

// Keep the full port/recovery sequence once. English public startup/failure/resume
// remains in public-setup-operations; locale and advice are checked below in both languages.
test('public setup stable port and actionable replacement/startup guidance in Japanese', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const f = publicFixture(t), diagnose = process.env.PUBLIC_SETUP_DIAGNOSE === '1'; if (diagnose) Object.assign(f.env, { PUBLIC_SETUP_TRACE_BACKEND: join(f.root, 'backend-trace') }); f.env.LANG = 'ja_JP.UTF-8'; f.env.LC_ALL = f.env.LANG;
  const copied = (out: Awaited<ReturnType<typeof f.run>>, expected: string) => {
    const lines = out.transcript.split(/\r?\n/).map(line => line.trim());
    const command = lines.find(line => line === expected);
    assert(command, `Missing independently copyable line: ${expected}\n${out.transcript}`);
    const [name, ...args] = command.split(' ');
    return spawnSync(join(f.bin, name!), args, { env: f.env, encoding: 'utf8' });
  };
  const statusAndLog = (out: Awaited<ReturnType<typeof f.run>>) => {
    assert.equal(copied(out, 'systemctl --user status alpacawork.service').status, 3);
    assert.equal(copied(out, 'journalctl --user -u alpacawork.service -n 50 --no-pager').status, 0);
    const failures = out.transcript.split(/\r?\n/).flatMap(line => { try { const item = JSON.parse(line.trim()); return item.error ? [item.error] : []; } catch { return []; } });
    assert.equal(failures.at(-1)?.message, 'Setup did not complete', 'machine failure stays short');
  };
  const skill = join(f.home, '.agents/skills/alpacawork'); mkdirSync(skill, { recursive: true, mode: 0o700 });
  writeFileSync(join(skill, 'SKILL.md'), 'my edited original', { mode: 0o600 });
  const cancelled = await f.run('cancel', ['setup']); assert.equal(cancelled.status, 0, cancelled.transcript);
  assert(cancelled.transcript.includes(skill.replace(f.home, '~')));
  assert.doesNotMatch(cancelled.transcript, /cannot be recovered|別の場所へ写して|chmod/);
  assert.equal(readFileSync(join(skill, 'SKILL.md'), 'utf8'), 'my edited original'); assert.equal(existsSync(join(f.home, '.config')), false);
  writeFileSync(join(f.home, 'fail-start'), ''); const failed = await f.run('enter', ['setup']); assert.notEqual(failed.status, 0, failed.transcript);
  assert.match(failed.transcript, /^理由: Initial target did not become ready;.*Resume the same journal/m);
  statusAndLog(failed);
  assert.match(failed.transcript, /systemctl --user status alpacawork.service/); assert.match(failed.transcript, /journalctl --user -u alpacawork.service -n 50 --no-pager/);
  assert.match(failed.transcript, /同じ alpacawork setup を実行し直して/);
  const recordPath = join(f.home, '.config/alpacawork/installation.json'), saved = JSON.parse(readFileSync(recordPath, 'utf8')), port = saved.service.port;
  assert(port > 0 && port <= 65535); assert.equal(saved.version, 4); assert.equal(serviceDefinition(saved, recordPath).args.at(-1), String(port));
  const skillOperation = f.journal().request.operationId; rmSync(join(f.home, 'fail-start'));
  const blocker = createServer((_request, response) => response.end('other process'));
  await new Promise<void>((done, reject) => { blocker.once('error', reject); blocker.listen(port, '127.0.0.1', done); });
  try {
    const occupied = await f.run('enter', ['setup']); assert.notEqual(occupied.status, 0, occupied.transcript);
    statusAndLog(occupied);
    assert.deepEqual(JSON.parse(readFileSync(recordPath, 'utf8')).service, saved.service); assert.equal(f.journal().request.operationId, skillOperation);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'other process', 'setup must not stop the port owner');
    evidence({ kind: 'occupied-port-preserved', test: t.name, port, definition: serviceDefinition(saved, recordPath), transcript: occupied.transcript });
  } finally { await new Promise<void>((done, reject) => blocker.close(error => error ? reject(error) : done())); }
  const resumed = await f.run('enter', ['setup']); await f.ready(resumed); assert.equal(resumed.payload!.port, port);
  assert(resumed.transcript.includes(resumed.payload!.url!));
  assert.equal(resumed.confirmations, 1); assert.equal(f.receipt().operationId, skillOperation); assert.notEqual(readFileSync(join(skill, 'SKILL.md'), 'utf8'), 'my edited original');
  const repeated = await f.run('enter', ['setup'], undefined, diagnose); await f.ready(repeated); assert.equal(repeated.payload!.url, resumed.payload!.url, 'running service owns its saved port; setup must reuse it');
  assert.equal((await f.native('stop', 'alpacawork.service')).status, 0); assert.equal((await f.native('restart', 'alpacawork.service')).status, 0);
  const url = resumed.payload!.url!; let accepting = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { const response = await fetch(new URL('/api/runtime/readiness', url), { signal: AbortSignal.timeout(1000) }); const body = await response.json(); if (response.status === 200 && body.state === 'accepting') { accepting = true; break; } } catch { /* wait for the actual restarted backend */ }
    await delay(100);
  }
  assert(accepting, 'original URL must reach accepting after native stop/restart'); await f.ready(resumed);
  evidence({ kind: 'stable-port-restart', test: t.name, port, url, definition: serviceDefinition(JSON.parse(readFileSync(recordPath, 'utf8')), recordPath), status: 200 });
  const unchanged = JSON.parse(readFileSync(recordPath, 'utf8')).service;
  assert.equal((await f.native('stop', 'alpacawork.service')).status, 0);
  writeFileSync(join(skill, 'SKILL.md'), 'edit after successful setup');
  const beforeRetry = f.receipt().operationId;
  const occupiedAfterCommit = createServer((_request, response) => response.end('committed port owner'));
  await new Promise<void>((done, reject) => { occupiedAfterCommit.once('error', reject); occupiedAfterCommit.listen(port, '127.0.0.1', done); });
  try {
    const rejected = await f.run('enter', ['setup']); assert.notEqual(rejected.status, 0);
    statusAndLog(rejected);
    assert(rejected.transcript.split(/\r?\n/).includes('systemctl --user start alpacawork.service'));
    assert.match(rejected.transcript, /systemctl --user start alpacawork.service/); assert(!rejected.transcript.includes('systemctl --user restart'));
    assert.notEqual(f.journal().request.operationId, beforeRetry, 'successful setup begins a new approved request');
    assert.notEqual(readFileSync(join(skill, 'SKILL.md'), 'utf8'), 'edit after successful setup');
    assert.equal(await (await fetch(url)).text(), 'committed port owner');
  } finally { await new Promise<void>((done, reject) => occupiedAfterCommit.close(error => error ? reject(error) : done())); }
  const interruptedOperation = f.journal().request.operationId;
  // Hold actual backend discovery until the next CLI has started, after its HOME
  // baseline. This used to race the snapshot even though the CLI only reads it.
  const updateState = join(f.releases, '.updates/state.json');
  rmSync(join(f.releases, '.updates'), { recursive: true, force: true });
  const manifest = JSON.parse(readFileSync(join(s.image, 'package.json'), 'utf8'));
  let metadata: ServerResponse, metadataSeen!: () => void, published = false, registryUrl = '';
  const requested = new Promise<void>(done => { metadataSeen = done; });
  const sendMetadata = (response: ServerResponse) => {
    const version = { ...manifest, dist: { tarball: registryUrl + '/unused.tgz', integrity: 'sha512-' + Buffer.alloc(64).toString('base64') } };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ name: manifest.name, 'dist-tags': { latest: manifest.version }, versions: { [manifest.version]: version } }));
  };
  const registry = createServer((request, response) => {
    if (request.url !== '/publish') {
      if (published) sendMetadata(response);
      else { metadata = response; metadataSeen(); }
      return;
    }
    void (async () => {
      const changes = watch(f.releases, { recursive: true, signal: AbortSignal.timeout(20_000) });
      try {
        // Start watching before returning metadata so an immediate atomic write is observed.
        const next = changes.next(); published = true; sendMetadata(metadata);
        await next;
        while (!existsSync(updateState)) await changes.next();
        response.end('published');
      } finally { await changes.return(); }
    })().catch(error => { response.writeHead(500); response.end(String(error)); });
  });
  await new Promise<void>(done => registry.listen(0, '127.0.0.1', done));
  f.cleanup.push(() => new Promise<void>((done, reject) => { registry.closeAllConnections(); registry.close(error => error ? reject(error) : done()); }));
  const address = registry.address(); assert(address && typeof address === 'object'); registryUrl = `http://127.0.0.1:${address.port}`;
  f.env.npm_config_registry = registryUrl;
  const stopped = await f.run('enter', ['setup']); await f.ready(stopped);
  assert.equal(f.receipt().operationId, interruptedOperation, 'failed restart resumes the same skill request');
  await Promise.race([requested, delay(20_000, undefined, { ref: false }).then(() => { throw new Error('Backend discovery did not request metadata'); })]);
  assert.equal(existsSync(updateState), false, 'discovery is held before the CLI snapshot');
  const publish = join(f.root, 'publish-update.mjs');
  writeFileSync(publish, `const response = await fetch(${JSON.stringify(registryUrl + '/publish')}, {signal: AbortSignal.timeout(25_000)}); if (!response.ok) throw Error(await response.text());`);
  const checked = await f.run('enter', ['setup'], publish); await f.ready(checked); assert.equal(checked.payload!.url, url);
  assert(checked.beforeEnterChanges.some(change => (change as { path: string }).path === '.local/share/alpacawork/releases/.updates/state.json'), 'backend discovery must publish between snapshot and prompt');
  assert.deepEqual(checked.cliBeforeEnterWrites, [], 'the CLI only reads backend discovery state before approval');
  assert.deepEqual(JSON.parse(readFileSync(recordPath, 'utf8')).service, unchanged);
  evidence({ kind: 'committed-service-setup-restart', test: t.name, port, url, status: 200, service: unchanged });
  {
    assert.equal((await f.native('stop', 'alpacawork.service')).status, 0);
    const journalOwner = await import(pathToFileURL(join(s.library, 'release/journal.js')).href);
    const place = { releases: f.releases, workspace: join(f.home, 'alpacawork') }, originalSwitch = journalOwner.loadJournal(place)!;
    journalOwner.saveJournal(place, { ...originalSwitch, phase: 'recovery_intent', recovery: { id: '98657f00-d3e3-434c-953c-e9356bb26b48', backup: 'not-opened', source: originalSwitch.target, reader: originalSwitch.target, target: originalSwitch.target, replaced: [], failure: 'pending recovery fixture' } });
    const recovery = await f.run('enter', ['setup']); assert.notEqual(recovery.status, 0); assert(!recovery.transcript.includes('systemctl --user start '));
    assert.match(recovery.transcript, /^理由: Resume the pending DB recovery before switching code/m);
    assert.doesNotMatch(recovery.transcript, /^systemctl --user (?:start|restart) /m);
    journalOwner.saveJournal(place, { ...originalSwitch, phase: 'target_selected' }); writeFileSync(join(f.home, 'fail-start'), '');
    const incomplete = await f.run('enter', ['setup']); assert.notEqual(incomplete.status, 0); assert(!incomplete.transcript.includes('systemctl --user start '));
    assert.match(incomplete.transcript, /^理由: Initial target did not become ready/m);
    assert.doesNotMatch(incomplete.transcript, /^systemctl --user (?:start|restart) /m);
    rmSync(join(f.home, 'fail-start')); const finished = await f.run('enter', ['setup']); await f.ready(finished);
    evidence({ kind: 'recovery-and-incomplete-no-manual-start', test: t.name, verified: true });
  }

});

test('setup locale and overwrite confirmation use the request environment before any write', async t => {
  // backendUnitLibrary uses this checkout's declared dependencies, outside the sealed image.
  const core = await import('@alpacawork/core');
  const { createSystemdService } = await import('../packages/core/dist/platform/systemd-service.js');
  for (const [lang, lcAll, ja] of [
    ['en_US.UTF-8', 'ja_JP.UTF-8', true],
    ['ja_JP.UTF-8', 'en_US.UTF-8', false],
  ] as const) {
    const f = publicFixture(t), skill = join(f.home, '.agents/skills/alpacawork');
    Object.assign(f.env, { LANG: lang, LC_ALL: lcAll });
    const terminal = installationTerminal('\x03'); terminal.value.env = f.env;
    const lines: string[] = [];
    const previous = core.platform.service;
    // The real adapter observes this case's fake manager, never the user's manager.
    core.platform.service = createSystemdService((file: string, args: string[]) => spawnSync(file, args, { env: f.env, encoding: 'utf8' }));
    try {
      const fresh = installationTerminal('\x03'); fresh.value.env = f.env;
      assert.deepEqual(await s.owner.runSetup({ cwd: f.root, env: f.env }, line => lines.push(line), fresh.value),
        { installed: false, reason: 'cancelled' });
      assert.doesNotMatch(fresh.shown(), /手で直した内容も上書き|including local edits|Overwrite +Overwrite/);
      mkdirSync(skill, { recursive: true, mode: 0o700 });
      writeFileSync(join(skill, 'SKILL.md'), 'my edited original', { mode: 0o600 });
      assert.deepEqual(await s.owner.runSetup({ cwd: f.root, env: f.env }, line => lines.push(line), terminal.value),
        { installed: false, reason: 'cancelled' });
    } finally { core.platform.service = previous; }
    const shown = terminal.shown();
    assert(shown.includes(skill.replace(f.home, '~'))); assert(shown.includes('[Y/n]')); assert.deepEqual(lines, []);
    assert.equal(readFileSync(join(skill, 'SKILL.md'), 'utf8'), 'my edited original');
    assert.equal(existsSync(f.releases), false); assert.equal(existsSync(join(f.home, '.config')), false);
  }
});

test('startup diagnostics use the recorded service name and do not invent launchd stdout log files', async () => {
  const requireSwitch = await import(pathToFileURL(join(s.library, 'release/switch.js')).href);
  for (const ja of [false, true]) {
    const linux = s.owner.serviceStartupAdvice('selected.service', ja, 'linux'); assert(linux.includes('systemctl --user status selected.service')); assert(linux.includes('journalctl --user -u selected.service'));
    assert.match(linux, ja ? /同じ alpacawork setup を実行し直して/ : /run the same alpacawork setup again/);
    assert.match(linux, ja ? /保存済みのポートと設定で再開/ : /saved port and definition/);
    const stoppedLinux = s.owner.serviceStartupAdvice('selected.service', ja, 'linux', new (requireSwitch.ServiceStartRequired)('selected.service'));
    assert(stoppedLinux.split('\n').includes('systemctl --user start selected.service'));
    assert(!stoppedLinux.includes('systemctl --user restart'));
    assert.match(stoppedLinux, ja ? /起動後、同じ alpacawork setup を実行して確認/ : /Then run the same alpacawork setup to check/);
    const mac = s.owner.serviceStartupAdvice('selected.service', ja, 'darwin'); assert(mac.includes(`launchctl print gui/${process.getuid!()}/selected.service`)); assert(mac.includes('log show --last 10m')); assert.match(mac, ja ? /ログファイルが設定されていません/ : /does not configure stdout\/stderr log files/);
    assert(!mac.includes('backend.log')); const stopped = new (requireSwitch.ServiceStartRequired)('selected.service'); const stoppedMac = s.owner.serviceStartupAdvice('selected.service', ja, 'darwin', stopped); assert(stoppedMac.split('\n').includes(`launchctl kickstart gui/${process.getuid!()}/selected.service`)); assert(stoppedMac.split('\n').includes(`launchctl print gui/${process.getuid!()}/selected.service`)); assert(stoppedMac.split('\n').some(line => line.startsWith('log show --last 10m --style compact --predicate ')));  assert(!stoppedMac.includes('kickstart -k')); assert(!mac.includes('kickstart')); assert(!linux.includes('systemctl --user start '));
  }
});
