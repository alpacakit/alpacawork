import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

for (const app of ['cli', 'backend']) test(`the built ${app} runs through a symlink and import→main starts once`, t => {
  const root = mkdtempSync(join(tmpdir(), 'cli-entry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = resolve(`apps/${app}/dist/${app}.js`), link = join(root, 'alpacawork');
  symlinkSync(entry, link);
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: root, ALPACAWORK_RUN_CLI: '', ALPACAWORK_SERVER: 'http://127.0.0.1:1' };
  const direct = spawnSync(link, ['--help'], { encoding: 'utf8', env, timeout: 10000 });
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(direct.stderr, '');
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `
    process.argv[1] = ${JSON.stringify(link)};
    const { main } = await import(${JSON.stringify(pathToFileURL(entry).href)});
    process.exitCode = await main(['--help']);
  `], { encoding: 'utf8', env, timeout: 10000 });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stderr, '');
  assert.equal(imported.stdout, direct.stdout);
});

test('the packaged agent management command reaches the CLI inside and outside a Run, while the dedicated bridge keeps its entrance', t => {
  const root = mkdtempSync(join(tmpdir(), 'cli-agent-routing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const folder of ['bin', 'apps/backend/dist/installation', 'apps/cli/dist', 'apps/agent-cli/dist'])
    mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  for (const file of ['alpacawork.mjs', 'agent.mjs', 'launcher.mjs'])
    copyFileSync(resolve('apps/launcher', file), join(root, 'bin', file));
  writeFileSync(join(root, 'apps/backend/dist/package-version.js'),
    `export const readPackageVersion = () => ({version: 'synthetic', targets: ['linux-x64-glibc', 'darwin-arm64']});`);
  writeFileSync(join(root, 'apps/backend/dist/installation/local-cli.js'),
    `export const localCli = () => ({release: ${JSON.stringify(root)}});`);
  const cli = join(root, 'apps/cli/dist/cli.js');
  writeFileSync(cli, `#!${process.execPath}
import { fileURLToPath } from 'node:url';
export async function main(args) { console.log(JSON.stringify({entry: 'cli', args})); return 0; }
if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
`);
  chmodSync(cli, 0o700);
  writeFileSync(join(root, 'apps/agent-cli/dist/cli.js'),
    `console.log(JSON.stringify({entry: 'bridge', args: process.argv.slice(2)}));`);
  // A tools-only PATH makes even an accidental provider dispatch harmless.
  const tools = join(root, 'tools'); mkdirSync(tools); symlinkSync(process.execPath, join(tools, 'node'));
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: root, PATH: tools };
  const args = ['agent', 'assign', '--help'];
  for (const runCli of ['', cli]) {
    const result = spawnSync('/bin/sh', [join(root, 'bin/alpacawork.mjs'), ...args],
      { env: { ...env, ALPACAWORK_RUN_CLI: runCli }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { entry: 'cli', args });
  }
  const bridge = spawnSync(process.execPath, [join(root, 'bin/agent.mjs'), 'synthetic-adapter'],
    { env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(bridge.status, 0, bridge.stderr);
  assert.deepEqual(JSON.parse(bridge.stdout), { entry: 'bridge', args: ['synthetic-adapter'] });
});
