/** npm boundary tests; the real fixed-commit/offline-prefix acceptance is scripts/check-npm-package.ts. */
import { assembleFixtureDistribution } from './helpers/distribution-fixture.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { packageName, parseTargets, runtimeClosure, checkNative } from '@alpacawork/backend/test-dist/release/package-closure.js';
import { inventory, verifyDistributionInventory } from '@alpacawork/backend/test-dist/release/package-files.js';

function scratch(t: TestContext) { const root = mkdtempSync(join(tmpdir(), 'npm-package-unit-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
function pkg(path: string, name: string, extra = {}) {
  mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...extra }));
  writeFileSync(join(path, 'index.js'), 'export const value=1;');
}
test('the shared pack/intake inventory check accepts readable files and returns the complete observed tree', t => {
  const root = scratch(t);
  writeFileSync(join(root, 'payload.txt'), 'synthetic payload');
  writeFileSync(join(root, '__proto__'), 'ordinary file name');
  writeFileSync(join(root, 'DISTRIBUTION.json'), JSON.stringify(inventory(root)));
  chmodSync(join(root, 'payload.txt'), 0o666);
  const tree = verifyDistributionInventory(root);
  assert.deepEqual(tree, inventory(root));
  assert.ok(Object.hasOwn(tree, '__proto__'));
  assert.ok(Object.hasOwn(tree, 'DISTRIBUTION.json'), 'provenance includes the inventory itself');
});
test('the shared inventory check rejects changed, missing and extra payloads and an invalid manifest', t => {
  for (const fault of ['changed', 'missing', 'extra', 'invalid'] as const) {
    const root = scratch(t), payload = join(root, 'payload.txt');
    writeFileSync(payload, 'before');
    writeFileSync(join(root, 'DISTRIBUTION.json'), JSON.stringify(inventory(root)));
    if (fault === 'changed') writeFileSync(payload, 'after!'); // Same length: bytes alone are insufficient.
    if (fault === 'missing') rmSync(payload);
    if (fault === 'extra') writeFileSync(join(root, 'extra.txt'), 'extra');
    if (fault === 'invalid') writeFileSync(join(root, 'DISTRIBUTION.json'), '{');
    assert.throws(() => verifyDistributionInventory(root), fault === 'invalid' ? SyntaxError : /Distribution inventory mismatch/);
  }
});
test('literal package identity rejects shell, path, registry, option and scope injection', () => {
  for (const name of ['fixture', '@fixture/alpacawork', 'fixture.a_b-0']) packageName(name);
  for (const name of ['../bad', '--help', '@scope/../bad', '$(touch x)', 'name;pwd', 'name@latest', '@scope/a/b', 'https://x/a', 'CAPS', '', '@s/'])
    assert.throws(() => packageName(name), /literal lowercase/);
  assert.deepEqual(parseTargets('linux-x64-glibc,darwin-arm64'), ['darwin-arm64', 'linux-x64-glibc']);
  for (const targets of ['', 'win32-x64', 'linux-x64-glibc,linux-x64-glibc']) assert.throws(() => parseTargets(targets));
});
test('runtime closure follows only actual dependency/peer edges, preserves nested versions and strips lifecycle/workspace edges', t => {
  const root = scratch(t), source = join(root, 'source'), target = join(root, 'package'); mkdirSync(target);
  for (const app of ['backend', 'cli', 'agent-cli']) pkg(join(source, 'apps', app), `@private/${app}`, app === 'backend' ? { dependencies: { unusedApp: '*' }, devDependencies: { unused: '*' } } : {});
  pkg(join(source, 'node_modules/koffi'), 'koffi', { bin: { unused: 'index.js' }, scripts: { install: 'exit 1' }, dependencies: { shared: '*' }, peerDependencies: { peer: '*' } });
  pkg(join(source, 'node_modules/@github/copilot-sdk'), '@github/copilot-sdk', { dependencies: { shared: '*' }, optionalDependencies: { absent: '1.0.0' } });
  pkg(join(source, 'node_modules/shared'), 'shared'); pkg(join(source, 'node_modules/peer'), 'peer');
  pkg(join(source, 'node_modules/koffi/node_modules/shared'), 'shared', { version: '2.0.0' });
  const bundled = runtimeClosure(source, target);
  assert.deepEqual(bundled, ['@github/copilot-sdk', 'koffi', 'peer', 'shared']);
  const a = JSON.parse(readFileSync(join(target, 'node_modules/koffi/package.json'), 'utf8'));
  assert.equal(a.scripts, undefined); assert.equal(a.peerDependencies, undefined); assert.equal(a.dependencies.shared, '2.0.0');
  assert.equal(a.bin, undefined);
  assert.equal(JSON.parse(readFileSync(join(target, 'node_modules/koffi/node_modules/shared/package.json'), 'utf8')).version, '2.0.0');
  assert.equal(existsSync(join(target, 'node_modules/unused')), false);
  const files = inventory(target); assert.ok(Object.keys(files).length > 5);
  rmSync(join(source, 'node_modules/peer'), { recursive: true });
  assert.throws(() => runtimeClosure(source, join(root, 'missing')), /Missing runtime dependency/);
});
test('source dependencies may not resolve through an external symlink or a mismatched package', t => {
  const root = scratch(t), source = join(root, 'source');
  for (const app of ['backend', 'cli', 'agent-cli']) pkg(join(source, 'apps', app), `@private/${app}`, { dependencies: { a: '*' } });
  pkg(join(root, 'outside'), '@github/copilot-sdk'); mkdirSync(join(source, 'node_modules/@github'), { recursive: true }); symlinkSync(join(root, 'outside'), join(source, 'node_modules/@github/copilot-sdk'));
  assert.throws(() => runtimeClosure(source, join(root, 'package')), /escapes/);
  rmSync(join(source, 'node_modules/@github/copilot-sdk')); pkg(join(source, 'node_modules/@github/copilot-sdk'), 'wrong');
  assert.throws(() => runtimeClosure(source, join(root, 'package')), /name mismatch/);
});
test('inventory rejects links and shared inodes', t => {
  const root = scratch(t), tree = join(root, 'package'); mkdirSync(tree); writeFileSync(join(root, 'outside'), 'x');
  symlinkSync(join(root, 'outside'), join(tree, 'bad')); assert.throws(() => inventory(tree), /regular and unshared/); rmSync(join(tree, 'bad'));
  linkSync(join(root, 'outside'), join(tree, 'bad')); assert.throws(() => inventory(tree), /regular and unshared/); rmSync(join(tree, 'bad'));

});
test('removing the real shared-inode guard makes the same major acceptance assertion fail', t => {
  const root = scratch(t), tree = join(root, 'package'); mkdirSync(tree); writeFileSync(join(root, 'outside'), 'x'); linkSync(join(root, 'outside'), join(tree, 'shared'));
  const production = readFileSync(resolve('apps/backend/test-dist/release/package-files.js'), 'utf8');
  const marker = '!stat.isFile() || stat.nlink !== 1'; assert.ok(production.includes(marker));
  const fixture = (file: string) => `import assert from 'node:assert/strict'; import { inventory } from ${JSON.stringify(pathToFileURL(file).href)}; assert.throws(()=>inventory(${JSON.stringify(tree)}), /regular and unshared/);`;
  const normal = join(root, 'normal.mjs'), mutated = join(root, 'mutated.mjs');
  writeFileSync(normal, production); writeFileSync(mutated, production.replace(marker, '!stat.isFile()'));
  assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', fixture(normal)]).status, 0);
  assert.notEqual(spawnSync(process.execPath, ['--input-type=module', '-e', fixture(mutated)]).status, 0);
});
test('optional native absence is an explicit refusal, not a successful partial target', t => {
  const root = scratch(t); pkg(root, 'fixture'); pkg(join(root, 'node_modules/@alpacawork/core'), '@alpacawork/core');
  pkg(join(root, 'node_modules/koffi'), 'koffi'); pkg(join(root, 'node_modules/@github/copilot-sdk'), '@github/copilot-sdk');
  assert.throws(() => checkNative(root, ['darwin-arm64']), /Missing native closure for darwin-arm64/);
});
test('common closure retains only requested platform payloads without npm host filters or lifecycle shims', t => {
  const root = scratch(t), source = join(root, 'source'), target = join(root, 'package');
  for (const app of ['backend', 'cli', 'agent-cli']) pkg(join(source, 'apps', app), `@private/${app}`, app === 'backend' ? { dependencies: { runtime: '*' } } : {});
  pkg(join(source, 'node_modules/koffi'), 'koffi', { optionalDependencies: { linux: '1.0.0', mac: '1.0.0', windows: '1.0.0' } });
  pkg(join(source, 'node_modules/linux'), 'linux', { os: ['linux'], cpu: ['x64'], libc: ['glibc'] });
  pkg(join(source, 'node_modules/mac'), 'mac', { os: ['darwin'], cpu: ['arm64'] });
  pkg(join(source, 'node_modules/windows'), 'windows', { os: ['win32'], cpu: ['x64'] });
  const roots = ['@github/copilot-sdk', 'koffi'];
  for (const name of roots.filter(name => name !== 'koffi')) pkg(join(source, 'node_modules', name), name);
  assert.deepEqual(runtimeClosure(source, target), [...roots, 'linux', 'mac']);
  const mac = JSON.parse(readFileSync(join(target, 'node_modules/mac/package.json'), 'utf8'));
  assert.equal(mac.os, undefined); assert.equal(mac.cpu, undefined); assert.equal(mac.scripts, undefined);
  const subset = join(root, 'linux-only');
  assert.deepEqual(runtimeClosure(source, subset, ['linux-x64-glibc']), [...roots, 'linux']);
});
test('native file magic alone cannot pass an ELF runtime for the wrong architecture', t => {
  const root = scratch(t); pkg(root, 'fixture');
  pkg(join(root, 'node_modules/@alpacawork/core'), '@alpacawork/core');
  pkg(join(root, 'node_modules/koffi'), 'koffi'); pkg(join(root, 'node_modules/@github/copilot-sdk'), '@github/copilot-sdk');
  const ffi = join(root, 'node_modules/@koromix/koffi-linux-x64'); pkg(ffi, '@koromix/koffi-linux-x64'); mkdirSync(join(ffi, 'linux_x64'));
  pkg(join(root, 'node_modules/@github/copilot-sdk-linux-x64'), '@github/copilot-sdk-linux-x64');
  const elf = Buffer.alloc(64); elf.write('7f454c46', 0, 'hex'); elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(183, 18);
  writeFileSync(join(ffi, 'linux_x64/koffi.node'), elf);
  assert.throws(() => checkNative(root, ['linux-x64-glibc']), /does not match linux-x64-glibc/);
});
test('launcher version reads local facts without initializing even an unsupported host; incomplete setup does not succeed', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, t => {
  const stage = scratch(t), root = join(stage, 'image');
  assembleFixtureDistribution(resolve('.'),join(stage,'build'),root,undefined,built=>{
    const file=join(built,'package.json'), manifest=JSON.parse(readFileSync(file,'utf8'));
    writeFileSync(file,JSON.stringify({...manifest,name:'@fixture/local',version:'2.3.4'}));
  });
  const launcher = join(root, 'bin/alpacawork.mjs');
  const code = `Object.defineProperty(process,'platform',{value:'win32'});process.argv=[process.execPath,${JSON.stringify(launcher)},'version'];await import(${JSON.stringify(pathToFileURL(launcher).href)});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).version, '2.3.4');
  for (const args of [['setup'], ['client', 'update']]) {
    const pending = spawnSync(process.execPath, [launcher, ...args], { encoding: 'utf8' });
    assert.equal(pending.status, 2);
    assert.match(pending.stderr, args[0] === 'setup'
      ? /Run setup from a terminal, or add --yes to go ahead without asking\. No setup changes were made\./
      : /unknown command 'client'/);
  }
  const direct = spawnSync(process.execPath, [launcher, 'task', 'list', '--help'], { encoding: 'utf8' });
  assert.equal(direct.status, 0, direct.stderr); assert.match(direct.stdout, /Usage: alpacawork task list/);
});

test('readonly global distribution runs launcher facts and launcher/direct CLI help without source writes', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, t => {
  const stage = scratch(t), root = join(stage, 'image');
  assembleFixtureDistribution(resolve('.'), join(stage, 'build'), root);
  const files = Object.keys(inventory(root)), directories: string[] = [];
  assert.equal(files.some(file => file.startsWith('drafts/')), false);
  for (const kind of ['retired-kind']) {
    const result = spawnSync(process.execPath, [join(root, 'bin/agent.mjs'), kind], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, new RegExp(`unknown agent: ${kind}`));
  }
  const walk = (path: string) => {
    directories.push(path);
    for (const name of readdirSync(path)) { const child = join(path, name); if (lstatSync(child).isDirectory()) walk(child); }
  };
  walk(root);
  try {
    for (const file of files) chmodSync(join(root, file), file.startsWith('bin/') ? 0o555 : 0o444);
    for (const dir of directories) chmodSync(dir, 0o555);
    const stats = () => Object.fromEntries([...directories, ...files.map(file => join(root, file))].map(path => {
      const s = lstatSync(path, { bigint: true });
      return [path, [s.dev, s.ino, s.uid, s.nlink, s.mode, s.size, s.mtimeNs, s.ctimeNs]];
    }));
    const before = { content: inventory(root), stat: stats() };
    for (const [entry, args] of [
      ['bin/alpacawork.mjs', ['version']], ['bin/alpacawork.mjs', ['--version']],
      ['bin/backend.mjs', ['--help']],
      ['bin/alpacawork.mjs', ['task', '--help']], ['apps/cli/dist/cli.js', ['--help']],
    ] as const) {
      const result = spawnSync(process.execPath, [join(root, entry), ...args], { encoding: 'utf8', timeout: 15_000 });
      assert.equal(result.status, 0, result.stderr);
      if (args.some(arg => arg === '--help')) assert.match(result.stdout, /Usage: alpacawork/);
      else if (args[0] === 'version') assert.equal(JSON.parse(result.stdout).version, JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);
      else assert.equal(result.stdout.trim(), JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);
    }
    assert.deepEqual({ content: inventory(root), stat: stats() }, before);
  } finally { for (const dir of directories) chmodSync(dir, 0o700); }
});
