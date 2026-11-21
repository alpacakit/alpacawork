/** Uninstall over a synthetic HOME and a stand-in service manager. Nothing here reaches the real HOME, launchd or systemd. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { platform, type ServiceDefinition, type ServiceObservation } from '@alpacawork/core';
import { runUninstall, serviceRemovalCommands, defaultServiceDefinition } from '@alpacawork/backend/test-dist/installation/uninstall.js';
import { holdReleases } from '@alpacawork/backend/test-dist/release/layout.js';
import { createSystemdService, systemdDefinition } from '../packages/core/dist/platform/systemd-service.js';
import { createLaunchdService, launchdDefinition } from '../packages/core/dist/platform/launchd-service.js';
import { initializeInstallation, registerInstallation, inspectInstallationService, recordInstallationService } from '@alpacawork/backend/test-dist/installation/setup.js';
import { InstallationStore, installationPath } from '@alpacawork/backend/test-dist/installation/store.js';
import { ManagedSkillsWriter } from '@alpacawork/backend/test-dist/installation/skills.js';
import { inspectAgentSkillLinks, syncAgentSkillLinks } from '@alpacawork/backend/test-dist/installation/agent-skill-links.js';
import { cleanCliEnv } from './helpers/http-cli.ts';
import { installationTerminal } from './helpers/installation-terminal.ts';
import { saveJournal, type SwitchJournal } from '@alpacawork/backend/test-dist/release/journal.js';

const snapshot = (root: string) => readdirSync(root, { recursive: true, encoding: 'utf8' }).sort().map(name => {
  const path = join(root, name), info = lstatSync(path);
  return { name, mode: info.mode, content: info.isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : info.isSymbolicLink() ? readlinkSync(path) : null };
});
const put = (path: string, bytes = 'synthetic\n') => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };

/** An empty HOME where every location uninstall derives from the environment stays inside the test's own folder. */
function fixture(t: TestContext, lang = 'en') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'uninstall-'))), home = join(root, 'home'); mkdirSync(home, { mode: 0o700 });
  // Installation now checks sign-in; this removal fixture must not discover host providers.
  const env = cleanCliEnv({ HOME: home, PATH: join(root, 'empty-bin'), XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'),
    XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'), LANG: lang, LC_ALL: '', LC_MESSAGES: '' });
  delete env.SUDO_USER; delete env.SUDO_UID;
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) assert(env[key]!.startsWith(home + '/') || env[key] === home);
  // The stand-in keeps what a service manager would: what it reports of the definition, and whether the job is loaded and runs.
  // `conflict` with `loaded: false` is a definition file left on disk that the manager has not loaded.
  const service = { state: 'absent' as ServiceObservation['state'], running: false, loaded: false,
    stopReports: true, unregister: 'removes' as 'removes' | 'refuses' | 'throws after removing',
    calls: [] as { call: string; definition?: ServiceDefinition | string }[] };
  const actual = platform.service;
  platform.service = {
    observe: definition => { service.calls.push({ call: 'observe', definition }); return { state: service.state, running: service.running, registrationStarts: true }; },
    register: () => { throw new Error('Uninstall must not register a service'); },
    start: () => { throw new Error('Uninstall must not start a service'); },
    restart: () => { throw new Error('Uninstall must not restart a service'); },
    restarts: () => 0,
    known: name => { service.calls.push({ call: 'known', definition: name }); return service.loaded; },
    stop: definition => { service.calls.push({ call: 'stop', definition }); service.running = false; service.loaded = false; return service.stopReports; },
    unregister: definition => {
      service.calls.push({ call: 'unregister', definition });
      if (service.unregister === 'refuses' || service.state !== 'matching' || service.running) return false;
      service.state = 'absent';
      if (service.unregister === 'throws after removing') throw new Error('synthetic fault after the definition was removed');
      return true;
    },
  };
  t.after(() => {
    platform.service = actual;
    // A test that locked a folder to make removal fail may have ended before unlocking it.
    for (const name of existsSync(root) ? readdirSync(root, { recursive: true, encoding: 'utf8' }) : []) {
      const info = lstatSync(join(root, name), { throwIfNoEntry: false });
      if (info?.isDirectory()) chmodSync(join(root, name), 0o700);
    }
    rmSync(root, { recursive: true, force: true });
  });
  const paths = { config: join(home, '.config/alpacawork'), record: join(home, '.config/alpacawork/installation.json'),
    state: join(home, '.local/state/alpacawork'), share: join(home, '.local/share/alpacawork'), releases: join(home, '.local/share/alpacawork/releases'),
    skills: join(home, '.agents/skills'), receipt: join(home, '.agents/skills/.alpacawork'), linked: ['.claude/skills'].map(folder => join(home, folder)), workspace: join(home, 'alpacawork') };
  type Overrides = { env?: NodeJS.ProcessEnv; tty?: boolean; explicit?: string; yes?: boolean; beforeAnswer?: () => Promise<unknown> | unknown };
  async function uninstall(answer: string | null = '\r', overrides: Overrides = {}) {
    const terminal = installationTerminal(answer, overrides.tty ?? true); terminal.value.env = overrides.env ?? env;
    if (overrides.beforeAnswer) {
      // The person reads the screen for a while: whatever happens in between happens before their Enter.
      const output = terminal.value.output as unknown as { write: (value: string, callback?: (error?: Error) => void) => boolean }, write = output.write;
      output.write = (value, callback) => {
        if (value.includes('Enter to start')) void Promise.resolve(overrides.beforeAnswer!()).then(() => write(value, callback)); else write(value, callback);
        return true;
      };
    }
    const said: string[] = [];
    const outcome = await runUninstall({ env: overrides.env ?? env, explicit: overrides.explicit, yes: overrides.yes }, line => said.push(line), terminal.value)
      .then(result => ({ result, error: null }), (error: Error) => ({ result: null, error }));
    return { ...outcome, said: said.join('\n'), shown: terminal.shown() };
  }
  /** What setup leaves on a PC, made by the same Owners setup uses; only the service manager is the stand-in. */
  async function install(workspace = paths.workspace, releases = paths.releases) {
    const request = { cwd: root, env, explicit: workspace }, store = new InstallationStore(installationPath(env));
    await initializeInstallation({ ...request, detectedAgents: [] }, store);
    put(join(workspace, 'notes/keep.txt'), 'the person\'s own file in the data folder\n');
    mkdirSync(releases, { recursive: true, mode: 0o700 });
    await registerInstallation(request, releases, store);
    const definition = await inspectInstallationService(realpathSync(releases), workspace, env);
    await recordInstallationService(realpathSync(releases), workspace, definition, env);
    service.state = 'matching'; service.running = true; service.loaded = true;
    const release = join(releases, 'a'.repeat(40));
    put(join(release, 'SOURCE'), 'a'.repeat(40) + '\n'); put(join(release, 'package.json'), JSON.stringify({ name: 'alpacawork', version: '1.2.3' }));
    for (const name of ['alpacawork', 'alpacawork-majority']) put(join(release, 'skills', name, 'SKILL.md'), `# ${name}\n`);
    put(join(release, 'apps/backend/dist/backend.js'), '// synthetic\n');
    symlinkSync('a'.repeat(40), join(releases, 'current')); put(join(releases, 'setup-skills.json'), '{}');
    put(join(releases, 'switch.json'), JSON.stringify({ version: 4, skillsWriteStarted: false, opId: randomUUID(), workspace, old: null,
      target: release, previous: null, phase: 'committed', schema: null }));
    // The rest of what the release Owners keep in a releases folder.
    put(join(releases, '.updates/state.json'), '{}'); put(join(releases, '.release-metadata', 'a'.repeat(40) + '.json'), '{}');
    put(join(releases, 'backups', randomUUID(), 'backup.json'), '{}'); put(join(releases, 'recovery-evidence', randomUUID(), 'recovery.json'), '{}');
    put(join(releases, '.stage-aaaaaaaaaaaa-x1/image/file'), 'left by an interrupted publication\n');
    await new ManagedSkillsWriter({ root: paths.skills }).install({ version: 2, operationId: randomUUID(), release,
      intent: { place: ['alpacawork', 'alpacawork-majority'], remove: [] } });
    put(join(paths.skills, 'alpacawork/SKILL.md'), '# edited by the person after installation\n');
    for (const folder of paths.linked) mkdirSync(folder, { recursive: true });
    syncAgentSkillLinks(paths.skills, { place: ['alpacawork'], remove: [] }, []);
    assert.deepEqual(inspectAgentSkillLinks(paths.skills, ['alpacawork'], []).map(link => [link.path, link.action]), paths.linked.map(folder => [join(folder, 'alpacawork'), 'keep']));
    put(join(paths.config, 'telemetry.json'), '{}'); put(join(paths.config, 'client.json'), '{}');
    put(join(paths.state, 'telemetry/marks.json'), '{}'); put(join(paths.state, 'write-pins/pin.json'), '{}');
    return { definition, release };
  }
  /** The person's own things beside alpacawork's: none of them is alpacawork's to remove. */
  function ownThings() {
    put(join(paths.skills, 'my-own/SKILL.md'), '# mine\n');
    mkdirSync(join(root, 'elsewhere'));
    for (const folder of paths.linked) { put(join(folder, 'other-tool/SKILL.md'), '# another tool\n'); symlinkSync(join(root, 'elsewhere'), join(folder, 'alpacawork-majority')); }
    return () => {
      assert.equal(readFileSync(join(paths.skills, 'my-own/SKILL.md'), 'utf8'), '# mine\n');
      for (const folder of paths.linked) {
        assert.equal(readFileSync(join(folder, 'other-tool/SKILL.md'), 'utf8'), '# another tool\n');
        assert.equal(readlinkSync(join(folder, 'alpacawork-majority')), join(root, 'elsewhere'), 'a link pointing elsewhere is the person\'s own');
      }
    };
  }
  /** Stands for a Run manager: a process started from a release folder, as serve starts them. */
  async function agent(release: string) {
    const child = spawn(process.execPath, ['-e', 'console.log("started"); setInterval(() => {}, 1000)', join(release, 'apps/backend/dist/run-manager.js')], { stdio: ['ignore', 'pipe', 'inherit'] });
    const end = async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'close'); } };
    t.after(end); await once(child.stdout!, 'data');
    return { pid: child.pid!, end };
  }
  return { root, home, env, service, paths, uninstall, install, ownThings, agent };
}
const calls = (f: ReturnType<typeof fixture>) => f.service.calls.map(item => item.call);
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NOT_STARTED = /Uninstall did not start\. Nothing was changed\./;
const withoutLock = (entries: ReturnType<typeof snapshot>) => entries.filter(entry => !entry.name.endsWith('.release.lock'));

test('uninstall removes what setup placed, the record last, and leaves the data folder and the person\'s own files', async t => {
  const f = fixture(t), { definition } = await f.install(), own = f.ownThings(), data = snapshot(f.paths.workspace);
  const out = await f.uninstall();
  assert.ifError(out.error); assert.deepEqual(out.result, { uninstalled: true });
  // The screen the person approved names everything removed and the one thing kept.
  for (const path of [...f.paths.linked.map(folder => join(folder, 'alpacawork')), join(f.paths.skills, 'alpacawork'), join(f.paths.skills, 'alpacawork-majority'),
    f.paths.receipt, f.paths.state, f.paths.releases, f.paths.config])
    assert.match(out.shown, new RegExp(`Remove +[A-Za-z, -]+ +${literal(path)}( |\\n)`), path);
  assert.match(out.shown, /Remove +Auto-start +(launchd|systemd --user): alpacawork\.service \(stop, then unregister\)/);
  assert.match(out.shown, new RegExp(`Keep +Data +${literal(f.paths.workspace)} \\(your tasks and history; delete it by hand`));
  assert(!out.shown.includes('my-own') && !out.shown.includes('other-tool') && !f.paths.linked.some(folder => out.shown.includes(join(folder, 'alpacawork-majority'))));
  // The service stops before it is unregistered, with the recorded definition, before any file goes.
  assert.deepEqual(calls(f), ['observe', 'stop', 'unregister']);
  for (const item of f.service.calls) assert.deepEqual(item.definition, definition);
  assert.equal(f.service.state, 'absent');
  const removed = out.said.split('\n').filter(line => line.startsWith('Removed: ')).map(line => line.slice('Removed: '.length));
  assert.match(removed[0]!, /alpacawork\.service$/); assert.equal(removed.at(-1), f.paths.config, 'the installation record goes last');
  for (const path of [f.paths.config, f.paths.state, f.paths.share, join(f.paths.skills, 'alpacawork'), join(f.paths.skills, 'alpacawork-majority'),
    f.paths.receipt, ...f.paths.linked.map(folder => join(folder, 'alpacawork'))]) assert.equal(lstatSync(path, { throwIfNoEntry: false }), undefined, path);
  assert.deepEqual(snapshot(f.paths.workspace), data, 'the data folder is byte-for-byte what it was');
  own(); assert.deepEqual(readdirSync(f.paths.skills), ['my-own']);
  assert.match(out.said, new RegExp(`Keep +Data +${literal(f.paths.workspace)}`)); assert.match(out.said, /Remaining step .*: npm uninstall -g alpacawork$/);

  f.service.calls.length = 0;
  const before = snapshot(f.home), again = await f.uninstall();
  assert.deepEqual(again.result, { uninstalled: false, reason: 'nothing_to_remove' }); assert.equal(again.shown, '', 'nothing to approve');
  assert.match(again.said, /No alpacawork installation was found on this PC/); assert.match(again.said, /npm uninstall -g alpacawork$/);
  assert.deepEqual(snapshot(f.home), before); assert.deepEqual(calls(f), ['observe'], 'the default registration is looked for, read-only');
});

test('declining, in either language, changes nothing', async t => {
  const f = fixture(t, 'ja_JP.UTF-8'); await f.install(); f.ownThings();
  const before = snapshot(f.home);
  for (const [answer, reason] of [['\x03', 'cancelled'], [null, 'eof'], ['x', 'invalid_input']] as const) {
    const out = await f.uninstall(answer);
    assert.ifError(out.error); assert.deepEqual(out.result, { uninstalled: false, reason });
    assert.match(out.shown, /alpacawork をこの PC から外します/); assert.match(out.shown, /消す +自動起動 +.*alpacawork\.service（止めてから登録を外す）/);
    assert.match(out.shown, new RegExp(`残す +データ +${literal(f.paths.workspace)}（タスクと履歴。要らなくなったら手で消せます）`));
    assert.match(out.shown, /止めました。何も変えていません。/);
    assert.deepEqual(snapshot(f.home), before);
  }
  assert.deepEqual([...new Set(calls(f))], ['observe'], 'the service manager is only read');
  assert.equal(f.service.running, true);
});

test('journal removal waits for approval and service removal, and rechecks a changed operation before writes', async t => {
  const f = fixture(t), { release } = await f.install();
  const place = { releases: f.paths.releases, workspace: f.paths.workspace };
  const journal: SwitchJournal = { version: 4, skillsWriteStarted: false, opId: randomUUID(), workspace: place.workspace, old: null,
    target: release, previous: null, phase: 'committed', schema: null };
  saveJournal(place, journal);
  const locator = join(place.workspace, '.alpacawork/release-location.json'), before = snapshot(f.home);
  assert.deepEqual((await f.uninstall('x')).result, { uninstalled: false, reason: 'invalid_input' });
  assert.deepEqual(snapshot(f.home), before);
  f.service.unregister = 'refuses';
  const blocked = await f.uninstall();
  assert.match(String(blocked.error), /Uninstall did not complete/);
  assert.equal(existsSync(locator), true, 'a service removal failure keeps both references');
  assert.equal(existsSync(join(place.releases, 'switch.json')), true);
  f.service.unregister = 'removes'; f.service.calls.length = 0;
  const changed = await f.uninstall('\r', { beforeAnswer: () => saveJournal(place, { ...journal, phase: 'old_stopped' }) });
  assert.match(String(changed.error), /unfinished switch journal/);
  assert.deepEqual(calls(f), ['observe'], 'post-approval rejection does not stop or remove the service');
  assert.equal(existsSync(locator), true);
  const snapshotAfterChange = snapshot(f.home);
  const refused = await f.uninstall();
  assert.match(String(refused.error), /unfinished switch journal/); assert.equal(refused.shown, '');
  assert.deepEqual(snapshot(f.home), snapshotAfterChange);
});

// Each point stops a different step; what a second run needs to find the rest must still be there.
for (const point of ['receipt', 'state', 'config'] as const)
  test(`a run that stopped at the ${point} step is finished by running uninstall again`, { skip: process.getuid!() === 0 && 'root removes a read-only folder' }, async t => {
    const f = fixture(t); await f.install(); const own = f.ownThings(), data = snapshot(f.paths.workspace);
    const locked = { receipt: f.paths.receipt, state: join(f.paths.state, 'telemetry'), config: f.paths.config }[point], stopped = { receipt: f.paths.receipt, state: f.paths.state, config: f.paths.config }[point];
    chmodSync(locked, 0o500);
    const first = await f.uninstall();
    assert.match(String(first.error), /Uninstall did not complete/);
    assert.match(first.said, new RegExp(`Uninstall stopped at ${literal(stopped)}: E[A-Z]+`)); assert.match(first.said, /run alpacawork uninstall again; it removes what is left/);
    // The service and the skills go before every one of these points; the record outlives them all.
    assert.equal(f.service.state, 'absent'); assert.equal(existsSync(join(f.paths.skills, 'alpacawork')), false); assert(existsSync(f.paths.record));
    assert.equal(existsSync(join(f.paths.receipt, 'installed.json')), point === 'receipt', 'the receipt outlives the skills it lists');
    assert.equal(existsSync(f.paths.releases), point !== 'config', 'releases go after state and before the record');
    chmodSync(locked, 0o700); f.service.calls.length = 0;
    const second = await f.uninstall();
    assert.ifError(second.error); assert.deepEqual(second.result, { uninstalled: true });
    assert.deepEqual(calls(f), ['observe'], 'an unregistered service is not unregistered twice');
    assert(!second.shown.includes('Auto-start') && !second.shown.includes('Managed skill'));
    for (const path of [f.paths.config, f.paths.state, f.paths.share, f.paths.receipt]) assert.equal(existsSync(path), false, path);
    assert.deepEqual(snapshot(f.paths.workspace), data); own();
  });

test('a service that cannot be removed stops uninstall before any file goes, and says what is true and what to do', async t => {
  const f = fixture(t); await f.install();
  const before = snapshot(f.home), byHand = process.platform === 'darwin' ? /launchctl bootout 'gui\/\d+\/alpacawork\.service'\nrm -f '.*\/Library\/LaunchAgents\/alpacawork\.service\.plist'/
    : /systemctl --user disable --now 'alpacawork\.service'\nrm -f '.*\/\.config\/systemd\/user\/alpacawork\.service'\nsystemctl --user daemon-reload/;
  f.service.state = 'conflict';
  const conflict = await f.uninstall();
  assert.match(String(conflict.error), NOT_STARTED); assert.equal(conflict.shown, '');
  assert.match(conflict.said, /differs from what alpacawork registered/); assert.match(conflict.said, byHand); assert.deepEqual(snapshot(f.home), before);
  // An unreachable manager cannot run the commands either: the person is told where to run uninstall, not what will fail.
  f.service.state = 'unavailable';
  const unavailable = await f.uninstall();
  assert.match(String(unavailable.error), NOT_STARTED); assert.equal(unavailable.shown, ''); assert.match(unavailable.said, /service manager cannot be reached/);
  assert(!/launchctl|systemctl/.test(unavailable.said)); assert.deepEqual(snapshot(f.home), before);

  // Approved, but the registration is still there afterwards: it was first, so nothing else was touched.
  for (const fault of [() => { f.service.unregister = 'refuses'; }, () => { f.service.stopReports = false; }]) {
    f.service.state = 'matching'; f.service.running = true; f.service.loaded = true; fault();
    const left = await f.uninstall();
    assert.match(String(left.error), /Uninstall did not complete/);
    assert.match(left.said, /alpacawork\.service was not fully removed\. The server may be stopped now, but it is still registered to start at login\.\nNothing else was removed\./);
    assert.match(left.said, /To get a working alpacawork back, run alpacawork setup\. To finish removing it, run alpacawork uninstall again\./); assert.match(left.said, byHand);
    assert.deepEqual(withoutLock(snapshot(f.home)), before); assert.equal(f.service.state, 'matching');
    f.service.unregister = 'removes'; f.service.stopReports = true;
  }
  // What counts is what is there afterwards: a fault reported after the registration went is not a registration left behind.
  f.service.unregister = 'throws after removing';
  assert.deepEqual((await f.uninstall()).result, { uninstalled: true }); assert.equal(existsSync(f.paths.config), false); assert.equal(f.service.state, 'absent');
});

test('the commands to paste quote what the record names and never carry a control character', async t => {
  const f = fixture(t);
  assert.match(serviceRemovalCommands('x.service', f.env, 'darwin'), /^launchctl bootout 'gui\/\d+\/x\.service'\nrm -f '/); assert.match(serviceRemovalCommands('x.service', f.env, 'linux'), /^systemctl --user disable --now 'x\.service'\n/);
  for (const host of ['darwin', 'linux']) {
    assert(serviceRemovalCommands('x; rm -rf ~ #', f.env, host).split('\n').every(line => /^[a-z]+ (--user (disable --now|daemon-reload)|bootout|-f)( '[^']*')?$/.test(line)), host);
    const escaped = serviceRemovalCommands('x\x1b[2Jy', f.env, host);
    assert(!escaped.includes('\x1b')); assert.match(escaped, /\[escaped path; not a command\]/);
  }
});

test('a record that exists but cannot be read is never treated as no record: uninstall refuses and changes nothing', async t => {
  const f = fixture(t), workspace = join(f.paths.config, 'data'); await f.install(workspace); f.ownThings();
  const record = JSON.parse(readFileSync(f.paths.record, 'utf8'));
  for (const [what, bytes] of [['written by a newer version', JSON.stringify({ ...record, version: 5 })], ['of another user', JSON.stringify({ ...record, uid: record.uid + 1 })], ['damaged', 'not a record']] as const) {
    writeFileSync(f.paths.record, bytes); f.service.calls.length = 0;
    const before = snapshot(f.home), out = await f.uninstall();
    assert.match(String(out.error), NOT_STARTED, what); assert.equal(out.shown, '', what);
    assert.match(out.said, new RegExp(`installation record ${literal(f.paths.record)} exists, but this version of alpacawork cannot read it`));
    assert.match(out.said, /the alpacawork version that wrote it/); assert.match(out.said, /as the user it belongs to/);
    assert.deepEqual(snapshot(f.home), before, what); assert.deepEqual(calls(f), [], what);
    assert(existsSync(join(workspace, 'notes/keep.txt')));
  }
});

test('with no record file the default places are cleaned, and the default data folder is never among them', async t => {
  const f = fixture(t); await f.install(); f.ownThings();
  rmSync(f.paths.record); f.service.state = 'absent'; f.service.calls.length = 0;
  const data = snapshot(f.paths.workspace), out = await f.uninstall();
  assert.ifError(out.error); assert.deepEqual(out.result, { uninstalled: true }); assert.deepEqual(calls(f), ['observe']);
  for (const path of [f.paths.config, f.paths.state, f.paths.share, join(f.paths.skills, 'alpacawork')]) assert.equal(existsSync(path), false, path);
  assert.deepEqual(snapshot(f.paths.workspace), data);
});

test('a product folder that is the default data folder is kept, record or no record', async t => {
  // A product folder is `<XDG folder>/alpacawork`, and so is the default data folder when that XDG folder is HOME.
  const g = fixture(t), env = { ...g.env, XDG_STATE_HOME: g.home };
  put(join(g.paths.workspace, 'notes/keep.txt'), 'data with no record to name it\n'); put(join(g.paths.config, 'telemetry.json'), '{}');
  const kept = snapshot(g.paths.workspace);
  for (const run of [1, 2]) {
    const again = await g.uninstall('\r', { env });
    assert.ifError(again.error); assert.deepEqual(snapshot(g.paths.workspace), kept, `run ${run}`);
    assert(!/Remove +State/.test(again.shown)); assert.equal(existsSync(g.paths.config), false);
    assert.match(run === 1 ? again.shown : again.said, new RegExp(`Keep +Holds the data +${literal(g.paths.workspace)} `));
  }
});

test('with no record, a definition file or an unknown manager state means a registration may be left: uninstall refuses', async t => {
  const f = fixture(t); await f.install(); rmSync(f.paths.record);
  const before = snapshot(f.home);
  // The manager has not loaded the job, but its definition file is on disk and starts it at the next login.
  f.service.state = 'conflict'; f.service.loaded = false; f.service.running = false;
  const left = await f.uninstall();
  assert.match(String(left.error), NOT_STARTED); assert.equal(left.shown, ''); assert.match(left.said, /alpacawork\.service exists, but no installation record describes it\./);
  assert.match(left.said, /launchctl bootout|systemctl --user disable --now/); assert.deepEqual(snapshot(f.home), before);
  f.service.state = 'unavailable';
  const unknown = await f.uninstall();
  assert.match(String(unknown.error), NOT_STARTED); assert.equal(unknown.shown, ''); assert.match(unknown.said, /service manager cannot be reached/); assert.deepEqual(snapshot(f.home), before);
  assert(!calls(f).includes('known'), 'whether a job is loaded does not say whether its definition file is there');
});

test('the question uninstall asks without a record is answered by the real adapters from the definition file, loaded or not', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'uninstall-probe-'))), home = join(root, 'home'); mkdirSync(home);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const probe = defaultServiceDefinition({ HOME: home, XDG_CONFIG_HOME: join(home, '.config') });
  assert.equal(probe.name, 'alpacawork.service');
  for (const os of ['launchd', 'systemd'] as const) {
    let reachable = true;
    // A manager that knows no job of this name, as after a logout or before the next login.
    const command = (_file: string, args: string[]) => !reachable ? { status: 1, stdout: '', stderr: 'manager unreachable' }
      : os === 'launchd' ? args[0] === 'print' && args[1]!.endsWith('/alpacawork.service') ? { status: 113, stdout: '', stderr: 'Could not find service' } : { status: 0, stdout: '' }
      : args.includes('show') ? { status: 0, stdout: 'LoadState=not-found\nActiveState=inactive\nFragmentPath=\nLoadError=\n' } : { status: 0, stdout: '' };
    const adapter = os === 'launchd' ? createLaunchdService(command) : createSystemdService(command);
    const file = (os === 'launchd' ? launchdDefinition(probe) : systemdDefinition(probe)).path;
    assert(file.startsWith(home + '/')); assert.equal(adapter.observe(probe).state, 'absent', os);
    put(file, 'what an earlier setup registered\n');
    assert.equal(adapter.observe(probe).state, 'conflict', `${os}: a definition file that is not loaded is still a registration`);
    reachable = false; assert.equal(adapter.observe(probe).state, 'unavailable', os);
    rmSync(file);
  }
});

test('nothing installed says so; a skill folder without alpacawork\'s receipt is the person\'s own', async t => {
  const f = fixture(t);
  put(join(f.paths.skills, 'alpacawork/SKILL.md'), '# my own skill with the same name\n'); f.ownThings();
  const before = snapshot(f.home), out = await f.uninstall();
  assert.ifError(out.error); assert.deepEqual(out.result, { uninstalled: false, reason: 'nothing_to_remove' });
  assert.equal(out.shown, ''); assert.deepEqual(snapshot(f.home), before); assert.deepEqual(calls(f), ['observe']);
});

test('an unreadable skill record keeps every skill and says so', async t => {
  const f = fixture(t); await f.install();
  writeFileSync(join(f.paths.receipt, 'installed.json'), 'not a receipt');
  const out = await f.uninstall();
  assert.deepEqual(out.result, { uninstalled: true });
  assert.match(out.shown, new RegExp(`Keep +Skills +${literal(f.paths.skills)} \\(not removed: the skill record is unreadable`));
  assert(existsSync(join(f.paths.skills, 'alpacawork/SKILL.md'))); for (const folder of f.paths.linked) assert(existsSync(join(folder, 'alpacawork'))); assert.equal(existsSync(f.paths.config), false);
});

test('--yes uninstalls without a terminal and without an answer, and still shows what goes and what stays', async t => {
  const f = fixture(t); await f.install();
  // The flag skips the question only: an agent that alpacawork started is still refused.
  assert.match(String((await f.uninstall(null, { tty: false, yes: true, env: { ...f.env, ALPACAWORK_RUN: '' } })).error), NOT_STARTED);
  const data = snapshot(f.paths.workspace), out = await f.uninstall(null, { tty: false, yes: true });
  assert.ifError(out.error); assert.deepEqual(out.result, { uninstalled: true });
  assert.match(out.shown, /Remove +Auto-start/); assert.match(out.shown, new RegExp(`Keep +Data +${literal(f.paths.workspace)}`)); assert(!out.shown.includes('Enter to start'));
  assert.equal(lstatSync(f.paths.config, { throwIfNoEntry: false }), undefined); assert.deepEqual(snapshot(f.paths.workspace), data);
});

test('sudo, an agent, a pipe and --workspace are refused before anything is read or changed', async t => {
  const f = fixture(t); await f.install();
  const before = snapshot(f.home);
  for (const [overrides, said] of [
    [{ env: { ...f.env, SUDO_USER: 'someone' } }, /Run it as yourself, without sudo\./], [{ env: { ...f.env, SUDO_UID: '501' } }, /without sudo/],
    [{ env: { ...f.env, ALPACAWORK_RUN: '' } }, /Only a person on this PC can run alpacawork uninstall, not an agent\./],
    [{ env: { ...f.env, ALPACAWORK_RUN_TOKEN: 'token' } }, /not an agent/],
    [{ tty: false }, /Run this in a terminal, or add --yes to go ahead without asking\./], [{ explicit: f.paths.workspace }, /--workspace is not accepted/],
  ] as const) {
    const out = await f.uninstall('\r', overrides);
    assert.match(String(out.error), NOT_STARTED); assert.match(out.said, said); assert.equal(out.shown, '');
    assert.deepEqual(snapshot(f.home), before);
  }
  assert.deepEqual(calls(f), [], 'a refused caller does not reach the service manager');
});

test('agents still running from a release are never orphaned: uninstall refuses before the screen, and again after Enter', async t => {
  const f = fixture(t), { release } = await f.install();
  const before = snapshot(f.home), busy = (pid: number) => new RegExp(`1 process started from ${literal(f.paths.releases)}: pid ${pid}\\)`);
  const first = await f.agent(release), out = await f.uninstall();
  assert.match(String(out.error), NOT_STARTED); assert.equal(out.shown, '', 'not asked to approve what would be refused');
  assert.match(out.said, busy(first.pid)); assert.match(out.said, /Stop them on the screen .* or wait until they finish/);
  assert.deepEqual(snapshot(f.home), before); assert.deepEqual(calls(f), ['observe']); assert.equal(f.service.running, true);
  await first.end();

  // A Run that starts while the person reads the screen is seen after their Enter, before the server is stopped.
  let late: Awaited<ReturnType<typeof f.agent>>;
  const approved = await f.uninstall('\r', { beforeAnswer: async () => { late = await f.agent(release); } });
  assert.match(String(approved.error), NOT_STARTED); assert.match(approved.shown, /Enter to start/); assert.match(approved.said, busy(late!.pid));
  assert.deepEqual(withoutLock(snapshot(f.home)), before); assert.equal(f.service.running, true); assert(!calls(f).includes('stop'));
  await late!.end();

  // A deploy, update or setup in progress holds the releases folder.
  let release_: (() => void) | undefined;
  const held = await f.uninstall('\r', { beforeAnswer: () => { release_ = holdReleases(f.paths.releases); } });
  release_!();
  assert.match(String(held.error), NOT_STARTED); assert.match(held.said, /An update or another release operation is in progress/);
  assert.deepEqual(withoutLock(snapshot(f.home)), before); assert.equal(f.service.running, true); assert(!calls(f).includes('stop'));
  assert.deepEqual((await f.uninstall()).result, { uninstalled: true });
});

test('agents are found by the real path of the releases folder when HOME is reached through a link', async t => {
  const f = fixture(t), { release } = await f.install(); rmSync(f.paths.record); f.service.state = 'absent';
  const link = join(f.root, 'home-link'); symlinkSync(f.home, link);
  const env = { ...f.env, HOME: link, XDG_CONFIG_HOME: join(link, '.config'), XDG_STATE_HOME: join(link, '.local/state'), XDG_DATA_HOME: join(link, '.local/share'), XDG_CACHE_HOME: join(link, '.cache') };
  const before = snapshot(f.home), running = await f.agent(release), out = await f.uninstall('\r', { env });
  assert.match(String(out.error), NOT_STARTED); assert.equal(out.shown, ''); assert.match(out.said, new RegExp(`pid ${running.pid}\\)`)); assert.deepEqual(snapshot(f.home), before);
});

// Every placement setup accepts for an existing data folder inside a folder uninstall would otherwise remove whole.
const insideProductFolder = {
  'a chosen releases folder': (f: ReturnType<typeof fixture>) => ({ kept: join(f.root, 'chosen'), releases: join(f.root, 'chosen') }),
  'the default releases folder': (f: ReturnType<typeof fixture>) => ({ kept: f.paths.releases, releases: f.paths.releases }),
  'the state folder': (f: ReturnType<typeof fixture>) => ({ kept: f.paths.state, releases: f.paths.releases }),
  'the skill record folder': (f: ReturnType<typeof fixture>) => ({ kept: f.paths.receipt, releases: f.paths.releases }),
  'the settings folder': (f: ReturnType<typeof fixture>) => ({ kept: f.paths.config, releases: f.paths.releases }),
};
for (const [where, place] of Object.entries(insideProductFolder))
  test(`a data folder inside ${where} survives every run of uninstall, with the record that names it`, async t => {
    const f = fixture(t), { kept, releases } = place(f), workspace = join(kept, 'data');
    await f.install(workspace, releases);
    const data = snapshot(workspace), whole = withoutLock(snapshot(kept));
    for (const run of [1, 2, 3]) {
      const out = await f.uninstall();
      assert.ifError(out.error); assert.deepEqual(snapshot(workspace), data, `run ${run}`);
      assert(existsSync(f.paths.record), `run ${run}: the record that names the data folder`);
      const rows = run === 1 ? out.shown : out.said;
      assert.match(rows, new RegExp(`Keep +Data +${literal(workspace)} `)); assert.match(rows, new RegExp(`Keep +Holds the data +${literal(kept)} \\(not removed: it is the data folder or contains it\\)`));
      if (kept !== f.paths.config) assert.match(rows, new RegExp(`Keep +Record +${literal(f.paths.record)} \\(not removed: it names the data folder`));
      assert.deepEqual(out.result, run === 1 ? { uninstalled: true } : { uninstalled: false, reason: 'nothing_to_remove' });
      if (run > 1) { assert.equal(out.shown, ''); assert.match(out.said, /Nothing is left to remove\./); }
    }
    // The kept folder is kept whole; everything else alpacawork placed is gone.
    assert.deepEqual(withoutLock(snapshot(kept)), whole);
    assert.equal(f.service.state, 'absent'); assert.equal(existsSync(join(f.paths.skills, 'alpacawork')), false);
    for (const path of [f.paths.state, f.paths.releases, f.paths.receipt]) if (path !== kept) assert.equal(existsSync(path), false, path);
    if (kept !== f.paths.config) assert.deepEqual(readdirSync(f.paths.config), ['installation.json']);
    // Once the person has deleted the data folder themselves, nothing is left to protect and the rest goes.
    rmSync(workspace, { recursive: true });
    const last = await f.uninstall();
    assert.ifError(last.error); assert.deepEqual(last.result, { uninstalled: true }); assert(!last.shown.includes('Keep'));
    assert.equal(existsSync(f.paths.config), false); assert.equal(existsSync(kept), false);
  });

test('a releases folder the person also uses for other things loses only what alpacawork put there', async t => {
  const f = fixture(t), tools = join(f.root, 'tools');
  put(join(tools, 'my-tool/bin/run'), '#!/bin/sh\n'); put(join(tools, 'notes.txt'), 'mine\n'); put(join(tools, 'backups/my-own.tar'), 'my own backup\n');
  await f.install(f.paths.workspace, tools);
  const out = await f.uninstall();
  assert.ifError(out.error); assert.deepEqual(out.result, { uninstalled: true });
  assert.match(out.shown, new RegExp(`Remove +Releases +${literal(tools)} \\(what alpacawork put there; the folder itself only when nothing else is in it\\)`));
  assert.match(out.shown, new RegExp(`Keep +Releases folder +${literal(tools)} \\(not removed: it holds entries alpacawork did not put there\\)`));
  assert.deepEqual(readdirSync(tools).sort(), ['backups', 'my-tool', 'notes.txt']); assert.deepEqual(readdirSync(join(tools, 'backups')), ['my-own.tar']);
  assert.equal(readFileSync(join(tools, 'my-tool/bin/run'), 'utf8'), '#!/bin/sh\n'); assert.equal(existsSync(f.paths.config), false);
});

test('a record that names HOME, a folder above it, or either under another name removes nothing', async t => {
  const f = fixture(t); await f.install();
  const record = JSON.parse(readFileSync(f.paths.record, 'utf8')), alias = join(f.root, 'alias'); symlinkSync(f.home, alias);
  // One folder has many names: through a link, and on a volume that ignores case.
  const sameFolder = existsSync(join(f.root, 'HOME')) ? [join(f.root, 'HOME')] : [];
  put(join(f.home, 'current'), 'a file of the person\'s own that is named like a release link\n');
  for (const releases of [f.home, f.root, alias, ...sameFolder]) {
    writeFileSync(f.paths.record, JSON.stringify({ ...record, releases }));
    const before = snapshot(f.home), out = await f.uninstall();
    assert.match(String(out.error), /Product directory must be separate from HOME and its parents/, releases); assert.equal(out.shown, '');
    assert.deepEqual(snapshot(f.home), before, releases);
  }
});

test('a recorded path that ends in a separator is refused, so a link is never followed into the folder it names', async t => {
  const f = fixture(t); await f.install();
  const record = JSON.parse(readFileSync(f.paths.record, 'utf8')), victim = join(f.root, 'victim'), link = join(f.root, 'link');
  put(join(victim, 'current'), 'not a release link\n'); put(join(victim, 'a'.repeat(40), 'file'), 'not a release\n'); symlinkSync(victim, link);
  writeFileSync(f.paths.record, JSON.stringify({ ...record, releases: link + '/' }));
  const before = snapshot(f.home), there = snapshot(victim), out = await f.uninstall();
  assert.match(String(out.error), /not a normalized path/); assert.equal(out.shown, '');
  assert.deepEqual(snapshot(victim), there); assert.deepEqual(snapshot(f.home), before);
});

test('a folder that holds the data folder is known by what it is on disk, whatever name the record gives it', async t => {
  const f = fixture(t), place = join(f.root, 'place'), workspace = join(place, 'data');
  await f.install(workspace);
  const record = JSON.parse(readFileSync(f.paths.record, 'utf8')), alias = join(f.root, 'place-alias'); symlinkSync(place, alias);
  writeFileSync(f.paths.record, JSON.stringify({ ...record, releases: alias }));
  const data = snapshot(workspace), out = await f.uninstall();
  assert.ifError(out.error); assert.match(out.shown, new RegExp(`Keep +Holds the data +${literal(alias)} `));
  assert.deepEqual(snapshot(workspace), data); assert(existsSync(f.paths.record));
});

test('the launcher keeps uninstall independent of current and preserves local workspace arguments', t => {
  const root = mkdtempSync(join(tmpdir(), 'uninstall-launcher-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(resolve('apps/launcher'), join(root, 'bin'), { recursive: true });
  put(join(root, 'package.json'), '{"type":"module"}');
  put(join(root, 'apps/backend/dist/package-version.js'), 'export function readPackageVersion() { return { version:"1.0.0", targets:["linux-x64-glibc","darwin-arm64"] }; }');
  put(join(root, 'apps/backend/dist/backend.js'), 'export async function main(args) { console.log(JSON.stringify({ release: "bundled", args })); }');
  put(join(root, 'apps/cli/dist/cli.js'), 'throw new Error("Uninstall must not load the CLI");');
  put(join(root, 'apps/backend/dist/installation/local-cli.js'), 'throw new Error("Uninstall must not select current");');
  for (const args of [['uninstall'], ['uninstall', '-h'], ['uninstall', '--workspace', '/synthetic/data'], ['--workspace', '/synthetic/data', 'uninstall']]) {
    const out = spawnSync(process.execPath, [join(root, 'bin/alpacawork.mjs'), ...args], { encoding: 'utf8', timeout: 10_000,
      env: cleanCliEnv({ HOME: root, XDG_CONFIG_HOME: root }) });
    const forwarded = args.includes('--workspace') ? ['--workspace', '/synthetic/data', 'uninstall'] : args;
    assert.equal(out.status, 0, out.stderr); assert.deepEqual(JSON.parse(out.stdout), { release: 'bundled', args: forwarded });
  }
});

test('help lists uninstall and says what it removes, keeps and leaves to do', t => {
  const home = mkdtempSync(join(tmpdir(), 'uninstall-help-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = cleanCliEnv({ HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state') });
  const help = (app: string, args: string[]) => { const out = spawnSync(process.execPath, [resolve(`apps/${app}/dist/${app}.js`), ...args], { encoding: 'utf8', env, timeout: 10_000 }); assert.equal(out.status, 0, out.stderr); return out.stdout; };
  assert.match(help('cli', ['-h']), /Local commands:\n(?:.*\n)*  alpacawork uninstall      Remove alpacawork from this PC; the data folder stays\n/);
  assert.match(help('backend', ['-h']), /uninstall \[options\]\s+Remove alpacawork from this PC and keep the data\s+folder/);
  const text = help('backend', ['uninstall', '-h']);
  for (const fact of [/Remove alpacawork from this PC and keep the data folder/, /as yourself: not with sudo, not from an agent that alpacawork started/, /Without a terminal, or to skip the confirmation, add --yes/,
    /starts on Enter\. Any other key cancels and changes nothing/, /Removes: the auto-start registration \(stopped first\), what alpacawork put in the releases folder/,
    /settings, installation record and state/, /the managed skills in the skill record \(with\s+local edits\)/, /links to them in agents' own skills folders/,
    /Keeps: the data folder with your tasks and history\. Delete it by hand/, /is the data folder or contains it is kept whole, with the installation record that\s+names it/,
    /Anything else you keep in the releases folder stays/, /Refuses, changing nothing: while agents or an update are still running/,
    /auto-start registration cannot be removed \(it prints what to do\)/, /record\s+exists that this version cannot read \(use the alpacawork version that wrote it\)/,
    /Safe to run again/, /--workspace is refused/, /npm uninstall -g alpacawork/]) assert.match(text, fact);
  assert.deepEqual(readdirSync(home), [], 'help reads and writes nothing');
});
