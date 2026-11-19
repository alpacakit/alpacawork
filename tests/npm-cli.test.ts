import { installSetupSystemctl } from './helpers/setup-systemctl.ts';
/** The npm-shaped public command, real setup/HTTP/switch, and an owned fake native service command. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { assembleFixtureDistribution, npmTarball } from './helpers/distribution-fixture.ts';
import { openTree } from './helpers/managed-skills-fixture.ts';
import { cleanCliEnv } from './helpers/http-cli.ts';
import { preserveTestFailure } from './helpers/failure-workspace.ts';
import { stubBundledStatus } from './helpers/agent-inspection.ts';
const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string;
import { switchTo } from '@alpacawork/backend/test-dist/release/switch.js';
const exec = promisify(execFile);

test('npm command follows current and the setup port; ordinary task/server commands need no cli prefix',
  { skip: process.platform !== 'linux', timeout: 180_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'npm-cli-')), home = join(root, 'home'), bin = join(root, 'bin');
  mkdirSync(home); mkdirSync(bin);
  const systemctl = join(bin, 'systemctl'); installSetupSystemctl(systemctl);
  symlinkSync(process.execPath, join(bin, 'node'));
  const env = cleanCliEnv({ HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
    XDG_STATE_HOME: join(home, '.local/state'), XDG_CACHE_HOME: join(home, '.cache'),
    PATH: `${bin}:/usr/bin:/bin`, LANG: 'en', LC_ALL: 'en_US.UTF-8', COREPACK_ENABLE_NETWORK: '0',
    NODE_OPTIONS: '--import=' + pathToFileURL(resolve('e2e/perf/guard.mjs')).href });
  delete env.SUDO_USER; delete env.SUDO_UID; delete env.ALPACAWORK_MANAGED_RELEASES;
  t.after(async () => {
    await exec(systemctl, ['--user', 'stop', 'alpacawork.service'], { env });
    try { await preserveTestFailure(t, root, { databaseRoot: join(home, 'alpacawork') }); }
    finally { openTree(root); rmSync(root, { recursive: true, force: true }); }
  });
  const installed = join(root, 'prefix/lib/node_modules/alpacawork');
  assembleFixtureDistribution(resolve('.'), join(root, 'build'), join(root, 'package'), undefined, stubBundledStatus);
  const archive = join(root, 'alpacawork.tgz');
  npmTarball(archive, ['-C', root, 'package']);
  const npm = realpathSync(join(dirname(process.execPath), 'npm'));
  const userConfig = join(root, 'user.npmrc'), globalConfig = join(root, 'global.npmrc');
  writeFileSync(userConfig, ''); writeFileSync(globalConfig, '');
  await exec(process.execPath, [npm, 'install', '--global', '--prefix', join(root, 'prefix'), '--offline', '--ignore-scripts',
    '--no-audit', '--no-fund', '--registry', 'http://127.0.0.1:9/', '--cache', join(root, 'npm-cache'),
    '--userconfig', userConfig, '--globalconfig', globalConfig, archive], { cwd: root, env, timeout: 60_000 });
  const command = join(root, 'prefix/bin/alpacawork');
  const evidence: unknown[] = [];
  function captureOutput(args: string[], result: { status: number; stdout: string; stderr: string }, extra = {}) {
    evidence.push({ args, env: extra, ...result });
    if (process.env.NPM_CLI_EVIDENCE) writeFileSync(process.env.NPM_CLI_EVIDENCE, JSON.stringify(evidence, null, 2));
    return result;
  }
  async function cli(args: string[], extra = {}) {
    try { return captureOutput(args, { status: 0, ...await exec(command, args, { cwd: root, env: { ...env, ...extra }, timeout: 15_000 }) }, extra); }
    catch (error) { if (typeof (error as any).code !== 'number') throw error;
      return captureOutput(args, { status: (error as any).code as number, stdout: String((error as any).stdout), stderr: String((error as any).stderr) }, extra); }
  }
  assert.equal((await cli(['--version'])).stdout.trim(), packageVersion);
  assert.equal(JSON.parse((await cli(['server', 'show'])).stdout).source, 'default');
  const help = await cli(['--help']); assert.equal(help.status, 0); assert.match(help.stdout, /alpacawork setup/);
  const retired = await cli(['cli', 'task', 'list']); assert.notEqual(retired.status, 0); assert.match(retired.stderr, /unknown command 'cli'/);

  const config = join(root, 'terminal.json');
  writeFileSync(config, JSON.stringify({ home, cwd: root, env, output: join(root, 'terminal-result.json'),
    answer: 'enter', command: [command, 'setup', '--no-open'] }));
  const setup = JSON.parse((await exec(process.execPath, [resolve('tests/helpers/setup-terminal.ts'), config], { env, timeout: 150_000, maxBuffer: 8 * 1024 * 1024 })).stdout);
  captureOutput(['setup'], { status: setup.status, stdout: setup.transcript, stderr: '' });
  assert.equal(setup.status, 0, setup.transcript); assert.equal(setup.confirmations, 1);
  const record = JSON.parse(readFileSync(join(home, '.config/alpacawork/installation.json'), 'utf8'));
  const origin = `http://127.0.0.1:${record.service.port}`;
  assert.notEqual(record.service.port, 5499, 'setup must exercise its selected port rather than the CLI default');
  assert.deepEqual(JSON.parse((await cli(['server', 'show'])).stdout), { server: origin, source: 'installation.json' });
  const listed = await cli(['task', 'list']); assert.equal(listed.status, 0, listed.stderr); assert.ok(Array.isArray(JSON.parse(listed.stdout).tasks));

  const alternate = createServer((req, res) => { res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/identity' ? { generation: randomUUID(), root: '/synthetic' } : { alternate: true })); });
  alternate.listen(0, '127.0.0.1'); await once(alternate, 'listening');
  t.after(() => new Promise<void>((done, reject) => alternate.close(error => error ? reject(error) : done())));
  const other = `http://127.0.0.1:${(alternate.address() as { port: number }).port}`;
  assert.equal((await cli(['server', 'set', other])).status, 0);
  assert.equal(JSON.parse((await cli(['task', 'list'])).stdout).alternate, true);
  assert.deepEqual(JSON.parse((await cli(['server', 'show'], { ALPACAWORK_SERVER: origin })).stdout), { server: origin, source: 'ALPACAWORK_SERVER' });
  assert.deepEqual(JSON.parse((await cli(['--server', origin, 'server', 'show'])).stdout), { server: origin, source: '--server' });
  assert.equal((await cli(['server', 'unset'])).status, 0);
  assert.equal(JSON.parse((await cli(['server', 'show'])).stdout).source, 'installation.json');

  const current = join(record.releases, 'current');
  const bundledLauncher = readFileSync(join(installed, 'bin/launcher.mjs'));
  // Keep the actual pre-uninstall bootstrap throughout the update, as on an npm installation of beta.5.
  writeFileSync(join(installed, 'bin/launcher.mjs'), readFileSync(new URL('./fixtures/launcher-before-uninstall.mjs', import.meta.url)));
  renameSync(current, current + '.saved');
  try {
    assert.equal((await cli(['--version'])).stdout.trim(), packageVersion);
    assert.equal((await cli(['--help'])).status, 0);
    assert.equal(JSON.parse((await cli(['server', 'show'])).stdout).source, 'installation.json');
  } finally { renameSync(current + '.saved', current); }

  const next = join(record.releases, 'b'.repeat(40));
  assembleFixtureDistribution(resolve('.'), join(root, 'next-build'), next, 'b'.repeat(40), built => {
    const path = join(built, 'package.json'), pkg = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...pkg, version: '0.3.1' }));
  });
  const prior = new Map<string, string | undefined>();
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'PATH']) {
    prior.set(key, process.env[key]); process.env[key] = env[key];
  }
  try { await switchTo({ releases: record.releases, workspace: record.workspace, service: record.service.name, say: () => {} }, next, 'production'); }
  finally { for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version, packageVersion);
  const updated = await cli(['--version']); assert.equal(updated.status, 0, updated.stderr); assert.equal(updated.stdout.trim(), '0.3.1');
  assert.equal(JSON.parse((await cli(['version'])).stdout).version, '0.3.1');
  assert.equal((await cli(['task', 'list'])).status, 0);
  const wrongWorkspace = await cli(['uninstall', '--workspace', record.workspace]);
  assert.equal(wrongWorkspace.status, 2, wrongWorkspace.stderr);
  assert.match(wrongWorkspace.stderr, /workspace/);
  // The ordinary command follows current; an explicit version stays pinned to its package.
  const skills = await cli(['skills', 'update']); assert.equal(skills.status, 0, skills.stderr);
  assert.equal(JSON.parse(skills.stdout).receipt.skills.find((skill: any) => skill.name === 'alpacawork').source.version, '0.3.1');
  const pinned = await cli(['skills', 'update', '--package-version', packageVersion]); assert.equal(pinned.status, 0, pinned.stderr);
  assert.equal(JSON.parse(pinned.stdout).receipt.skills.find((skill: any) => skill.name === 'alpacawork').source.version, packageVersion);
  const wrong = await cli(['skills', 'update', '--package-version', '0.3.1']); assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /npx --yes --package=alpacawork@0.3.1/);

  // The same npm entry reaches the updated uninstaller; cancellation keeps it usable, removal keeps the data.
  async function terminal(args: string[], answer: string) {
    writeFileSync(config, JSON.stringify({ home, cwd: root, env, output: join(root, 'terminal-result.json'),
      answer, command: [command, ...args] }));
    const result = JSON.parse((await exec(process.execPath, [resolve('tests/helpers/setup-terminal.ts'), config], { env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })).stdout);
    captureOutput(args, { status: result.status, stdout: result.transcript, stderr: '' });
    return result;
  }
  async function uninstall(answer: string) {
    const result = await terminal(['uninstall'], answer);
    assert.equal(result.status, 0, result.transcript);
    return result.transcript as string;
  }
  assert.match(await uninstall('cancel'), /"uninstalled":false/);
  const uninstallHelp = await cli(['uninstall', '-h']); assert.equal(uninstallHelp.status, 0, uninstallHelp.stderr);
  assert.match(uninstallHelp.stdout, /Remove alpacawork from this PC and keep the data folder/);
  const retained = await cli(['task', 'list']); assert.equal(retained.status, 0);
  const data = join(record.workspace, 'keep.txt'); writeFileSync(data, 'synthetic user file');
  await exec(systemctl, ['--user', 'stop', 'alpacawork.service'], { env });
  const database = join(record.workspace, '.alpacawork/alpacawork.sqlite');
  const hashDatabase = () => createHash('sha256').update(readFileSync(database)).digest('hex');
  const databaseBefore = hashDatabase();
  const locator = join(record.workspace, '.alpacawork/release-location.json');
  assert.equal(existsSync(locator), true);
  // Replay the same stopped installation for the second entry, without another setup/service start.
  const stopped = join(root, 'stopped-installation');
  await exec('cp', ['-a', home, stopped]);
  // The recovery copy needs current, not historical payloads that each PTY audit would hash again.
  const copiedReleases = join(stopped, relative(home, record.releases));
  for (const name of readdirSync(copiedReleases))
    if (/^[a-f0-9]{40}$/.test(name) && name !== basename(next)) rmSync(join(copiedReleases, name), { recursive: true, force: true });
  assert.match(await uninstall('enter'), /"uninstalled":true/);
  assert.equal(readFileSync(data, 'utf8'), 'synthetic user file');
  assert.equal(hashDatabase(), databaseBefore);
  assert.equal(existsSync(locator), false);
  assert.equal((await cli(['--version'])).stdout.trim(), packageVersion);

  // Installation management must also work when current cannot provide an uninstaller.
  await exec('cp', ['-a', stopped + '/.', home]);
  rmSync(stopped, { recursive: true, force: true });
  writeFileSync(join(installed, 'bin/launcher.mjs'), bundledLauncher);
  const recoveryRecord = JSON.parse(readFileSync(join(home, '.config/alpacawork/installation.json'), 'utf8'));
  const recoveryRelease = realpathSync(join(recoveryRecord.releases, 'current'));
  // A current CLI with no uninstall command models the older command surface; it must never run.
  writeFileSync(join(recoveryRelease, 'apps/cli/dist/cli.js'), `export async function main() { console.error("error: unknown command 'uninstall'"); return 2; }`);
  const recoveryHelp = await cli(['uninstall', '-h']);
  assert.equal(recoveryHelp.status, 0, recoveryHelp.stderr);
  assert.match(recoveryHelp.stdout, /Remove alpacawork from this PC and keep the data folder/);

  // Damage both entry points in the real assembled current; the npm bundle remains intact.
  for (const entry of ['apps/cli/dist/cli.js', 'apps/backend/dist/backend.js']) rmSync(join(recoveryRelease, entry));
  const wrongData = join(home, 'wrong-workspace'); mkdirSync(wrongData);
  writeFileSync(join(wrongData, 'keep.txt'), 'not the recorded data folder');
  const snapshot = () => readdirSync(home, { recursive: true, encoding: 'utf8' }).sort().map(name => {
    const file = join(home, name), info = lstatSync(file);
    return [name, info.mode, info.isFile() ? createHash('sha256').update(readFileSync(file)).digest('hex') : info.isSymbolicLink() ? readlinkSync(file) : null];
  });
  const before = snapshot();
  // The launcher unit test covers both argument orders; exercise the resulting refusal once here.
  const refused = await terminal(['uninstall', '--workspace', wrongData], 'enter');
  assert.equal(refused.status, 2, refused.transcript);
  assert.equal(refused.confirmations, 0, refused.transcript);
  assert.match(refused.transcript, /--workspace is not accepted: the installation record decides what is removed/);
  assert.match(refused.transcript, /"code":"invalid_input"/);
  assert.match(refused.transcript, /Uninstall did not start\. Nothing was changed\./);
  assert.deepEqual(snapshot(), before, 'a refused workspace changes no installation or data files');
  assert.match(await uninstall('enter'), /"uninstalled":true/);
  assert.equal(readFileSync(data, 'utf8'), 'synthetic user file');
  assert.equal(hashDatabase(), databaseBefore);
  assert.equal(existsSync(locator), false);
  assert.equal(readFileSync(join(wrongData, 'keep.txt'), 'utf8'), 'not the recorded data folder');
  assert.equal((await cli(['--version'])).stdout.trim(), packageVersion);
  const reinstalled = await terminal(['setup', '--no-open'], 'enter');
  assert.equal(reinstalled.status, 0, reinstalled.transcript);
  const reread = await cli(['task', 'list']); assert.equal(reread.status, 0, reread.stderr);
  assert.deepEqual(JSON.parse(reread.stdout).tasks, JSON.parse(retained.stdout).tasks);
  assert.equal(readFileSync(data, 'utf8'), 'synthetic user file');
});
