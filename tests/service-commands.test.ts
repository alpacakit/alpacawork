import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { runServiceCommand } from '../apps/backend/test-dist/installation/service-commands.js';
import { serviceDefinition } from '../apps/backend/test-dist/installation/setup.js';
import { installationPath, installationVersion, type Installation } from '../apps/backend/test-dist/installation/store.js';
import { createLaunchdService, launchdDefinition } from '../packages/core/dist/platform/launchd-service.js';
import { createSystemdService, systemdDefinition } from '../packages/core/dist/platform/systemd-service.js';
import type { ServiceCommand } from '../packages/core/dist/platform/service-definition.js';

for (const manager of ['systemd', 'launchd'] as const) test(`local service commands use the saved ${manager} service`, t => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'service-commands-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, 'config'), LANG: 'en' };
  const path = installationPath(env), name = 'synthetic.service', releases = join(home, 'releases'), port = 5519;
  const record: Installation = { version: installationVersion, home, uid: process.getuid!(),
    nodeExecutable: process.execPath, releases, workspace: join(home, 'data'),
    workspaceIdentity: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
    service: { name, port, environmentPath: '/usr/bin:/bin', publicHost: null } };
  const definition = serviceDefinition(record, path);
  const native = manager === 'systemd' ? systemdDefinition(definition) : launchdDefinition(definition);
  const mutations: string[][] = [];
  let running = false, loaded = manager === 'systemd', unavailable = false;
  const domain = `gui/${record.uid}`, target = `${domain}/${name}`;
  const ok = (stdout = '') => ({ status: 0, stdout });
  const missingJob = { status: 113, stdout: '', stderr: 'Could not find service' };
  const command: ServiceCommand = (file, args) => {
    if (unavailable) return { status: 1, stdout: '' };
    if (manager === 'systemd') {
      assert.equal(file, 'systemctl');
      assert.equal(args[0], '--user');
      if (args[1] === 'show-environment') return ok();
      if (args[1] === 'show') {
        assert.equal(args.at(-1), name);
        return ok(`LoadState=loaded\nActiveState=${running ? 'active' : 'inactive'}\nFragmentPath=${native.path}\n`);
      }
      assert.deepEqual(args.slice(2), [name]);
      mutations.push(args);
      running = args[1] !== 'stop';
      return ok();
    }

    if (file === 'ps') return running ? ok('synthetic process start time') : { status: 1, stdout: '' };
    assert.equal(file, 'launchctl');
    if (args[0] === 'print') {
      if (args[1] === domain) return ok();
      assert.equal(args[1], target);
      return loaded ? ok(`${target} = {\npath = ${native.path}\n${running ? 'pid = 12345\n' : ''}}\n`) : missingJob;
    }
    mutations.push(args);
    if (args[0] === 'bootstrap') {
      assert.deepEqual(args, ['bootstrap', domain, native.path]);
      loaded = running = true;
    } else {
      assert.equal(args.at(-1), target);
      if (args[0] === 'bootout') loaded = running = false;
      else {
        assert.equal(args[0], 'kickstart');
        assert(loaded, 'must load the saved job before starting it');
        running = true;
      }
    }
    return ok();
  };
  const service = manager === 'systemd' ? createSystemdService(command) : createLaunchdService(command);
  const run = (action: Parameters<typeof runServiceCommand>[0]) => runServiceCommand(action, env, service);
  assert.match(run('start').message, /alpacawork setup/);
  assert.deepEqual(mutations, []);
  mkdirSync(releases);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record));
  mkdirSync(dirname(native.path), { recursive: true });
  writeFileSync(native.path, native.text);

  const stopped = run('status');
  assert.equal(stopped.ok, true);
  assert.doesNotMatch(stopped.message, /http:\/\//);
  assert.equal(run('start').ok, true);
  assert.deepEqual(mutations.splice(0), manager === 'systemd' ? [['--user', 'start', name]]
    : [['bootstrap', domain, native.path], ['kickstart', target]]);
  assert(run('status').message.includes(`http://127.0.0.1:${port}`));
  assert.equal(run('start').ok, true);
  assert.deepEqual(mutations, [], 'status and start on a running service must leave it running');
  assert.equal(run('stop').ok, true);
  assert.deepEqual(mutations.splice(0), manager === 'systemd' ? [['--user', 'stop', name]] : [['bootout', target]]);
  assert.deepEqual(run('status'), stopped);
  assert.equal(run('restart').ok, true);
  assert.deepEqual(mutations.splice(0), manager === 'systemd' ? [['--user', 'restart', name]]
    : [['bootstrap', domain, native.path], ['kickstart', '-k', target]]);
  assert(run('status').message.includes(`http://127.0.0.1:${port}`));

  unavailable = true;
  assert.equal(run('status').ok, false);
  assert.equal(run('stop').ok, false);
  assert.deepEqual(mutations, []);
});
