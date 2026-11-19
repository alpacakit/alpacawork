import { backendEntry, type BACKEND_ENTRIES } from '../app-paths.js';
/** Commit acquisition/build and atomic release publication. The target executable owns distribution rules. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROBLEM_CODE, Problem } from '@alpacawork/core';
import { releaseKind, releasePath, validateRelease, type ReleaseKind } from './layout.js';
import { PACKAGE_TARGETS, parseTargets, type PackageTarget } from './package-closure.js';
import { packageEnvironment } from './package-facts.js';
import { distributionCommand } from './distribution-driver.js';
import { importSelfDistribution, type DistributionIdentity } from './distribution.js';

function completed(child: ChildProcess, label: string): Promise<void> {
  return new Promise((done, failed) => {
    let fault: Error | undefined;
    child.once('error', error => { fault = error; });
    child.once('close', (code, signal) => code === 0 && !fault ? done()
      : failed(new Error(`${label} failed: ${fault?.message ?? signal ?? `exit ${code}`}`, { cause: fault })));
  });
}
async function step(command: string, args: string[], cwd: string): Promise<void> {
  await completed(spawn(command, args, { cwd, env: packageEnvironment(), stdio: ['ignore', 2, 2] }), `${command} ${args.join(' ')}`);
}
/** A failed archive or extractor cancels its sibling; both close before the stage can be removed. */
async function archiveCommit(repo: string, sha: string, work: string): Promise<void> {
  const archive = spawn('git', ['-C', repo, 'archive', sha], { stdio: ['ignore', 'pipe', 2] });
  const tar = spawn('tar', ['-x', '-C', work], { stdio: ['pipe', 2, 2] });
  archive.stdout!.pipe(tar.stdin!);
  tar.stdin!.on('error', () => { archive.kill('SIGTERM'); });
  const siblings = [archive, tar];
  const results = await Promise.allSettled(siblings.map((child, i) => completed(child, i === 0 ? 'git archive' : 'tar extract')
    .catch(error => { for (const sibling of siblings) if (sibling !== child) sibling.kill('SIGTERM'); throw error; })));
  const faults = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (faults.length) throw new AggregateError(faults, 'Release archive/extract failed');
}
function generated(work: string, entry: keyof typeof BACKEND_ENTRIES): string {
  const result = spawnSync(process.execPath, [backendEntry(entry, work)], {
    cwd: work, env: packageEnvironment(), encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(`Release ${entry} failed: ${result.error?.message ?? result.stderr}`, { cause: result.error });
  return result.stdout;
}

/** Resolve a ref before entering the switch. The resulting SHA also pins a later build of a movable ref. */
function resolveRelease(repo: string, releases: string, ref: string, kind: ReleaseKind = 'production') {
  const rev = spawnSync('git', ['-C', repo, 'rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' });
  const sha = rev.stdout.trim();
  if (rev.status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) throw new Problem(PROBLEM_CODE.invalidInput, `Not a commit in ${repo}: ${ref}`);
  return { sha, release: releasePath(releases, {source:sha, edition:kind}) };
}
/** One publication/reuse boundary for repository builds and installed-package setup.
 * The caller holds holdReleases; producers only populate the private image in this root. */
export async function publishRelease(releases: string, identity: DistributionIdentity, say: (line: string) => void,
  prepare: (stage: string, image: string) => Promise<void>): Promise<string> {
  const expected = { ...identity, targets: parseTargets(identity.targets.join(',')) };
  const release = releasePath(releases, expected);
  if (existsSync(release)) {
    try {
      validateRelease(releases, release, expected.edition);
      // No chmod, repair, missing lease creation or legacy conversion at this boundary.
      distributionCommand(release, { operation: 'validate', source: release, expected });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cause = message.split('\n').find(line => /^[A-Za-z]*Error:/.test(line)) ?? message.split('\n')[0];
      throw new Problem(PROBLEM_CODE.conflict, `Existing release is not the requested complete distribution: ${release}. Kept unchanged; keep current/previous and pending releases. For normal deploy, use another commit, roll back to a usable previous, or prune unused releases normally. Separate roots are for target-specific tests/pack.`, {
        cause,
      }, { cause: error });
    }
    say(`release ${expected.source} is already built`); return release;
  }
  const stage = mkdtempSync(join(releases, `.stage-${expected.source.slice(0, 12)}-`));
  let published = false, fault: unknown;
  try {
    const image = join(stage, 'image');
    await prepare(stage, image);
    // A producer cannot publish an unchecked image, including after a future producer change.
    distributionCommand(image, { operation: 'validate', source: image, expected });
    renameSync(image, release); published = true;
  } catch (error) { fault = error; }
  try { rmSync(stage, { recursive: true, force: true }); }
  catch (cleanup) {
    throw new AggregateError(fault === undefined ? [cleanup] : [fault, cleanup],
      published ? `Release published at ${release}; stage cleanup failed` : `Release publication failed; stage cleanup failed at ${stage}`);
  }
  if (fault !== undefined) throw fault;
  say(`built ${release}`); return release;
}

/** Imports only the package owning this executable; never executes or repairs the npm input. */
export async function publishSelfRelease(releases: string, expected: DistributionIdentity, say: (line: string) => void): Promise<string> {
  return publishRelease(releases, expected, say, async (stage, image) => {
    say(`Importing installed application into ${image}; temporary stage: ${stage}. If interrupted, inspect this exact stage before removing it.`);
    importSelfDistribution({ destination: image, expected });
  });
}
export async function buildRelease(repo: string, releases: string, ref: string, say: (line: string) => void,
  kind: ReleaseKind = 'production', requestedTargets: readonly PackageTarget[] = PACKAGE_TARGETS): Promise<string> {
  const targets = parseTargets(requestedTargets.join(','));
  const { sha } = resolveRelease(repo, releases, ref, kind), expected = { source: sha, edition: kind, targets };
  return publishRelease(releases, expected, say, async (stage, image) => {
    const work = join(stage, 'work');
    mkdirSync(work);
    say(`building ${sha} in ${stage}`);
    await archiveCommit(repo, sha, work);
    writeFileSync(join(work, 'SOURCE'), `${sha}\n`);
    await step('pnpm', ['install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--package-import-method=copy'], work);
    // Exercise the same pnpm/script boundary as build: its Node must be the one running this driver.
    await step('pnpm', ['exec', 'node', '--eval',
      `if(process.version!==${JSON.stringify(process.version)})throw new Error('Build Node '+process.version+' differs from release driver '+${JSON.stringify(process.version)});`], work);
    say(`build Node ${process.version} (${process.execPath})`);
    await step('pnpm', [kind === 'diagnostic' ? 'build:diagnostic' : 'build'], work);
    if (releaseKind(work) !== kind) throw new Error('Built release kind/content mismatch');
    writeFileSync(join(work, 'FORMAT'), generated(work, 'storage-format'));
    writeFileSync(join(work, 'SCHEMA.json'), generated(work, 'schema-manifest'));
    const started = performance.now();
    distributionCommand(work, { operation: 'assemble', source: work, destination: image, expected });
    say(`assembled ${sha} in ${((performance.now() - started) / 1000).toFixed(3)}s`);
    rmSync(work, { recursive: true, force: true });
  });
}
