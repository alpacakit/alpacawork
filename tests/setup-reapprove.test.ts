/** `alpacawork setup` on an installed PC re-approves the recorded service facts. The real setup, installation record,
 * switch Owner and both service adapters run against an isolated HOME: only the manager's command (systemctl,
 * launchctl) and the served release are stand-ins. No real service manager is addressed. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createSocket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { platform, type ServiceDefinition } from '@alpacawork/core';
import { controlSchemaManifest } from '@alpacawork/db';
import { createSystemdService, systemdDefinition } from '../packages/core/dist/platform/systemd-service.js';
import { createLaunchdService, launchdDefinition } from '../packages/core/dist/platform/launchd-service.js';
import { InstallationStore, installationPath } from '@alpacawork/backend/test-dist/installation/store.js';
import { initializeInstallation, registerInstallation, readInstallationService, managedInstallation, installationSkillsRoot, serviceDefinition, servicePath, servicePort, servicePublicHost, serviceMcp } from '@alpacawork/backend/test-dist/installation/setup.js';
import { runSetup, type SetupRequest } from '@alpacawork/backend/test-dist/installation/public-setup.js';
import { newSetupSkills, saveSetupSkills } from '@alpacawork/backend/test-dist/installation/setup-skills.js';
import { applyDeployArtifact } from '@alpacawork/backend/test-dist/installation/deploy.js';
import { point } from '@alpacawork/backend/test-dist/release/layout.js';
import { saveJournal, JOURNAL_VERSION } from '@alpacawork/backend/test-dist/release/journal.js';
import { releaseArtifacts } from './helpers/release-switch-fixture.ts';
import { installationTerminal } from './helpers/installation-terminal.ts';
import { cleanCliEnv } from './helpers/http-cli.ts';
import { preserveTestFailure } from './helpers/failure-workspace.ts';

const NODE = realpathSync(process.execPath);
/** A loopback port outside the range the OS hands out by itself, so no other test's port 0 takes it before the stand-in serves. */
async function freePort(): Promise<number> {
  for (;;) {
    const port = randomInt(20000, 45000), probe = createSocket();
    const free = await new Promise<boolean>(done => { probe.once('error', () => done(false)); probe.listen(port, '127.0.0.1', () => done(true)); });
    if (free) { await new Promise<void>(done => probe.close(() => done())); return port; }
  }
}
type Approved = { port: number; publicHost?: string; node?: string; path?: string };
const MANAGERS = ['systemd', 'launchd'] as const;
async function fixture(t: TestContext, manager: typeof MANAGERS[number], approved: Approved) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'setup-reapprove-'))), home = join(root, 'home'), releases = join(root, 'releases'), workspace = join(home, 'alpacawork');
  mkdirSync(home, { mode: 0o700 });
  // The switch Owner reads the installation of its own process, as the real command does.
  const original = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: join(home, '.config') });
  const env = cleanCliEnv({ PATH: '/synthetic/bin:/usr/bin:/bin', LANG: 'en' }); delete env.SUDO_USER; delete env.SUDO_UID; delete env.LC_ALL; delete env.LC_MESSAGES;
  const store = new InstallationStore(installationPath(env)), request: SetupRequest = { cwd: root, env };
  await initializeInstallation({ ...request, explicit: workspace, detectedAgents: [] }, store);
  mkdirSync(releases, { mode: 0o700 }); await registerInstallation({ ...request, explicit: workspace }, releases, store);
  // One installed release: setup runs from this same version, so nothing but the service can change.
  const release = join(releases, 'a'), control = controlSchemaManifest();
  mkdirSync(join(release, 'apps/backend/dist'), { recursive: true });
  writeFileSync(join(release, 'package.json'), JSON.stringify({ name: 'alpacawork', version: '1.0.0', type: 'module', private: true, alpacawork: { source: 'a', format: 'f1' } }));
  writeFileSync(join(release, 'SOURCE'), 'a\n'); writeFileSync(join(release, 'FORMAT'), 'f1\n');
  writeFileSync(join(release, 'SCHEMA.json'), JSON.stringify({ control, host: [] }));
  writeFileSync(join(release, 'apps/backend/dist/maintenance.js'), `import ${JSON.stringify(new URL('./fixtures/release-maintenance.ts', import.meta.url).href)};`);
  releaseArtifacts(release); point(releases, 'current', release);
  // The approval as an earlier terminal left it, including a Node path this process no longer runs from.
  const node = approved.node ?? NODE;
  const record = store.read()!;
  const installed = { ...record, nodeExecutable: node, service: { port: approved.port, name: 'alpacawork.service',
    publicHost: approved.publicHost ?? null, environmentPath: approved.path ?? servicePath(env) } };
  const definition = serviceDefinition(installed, store.path);
  writeFileSync(store.path, JSON.stringify(installed) + '\n');

  // The real adapter owns the definition file and every decision. Its command only keeps what a manager keeps (loaded,
  // running) and serves the port the definition file on disk names, as the managed backend would.
  const execution = { workspace, schema: control.version, control, host: null, unfinishedRuns: [] as string[], contractUsers: [], unpublishedStops: 0 };
  const saveExecution = () => writeFileSync(join(workspace, 'inspection.json'), JSON.stringify(execution)); saveExecution();
  const native = (value: ServiceDefinition) => manager === 'systemd' ? systemdDefinition(value) : launchdDefinition(value);
  const file = native(definition).path, connection = join(workspace, '.alpacawork/connection.json');
  const commands: string[] = [], failing = new Set<string>();
  // launchd holds a job once bootstrapped. systemd reads a unit file on disk as loaded and keeps a removed one held until
  // daemon-reload, while only `enable` makes it start the unit by itself: `registered` is that fact for both.
  let registered = false, held = false, running = false, starts = 0, server: Server | null = null, served: string | null = null;
  const hooks: { stopped?: () => void } = {};
  const close = async () => { const old = server; server = null; if (old) { old.closeAllConnections(); await new Promise<void>(done => old.close(() => done())); } };
  const stop = () => { running = false; starts++; void close(); hooks.stopped?.(); };
  const start = () => {
    const text = readFileSync(file, 'utf8'), start = ++starts; running = true;
    const port = Number(/"--port" "(\d+)"/.exec(text)?.[1] ?? /<string>--port<\/string><string>(\d+)<\/string>/.exec(text)![1]);
    void close().then(() => {
      if (start !== starts) return;
      const generation = randomUUID(), next = createServer((request, response) => {
        response.setHeader('Connection', 'close'); response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(request.url === '/api/runtime/preflight' ? execution : { ...execution, state: 'accepting', generation }));
      });
      server = next; served = text;
      next.listen(port, '127.0.0.1', () => writeFileSync(connection, JSON.stringify({ url: `http://127.0.0.1:${port}/`, publicUrl: null, generation, runManager: join(release, 'apps/backend/dist/run-manager.js') })));
    });
  };
  const ok = { status: 0, stdout: '', stderr: '' };
  /** Reads answer from the kept state; every other verb is recorded, and fails when the test says the manager refuses it. */
  const changes = (verb: string) => { commands.push(verb); return !failing.has(verb); };
  const command = (program: string, args: string[]) => {
    if (manager === 'systemd') {
      const [verb, ...rest] = args.slice(1), loaded = existsSync(file) || held;
      if (verb === 'show-environment') return ok;
      if (verb === 'show') return { ...ok, stdout: rest.includes('NRestarts') ? '0\n'
        : `LoadState=${loaded ? 'loaded' : 'not-found'}\nActiveState=${running ? 'active' : 'inactive'}\nFragmentPath=${loaded ? file : ''}\n` };
      if (verb === 'is-enabled') return { ...ok, status: registered && existsSync(file) ? 0 : 1 };
      if (!changes(verb!)) return { ...ok, status: 1 };
      if (verb === 'daemon-reload') held = existsSync(file); else if (verb === 'enable') registered = held = true; else if (verb === 'disable') registered = false;
      else if (verb === 'stop') stop(); else if (verb === 'restart') start(); else throw new Error(`Unexpected systemctl ${args.join(' ')}`);
      return ok;
    }
    if (program === 'ps') return running ? { ...ok, stdout: 'Tue Nov 10 12:00:00 2026\n' } : { ...ok, status: 1 };
    const [verb, target] = args;
    if (verb === 'print') return target === `gui/${process.getuid!()}` ? ok : registered ? { ...ok, stdout: `path = ${file}\n${running ? 'pid = 4242\n' : ''}` } : { status: 113, stdout: '', stderr: 'Could not find service' };
    if (!changes(verb!)) return { ...ok, status: 1 };
    if (verb === 'bootstrap') { registered = true; start(); } else if (verb === 'bootout') { registered = false; stop(); } else if (verb === 'kickstart') start();
    else throw new Error(`Unexpected launchctl ${args.join(' ')}`);
    return ok;
  };
  const previous = platform.service;
  platform.service = manager === 'systemd' ? createSystemdService(command) : createLaunchdService(command);
  t.after(async () => {
    try { await preserveTestFailure(t, root, { databaseRoot: workspace, diagnostics: () => ({ commands, registered, held, running, definition: existsSync(file) ? readFileSync(file, 'utf8') : null, record: readFileSync(store.path, 'utf8') }) }); }
    finally { platform.service = previous; hooks.stopped = undefined; stop(); await close(); Object.assign(process.env, original); rmSync(root, { recursive: true, force: true }); }
  });
  const generation = () => existsSync(connection) ? JSON.parse(readFileSync(connection, 'utf8')).generation as string : null;
  /** Start what the record approves, as the manager did before this terminal opened. */
  const serve = async () => {
    const before = generation(); assert(platform.service.register(definition)); assert(platform.service.restart(definition));
    for (let n = 0; n < 500 && generation() === before; n++) await delay(10);
    assert.notEqual(generation(), before, 'the stand-in backend wrote its connection'); commands.length = 0;
  };
  const lines: string[] = [];
  /** Setup run from the package whose release folder is `source`; the installed one is `a`. */
  const setup = async (options: Partial<Pick<SetupRequest, 'port' | 'publicHost' | 'mcp' | 'confirmPrivateTailnet' | 'explicit' | 'yes'>> = {}, answer: string | null = '\r', lang = 'en', source = 'a') => {
    const terminal = installationTerminal(answer, !options.yes); terminal.value.env = { ...env, LANG: lang }; lines.length = 0;
    const result = await runSetup({ ...request, ...options, env: terminal.value.env, artifact: { facts: { name: 'alpacawork', version: '1.0.0', source, edition: 'production', targets: [] },
      publish: async () => { throw new Error('A changed fact publishes no release'); } } }, line => lines.push(line), terminal.value);
    return { result, shown: terminal.shown(), lines, prompts: (terminal.shown().match(/\[Y\/n\]/g) ?? []).length };
  };
  const recorded = () => { const value = store.read()!; assert(value.service); return serviceDefinition(value, store.path); };
  /** The manager holds, starts by itself and runs exactly the definition the record approves. */
  const assertServing = () => {
    const text = native(recorded()).text;
    assert.equal(readFileSync(file, 'utf8'), text, 'the definition file is the recorded definition'); assert(registered, 'the manager starts the service by itself');
    assert(running); assert.equal(served, text, 'the running backend was started from it');
  };
  return { root, home, env, releases, workspace, store, definition, execution, saveExecution, commands, failing, hooks, setup, lines, serve, generation, recorded, assertServing, file, command,
    registration: () => ({ definition: existsSync(file) ? readFileSync(file, 'utf8') : null, registered, running }), native, place: { releases, workspace, service: definition.name, say: () => {} } };
}
const ready = async (url: string) => (await (await fetch(new URL('/api/runtime/readiness', url), { headers: { Connection: 'close' } })).json()) as { state: string; generation: string };
const listening = (port: number) => new Promise<() => Promise<void>>((done, reject) => {
  const other = createSocket(); other.once('error', reject);
  other.listen(port, '127.0.0.1', () => done(() => new Promise<void>(closed => other.close(() => closed()))));
});
const artifact = (source: string) => ({ facts: { name: 'alpacawork', version: '1.0.1', source, edition: 'production' as const, targets: [] }, publish: async () => { throw new Error('Refused before publication'); } });
const savedSetup = (f: { releases: string; workspace: string; env: NodeJS.ProcessEnv }) => saveSetupSkills(f.releases, newSetupSkills(f.workspace, installationSkillsRoot(f.env),
  { version: 2, operationId: randomUUID(), release: join(f.releases, 'a'), intent: { place: ['alpacawork'], remove: [] } }));

test('setup refuses Funnel, then records and shows the powers granted by private MCP access', async t => {
  const port = await freePort();
  const f = await fixture(t, 'systemd', { port });
  await f.serve();
  const bin = join(f.home, 'bin');
  mkdirSync(bin);
  f.env.PATH = bin + ':/usr/bin:/bin';
  const tailscale = join(bin, 'tailscale');
  const status = (value: object) => writeFileSync(tailscale, '#!/bin/sh\nprintf "%s\\n" \'' + JSON.stringify(value) + '\'\n', { mode: 0o700 });
  const address = 'node.test.ts.net:443';
  const web = { [address]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } };
  status({ Web: web, AllowFunnel: { [address]: true } });
  const original = f.generation();
  await assert.rejects(f.setup({ mcp: true, confirmPrivateTailnet: true, yes: true }), /Tailscale Funnel forwards/);
  assert.equal(f.generation(), original);
  assert.equal(serviceMcp(f.recorded()), false);
  status({ Web: web });
  const enabled = await f.setup({ mcp: true });
  assert.ok(enabled.result.installed);
  assert.match(enabled.shown, /save settings that affect future AI launches/);
  assert.match(enabled.shown, /run an executable immediately to inspect it/);
  assert.equal(serviceMcp(f.recorded()), true);
  f.assertServing();
  const disabled = await f.setup({ mcp: false });
  assert.ok(disabled.result.installed);
  assert.equal(serviceMcp(f.recorded()), false);
  f.assertServing();
});

for (const manager of MANAGERS) {
  test(`${manager}: setup adds a public host to an installation made without one and ends there; a later plain setup keeps it`, async t => {
    const f = await fixture(t, manager, { port: await freePort() }); await f.serve();
    const before = f.generation(), port = servicePort(f.definition);
    // Even from another package version there is one confirmation, and setup ends after the change.
    const added = await f.setup({ publicHost: 'pc.tailnet.example' }, '\r', 'en', 'b');
    assert.deepEqual(added.result, { installed: true, operation: 'change', url: `http://127.0.0.1:${port}/`, port, version: '1.0.0' }); assert.equal(added.prompts, 1);
    assert(added.shown.includes('pc.tailnet.example'));
    assert(!added.shown.includes('alpacawork/.agents/skills'), 'a service change installs no skills');
    assert.equal(servicePublicHost(f.recorded()), 'pc.tailnet.example'); assert.equal(servicePort(f.recorded()), port);
    f.assertServing(); assert(f.registration().definition!.includes('pc.tailnet.example'));
    assert.notEqual((await ready(`http://127.0.0.1:${port}/`)).generation, before, 'the service restarted with the new definition');
    assert.match(added.lines.join('\n'), new RegExp(`Installation changed\\. Ready on port ${port}`));
    // Same values, named or omitted: nothing to approve, so setup shows its ordinary screen and changes nothing when declined.
    const record = readFileSync(f.store.path, 'utf8'), registration = f.registration(); f.commands.length = 0;
    for (const options of [{}, { publicHost: 'pc.tailnet.example', port }]) {
      const again = await f.setup(options, '\x03');
      assert.deepEqual(again.result, { installed: false, reason: 'cancelled' });
      assert(!again.shown.includes(' → '), 'unchanged service facts need no replacement approval');
      assert(again.shown.includes('pc.tailnet.example')); assert(again.shown.includes(String(port)), 'the recorded port and public host stay visible');
    }
    assert.equal(readFileSync(f.store.path, 'utf8'), record); assert.deepEqual(f.registration(), registration); assert.deepEqual(f.commands, []);
  });

  test(`${manager}: another terminal PATH alone is no change: setup asks nothing about it and keeps the recorded definition`, async t => {
    const f = await fixture(t, manager, { port: await freePort() }); await f.serve();
    const record = readFileSync(f.store.path, 'utf8'), registration = f.registration(), generation = f.generation();
    f.env.PATH = `/ide-terminal/bin:${f.env.PATH}`;
    const plain = await f.setup({}, '\x03');
    assert.deepEqual(plain.result, { installed: false, reason: 'cancelled' }); assert.equal(plain.prompts, 1);
    assert.doesNotMatch(plain.shown, /ide-terminal/);
    assert.equal(readFileSync(f.store.path, 'utf8'), record); assert.deepEqual(f.commands, []); assert.deepEqual(f.registration(), registration); assert.equal(f.generation(), generation);
    // With a change the person does confirm, the definition takes this terminal's PATH and shows it.
    const hosted = await f.setup({ publicHost: 'pc.tailnet.example' });
    assert.equal(hosted.result.installed, true); assert(hosted.shown.includes(`${f.definition.environment.PATH} → ${servicePath(f.env)}`));
    assert.equal(f.recorded().environment.PATH, servicePath(f.env)); f.assertServing();
  });

  test(`${manager}: setup re-approves a changed Node path; managed start and deploy refuse it before and read it after`, async t => {
    const old = '/opt/synthetic-node/22.1.0/bin/node', oldPath = `${dirname(old)}:/synthetic/bin:/usr/bin:/bin`;
    const f = await fixture(t, manager, { port: await freePort(), node: old, path: oldPath });
    mkdirSync(join(f.home, '.agents/skills'), { recursive: true });
    // The managed start and a real deploy both refuse and name the fix. The service of the removed Node is registered and does not run.
    const managed = { ...f.env, ALPACAWORK_MANAGED_RELEASES: f.releases }, fix = new RegExp(`approved ${old}; run alpacawork setup again from a terminal`);
    assert.throws(() => managedInstallation(managed), fix);
    const deploy = () => applyDeployArtifact({ cwd: f.root, env: f.env }, artifact('b'), () => {}, installationTerminal('\r').value);
    await assert.rejects(deploy(), fix);
    assert(platform.service.register(f.definition)); assert(platform.service.stop(f.definition));
    const registration = f.registration(); f.commands.length = 0;
    for (const lang of ['ja', 'en']) {
      const declined = await f.setup({}, '\x03', lang);
      assert.deepEqual(declined.result, { installed: false, reason: 'cancelled' });
      assert(declined.shown.includes('[Y/n]'));
      assert(declined.shown.includes(`${old} → ${NODE}`));
      assert(declined.shown.includes(`${oldPath} → ${servicePath(f.env)}`));
    }
    assert.equal(f.recorded().executable, old); assert.deepEqual(f.registration(), registration); assert.deepEqual(f.commands, [], 'declining reaches no service operation');
    const approved = await f.setup();
    assert.equal(approved.result.installed, true, approved.lines.join('\n'));
    assert.equal(f.recorded().executable, NODE); assert.equal(f.store.read()!.nodeExecutable, NODE); assert.equal(f.recorded().environment.PATH, servicePath(f.env));
    assert.equal(servicePort(f.recorded()), servicePort(f.definition), 'an omitted port keeps the recorded one');
    f.assertServing(); assert(!f.registration().definition!.includes(old), 'the definition file no longer names the removed Node');
    assert.deepEqual(serviceDefinition(managedInstallation(managed)!, f.store.path), f.recorded());
    // Deploy now reads the installation and goes on to its own next refusal, this fixture's missing skill receipt.
    await assert.rejects(deploy(), /Managed skills are not installed; finish setup first/);
  });

  test(`${manager}: setup moves the port only to a free one and only when no Run remains, also when a Run appears as serve stops`, async t => {
    const f = await fixture(t, manager, { port: await freePort() }); await f.serve();
    const old = servicePort(f.definition), next = await freePort(), record = readFileSync(f.store.path, 'utf8'), generation = f.generation();
    // A Run keeps the origin it was launched with. A running serve refuses before the terminal asks, without a service operation.
    f.execution.unfinishedRuns = ['R7', 'R9']; f.saveExecution();
    await assert.rejects(f.setup({ port: next }, null), /port cannot change now \(2 Runs remaining\); retry after natural completion/);
    assert.deepEqual(f.commands, []); assert.equal(f.generation(), generation);
    // Another fact restarts the service as a deploy does, with those Runs still unfinished.
    const hosted = await f.setup({ publicHost: 'pc.tailnet.example' });
    assert.equal(hosted.result.installed, true, hosted.lines.join('\n')); assert.equal(servicePort(f.recorded()), old); f.assertServing();
    const withHost = readFileSync(f.store.path, 'utf8');
    // A stopped serve is read only after Enter, by its release's stopped reader, and is refused the same way.
    assert(platform.service.stop(f.recorded())); f.commands.length = 0;
    assert.deepEqual(await f.setup({ port: next }, '\x03').then(run => run.result), { installed: false, reason: 'cancelled' });
    assert.equal(existsSync(join(f.workspace, 'maintenance.jsonl')), false, 'nothing is read through the writer before Enter');
    await assert.rejects(f.setup({ port: next }), /port cannot change now \(2 Runs remaining\)/);
    assert.equal(JSON.parse(readFileSync(join(f.workspace, 'maintenance.jsonl'), 'utf8').trim()).mode, 'inspect');
    assert.equal(readFileSync(f.store.path, 'utf8'), withHost); assert.equal(f.registration().definition, f.native(f.recorded()).text); assert.deepEqual(f.commands, []);
    f.execution.unfinishedRuns = []; f.saveExecution();
    assert(platform.service.register(f.recorded())); assert(platform.service.restart(f.recorded()));
    for (let n = 0; n < 500 && f.generation() === generation; n++) await delay(10);
    // The new port is taken by another process: refused before the terminal asks, nothing stopped.
    const release = await listening(next), serving = f.generation(); f.commands.length = 0;
    try { await assert.rejects(f.setup({ port: next }, null), new RegExp(`Port ${next} cannot be used \\(another process is using it\\); choose another --port\\. Nothing was changed`)); }
    finally { await release(); }
    assert.equal(readFileSync(f.store.path, 'utf8'), withHost); assert.deepEqual(f.commands, []); assert.equal(f.generation(), serving);
    // A Run launched after the last check and before the stop is found once serve has stopped: the old service comes back.
    f.hooks.stopped = () => { f.execution.unfinishedRuns = ['R11']; f.saveExecution(); };
    await assert.rejects(f.setup({ port: next }), /port cannot change now \(1 Runs remaining\).*The recorded service is back as it was\. Nothing was changed/s);
    f.hooks.stopped = undefined;
    assert.equal(readFileSync(f.store.path, 'utf8'), withHost); assert.doesNotMatch(f.lines.join('\n'), /Keep the installation record|could not start/);
    for (let n = 0; n < 500 && f.generation() === serving; n++) await delay(10);
    f.assertServing(); assert.equal((await ready(`http://127.0.0.1:${old}/`)).state, 'accepting'); assert.notEqual(f.generation(), serving, 'the old service was started again');
    f.execution.unfinishedRuns = []; f.saveExecution();
    const moved = await f.setup({ port: next, yes: true });
    assert.equal(moved.prompts, 0, 'yes applies the change without reading non-terminal input');
    assert.deepEqual(moved.result, { installed: true, operation: 'change', url: `http://127.0.0.1:${next}/`, port: next, version: '1.0.0' });
    assert.match(moved.shown, new RegExp(`${old} → ${next}`));
    assert.equal(servicePort(f.recorded()), next); assert.equal(readInstallationService({ workspace: f.workspace, releases: f.releases, env: f.env }).port, next);
    f.assertServing(); assert.equal((await ready(`http://127.0.0.1:${next}/`)).state, 'accepting');
    await assert.rejects(fetch(`http://127.0.0.1:${old}/api/runtime/readiness`), 'the old port is closed');
  });

  test(`${manager}: declining the confirmation changes nothing`, async t => {
    const f = await fixture(t, manager, { port: await freePort() }); await f.serve();
    const record = readFileSync(f.store.path, 'utf8'), registration = f.registration(), generation = f.generation(), next = await freePort();
    for (const answer of ['\x03', 'yes\r', null]) {
      const terminal = await f.setup({ port: next, publicHost: 'pc.tailnet.example' }, answer);
      assert.equal(terminal.result.installed, false); assert(terminal.shown.includes(`${servicePort(f.definition)} → ${next}`));
    }
    f.env.SUDO_USER = 'synthetic-user';
    try { await assert.rejects(f.setup({ yes: true, port: next }), { reason: { kind: 'installation_sudo_refused' } }); }
    finally { delete f.env.SUDO_USER; }
    assert.equal(readFileSync(f.store.path, 'utf8'), record); assert.deepEqual(f.commands, []); assert.deepEqual(f.registration(), registration);
    assert.equal((await ready(`http://127.0.0.1:${servicePort(f.definition)}/`)).generation, generation, 'the same service keeps running');
  });

  test(`${manager}: a change interrupted at any step is finished by the next setup`, async t => {
    const f = await fixture(t, manager, { port: await freePort() }); await f.serve();
    const drop = (definition = f.recorded()) => { assert(platform.service.stop(definition)); assert(platform.service.unregister(definition)); f.commands.length = 0; };
    // Stopped after the old registration was removed and before the record changed: the old approval stands, and the same command shows the same change.
    drop();
    assert.deepEqual(f.registration(), { definition: null, registered: false, running: false });
    assert.deepEqual(readInstallationService({ workspace: f.workspace, releases: f.releases, env: f.env }).definition, f.definition);
    const resumed = await f.setup({ publicHost: 'pc.tailnet.example' });
    assert.equal(resumed.result.installed, true, resumed.lines.join('\n')); assert(resumed.shown.includes('pc.tailnet.example')); f.assertServing();
    // Stopped after the record changed and before the new definition was written: nothing differs any more, and the manager holds nothing.
    drop();
    const registeredAgain = await f.setup({ publicHost: 'pc.tailnet.example' });
    assert.equal(registeredAgain.result.installed, true, registeredAgain.lines.join('\n')); assert.equal(registeredAgain.prompts, 1);
    assert(!registeredAgain.shown.includes(' → ')); f.assertServing();
    // Stopped after the new definition file was written and before the manager was told to start it by itself:
    // the file is there, which systemd reads as loaded, and still setup registers it.
    drop(); writeFileSync(f.file, f.native(f.recorded()).text);
    assert.equal(platform.service.observe(f.recorded()).state, 'matching'); assert.equal(platform.service.known(f.recorded().name), false);
    const enabled = await f.setup();
    assert.equal(enabled.result.installed, true, enabled.lines.join('\n')); assert(!enabled.shown.includes(' → ')); f.assertServing();
  });

  test(`${manager}: a failure says truthfully what state it left, and the next setup or the old port recovers`, async t => {
    const f = await fixture(t, manager, { port: await freePort() }); await f.serve();
    const old = servicePort(f.definition), next = await freePort(), record = readFileSync(f.store.path, 'utf8'), generation = f.generation();
    // The old service stops but cannot be removed: it is started again, nothing changed, and this is no start failure.
    f.failing.add(manager === 'systemd' ? 'disable' : 'bootout');
    await assert.rejects(f.setup({ port: next }), /did not stop or its definition could not be removed\. The recorded service is back as it was\. Nothing was changed/);
    f.failing.clear();
    assert.equal(readFileSync(f.store.path, 'utf8'), record); assert.doesNotMatch(f.lines.join('\n'), /Keep the installation record|could not start/);
    for (let n = 0; n < 500 && f.generation() === generation; n++) await delay(10);
    f.assertServing(); assert.equal((await ready(`http://127.0.0.1:${old}/`)).state, 'accepting');
    // The manager refuses the new registration after the record changed: stopped and unregistered, with the way back named.
    f.failing.add(manager === 'systemd' ? 'enable' : 'bootstrap');
    const failed = await f.setup({ port: next }).then(() => null, error => error as Error);
    assert.equal(failed?.message, 'Setup did not complete');
    const said = f.lines.join('\n');
    assert.match(said, /Keep the installation record and data\./); assert.match(said, /Reason: The service did not become ready with the approved definition; it is stopped and unregistered/);
    assert.match(said, /run the same alpacawork setup again/); assert(said.includes(`To go back to the old port: alpacawork setup --port ${old}`));
    assert.doesNotMatch(said, /kickstart|systemctl --user start /, 'no manual start is advised for a service the manager no longer holds');
    assert.equal(servicePort(f.recorded()), next, 'the record holds the new approval');
    assert.deepEqual(f.registration(), { definition: null, registered: false, running: false }, 'the manager holds the new definition or none, never the old one');
    assert.deepEqual(readInstallationService({ workspace: f.workspace, releases: f.releases, env: f.env }).definition, f.recorded(), 'no reader refuses the new record');
    // The same setup again registers what the manager does not hold; with the manager still refusing it fails the same way.
    const again = await f.setup({ port: next }).then(() => null, error => error as Error);
    assert.equal(again?.message, 'Setup did not complete'); assert.deepEqual(f.registration(), { definition: null, registered: false, running: false });
    f.failing.clear();
    // The named way back works whatever the manager's reason was.
    const back = await f.setup({ port: old });
    assert.deepEqual(back.result, { installed: true, operation: 'change', url: `http://127.0.0.1:${old}/`, port: old, version: '1.0.0' });
    assert.match(back.shown, new RegExp(`${next} → ${old}`)); f.assertServing();
  });

  test(`${manager}: while a switch, a database recovery or an unfinished setup is pending, setup changes nothing and says how to finish first`, async t => {
    const f = await fixture(t, manager, { port: await freePort() }); await f.serve();
    const record = readFileSync(f.store.path, 'utf8'), registration = f.registration(), generation = f.generation(), next = await freePort(), release = join(f.releases, 'a');
    // Unfinished Runs too: a pending switch must not open a way around the port rule.
    f.execution.unfinishedRuns = ['R7']; f.saveExecution();
    const unchanged = async () => {
      assert.equal(readFileSync(f.store.path, 'utf8'), record); assert.deepEqual(f.commands, [], 'no service command'); assert.deepEqual(f.registration(), registration);
      assert.equal((await ready(`http://127.0.0.1:${servicePort(f.definition)}/`)).generation, generation, 'the same service keeps running');
    };
    const journal = { version: JOURNAL_VERSION, skillsWriteStarted: false, opId: randomUUID(), workspace: f.workspace, old: release, target: release, previous: null, schema: null };
    for (const phase of ['prepared', 'target_selected', 'target_ready', 'restoring_old'] as const) {
      saveJournal(f.place, { ...journal, phase });
      for (const options of [{ port: next }, { publicHost: 'pc.tailnet.example' }])
        await assert.rejects(f.setup(options, null), /release switch is in progress.*run the alpacawork deploy or setup that started it again.*Nothing was changed/s, phase);
      await unchanged();
    }
    saveJournal(f.place, { ...journal, phase: 'recovery_intent',
      recovery: { id: randomUUID(), backup: 'not-opened', source: release, reader: release, target: release, replaced: [], failure: 'pending recovery fixture' } });
    await assert.rejects(f.setup({ publicHost: 'pc.tailnet.example' }, null), /database recovery is in progress.*resume the same recovery.*Nothing was changed/s);
    await unchanged();
    saveJournal(f.place, { ...journal, phase: 'committed' }); savedSetup(f);
    await assert.rejects(f.setup({ port: next }, null), /saved setup is in progress.*run alpacawork setup without changed options to resume it.*Nothing was changed/s);
    await unchanged();
    // With nothing to change, the pending setup resumes on its ordinary screen as before.
    const resumed = await f.setup({}, '\x03');
    assert.deepEqual(resumed.result, { installed: false, reason: 'cancelled' }); await unchanged();
  });

  test(`${manager}: Node.js moved while a switch is pending: setup changes nothing and names the Node.js to put back`, async t => {
    const old = '/opt/synthetic-node/22.1.0/bin/node', release = 'a';
    const f = await fixture(t, manager, { port: await freePort(), node: old, path: `${dirname(old)}:/usr/bin:/bin` });
    assert(platform.service.register(f.definition)); assert(platform.service.stop(f.definition));
    const record = readFileSync(f.store.path, 'utf8'), registration = f.registration(); f.commands.length = 0;
    saveJournal(f.place, { version: JOURNAL_VERSION, skillsWriteStarted: false, opId: randomUUID(), workspace: f.workspace, old: join(f.releases, release), target: join(f.releases, release), previous: null, phase: 'target_ready', schema: null });
    await assert.rejects(f.setup({}, null), error => {
      assert(error instanceof Error); assert.match(error.message, /A release switch is in progress and can finish only under the Node\.js it was approved with/);
      assert(error.message.includes(`Install Node.js at ${old} again`)); assert(error.message.includes(`Node.js is now ${NODE}`)); assert.match(error.message, /Nothing was changed$/); return true;
    });
    assert.equal(readFileSync(f.store.path, 'utf8'), record); assert.deepEqual(f.commands, []); assert.deepEqual(f.registration(), registration);
  });
}

test('systemd: a manager that still holds the removed unit is named with its manual fix, and setup goes on after it', async t => {
  const f = await fixture(t, 'systemd', { port: await freePort() }); await f.serve();
  const record = readFileSync(f.store.path, 'utf8');
  // daemon-reload fails right after the unit file was removed: the old unit cannot be put back while the manager holds it.
  f.failing.add('daemon-reload');
  await assert.rejects(f.setup({ publicHost: 'pc.tailnet.example' }), /The installation record is unchanged, but the recorded service is stopped now and could not be put back; run alpacawork setup again/);
  f.failing.clear();
  assert.equal(readFileSync(f.store.path, 'utf8'), record); assert.doesNotMatch(f.lines.join('\n'), /Keep the installation record|could not start/);
  assert.equal(platform.service.observe(f.definition).state, 'conflict');
  await assert.rejects(f.setup({ publicHost: 'pc.tailnet.example' }, null), /definition conflicts.*If its definition file no longer exists.*systemctl --user daemon-reload/s);
  // The person runs the named command; the next setup shows the same change and finishes it.
  assert.equal(f.command('systemctl', ['--user', 'daemon-reload']).status, 0);
  const finished = await f.setup({ publicHost: 'pc.tailnet.example' });
  assert.equal(finished.result.installed, true, finished.lines.join('\n')); assert.equal(servicePublicHost(f.recorded()), 'pc.tailnet.example'); f.assertServing();
});

test('deploy approves no changed fact: it names setup, and resumes a saved setup with the recorded definition only', async t => {
  const f = await fixture(t, 'systemd', { port: await freePort() }), record = readFileSync(f.store.path, 'utf8');
  for (const option of [{ port: await freePort() }, { publicHost: 'pc.tailnet.example' }])
    await assert.rejects(applyDeployArtifact({ cwd: f.root, env: f.env, ...option }, artifact('b'), () => {}, installationTerminal('\r').value),
      /differs from the recorded installation; run alpacawork setup --port\/--public-host from a terminal to change it/);
  // Deploy routes a saved setup to its resume. From another terminal PATH it shows the recorded definition and no change to approve.
  savedSetup(f);
  const terminal = installationTerminal('\x03'), elsewhere = { ...f.env, PATH: '/another-terminal/bin:/usr/bin:/bin' };
  assert.deepEqual(await applyDeployArtifact({ cwd: f.root, env: elsewhere }, artifact('a'), () => {}, terminal.value), { installed: false, reason: 'cancelled' });
  assert.doesNotMatch(terminal.shown(), /another-terminal/);
  await assert.rejects(applyDeployArtifact({ cwd: f.root, env: elsewhere, port: await freePort() }, artifact('a'), () => {}, installationTerminal('\r').value), /run alpacawork setup --port\/--public-host from a terminal to change it/);
  assert.equal(readFileSync(f.store.path, 'utf8'), record); assert.deepEqual(f.commands, []);
});

test('deploy resuming a saved setup under a moved Node.js is refused before any prompt and names setup', async t => {
  const old = '/opt/synthetic-node/22.1.0/bin/node';
  const f = await fixture(t, 'systemd', { port: await freePort(), node: old, path: `${dirname(old)}:/usr/bin:/bin` }), record = readFileSync(f.store.path, 'utf8');
  savedSetup(f);
  const terminal = installationTerminal('\r');
  await assert.rejects(applyDeployArtifact({ cwd: f.root, env: f.env }, artifact('a'), () => {}, terminal.value), new RegExp(`approved ${old}; run alpacawork setup again from a terminal`));
  assert.equal(terminal.shown(), ''); assert.equal(readFileSync(f.store.path, 'utf8'), record); assert.deepEqual(f.commands, []);
});

test('setup refuses another data folder and says it cannot be changed', async t => {
  const f = await fixture(t, 'systemd', { port: await freePort() }), record = readFileSync(f.store.path, 'utf8');
  await assert.rejects(f.setup({ explicit: join(f.root, 'moved-data') }), error => {
    assert(error instanceof Error); assert(error.message.includes(`differs from the installation record ${f.workspace}`));
    assert.match(error.message, /data folder of an installation cannot be changed/); return true;
  });
  assert.equal(readFileSync(f.store.path, 'utf8'), record); assert.deepEqual(f.commands, []); assert.equal(existsSync(join(f.root, 'moved-data')), false);
});
