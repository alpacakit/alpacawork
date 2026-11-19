/** Pack input errors through the real local CLI, before any release build or npm step. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { cleanCliEnv } from './helpers/http-cli.ts';

test('release pack translates only name/version/targets input rejection and preserves later failures', { timeout: 60000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'release-pack-input-'));
  const home = join(root, 'home'); mkdirSync(home);
  const env = cleanCliEnv({ HOME: home });
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 15000 });
    assert.ifError(result.error); assert.equal(result.signal, null, result.stderr);
    return result;
  };
  const fixture = resolve('scripts/dev-fixtures/fixture.ts');
  let source: string | undefined, workspace: string | undefined;
  t.after(() => {
    try {
      for (const path of [workspace, source]) if (path) {
        const removed = run([fixture, 'remove', '--root', path]); assert.equal(removed.status, 0, removed.stderr);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  const created = run([fixture, 'create', '--profile', 'small', '--seed', 'release-pack-input', '--cache', join(root, 'cache')]);
  assert.equal(created.status, 0, created.stderr); source = JSON.parse(created.stdout).root;
  const copy = join(root, 'workspace');
  const copied = run([fixture, 'copy', '--source', source!, '--dest', copy]);
  assert.equal(copied.status, 0, copied.stderr); workspace = copy;
  const cases = [
    { name: 'bad-name', args: ['--name', 'CAPS', '--targets', 'linux-x64-glibc'], message: 'Expected a literal lowercase npm package name' },
    { name: 'bad-version', args: ['--name', 'fixture', '--version', '1.0.0+build.1', '--targets', 'linux-x64-glibc'], message: 'Expected a literal npm version without build metadata' },
    { name: 'bad-targets', args: ['--name', '@fixture/alpacawork', '--targets', 'win32-x64'], message: 'Targets must be linux-x64-glibc,darwin-arm64 (WSL2 uses the Linux closure)' },
    { name: 'missing-name', args: ['--targets', 'linux-x64-glibc'], message: 'release pack requires explicit --name and --output' },
    { name: 'missing-output', args: ['--name', 'fixture'], message: 'release pack requires explicit --name and --output' },
    { name: 'valid-build-boundary', args: ['--name', 'fixture', '--targets', 'linux-x64-glibc'] },
    { name: 'valid-pack-fault', args: ['--name', '@fixture/alpacawork', '--targets', 'linux-x64-glibc,darwin-arm64'] },
  ];
  for (const entry of cases) await t.test(entry.name, () => {
    const area = join(root, entry.name); mkdirSync(area);
    const output = join(area, 'output'), repo = join(area, 'absent-repo');
    if (entry.name === 'valid-pack-fault') writeFileSync(output, 'synthetic occupied output');
    const args = [resolve('apps/backend/dist/backend.js'), '--workspace', copy, 'release', 'pack', '--repo', repo,
      '--releases', join(area, 'releases'), ...(entry.name === 'missing-output' ? [] : ['--output', output]), ...entry.args];
    const result = run(args);
    console.log(JSON.stringify({ packInputCli: { case: entry.name, argv: [process.execPath, ...args], pid: result.pid,
      exit: result.status, stdout: result.stdout, stderr: result.stderr } }));
    const error = JSON.parse(result.stderr).error;
    assert.equal(result.stdout, '');
    if (entry.name === 'valid-pack-fault') {
      assert.equal(result.status, 1); assert.equal(error.code, 'unavailable');
      assert.equal(error.reason.kind, 'system_error'); assert.equal(error.reason.code, 'EEXIST');
    } else {
      assert.equal(result.status, 2); assert.equal(error.code, 'invalid_input'); assert.equal(error.retry, 'fix');
      assert.equal(error.reason, undefined);
      assert.equal(error.message, entry.message ?? `Not a commit in ${repo}: main`);
    }
  });
});
