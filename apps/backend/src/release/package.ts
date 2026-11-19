/** Local npm distribution adapter. buildRelease is the only commit-to-build Owner. No service/DB/skill installation. */
import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { buildRelease } from './build.js';
import { type ReleaseKind } from './edition.js';
import { packageName, packageVersion, PACKAGE_TARGETS, parseTargets, readManifest, type PackageTarget } from './package-closure.js';
import { digest, regular, verifyDistributionInventory } from './package-files.js';
import { packageEnvironment } from './package-facts.js';
import { distributionCommand } from './distribution-driver.js';

export type PackOptions = { repo: string; releases: string; ref: string; name: string; version?: string; output: string;
  kind?: ReleaseKind; targets?: PackageTarget[]; say?: (line: string) => void };
export async function packRelease(options: PackOptions) {
  packageName(options.name);
  if (options.version !== undefined) packageVersion(options.version);
  const targets = parseTargets((options.targets ?? [...PACKAGE_TARGETS]).join(','));
  const kind = options.kind ?? 'production', say = options.say ?? (() => {});
  mkdirSync(options.releases, { recursive: true }); mkdirSync(options.output, { recursive: true });
  const releases = realpathSync(options.releases), output = realpathSync(options.output);
  const release = await buildRelease(resolve(options.repo), releases, options.ref, say, kind, targets);
  const stage = mkdtempSync(join(output, '.npm-stage-'));
  let complete = false;
  say(`assembling npm package in ${stage}`);
  try {
    const root = join(stage, 'package');
    const source = readFileSync(join(release, 'SOURCE'), 'utf8').trim();
    const expected = { source, edition: kind, targets };
    const { facts } = distributionCommand(release, { operation: 'copy', source: release, destination: root, expected, name: options.name,
      ...(options.version === undefined ? {} : { version: options.version }) });
    const pkg = readManifest(root);
    // Use npm belonging to this exact Node installation. No shell, user config, install hooks or registry.
    const npm = realpathSync(join(process.execPath, '..', 'npm'));
    const userConfig = join(stage, 'user.npmrc'), globalConfig = join(stage, 'global.npmrc');
    writeFileSync(userConfig, ''); writeFileSync(globalConfig, '');
    const result = spawnSync(process.execPath, [npm, 'pack', root, '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
      '--json', '--pack-destination', stage, '--cache', join(stage, 'cache'), '--userconfig', userConfig, '--globalconfig', globalConfig],
    { cwd: stage, env: packageEnvironment(), encoding: 'utf8', timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(`Local npm pack failed: ${result.error?.message ?? result.stderr}`);
    const packed = JSON.parse(result.stdout) as { filename: string }[];
    if (packed.length !== 1 || !packed[0]?.filename || basename(packed[0].filename) !== packed[0].filename) throw new Error('Invalid npm pack result');
    const temporary = join(stage, packed[0].filename); regular(temporary);
    const unpacked = join(stage, 'unpacked'); mkdirSync(unpacked);
    const extracted = spawnSync('tar', ['-xzf', temporary, '-C', unpacked], { encoding: 'utf8', timeout: 60_000 });
    if (extracted.error || extracted.status !== 0) throw new Error(`Cannot inspect packed artifact: ${extracted.error?.message ?? extracted.stderr}`);
    const unpackedImage = distributionCommand(release, { operation: 'validate', source: join(unpacked, 'package'), expected });
    verifyDistributionInventory(join(unpacked, 'package'));
    if (!isDeepStrictEqual(unpackedImage.facts, facts)) throw new Error('Packed distribution facts changed');
    const bytes = readFileSync(temporary), sha256 = digest(bytes);
    const tarball = join(output, `${encodeURIComponent(options.name)}-${pkg.version}.tgz`);
    // npm identity is name@version. An edition/target/source change needs a different name/version or is a conflict.
    try { linkSync(temporary, tarball); unlinkSync(temporary); }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      regular(tarball);
      if (digest(readFileSync(tarball)) !== sha256) throw new Error(`Distribution identity already exists with different bytes: ${tarball}`);
    }
    say(`packed ${tarball}`);
    complete = true;
    return { tarball, bytes: bytes.length, sha256, source: facts.source, edition: facts.edition, targets: facts.targets };
  } catch (error) {
    // Keep failed assembly evidence just as a caller-owned diagnostic, never advertise it as a release/candidate.
    say(`npm assembly failed; evidence retained at ${stage}`);
    throw new Error(`npm assembly failed: ${error instanceof Error ? error.message : String(error)}; evidence retained at ${stage}`, { cause: error });
  } finally {
    if (complete) rmSync(stage, { recursive: true, force: true });
  }
}
