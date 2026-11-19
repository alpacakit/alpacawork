/** Copy emitted code into one unpublished fixture build; production assembly owns facts and closure. */
import assert from 'node:assert/strict';
import { cpSync,mkdirSync,readFileSync,readdirSync,realpathSync,lstatSync,writeFileSync,rmSync,renameSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, chmodSync, existsSync } from 'node:fs';
import { preserveTestFailure } from './failure-workspace.ts';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import type { TestContext } from 'node:test';
import { assembleDistribution } from '../../apps/backend/test-dist/release/distribution.js';
import { releaseKind } from '../../apps/backend/test-dist/release/edition.js';
import { PACKAGE_TARGETS } from '../../apps/backend/test-dist/release/package-closure.js';
import { updateCapabilities } from '../../apps/backend/test-dist/release/update-capabilities.js';
export const distributionFixtureTargets = ['linux-x64-glibc'] as const;
export function distributionFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'alpacawork-distribution-'));
  t.after(async () => {
    try { await preserveTestFailure(t, root); } finally {
      // Only directories in this independently created fixture: permit removal of readonly cases.
      const writable = (path: string) => {
        if (!lstatSync(path).isDirectory()) return;
        chmodSync(path, 0o700);
        for (const name of readdirSync(path)) writable(join(path, name));
      };
      writable(root); rmSync(root, { recursive: true, force: true });
    }
  });
  const put = (relative: string, bytes: string | Buffer) => { const path = join(root, relative); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };
  const pkg = (path: string, name: string, extra = {}) => put(path + '/package.json', JSON.stringify({ name, version: '1.0.0', type: 'module', ...extra }));
  const repo = join(root, 'repo'); mkdirSync(repo);
  for (const args of [['init', '-q'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']]) {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  }
  const source = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const built = join(root, 'built'), releases = join(root, 'releases'); mkdirSync(built); mkdirSync(releases);
  pkg('built', 'fixture', { engines: { node: '>=24.16.0' } });
  put('built/SOURCE', source + '\n'); put('built/FORMAT', 'a'.repeat(64) + '\n');
  put('built/SCHEMA.json', '{"control":{"version":16,"migrations":[]},"host":[]}\n');
  cpSync(resolve('apps/backend/dist'), join(built, 'apps/backend/dist'), { recursive: true });
  put('built/apps/backend/dist/storage-format.js', `console.log(${'"' + 'a'.repeat(64) + '"'});`);
  put('built/apps/backend/dist/schema-manifest.js', 'console.log(JSON.stringify({control:{version:16,migrations:[]},host:[]}));');
  put('built/apps/backend/dist/release/update-capabilities.js', 'console.log(' + JSON.stringify(JSON.stringify(updateCapabilities())) + ');');
  put('built/apps/backend/public/index.html', '<script type="module" src="/assets/app.js"></script>');
  put('built/apps/backend/public/assets/app.js', '// fixture'); put('built/apps/backend/public/assets/mermaid.js', '// fixture');
  put('built/apps/backend/public/asset-manifest.json', JSON.stringify({ 'index.html': { file: 'assets/app.js' }, 'mermaid-frame.html': { file: 'assets/mermaid.js' } }));
  for (const output of ['apps/cli/dist', 'apps/agent-cli/dist', 'apps/backend/public']) put('built/' + output + '/third-party.json', '[]');
  put('built/skills/alpacawork/SKILL.md', 'fixture skill');
  put('built/docs/before-you-start.md', '[Getting started](getting-started.md)\n[Security](../SECURITY.md)');
  put('built/docs/getting-started.md', '![Example](images/example.png)');
  put('built/docs/images/example.png', Buffer.from('synthetic image'));
  put('built/SECURITY.md', 'Synthetic security reporting instructions');
  cpSync(resolve('apps/launcher'), join(built, 'apps/launcher'), { recursive: true });
  for (const app of ['backend', 'cli', 'agent-cli']) {
    pkg('built/apps/' + app, '@fixture/' + app, app === 'backend' ? { dependencies: {
      '@alpacawork/core': '*', '@alpacawork/contract': '*', '@github/copilot-sdk': '*', zod: '*',
    } } : {});
    put('built/apps/' + app + '/dist/cli.js', '// fixture');
  }
  pkg('built/node_modules/koffi', 'koffi', { optionalDependencies: { '@koromix/koffi-linux-x64': '*' } });
  pkg('built/node_modules/@github/copilot-sdk', '@github/copilot-sdk', { optionalDependencies: { '@github/copilot-sdk-linux-x64': '*' } });
  pkg('built/node_modules/@koromix/koffi-linux-x64', '@koromix/koffi-linux-x64');
  pkg('built/node_modules/@github/copilot-sdk-linux-x64', '@github/copilot-sdk-linux-x64');
  const native = Buffer.alloc(24); native.write('7f454c46', 0, 'hex'); native[4] = 2; native[5] = 1; native.writeUInt16LE(62, 18);
  put('built/node_modules/@koromix/koffi-linux-x64/linux_x64/koffi.node', native);
  for (const file of ['runtime.node', 'copilot-runtime']) put('built/node_modules/@github/copilot-sdk-linux-x64/prebuilds/linux-x64/' + file, native);
  // Linux startup uses the real POSIX FFI. Keep only Copilot payloads synthetic in this unit fixture.
  const koffi = createRequire(resolve('packages/core/package.json')).resolve('koffi');
  const koffiRoot = dirname(koffi);
  cpSync(koffiRoot, join(built, 'node_modules/koffi'), { recursive: true });
  const nativePackage = createRequire(koffi).resolve.paths('@koromix/koffi-linux-x64')!
    .map(dir => join(dir, '@koromix/koffi-linux-x64')).find(path => existsSync(join(path, 'package.json')))!;
  cpSync(realpathSync(nativePackage), join(built, 'node_modules/@koromix/koffi-linux-x64'), { recursive: true });
  const expected = { source, edition: 'production' as const, targets: [...distributionFixtureTargets] };
  return { root, built, releases, repo, expected, image: join(releases, source) };
}
export function fixtureSource(repo: string): string {
 return process.env.ALPACAWORK_FIXTURE_SOURCE ?? execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8',env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}}).trim();
}
/** Distinct real Git commits with the emitted source tree; objects stay in this disposable fixture only. */
export function fixtureCommit(repo: string, objects: string, label: string, changes: Record<string, string> = {}): string {
  mkdirSync(objects, { recursive: true, mode: 0o700 });
  const git = (args: string[], env = process.env, input?: string) => execFileSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd: repo, env, encoding: 'utf8', input }).trim();
  const source = fixtureSource(repo), common = resolve(repo, git(['rev-parse', '--git-common-dir']));
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_OBJECT_DIRECTORY: objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(common, 'objects'), GIT_INDEX_FILE: join(objects, 'fixture-index'),
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: '2026-11-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-01T00:00:00Z' };
  try {
    git(['read-tree', source], env);
    for (const [file, bytes] of Object.entries(changes)) {
      const blob = git(['hash-object', '-w', '--stdin'], env, bytes);
      git(['update-index', '--add', '--cacheinfo', '100644', blob, file], env);
    }
    const tree = git(['write-tree'], env);
    return git(['commit-tree', tree, '-p', source], env, 'Recovery fixture ' + label + '\n');
  } finally { rmSync(env.GIT_INDEX_FILE, { force: true }); }
}
export function assembleFixtureDistribution(repo: string,built: string,release: string,sha=fixtureSource(repo),prepare?: (built:string)=>void) {
  // Without a prepare step the image depends only on the checkout and SOURCE: copy the one sealed in this process.
  const sealed = prepare ? undefined : spareFor(repo).images.get(sha);
  if (sealed) { copyImage(sealed.path, release); return sealed.counts; }
  const counts = assembleOnce(repo, built, release, sha, prepare);
  if (!prepare) {
    const spare = spareFor(repo), path = join(spare.parent, 'images', sha);
    mkdirSync(dirname(path), { recursive: true }); copyImage(release, path); spare.images.set(sha, { path, counts });
  }
  return counts;
}
// cp -a keeps the sealed directory and file modes that cpSync would reset to the umask.
const copyImage = (from: string, to: string) => execFileSync('cp', ['-a', from, to]);
function assembleOnce(repo: string,built: string,release: string,sha: string,prepare?: (built:string)=>void) {
  mkdirSync(built,{recursive:true});
  for (const folder of ['apps/backend', 'apps/cli', 'apps/agent-cli', 'packages/core', 'packages/raw', 'packages/contract', 'packages/db', 'packages/runs', 'packages/cli-kit']) {
    mkdirSync(join(built, folder), { recursive: true });
    cpSync(join(repo, folder, 'dist'), join(built, folder, 'dist'), { recursive: true });
    cpSync(join(repo, folder, 'package.json'), join(built, folder, 'package.json'));
    cpSync(join(repo, folder, 'node_modules'), join(built, folder, 'node_modules'), { recursive: true, verbatimSymlinks: true });
  }
  const reused = takeSpareModules(repo, join(built, 'node_modules'));
  if (!reused) cpSync(join(repo, 'node_modules'), join(built, 'node_modules'), { recursive: true, verbatimSymlinks: true });
  cpSync(join(repo, 'packages/db/drizzle'), join(built, 'packages/db/drizzle'), { recursive: true });
  cpSync(join(repo, 'package.json'), join(built, 'package.json'));
  for (const folder of ['apps/web', 'packages/i18n']) { mkdirSync(join(built, folder), { recursive: true }); cpSync(join(repo, folder, 'package.json'), join(built, folder, 'package.json')); }
  const modules = join(built, 'node_modules');
  function audit(path: string, counts: SpareModules) {
    for (const name of readdirSync(path)) {
      const file = join(path, name), info = lstatSync(file), original = join(repo, file.slice(built.length + 1));
      if (file === modules) {
        // A reused tree passed this audit when it was copied, and assembly only reads it.
        Object.assign(moduleCounts, reused ?? audit(file, { ordinaryFiles: 0, internalLinks: 0 }));
        continue;
      }
      if (info.isSymbolicLink()) { assert.ok(realpathSync(file).startsWith(built + '/'), file); counts.internalLinks++; }
      else if (info.isDirectory()) audit(file, counts);
      else {
        const from = lstatSync(original, { throwIfNoEntry: false });
        if (from) assert.notDeepEqual([info.dev, info.ino], [from.dev, from.ino], file);
        if (file.includes('/.bin/')) { const bytes = readFileSync(file); if (bytes.includes(Buffer.from(repo))) writeFileSync(file, bytes.toString().replaceAll(repo, built)); }
        counts.ordinaryFiles++;
      }
    }
    return counts;
  }
  const moduleCounts: SpareModules = { ordinaryFiles: 0, internalLinks: 0 };
  const rest = audit(built, { ordinaryFiles: 0, internalLinks: 0 });
  const ordinaryFiles = rest.ordinaryFiles + moduleCounts.ordinaryFiles, internalLinks = rest.internalLinks + moduleCounts.internalLinks;
  mkdirSync(join(built, 'scripts'), {recursive:true});
  for (const file of ['app-root.mjs','runtime-roots.mjs']) cpSync(join(repo,'scripts',file),join(built,'scripts',file));
  for (const folder of ['apps/backend/public', 'apps/launcher', 'skills', 'docs'])
    cpSync(join(repo, folder), join(built, folder), { recursive: true });
  for (const file of ['README.md', 'SECURITY.md']) cpSync(join(repo, file), join(built, file));
  prepare?.(built);
  // Build facts and closure come from the same emitted checkout, through the production assembly Owner.
  writeFileSync(join(built, 'SOURCE'), sha + '\n');
  for (const [file, entry] of [['FORMAT', 'storage-format.js'], ['SCHEMA.json', 'schema-manifest.js']])
    writeFileSync(join(built, file!), execFileSync(process.execPath, [join(built, 'apps/backend/dist', entry!)], { encoding: 'utf8' }));
  assembleDistribution(built, release, { source: sha, edition: releaseKind(built), targets: [...distributionFixtureTargets] });
  keepSpareModules(repo, modules, moduleCounts);
  rmSync(built, { recursive: true });
  return { ordinaryFiles, internalLinks };
}
/**
 * The repo node_modules copy (about 1 GB) dominates assembly. Runtime closure only reads it, so one copy per
 * test process moves from build to build by rename. Sealed images without a prepare step are kept beside it and
 * only ever copied out. Both are removed when the process exits.
 */
type SpareModules = { ordinaryFiles: number; internalLinks: number };
type Spare = { parent: string; path: string; counts: SpareModules | null; images: Map<string, { path: string; counts: SpareModules }> };
const spares = new Map<string, Spare>();
function spareFor(repo: string): Spare {
  let spare = spares.get(repo);
  if (!spare) {
    const parent = mkdtempSync(join(tmpdir(), 'alpacawork-fixture-reuse-'));
    process.once('exit', () => rmSync(parent, { recursive: true, force: true }));
    spare = { parent, path: join(parent, 'node_modules'), counts: null, images: new Map() }; spares.set(repo, spare);
  }
  return spare;
}
function takeSpareModules(repo: string, target: string): SpareModules | null {
  const spare = spareFor(repo), counts = spare.counts;
  if (!counts) return null;
  try { renameSync(spare.path, target); } catch { return null; }
  spare.counts = null;
  return counts;
}
function keepSpareModules(repo: string, modules: string, counts: SpareModules) {
  const spare = spareFor(repo);
  if (spare.counts) return;
  try { renameSync(modules, spare.path); spare.counts = counts; } catch { /* Another filesystem: the build removal below owns it. */ }
}
/** npm reads any gzip level; level 1 packs a 150 MB image in about a third of tar's default time. */
export function npmTarball(archive: string, tarArgs: string[], cwd?: string) {
  const plain = archive + '.tar';
  execFileSync('tar', ['-cf', plain, ...tarArgs], { cwd });
  writeFileSync(archive, gzipSync(readFileSync(plain), { level: 1 })); rmSync(plain);
}
