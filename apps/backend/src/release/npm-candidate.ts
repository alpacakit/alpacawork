import { backendEntry } from '../app-paths.js';
/** Observe and acquire pinned npm releases; publication identity belongs to publishRelease. */
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fetchNpmMetadata, type NpmMetadataIdentity, type NpmMetadataRequest } from './npm-registry.js';
import { downloadNpmTarball } from './npm-download.js';
import { extractNpmArchive } from './npm-archive.js';
import { npmArguments, runNpmProcess } from './npm-process.js';
import { linkTarget, releaseName, releasePath, type ReleaseKind } from './layout.js';
import { digest, syncTree, verifyDistributionInventory } from './package-files.js';
import { parseTargets, readManifest } from './package-closure.js';

import type { PackageFacts } from './package-facts.js';
import { updateCapabilitiesSchema, NPM_RECORD_VERSION, object, id, sha256, schemaFacts, stable, publishProvenance, CandidateRejection, reject,
  type CandidateEnvironment, type NpmCandidate, type HumanConfirmedNpmCandidate, type CandidateFailure, type CandidateResult } from './npm-records.js';
export type { CandidateEnvironment, NpmCandidate, HumanConfirmedNpmCandidate, CandidateFailure, CandidateResult } from './npm-records.js';
import { assertAcquisitionLocked, updateDecision } from './update-operation.js';
import { holdReleases } from './layout.js';
import { publishRelease } from './build.js';
function directory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) reject('io_failed');
}
function rootPath(releases: string): string {
  if (!isAbsolute(releases)) reject('invalid_input');
  return realpathSync(releases);
}
function active(root: string, expected: string | null): void {
  if (linkTarget(root, 'current') !== expected) reject('expected_active_changed');
}
function candidateFrom(metadata: Record<string, unknown>, identity: NpmMetadataIdentity, environment: CandidateEnvironment,
  candidateId: string, expectedActive: string | null): NpmCandidate {
  if (metadata.deprecated) reject('candidate_withdrawn');
  const facts = metadata.alpacawork, dist = metadata.dist, engines = metadata.engines;
  if (!object(facts) || !object(dist) || !object(engines) || typeof engines.node !== 'string' || !engines.node ||
    typeof facts.source !== 'string' || !/^[a-f0-9]{40}$/.test(facts.source) ||
    facts.edition !== 'production' && facts.edition !== 'diagnostic' || typeof facts.format !== 'string' || !facts.format ||
    !object(facts.schema) || !object(facts.skills) || !sha256(facts.skills.sha256) ||
    !Array.isArray(facts.targets) || !facts.targets.every(t => typeof t === 'string')) reject('metadata_unknown');
  try {
    parseTargets((facts.targets as string[]).join(','));
    schemaFacts.parse(facts.schema);
    updateCapabilitiesSchema.parse(facts.update);
  } catch { reject('metadata_unknown'); }
  if (facts.edition !== environment.edition || !(facts.targets as string[]).includes(environment.target)) reject('metadata_unknown');
  if (typeof dist.tarball !== 'string' || typeof dist.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(dist.integrity)) reject('metadata_unknown');
  const integrity = dist.integrity as string;
  if (Buffer.from(integrity.slice(7), 'base64').toString('base64') !== integrity.slice(7)) reject('metadata_unknown');
  let url: URL;
  try { url = new URL(dist.tarball as string); } catch { return reject('metadata_unknown'); }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && url.protocol !== 'http:')) reject('metadata_unknown');
  // npm view merges these packument-wide fields into a version response. Moving latest/time alone is not version replacement.
  // npm view merges pacote's response Content-Length into the selected version.
  // That transport observation changes with other versions/tags, not this version's content.
  const { 'dist-tags': _tags, versions: _versions, time: _time, _contentLength: _responseLength, ...versionMetadata } = metadata;
  return { version: NPM_RECORD_VERSION, candidateId, registryOrigin: identity.registryOrigin, packageName: identity.packageName,
    exactVersion: metadata.version as string, tarball: dist.tarball as string, integrity,
    metadataDigest: digest(stable(versionMetadata)), edition: facts.edition as ReleaseKind,
    facts: facts as PackageFacts, engines: { node: engines.node as string }, environment: structuredClone(environment), expectedActive, changes: 'unknown' };
}
function failure(error: unknown): CandidateResult<never> {
  const detail=error instanceof CandidateRejection?error.cause:error;
  const code=object(detail)&&typeof detail.code==='string'?detail.code:object(detail)&&typeof detail.npmCode==='string'?detail.npmCode:undefined;
  return { ok: false, error: { kind: error instanceof CandidateRejection ? error.kind : 'io_failed', ...(code&&/^[A-Z0-9_]{1,64}$/.test(code)?{cause:code}:{}),fault: error } };
}
export async function observeNpmCandidate(input: { releases: string; candidateId: string; expectedActive: string | null;
  registry: NpmMetadataRequest; environment: CandidateEnvironment }): Promise<CandidateResult<NpmCandidate>> {
  try {
    if (!id(input.candidateId) || !/^v?\d+\.\d+\.\d+/.test(input.environment.managedNodeVersion)) reject('invalid_input');
    const metadata = await fetchNpmMetadata(input.registry);
    if (metadata.ok === false) return { ok: false, error: { kind: 'metadata_failed', cause: metadata.error.npmCode??metadata.error.kind, httpStatus: metadata.error.httpStatus } };
    const candidate = candidateFrom(metadata.metadata, metadata.identity, input.environment, input.candidateId, input.expectedActive);
    if (existsSync(input.releases)) active(rootPath(input.releases), input.expectedActive);
    else if (input.expectedActive !== null) reject('expected_active_changed');
    return { ok: true, value: candidate };
  } catch (error) { return failure(error); }
}

// A non-success outcome may retain an immutable publication. Replay the same bound operation;
// fresh exact metadata and the common distribution identity validate reuse. Failure never implies absence.
export async function stageConfirmedNpmCandidate(input: { releases: string; confirmation: HumanConfirmedNpmCandidate;
  registry: NpmMetadataRequest; signal?: AbortSignal; deadlineMs?: number; maxTarballBytes?: number; maxExpandedBytes?: number;
}): Promise<CandidateResult<{ candidate: NpmCandidate; release: string; sha256: string | null; bytes: number | null }>> {
  try {
    const confirmation = { version: NPM_RECORD_VERSION, ...structuredClone(input.confirmation) };
    if (!id(confirmation.candidateId) || !id(confirmation.opId)) reject('invalid_input');
    const root = rootPath(input.releases);
    const candidate = updateDecision(root, () => assertAcquisitionLocked(root, confirmation));
    return await acquireNpmCandidate({ ...input, candidate, guard: () => { assertAcquisitionLocked(root, confirmation); } });
  } catch (error) { return failure(error); }
}
/** Acquisition accepts a pinned candidate; a screen operation may additionally guard its own authority.
 * CLI acquisition does not manufacture screen authorization or an update offer. */
export async function acquireNpmCandidate(input: { releases: string; candidate: NpmCandidate; registry: NpmMetadataRequest;
  guard?: () => void; signal?: AbortSignal; deadlineMs?: number; maxTarballBytes?: number; maxExpandedBytes?: number;
}): Promise<CandidateResult<{ candidate: NpmCandidate; release: string; sha256: string | null; bytes: number | null }>> {
  const deadline = input.deadlineMs ?? 300000, maxBytes = input.maxTarballBytes ?? 128 * 1024 * 1024;
  const maxExpanded = input.maxExpandedBytes ?? 1024 * 1024 * 1024;
  if (![deadline, maxBytes, maxExpanded].every(n => Number.isSafeInteger(n) && n > 0) || deadline > 300000 ||
    maxBytes < 1024 || maxBytes > 512 * 1024 * 1024 || maxExpanded > 2 * 1024 * 1024 * 1024) return failure(new CandidateRejection('invalid_input'));
  let root: string;
  try { root = rootPath(input.releases); } catch (error) { return failure(error); }
  let stage: string | undefined, result: CandidateResult<{ candidate: NpmCandidate; release: string; sha256: string | null; bytes: number | null }>;
  const controller = new AbortController();
  let stop: 'deadline' | 'aborted' | undefined;
  const abort = () => { stop ??= 'aborted'; controller.abort(); };

  const expiresAt = Date.now() + deadline;
  const stopped = () => {
    // Events cannot run during synchronous publication/cleanup. Observe the inputs again at completion.
    if (input.signal?.aborted) abort();
    if (Date.now() >= expiresAt) { stop ??= 'deadline'; controller.abort(); }
    return stop;
  };
  const check = () => { const reason = stopped(); if (reason) reject(reason); };
  const timer = setTimeout(() => { stop ??= 'deadline'; controller.abort(); }, deadline);
  input.signal?.addEventListener('abort', abort, { once: true }); if (input.signal?.aborted) abort();
  try {
    result = await (async (): Promise<typeof result> => {
    const gate = <T>(work: (candidate: NpmCandidate) => T) => updateDecision(root, () => {
      input.guard?.(); active(root, input.candidate.expectedActive); return work(input.candidate);
    });
    const publish = async (prepare: (stage: string, image: string) => Promise<void>) => {
      const unlock = holdReleases(root);
      try {
        input.guard?.(); active(root, input.candidate.expectedActive); check();
        return await publishRelease(root, { source: input.candidate.facts.source, edition: input.candidate.edition,
          targets: input.candidate.facts.targets }, () => {}, prepare);
      } catch (cause) { if (cause instanceof CandidateRejection) throw cause; reject('stage_conflict', cause); }
      finally { unlock(); }
    };
    const candidate = await gate(candidate => candidate);
    if (candidate.packageName !== input.registry.packageName)
      reject('confirmation_mismatch');
    check();
    const metadata = await fetchNpmMetadata({ ...input.registry, selector: candidate.exactVersion, signal: controller.signal });
    if (metadata.ok === false) {
      if (metadata.error.kind === 'cleanup_failed') reject('cleanup_failed');
      if (stop) reject(stop);
      return { ok: false, error: { kind: 'metadata_failed', cause: metadata.error.npmCode??metadata.error.kind, httpStatus: metadata.error.httpStatus } };
    }
    const current = candidateFrom(metadata.metadata, metadata.identity, candidate.environment, candidate.candidateId, candidate.expectedActive);
    if (!isDeepStrictEqual(current, candidate)) reject('metadata_changed');
    const target = releasePath(root, {source:candidate.facts.source, edition:candidate.edition});
    // Publication identity belongs to publishRelease. npm provenance is evidence, never a second identity.
    if (existsSync(target)) {
      const release = await publish(async () => { throw new Error('Existing release disappeared; retry acquisition'); });
      check();
      return { ok: true, value: { candidate, release, sha256: null, bytes: null } };
    }
    stage = mkdtempSync(join(root, '.npm-stage-'));
    const downloaded = await downloadNpmTarball(input.registry, candidate, stage, controller.signal, maxBytes);
    if (downloaded.ok === false) {
      if (downloaded.kind === 'cleanup_failed') reject('cleanup_failed');
      if (stop) reject(stop);
      return { ok: false, error: { kind: downloaded.kind === 'integrity_mismatch' || 'npmCode' in downloaded && downloaded.npmCode === 'EINTEGRITY' ? 'integrity_mismatch' : 'download_failed',
        cause: 'npmCode' in downloaded?downloaded.npmCode??downloaded.kind:downloaded.kind, ...('httpStatus' in downloaded && { httpStatus: downloaded.httpStatus }) } };
    }
    check();
    let unpacked: string;
    try { unpacked = await extractNpmArchive(downloaded.file, stage, { maxExpandedBytes: maxExpanded, maxEntries: 50000, signal: controller.signal }); }
    catch { if (stop) reject(stop); return failure(new CandidateRejection('archive_invalid')); }
    const manifest = readManifest(unpacked);
    if (manifest.name !== candidate.packageName || manifest.version !== candidate.exactVersion ||
      !isDeepStrictEqual(manifest.engines, candidate.engines)) reject('validation_failed');
    const home = join(stage, 'home'); directory(home); directory(join(stage, 'tmp'));
    const validationEnvironment = { HOME: home, TMPDIR: join(stage, 'tmp'),
      PATH: dirname(input.registry.nodeExecutable) + ':/usr/bin:/bin', LANG: 'C' };
    // All members have now passed our path/link/special/size checks. npm may place only these verified bytes.
    // Separate empty config + offline forbid credentials, hooks and dependency repair from the network.
    const userConfig = join(stage, 'offline-user.npmrc'), globalConfig = join(stage, 'offline-global.npmrc');
    writeFileSync(userConfig, ''); writeFileSync(globalConfig, '');
    const prefix = join(stage, 'prefix'), tarball = join(stage, 'verified.tgz');
    copyFileSync(downloaded.file, tarball);
    const installed = await runNpmProcess({ nodeExecutable: input.registry.nodeExecutable, npmCli: input.registry.npmCli,
      cwd: stage, environment: validationEnvironment, signal: controller.signal, maxStdoutBytes: 1024 * 1024, maxFileBytes: maxExpanded,
      args: [...npmArguments({ userConfig, globalConfig }, stage), '--offline=true', '--engine-strict=true', '--bin-links=false', '--package-lock=false',
        '--json', 'install', '--global', `--prefix=${prefix}`, tarball] });
    if (installed.ok === false) { if (installed.kind === 'cleanup_failed') reject('cleanup_failed'); if (stop) reject(stop); reject('validation_failed',installed); }
    unpacked = join(prefix, 'lib/node_modules', candidate.packageName);
    const facts = join(stage, 'expected-facts.json'); writeFileSync(facts, JSON.stringify(candidate.facts));
    const validated = await runNpmProcess({ nodeExecutable: input.registry.nodeExecutable,
      npmCli: backendEntry('release/npm-validate'), args: [unpacked, facts], cwd: stage,
      environment: validationEnvironment,
      signal: controller.signal, maxStdoutBytes: 1024, maxFileBytes: maxExpanded });
    if (validated.ok === false) { if (validated.kind === 'cleanup_failed') reject('cleanup_failed'); if (stop) reject(stop); reject('validation_failed'); }
    check();
    let tree: ReturnType<typeof verifyDistributionInventory>;
    try { tree = verifyDistributionInventory(unpacked); }
    catch (cause) { reject('validation_failed', cause); }
    const provenance = { version: NPM_RECORD_VERSION, registryOrigin: candidate.registryOrigin, packageName: candidate.packageName,
      exactVersion: candidate.exactVersion, tarball: candidate.tarball, integrity: candidate.integrity, sha256: downloaded.sha256,
      bytes: downloaded.bytes, treeDigest: digest(stable(tree)) };
    check();
    syncTree(unpacked); check();
    await publish(async (_publicationStage, image) => {
      // The common publication Owner validates and renames this private image.
      renameSync(unpacked, image);
      publishProvenance(root, releaseName(candidate.facts.source, candidate.edition), provenance);
    });
    return { ok: true, value: { candidate, release: target, sha256: downloaded.sha256, bytes: downloaded.bytes } };
    })();
  } catch (error) {
    result = failure(error);
  }
  finally {
    if (stage) try { rmSync(stage, { recursive: true, force: true }); } catch (error) { result = failure(new CandidateRejection('cleanup_failed', error)); }
    clearTimeout(timer); input.signal?.removeEventListener('abort', abort);
  }
  // One completion decision, after publication validation, every lock release and resource cleanup.
  // Cleanup failure outranks cancellation; otherwise the first observed abort/deadline outranks the operation result.
  const reason = stopped();
  return result!.ok === false && result!.error.kind === 'cleanup_failed' ? result!
    : reason ? failure(new CandidateRejection(reason)) : result!;
}
