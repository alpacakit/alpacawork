/** Producer boundary tests. Synthetic native headers are unit inputs, never OS/runtime acceptance. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { assembleDistribution, copyDistribution, validateDistribution } from '@alpacawork/backend/test-dist/release/distribution.js';
import { distributionCommand } from '@alpacawork/backend/test-dist/release/distribution-driver.js';
import { buildRelease } from '@alpacawork/backend/test-dist/release/build.js';
import { inventory, verifyDistributionInventory } from '@alpacawork/backend/test-dist/release/package-files.js';
import { switchTo } from '@alpacawork/backend/test-dist/release/switch.js';
import { saveJournal } from '@alpacawork/backend/test-dist/release/journal.js';
import { npmReadme } from '@alpacawork/backend/test-dist/release/npm-readme.js';
import { cleanCliEnv } from './helpers/http-cli.ts';

import { distributionFixture as fixture, distributionFixtureTargets as targets } from './helpers/distribution-fixture.ts';

function snapshot(root: string) {
  const content = inventory(root), stat = new Map<string, unknown>();
  const walk = (file: string) => {
    const s = lstatSync(join(root, file), { bigint: true });
    stat.set(file, [s.dev, s.ino, s.uid, s.gid, s.nlink, s.mode, s.size, s.mtimeNs, s.ctimeNs]);
    if (s.isDirectory()) for (const name of readdirSync(join(root, file))) walk(join(file, name));
  };
  walk('');
  return { content, stat: Object.fromEntries(stat) };
}
function useRuntime(root: string) {
  for (const bin of ['alpacawork.mjs', 'backend.mjs', 'agent.mjs']) {
    const child = spawnSync(join(root, 'bin', bin), ['--version'], { env: cleanCliEnv(), encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 0, String(child.error ?? child.stderr));
    assert.equal(child.stdout.trim(), '1.0.0');
  }
}
test('assembly, target-owned validation, copy/reseal and cache preserve the source image including runtime dependencies', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const f = fixture(t);
  const made = assembleDistribution(f.built, f.image, f.expected);
  assert.equal(made.facts.source, f.expected.source);
  assert.equal(existsSync(join(f.image, 'node_modules/@alpacawork')), false);
  assert.equal(existsSync(join(f.image, 'node_modules/zod')), false);
  assert.equal('cliContract' in made.facts, false);
  assert.deepEqual(inventory(join(f.image, 'docs')), inventory(join(f.built, 'docs')));
  assert.deepEqual(readFileSync(join(f.image, 'SECURITY.md')), readFileSync(join(f.built, 'SECURITY.md')));
  verifyDistributionInventory(f.image);
  const before = snapshot(f.image);
  const copied = copyDistribution(f.image, join(f.root, 'copy'), f.expected, '@fixture/renamed');
  assert.deepEqual(copied.facts, made.facts);
  assert.equal(JSON.parse(readFileSync(join(copied.root, 'package.json'), 'utf8')).name, '@fixture/renamed');
  assert.equal(lstatSync(join(copied.root, 'node_modules/koffi/package.json')).nlink, 1);
  const versioned = copyDistribution(f.image, join(f.root, 'versioned'), f.expected, '@fixture/renamed', '0.0.0-canary.20261108.abc1234');
  assert.deepEqual(versioned.facts, made.facts);
  assert.equal(JSON.parse(readFileSync(join(versioned.root, 'package.json'), 'utf8')).version, '0.0.0-canary.20261108.abc1234');
  assert.deepEqual(distributionCommand(versioned.root, { operation: 'validate', source: versioned.root, expected: f.expected }).facts, made.facts);
  assert.throws(() => copyDistribution(f.image, join(f.root, 'bad-version'), f.expected, undefined, '1.0.0+build'), /without build metadata/);
  assert.deepEqual(distributionCommand(f.image, { operation: 'validate', source: f.image, expected: f.expected }).facts, made.facts);
  assert.equal(await buildRelease(f.repo, f.releases, f.expected.source, () => {}, 'production', targets), f.image);
  await assert.rejects(buildRelease(f.repo, f.releases, f.expected.source, () => {}, 'production', ['darwin-arm64']), /requested complete distribution/);
  assert.deepEqual(snapshot(f.image), before);
  assert.deepEqual(readdirSync(f.releases), [f.expected.source]);
});
test('the package carries one notices file with every bundled package and its license text, or assembly fails', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, t => {
  const f = fixture(t), record = (packages: unknown[]) => writeFileSync(join(f.built, 'apps/backend/public/third-party.json'), JSON.stringify(packages));
  const pkg = { license: 'MIT', author: null, repository: null };
  record([{ name: 'bundled-a', version: '1.2.3', ...pkg, texts: [{ file: 'LICENSE', text: 'Copyright (c) Fixture A' }] }]);
  rmSync(join(f.built, 'apps/cli/dist/third-party.json'));
  assert.throws(() => assembleDistribution(f.built, f.image, f.expected), /third-party\.json/);
  rmSync(f.image, { recursive: true, force: true });
  writeFileSync(join(f.built, 'apps/cli/dist/third-party.json'), '[]');
  assembleDistribution(f.built, f.image, f.expected);
  const notices = readFileSync(join(f.image, 'THIRD-PARTY-NOTICES'), 'utf8');
  const backend = JSON.parse(readFileSync(join(f.built, 'apps/backend/dist/third-party.json'), 'utf8')) as { name: string; version: string }[];
  for (const found of [...backend, { name: 'bundled-a', version: '1.2.3' }])
    assert.ok(notices.split('\n').includes(`${found.name} ${found.version}`), `${found.name} is in the notices`);
  assert.match(notices, /Copyright \(c\) Fixture A/);
  assert.equal(existsSync(join(f.image, 'apps/backend/public/third-party.json')), false);
  rmSync(f.image, { recursive: true, force: true });
  record([{ name: 'bundled-c', version: '1.0.0', ...pkg, license: 'Apache-2.0', texts: [] }]);
  assert.throws(() => assembleDistribution(f.built, f.image, f.expected), /bundled-c@1\.0\.0 has no license text/);
});
test('copies trust sealed payloads without running generators, while identity drift is refused', async t => {
  const f = fixture(t); assembleDistribution(f.built, f.image, f.expected);
  // A copy must not execute generators or read/hash every payload after npm integrity verification.
  for (const entry of ['storage-format', 'schema-manifest', 'release/update-capabilities'])
    writeFileSync(join(f.image, 'apps/backend/dist', entry + '.js'), 'throw Error("copy ran a generator");');
  writeFileSync(join(f.image, 'skills/alpacawork/SKILL.md'), 'locally edited after receipt');
  const copied = copyDistribution(f.image, join(f.root, 'copy'), f.expected);
  assert.equal(readFileSync(join(copied.root, 'skills/alpacawork/SKILL.md'), 'utf8'), 'locally edited after receipt');
  for (const file of ['SOURCE', 'FORMAT', 'SCHEMA.json']) {
    const path = join(f.image, file), before = readFileSync(path);
    writeFileSync(path, file === 'SCHEMA.json' ? '{}' : 'b'.repeat(file === 'SOURCE' ? 40 : 64));
    assert.throws(() => copyDistribution(f.image, join(f.root, 'refused-' + file)), /mismatch/);
    assert.equal(existsSync(join(f.root, 'refused-' + file)), false);
    writeFileSync(path, before);
  }
  rmSync(join(f.image, 'DISTRIBUTION.json'));
  await assert.rejects(buildRelease(f.repo, f.releases, f.expected.source, () => {}, 'production', targets), /requested complete distribution/);
});
test('usable permissions survive copy and tar; broken cache permissions are rejected without mutation or repair', async t => {
  const f = fixture(t); assembleDistribution(f.built, f.image, f.expected);
  useRuntime(f.image);
  // Read/execute-only launchers and a read-only image directory are valid: validation needs no image writes.
  for (const bin of ['alpacawork.mjs', 'backend.mjs', 'agent.mjs']) chmodSync(join(f.image, 'bin', bin), 0o500);
  chmodSync(f.image, 0o555);
  try {
    const before = snapshot(f.image);
    validateDistribution(f.image, f.expected);
    const copied = copyDistribution(f.image, join(f.root, 'usable-copy'), f.expected);
    useRuntime(copied.root);
    const tar = join(f.root, 'image.tar'), unpacked = join(f.root, 'unpacked'); mkdirSync(unpacked);
    for (const args of [['-cf', tar, '-C', copied.root, '.'], ['-xf', tar, '-C', unpacked]]) {
      const child = spawnSync('tar', args, { encoding: 'utf8', timeout: 10_000 }); assert.equal(child.status, 0, child.stderr);
    }
    validateDistribution(unpacked, f.expected); useRuntime(unpacked);
    assert.deepEqual(snapshot(f.image), before);
  } finally { chmodSync(f.image, 0o755); }
  for (const file of ['bin/alpacawork.mjs', 'bin/backend.mjs', 'bin/agent.mjs']) {
    const path = join(f.image, file), mode = lstatSync(path).mode & 0o777;
    chmodSync(path, 0o644);
    const before = snapshot(f.image), dest = join(f.root, 'rejected-' + file.replace('/', '-'));
    assert.equal((spawnSync(path, ['--version'], { env: cleanCliEnv(), timeout: 10_000 }).error as NodeJS.ErrnoException | undefined)?.code, 'EACCES');
    assert.throws(() => validateDistribution(f.image, f.expected), /Distribution permissions/);
    assert.throws(() => copyDistribution(f.image, dest, f.expected), /Distribution permissions/);
    await assert.rejects(buildRelease(f.repo, f.releases, f.expected.source, () => {}, 'production', targets), /requested complete distribution/);
    assert.equal(existsSync(dest), false); assert.deepEqual(snapshot(f.image), before);
    chmodSync(path, mode);
  }
});
test('Owner and driver share target set normalization while rejecting duplicates and different sets', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, t => {
  const f = fixture(t);
  for (const [parent, name] of [['koffi', '@koromix/koffi-darwin-arm64'], ['@github/copilot-sdk', '@github/copilot-sdk-darwin-arm64']]) {
    const manifest = join(f.built, 'node_modules', parent!, 'package.json'), pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    pkg.optionalDependencies[name!] = '*'; writeFileSync(manifest, JSON.stringify(pkg));
    const native = join(f.built, 'node_modules', name!); mkdirSync(native, { recursive: true });
    writeFileSync(join(native, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module' }));
    const bytes = Buffer.alloc(24); bytes.write('cffaedfe', 0, 'hex'); bytes.writeUInt32LE(0x0100000c, 4);
    for (const rel of parent === 'koffi' ? ['darwin_arm64/koffi.node'] : ['prebuilds/darwin-arm64/runtime.node', 'prebuilds/darwin-arm64/copilot-runtime']) {
      mkdirSync(dirname(join(native, rel)), { recursive: true }); writeFileSync(join(native, rel), bytes);
    }
  }
  const expected = { ...f.expected, targets: ['linux-x64-glibc', 'darwin-arm64'] as const };
  const made = assembleDistribution(f.built, f.image, expected);
  assert.deepEqual(made.facts.targets, ['darwin-arm64', 'linux-x64-glibc']);
  assert.deepEqual(distributionCommand(f.image, { operation: 'validate', source: f.image, expected }).facts, made.facts);
  const copied = distributionCommand(f.image, { operation: 'copy', source: f.image, destination: join(f.root, 'copy'), expected });
  assert.deepEqual(copied.facts, made.facts);
  for (const invalid of [targets, ['linux-x64-glibc', 'linux-x64-glibc'] as const]) {
    assert.throws(() => distributionCommand(f.image, { operation: 'validate', source: f.image, expected: { ...expected, targets: [...invalid] } }));
    assert.throws(() => validateDistribution(f.image, { ...expected, targets: [...invalid] }));
  }
});
test('switch resume preserves complete public image validation, including missing inventory and runtime permissions', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const f = fixture(t); assembleDistribution(f.built, f.image, f.expected);
  const place = { releases: f.releases, workspace: f.root, service: 'alpacawork-distribution-test-only.service', say() {} };
  const journal = join(f.releases, 'switch.json');
  mkdirSync(join(f.root, '.alpacawork'), { mode: 0o700 });
  saveJournal(place, { version: 4, skillsWriteStarted: false, opId: 'fixture-operation', workspace: f.root, old: null,
    target: f.image, previous: null, phase: 'prepared', schema: 16 });
  const recorded = readFileSync(journal), distribution = join(f.image, 'DISTRIBUTION.json'), bytes = readFileSync(distribution);
  const target = { release: f.image, prepare: async () => { throw Error('resume must not build'); } };
  rmSync(distribution);
  await assert.rejects(switchTo(place, target), /Target distribution validate failed/);
  assert.deepEqual(readFileSync(journal), recorded); writeFileSync(distribution, bytes);
  chmodSync(join(f.image, 'bin/alpacawork.mjs'), 0o644);
  await assert.rejects(switchTo(place, target), /Distribution permissions/);
  assert.deepEqual(readFileSync(journal), recorded);
  chmodSync(join(f.image, 'bin/alpacawork.mjs'), 0o755);
  const manifest = join(f.image, 'package.json'), pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  writeFileSync(manifest, JSON.stringify({ ...pkg, private: true }));
  await assert.rejects(switchTo(place, target), /Invalid distribution identity/);
  assert.deepEqual(readFileSync(journal), recorded);
});
test('target executable errors retain operation context; it is not replaced by the driver implementation', t => {
  const f = fixture(t);
  const entry = join(f.built, 'apps/backend/dist/release/distribution.js');
  writeFileSync(entry, 'throw new Error("target-specific-assembly-fault");');
  assert.throws(() => distributionCommand(f.built, { operation: 'assemble', source: f.built, destination: f.image, expected: f.expected }),
    /Target distribution assemble failed[\s\S]*target-specific-assembly-fault/);
  assert.equal(existsSync(f.image), false);
});

test('archive/extractor failure closes both children and removes only the unpublished stage', async t => {
  const f = fixture(t), bin = join(f.root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'tar'), '#!/bin/sh\nexit 19\n', { mode: 0o700 });
  const previous = process.env.PATH; process.env.PATH = bin + ':' + previous;
  try {
    await assert.rejects(buildRelease(f.repo, f.releases, f.expected.source, () => {}, 'production', targets), /archive\/extract failed/);
    assert.deepEqual(readdirSync(f.releases), []);
  } finally { process.env.PATH = previous; }
});


test('packaged self import and ordinary copy accept writable files, preserve empty directories and source bytes', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, t => {
  const f = fixture(t);
  mkdirSync(join(f.built, 'skills/empty'), { recursive: true });
  assembleDistribution(f.built, f.image, f.expected);
  chmodSync(join(f.image, 'skills/alpacawork/SKILL.md'), 0o666);
  const before = snapshot(f.image), stage = join(f.root, 'stage');
  const result = spawnSync(process.execPath, [join(f.image, 'apps/backend/dist/release/distribution.js'),
    JSON.stringify({ operation: 'import-self', destination: stage, expected: f.expected })], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).root, stage);
  assert.deepEqual(snapshot(f.image), before);
  assert.deepEqual(inventory(stage), before.content);
  assert.ok(lstatSync(join(stage, 'skills/empty')).isDirectory());
  const copy = join(f.root, 'copy'); copyDistribution(stage, copy, f.expected, '@fixture/copy');
  assert.equal(JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8')).name, '@fixture/copy');
  assert.ok(lstatSync(join(copy, 'skills/empty')).isDirectory());
  assert.equal(existsSync(join(copy, 'apps/backend/test-dist')), false);
});
test('README pictures and links open on GitHub, and the packaged README uses versioned image URLs', () => {
  const tracked = new Set(spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).stdout.split('\0'));
  const targets = (text: string) => [...text.matchAll(/(!?)\[[^\]]*\]\(([^)\s]+)\)|\b(src|srcset|href)="([^"]+)"/g)]
    .map(m => ({ picture: m[1] === '!' || ['src', 'srcset'].includes(m[3]!), target: (m[2] ?? m[4])! }));
  for (const readme of readdirSync('.').filter(file => /^README(?:\.[\w-]+)?\.md$/.test(file)))
    for (const { target } of targets(readFileSync(readme, 'utf8')).filter(({ target }) => !/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)))
      assert.ok(tracked.has(target.split(/[?#]/)[0]!), `${readme} links to ${target}, which GitHub cannot open`);
  const source = 'a'.repeat(40);
  const packaged = (file: string) => (/^(?:docs|skills)\//.test(file) && !/^docs\/images\/.*\.gif$/.test(file))
    || ['LICENSE', 'SECURITY.md'].includes(file);
  const npm = npmReadme(readFileSync('README.md', 'utf8'), 'alpacawork', '1.2.3', source,
    'git+https://github.com/alpacakit/alpacawork.git', packaged);
  const unpkg = 'https://unpkg.com/alpacawork@1.2.3/';
  const github = `https://raw.githubusercontent.com/alpacakit/alpacawork/${source}/`;
  for (const { picture, target } of targets(npm).filter(({ target }) => !target.startsWith('#'))) {
    assert.match(target, /^https?:/, target);
    if (picture && !target.startsWith('https://img.shields.io/'))
      assert.ok(target.startsWith(unpkg) || target.startsWith(github), target);
  }
});
test('README responsive pictures use this package version and require a repository for unbundled images', () => {
  const rewrite = (text: string) => npmReadme(text, 'alpacawork', '1.2.3', 'a'.repeat(40), undefined,
    file => ['docs/images/phone.gif', 'docs/images/wide.gif'].includes(file));
  assert.equal(rewrite('<picture><source srcset="./docs/images/wide.gif?theme=dark 1x, docs/images/phone.gif 2x"><img src="docs/images/phone.gif"></picture>'),
    '<picture><source srcset="https://unpkg.com/alpacawork@1.2.3/docs/images/wide.gif?theme=dark 1x, https://unpkg.com/alpacawork@1.2.3/docs/images/phone.gif 2x"><img src="https://unpkg.com/alpacawork@1.2.3/docs/images/phone.gif"></picture>');
  const external = '<source srcset="data:image/gif;base64,R0lGODlh 1x, https://example.com/wide.gif 2x">';
  assert.equal(rewrite(external), external);
  assert.throws(() => rewrite('<source srcset="docs/images/missing.gif">'), /repository/);
});

test('assembly omits documentation image GIFs and pins the packaged README to their source commit',
  { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, t => {
    const f = fixture(t);
    const manifestPath = join(f.built, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const repository = { type: 'git', url: 'git+https://github.com/fixture/project.git' };
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, repository }));
    const gifs = ['docs/images/hero.gif', 'docs/images/hero-dark.gif'];
    for (const gif of gifs) writeFileSync(join(f.built, gif), 'synthetic GIF');
    writeFileSync(join(f.built, 'README.md'), `<picture>
<source media="(prefers-color-scheme: dark)" srcset="${gifs[1]}">
<img src="${gifs[0]}" alt="Overview">
</picture>
![Example](docs/images/example.png)
`);

    assembleDistribution(f.built, f.image, f.expected);

    for (const gif of gifs) assert.equal(existsSync(join(f.image, gif)), false, gif);
    assert.ok(existsSync(join(f.image, 'docs/images/example.png')));
    const readme = readFileSync(join(f.image, 'README.md'), 'utf8');
    const github = `https://raw.githubusercontent.com/fixture/project/${f.expected.source}`;
    assert.ok(readme.includes(`src="${github}/${gifs[0]}"`), readme);
    assert.ok(readme.includes(`srcset="${github}/${gifs[1]}"`), readme);
    assert.ok(readme.includes('https://unpkg.com/fixture@1.0.0/docs/images/example.png'), readme);
});
