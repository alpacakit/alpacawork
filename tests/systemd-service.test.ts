/** Native parser checks do not start or modify a user service manager. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSystemdService, systemdDefinition } from '../packages/core/dist/platform/systemd-service.js';
import type { ServiceDefinition } from '@alpacawork/core';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'systemd-service-'));
  const definition: ServiceDefinition = { name: 'fixture.service', executable: process.execPath,
    args: ['--', '/tmp/app space % "quote"/backend.js', '$literal'], workingDirectory: join(root, 'home space % "quote"'),
    environment: { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'), FIXTURE: 'space % "quote" $literal' } };
  return { root, definition };
}

test('WorkingDirectory uses raw path syntax; ExecStart and Environment keep quoted-word syntax', () => {
  const f = fixture();
  try {
    const native = systemdDefinition(f.definition);
    assert(native.text.includes(`WorkingDirectory=${f.definition.workingDirectory.replaceAll('%', '%%')}/\n`));
    assert(native.text.includes('ExecStart=:"' + process.execPath + '" "--" "/tmp/app space %% \\"quote\\"/backend.js" "$literal"\n'));
    assert(native.text.includes('Environment="FIXTURE=space %% \\"quote\\" $literal"\n'));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('real systemd parser accepts generated directories with spaces, percent, quotes and a final backslash', t => {
  if (process.platform !== 'linux' || spawnSync('systemd-analyze', ['--version']).status !== 0) { t.skip('systemd-analyze is unavailable'); return; }
  const f = fixture();
  try {
    const runtime = join(f.root, 'runtime'); mkdirSync(runtime, { mode: 0o700 });
    for (const directory of [f.definition.workingDirectory, join(f.root, 'back\\slash\\')]) {
      mkdirSync(directory, { recursive: true });
      const native = systemdDefinition({ ...f.definition, workingDirectory: directory });
      mkdirSync(dirname(native.path), { recursive: true }); writeFileSync(native.path, native.text);
      const out = spawnSync('systemd-analyze', ['--user', '--man=no', 'verify', native.path], {
        env: { PATH: process.env.PATH, HOME: f.definition.environment.HOME, XDG_RUNTIME_DIR: runtime,
          XDG_CONFIG_HOME: f.definition.environment.XDG_CONFIG_HOME }, encoding: 'utf8', timeout: 30_000,
      });
      assert.equal(out.status, 0, out.stderr);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('manager unavailability, unit read failure and unit load failure have distinct results', () => {
  const f = fixture();
  try {
    const native = systemdDefinition(f.definition);
    mkdirSync(dirname(native.path), { recursive: true }); writeFileSync(native.path, native.text);
    let manager = true, status = 0, load = 'loaded';
    const service = createSystemdService((_file, args) => args.includes('show-environment')
      ? { status: manager ? 0 : 1, stdout: '' }
      : { status, stdout: `LoadState=${load}\nActiveState=failed\nFragmentPath=${native.path}\nLoadError=org.freedesktop.systemd1.BadUnitSetting "invalid WorkingDirectory"`, stderr: 'unit query refused' });
    assert.equal(service.observe(f.definition).state, 'matching');
    load = 'bad-setting';
    assert.throws(() => service.observe(f.definition), /Cannot load systemd user unit fixture.service.*LoadState=bad-setting.*invalid WorkingDirectory.*daemon-reload.*setup again/);
    assert.throws(() => service.register(f.definition), /LoadState=bad-setting/);
    status = 1;
    assert.throws(() => service.observe(f.definition), /Cannot inspect systemd user unit fixture.service: unit query refused/);
    manager = false;
    assert.equal(service.observe(f.definition).state, 'unavailable');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
