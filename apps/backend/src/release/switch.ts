import { atomicJson } from './atomic-json.js';
import { completeUpdateSkills } from './update-skills.js';
import { backendEntry } from '../app-paths.js';
import { installationService, checkedInstallationService } from '../installation/setup.js';
import { FileWriter } from '../raw/storage.js';
import { provenanceDirectory } from './npm-records.js';
import { pendingUpdateReferences } from './npm-retention.js';
/** Deploy is a durable handshake and switch journal. A selected symlink is not readiness. */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PROBLEM_CODE, Problem, platform, tryLock, hasCode, type ServiceDefinition } from '@alpacawork/core';
import { parseControlSchema, sameControlSchema, canMigrateControlSchema, parseMigrationHistory, migrationPrefix, type ControlSchema, type MigrationIdentity, holdControlWriter, assertControlWriterAvailable, syncFile, fileHash } from '@alpacawork/db';
import { connectionPath, readConnection } from '@alpacawork/contract/connection';
import type { UpdateRunConflict } from '@alpacawork/contract';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { controlDatabasePath } from '@alpacawork/db';
import { executionReferences } from '../runs/execution-control.js';
import { validateRelease, type ReleaseKind, builtReleases, linkTarget, point, readFormat, users } from './layout.js';
import { distributionCommand } from './distribution-driver.js';
import { parseTargets, readManifest } from './package-closure.js';
import { runMaintenance } from './maintenance-process.js';

import { loadJournal as load, saveJournal as save, terminal, recovering, RECOVERY_PROTOCOL, publishRestoreIdentity, canRestorePreviousApplication, type SwitchJournal, type RecoveryGrant, workspaceJournal, releaseAdmission, newJournalVersion } from './journal.js';
import { readUpdateRecord, controllerAlive } from './update-record.js';
const updateFor = (releases: string, opId: string) => { const op=readUpdateRecord(releases).operation; return op?.opId===opId?op:null; };
import { DATABASES, readGroup, readGroupReceipt, restoreGroupMember, restoreGroupFiles, applyRecoveryFloor, type inspectRecoveryFiles } from './recovery-data.js';

export class ServiceStartRequired extends Problem {
  constructor(readonly service: string) { super(PROBLEM_CODE.unavailable, 'Current points at the target but it is not ready'); }
}
export class SwitchRunsActive extends Problem {
  constructor(readonly runConflict: UpdateRunConflict, users: Inspection['contractUsers'] = []) {
    super(PROBLEM_CODE.conflict, `${runConflict.reason === 'format' ? 'Execution FORMAT differs' : 'Database migration requires all Runs to naturally end'} (${runConflict.runs} remaining); retry after natural completion`, { runConflict, ...(runConflict.reason === 'format' ? { users, remaining: runConflict.runs } : {}) });
  }
}
/** Shared stopped-workspace guard for initial setup preview and the actual initial switch. */
export async function assertWorkspaceStopped(workspace: string): Promise<void> {
  try {
    const connection = readConnection(connectionPath(workspace));
    try { await fetch(new URL('/api/runtime/preflight', connection.url), { signal: AbortSignal.timeout(5000) }); throw new Problem(PROBLEM_CODE.conflict, `${workspace} is used by a running server (${connection.url.href}). Choose another --workspace. Only stop this server when intentionally converting it to a managed installation, then retry.`, { workspace, server: connection.url.href }); }
    catch (error) { if (!(error instanceof TypeError) || !hasCode(error.cause, 'ECONNREFUSED')) throw error; }
  } catch (error) { if (!(error instanceof Problem && hasCode(error.cause, 'ENOENT'))) throw error; }
  assertControlWriterAvailable(workspace);
}
export type SwitchPlace = { releases: string; workspace: string; service: string; say: (line: string) => void };
export type Serving = { release: string; url: string; generation: string };
type Inspection = { workspace: string; schema: number; unfinishedRuns?: string[]; control?: ControlSchema; host?: MigrationIdentity[] | null; agentSettingsPending?: boolean; contractUsers: { runId: string; attemptId: string; format: string }[]; unpublishedStops: number };
/** Every service operation is bound to the installation Owner's approved definition. */
function managedService(place: SwitchPlace) {
  return installationService(place.releases, place.workspace, place.service);
}
const schemaText = (release: string) => readFileSync(join(release, 'SCHEMA.json'), 'utf8');
function manifest(release: string) { return parseManifest(JSON.parse(schemaText(release))); }
const parseManifest = (value: { control?: unknown; host?: unknown }) => ({ control: parseControlSchema(value.control), host: parseMigrationHistory(value.host) });
function sameHost(actual: MigrationIdentity[] | null | undefined, expected: MigrationIdentity[]): boolean {
  return actual === null || actual !== undefined && actual.length === expected.length && migrationPrefix(actual, expected);
}
function matches(state: Pick<Inspection, 'schema' | 'control' | 'host' | 'agentSettingsPending'>, release: string): boolean {
  if (state.agentSettingsPending) return false;
  const target = manifest(release);
  const control = state.control;
  return control !== undefined && sameControlSchema(parseControlSchema(control), target.control) &&
    sameHost(state.host, target.host);
}
/** Restore only an unchanged fully identified schema; a common reader marker is insufficient. */
function canRestoreSchema(old: string, journal: SwitchJournal, actual: Inspection): boolean {
  const before = { schema: journal.schema ?? -1, control: journal.control, host: journal.host };
  try { return matches(before, old) && matches(actual, old); } catch { return false; }
}
async function inspect(place: SwitchPlace, release: string): Promise<Inspection> {
  const found = JSON.parse(await runMaintenance(process.execPath,
    [backendEntry('maintenance', release), 'inspect', place.workspace],
    { ...process.env }, place.say, 'Stopped-server inspection')) as Inspection;
  if (found.workspace !== place.workspace) throw new Error('Preflight inspected another workspace');
  return found;
}
/**
 * Why a switch from this workspace state (running `old`) to a release with these facts can go through only once no Run
 * is unfinished, whether or not any is now: the execution FORMAT differs from the running release's or a live Run's, or
 * the database differs from the release's (a missing history counts as differing). The switch refuses on it while Runs
 * remain; the update's status says it before anything is fetched.
 */
export function switchNeedsNoRuns(state: Pick<Inspection, 'contractUsers' | 'control' | 'host'>, target: { format: string; schema: unknown },
  old: string | null): 'format' | 'database' | null {
  if (state.contractUsers.some(user => user.format !== target.format) || old && readFormat(old) !== target.format) return 'format';
  if (state.control === undefined) return 'database';
  const expected = parseManifest(target.schema as { control?: unknown; host?: unknown });
  return !sameControlSchema(state.control, expected.control) || !sameHost(state.host, expected.host) ? 'database' : null;
}
function switchRunConflict(state: Inspection, target: string, old: string | null = null): 'format' | 'database' | 'stops' | null {
  const format = readFormat(target);
  if (!format) throw new Error('Target release has no execution FORMAT');
  const need = switchNeedsNoRuns(state, { format, schema: JSON.parse(schemaText(target)) }, old);
  if (need === 'format' && (state.unfinishedRuns?.length || state.contractUsers.some(user => user.format !== format))) return 'format';
  if (state.unpublishedStops) return 'stops';
  if (state.control === undefined) throw new Problem(PROBLEM_CODE.conflict, 'Database history is missing');
  if (need === 'database' && state.unfinishedRuns?.length) return 'database';
  return null;
}
function compatible(state: Inspection, target: string, old: string | null = null): void {
  const reason = switchRunConflict(state, target, old), expected = manifest(target);
  if (reason === 'format') throw new SwitchRunsActive({reason, runs: Math.max(state.unfinishedRuns?.length ?? 0, state.contractUsers.length)}, state.contractUsers);
  if (reason === 'stops') throw new Problem(PROBLEM_CODE.unavailable, 'Committed stops have not all been published');
  if (reason === 'database') throw new SwitchRunsActive({reason, runs: state.unfinishedRuns!.length});
  const actual = parseControlSchema(state.control!);
  if (actual.version !== state.schema || !canMigrateControlSchema(actual, expected.control))
    throw new Problem(PROBLEM_CODE.conflict, 'Target cannot open this database schema/history');
  if (state.host !== null && (state.host === undefined || !migrationPrefix(parseMigrationHistory(state.host), expected.host)))
    throw new Problem(PROBLEM_CODE.conflict, 'Target cannot open this host database history');
}
async function liveInspection(place: SwitchPlace): Promise<Inspection> {
  const connection = readConnection(connectionPath(place.workspace));
  // The service may stop synchronously before the next probe can process an idle socket's FIN.
  const response = await fetch(new URL('/api/runtime/preflight', connection.url), { headers: { Connection: 'close' }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Problem(PROBLEM_CODE.unavailable, 'Serve preflight failed');
  const state = await response.json() as Inspection;
  if (state.workspace !== place.workspace || !Array.isArray(state.unfinishedRuns) || !Array.isArray(state.contractUsers) || !Number.isSafeInteger(state.unpublishedStops)) throw new Error('Preflight identity or execution state differs');
  return state;
}
async function migrate(place: SwitchPlace, target: string): Promise<void> {
  place.say('Migrating and verifying the stopped database; waiting for maintenance to finish');
  await runMaintenance(process.execPath, [backendEntry('maintenance', target), 'migrate', place.workspace],
    { ...process.env }, place.say);
}
async function serving(place: SwitchPlace, release: string, before: string | null, seconds = 90, recovery = false): Promise<Serving | null> {
  const manager = backendEntry('run-manager', release);
  manifest(release);
  const restarts = platform.service.restarts(place.service);
  for (const deadline = performance.now() + seconds * 1000; performance.now() < deadline;) {
    if (platform.service.restarts(place.service) !== restarts) return null;
    try {
      const connection = readConnection(connectionPath(place.workspace));
      if (connection.generation !== before && connection.runManager === manager) {
        const response = await fetch(new URL('/api/runtime/readiness', connection.url), { signal: AbortSignal.timeout(5000) });
        const ready = await response.json() as { state: string; workspace: string; generation: string; schema: number; control?: ControlSchema; host?: MigrationIdentity[] | null };
        if (response.ok && (ready.state === 'accepting' || recovery && ready.state === 'recovery_ready') && ready.workspace === place.workspace && ready.generation === connection.generation && matches(ready, release))
          return { release: basename(release), url: connection.url.href, generation: connection.generation };
      }
    } catch { /* Wait only within this bounded readiness deadline. */ }
    // Readiness is one local file read and one loopback request; a short interval ends the user's wait sooner.
    await delay(100);
  }
  return null;
}
async function drain(place: SwitchPlace) {
  const connection = readConnection(connectionPath(place.workspace));
  const response = await fetch(new URL('/api/runtime/quiesce', connection.url), { method: 'POST', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Problem(PROBLEM_CODE.unavailable, 'Serve did not confirm durable stop handoff; service was not stopped');
  const token = await response.json() as NonNullable<SwitchJournal['drained']>;
  if (token.state !== 'drained' || token.workspace !== place.workspace || token.generation !== connection.generation || !token.nonce)
    throw new Error('Invalid drained token; service was not stopped');
  return token;
}
/** The journal owns both links, including the durable phase's interrupted rename window. */
function assertSwitchLinks(place: SwitchPlace, journal: SwitchJournal): void {
  const original = [journal.old, journal.previous];
  const selected = [journal.target, journal.old ?? journal.previous];
  const between = [journal.old, journal.old];
  const allowed = journal.phase === 'maintenance_complete' ? [original, ...(journal.old ? [between] : []), selected]
    : journal.phase === 'target_selected' || journal.phase === 'target_ready' ? [selected]
    : journal.phase === 'restoring_old' ? [selected, between, original] : [original];
  const current = linkTarget(place.releases, 'current'), previous = linkTarget(place.releases, 'previous');
  if (!allowed.some(([c, p]) => c === current && p === previous))
    throw new Error('Release links disagree with the switch journal; retained');
}
async function stopOld(place: SwitchPlace, journal: SwitchJournal): Promise<void> {
  if (journal.old === null) {
    assertSwitchLinks(place, journal);
    const definition = installationService(place.releases, place.workspace, place.service);
    const state = platform.service.observe(definition);
    if (!['absent', 'matching'].includes(state.state) || state.state === 'matching' && !platform.service.stop(definition)) throw new Error('Initial service did not stop; journal retained');
    await inspect(place, journal.target);
    journal.phase = 'old_stopped'; save(place, journal); return;
  }
  const generation = readConnection(connectionPath(place.workspace)).generation;
  if (generation !== journal.drained?.generation &&
    !(journal.phase === 'restoring_old' && generation === journal.restoreStoppedGeneration)) {
    try {
      journal.drained = await drain(place); save(place, journal);
    } catch (error) {
      // A connection file outlives serve. Only a refused connection proves no listener; a response, timeout,
      // or broken exchange cannot replace a valid drained token. Service stop must still succeed below.
      if (!(error instanceof TypeError) || !hasCode(error.cause, 'ECONNREFUSED')) throw error;
      place.say('Serve connection refused; confirming the service is stopped before inspection');
    }
  }
  if (!platform.service.stop(managedService(place))) throw new Problem(PROBLEM_CODE.unavailable, 'Service did not stop after its drained token or refused connection');
  if (journal.phase !== 'restoring_old') journal.phase = 'old_stopped';
  save(place, journal);
}
/** Only this Owner restarts the old serve. Persist restoration intent before changing links or starting it. */
async function restoreOld(place: SwitchPlace, journal: SwitchJournal): Promise<boolean> {
  if (!canRestorePreviousApplication(journal)) return false;
  if (journal.old) validateRelease(place.releases, journal.old);
  const current = linkTarget(place.releases, 'current');
  const selected = ['target_selected','target_ready'].includes(journal.phase) ? journal.target : journal.old;
  if (!journal.old || journal.old === journal.target ||
    current !== selected && !(journal.phase === 'restoring_old' && current === journal.target)) return false;
  if (journal.phase === 'restoring_old') await stopOld(place, journal);
  // Prove the database stayed at the old release's version. Never infer safety from FORMAT.
  const actual = await inspect(place, journal.target);
  if (!canRestoreSchema(journal.old, journal, actual)) return false;
  compatible(actual, journal.old);
  journal.restoreStoppedGeneration = readConnection(connectionPath(place.workspace)).generation;
  journal.phase = 'restoring_old'; save(place, journal);
  assertSwitchLinks(place, journal);
  point(place.releases, 'current', journal.old); point(place.releases, 'previous', journal.previous);
  if (!platform.service.restart(managedService(place)) || !await serving(place, journal.old, journal.drained?.generation ?? null))
    throw new Problem(PROBLEM_CODE.unavailable, 'Target and earlier serve both failed; resume old serve recovery with the same switch journal');
  journal.phase = 'aborted'; save(place, journal);
  return true;
}
function aborted(journal: SwitchJournal): never {
  throw new Problem(PROBLEM_CODE.unavailable, `Switch aborted${journal.abortReason ? ': ' + journal.abortReason : ''}; old serve restored. A retry starts a new switch`,
    { reason: journal.abortReason });
}
/**
 * A Run keeps the server origin it was launched with, so a port change waits for every Run as a FORMAT change does.
 * A serve that does not answer is read by `stopped`, that release's own stopped reader, which takes the writer: null
 * before the terminal approved anything, when only a running serve may be asked.
 */
export async function assertPortChangeable(place: SwitchPlace, stopped: string | null): Promise<void> {
  let state: Inspection;
  try { state = await liveInspection(place); }
  catch (error) {
    // Only a missing connection file or a refused connection proves no listener.
    if (!(error instanceof TypeError && hasCode(error.cause, 'ECONNREFUSED')) && !(error instanceof Problem && hasCode(error.cause, 'ENOENT'))) throw error;
    if (!stopped) return;
    state = await inspect(place, stopped);
  }
  const runs = Math.max(state.unfinishedRuns?.length ?? 0, state.contractUsers.length);
  if (runs) throw new Problem(PROBLEM_CODE.conflict,
    `Running agents keep calling the old port, so the port cannot change now (${runs} Runs remaining); retry after natural completion, or run alpacawork setup without --port to change the rest`, { runs });
}
/** The record is the new approval, and its service did not become ready: it is stopped and, with `removed`, unregistered. */
export class ServiceNotReady extends Problem {
  constructor(readonly service: string, readonly removed: boolean) {
    super(PROBLEM_CODE.unavailable, `The service did not become ready with the approved definition; it is stopped${removed ? ' and unregistered' : ''}`);
  }
}
/**
 * Setup's approved change of a settled installation's service; the caller refuses while anything is pending.
 * The old registration is removed before `publish` saves the new record and the new one is registered only after
 * it, so at every interruption the manager holds the record's definition or none, and setup finishes from either.
 * `publish` may still refuse (a Run appeared once serve stopped): then, as after any failure before the record
 * changed, the old registration is put back and the error says whether it is.
 */
export async function replaceService(place: SwitchPlace, replaces: ServiceDefinition | null, publish: () => Promise<unknown>): Promise<Serving> {
  const release = linkTarget(place.releases, 'current');
  if (!release) throw new Error('No release is selected; the service is not replaced');
  let before: string | null = null;
  try { before = readConnection(connectionPath(place.workspace)).generation; } catch { /* Never served: any generation is new. */ }
  if (replaces) {
    const observed = platform.service.observe(replaces);
    if (observed.state !== 'matching' && observed.state !== 'absent')
      throw new Problem(PROBLEM_CODE.unavailable, `Recorded service definition is ${observed.state}. Nothing was changed`);
    const unchanged = (cause: unknown): never => {
      const back = observed.state === 'absent' || platform.service.register(replaces) && (!observed.running || platform.service.restart(replaces));
      throw new Problem(cause instanceof Problem ? cause.code : PROBLEM_CODE.unavailable, `${cause instanceof Error ? cause.message : String(cause)}. ${back
        ? 'The recorded service is back as it was. Nothing was changed'
        : 'The installation record is unchanged, but the recorded service is stopped now and could not be put back; run alpacawork setup again'}`, undefined, { cause });
    };
    if (observed.state === 'matching' && (!platform.service.stop(replaces) || !platform.service.unregister(replaces)))
      unchanged(new Error('The recorded service did not stop or its definition could not be removed'));
    try { await publish(); } catch (error) { unchanged(error); }
  }
  const definition = managedService(place);
  // launchd bootstrap may start immediately, as in the switch: registration is an authorized start here.
  const ready = platform.service.register(definition)
    ? await serving(place, release, before, 1) ?? (platform.service.restart(definition) ? await serving(place, release, before) : null) : null;
  if (ready) return ready;
  // Unregistered, the next setup finds a service the manager does not hold and registers it again, on either manager.
  throw new ServiceNotReady(definition.name, platform.service.stop(definition) &&
    (platform.service.observe(definition).state !== 'matching' || platform.service.unregister(definition)));
}
type SwitchTarget = string | { link: 'previous' } | { release: string; prepare: () => Promise<string> };
type SwitchOptions = { opId?: string; reservePrepared?: (journal: SwitchJournal) => Promise<void>; afterStopped?: (journal: SwitchJournal) => Promise<Serving> };
export async function switchTo(place: SwitchPlace, selection: SwitchTarget, requested?: ReleaseKind, options: SwitchOptions = {}): Promise<Serving> {
  const { releases, service, say } = place;
  const prior = load(place);
  if (prior && !canRestorePreviousApplication(prior) && typeof selection !== 'string' && 'link' in selection) throw new Problem(PROBLEM_CODE.conflict, 'Skills have been overwritten; previous application rollback is unavailable. Continue with the target version');
  if (prior && recovering(prior)) throw new Problem(PROBLEM_CODE.conflict, 'Resume the pending DB recovery before switching code');

  let journal = prior && !terminal(prior) ? prior : null;
  if(journal&&updateFor(releases,journal.opId)&&options.opId!==journal.opId)throw new Error('This switch belongs to its update operation; resume that same operation');
  if (journal && options.opId && journal.opId !== options.opId) throw new Error('Another operation owns the switch');
  if (journal) assertSwitchLinks(place, journal);
  // Resolve the person's request against the operation's original links, not links already moved by that operation.
  const target = typeof selection === 'string' ? selection : 'link' in selection
    ? journal ? journal.previous : linkTarget(releases, selection.link) : selection.release;
  if (target === null) throw new Problem(PROBLEM_CODE.conflict, 'There is no previous release');
  if (journal && journal.target !== target) throw new Problem(PROBLEM_CODE.conflict, 'Finish the pending switch before choosing another target', { switch: journal });
  if (!journal && typeof selection !== 'string' && 'prepare' in selection && await selection.prepare() !== target)
    throw new Error('Prepared release differs from the switch target');
  const kind = validateRelease(releases, target, requested);
  // Validate any declared distribution contract, also on resume/rollback. Missing either part or changing
  // private alone cannot hide it. Existing private development releases retain validateRelease's contract.
  const manifest = readManifest(target);
  if (manifest.private !== true || 'alpacawork' in manifest || existsSync(join(target, 'DISTRIBUTION.json'))) {
    const facts = manifest.alpacawork as { targets?: string[] } | undefined;
    distributionCommand(target, { operation: 'validate', source: target, expected: {
      source: readFileSync(join(target, 'SOURCE'), 'utf8').trim(), edition: kind, targets: parseTargets(facts?.targets?.join(',') ?? ''),
    } });
  }
  const current = linkTarget(releases, 'current');
  const initial = journal ? journal.old === null : current === null;
  const definition = managedService(place);
  const observed = platform.service.observe(definition);
  if (!['absent', 'matching'].includes(observed.state)) throw new Problem(PROBLEM_CODE.unavailable, `Service definition is ${observed.state}; retained`);
  if (!journal && linkTarget(releases, 'current') === target) {
    let ready = await serving(place, target, null, 5);
    if (!ready && prior?.phase === 'committed' && prior.target === target && observed.state === 'matching' && !observed.running &&
        platform.service.known(definition.name) && releaseAdmission(place.workspace) === 'accepting') {
      // Explicit setup/deploy may start the same saved service; application completion still uses one path below.
      if (platform.service.restart(definition)) ready = await serving(place, target, null);
      if (!ready) {
        if (!platform.service.stop(definition)) throw new Error('Failed target could not be stopped; committed switch journal retained');
        throw new ServiceStartRequired(definition.name);
      }
    }
    if (!ready) throw new Problem(PROBLEM_CODE.unavailable, 'Current points at the target but it is not ready');
    if (!options.opId) return ready;
    journal = {version: newJournalVersion(prior), opId: options.opId, workspace: place.workspace, old: target, target,
      previous: linkTarget(releases, 'previous'), phase: 'target_ready', schema: null, skillsWriteStarted: false};
    if (options.reservePrepared) await options.reservePrepared(journal); else save(place, journal);
    if (options.afterStopped) return options.afterStopped(journal);
    return continueStoppedSwitch(place, journal);
  }
  if (!journal || journal.phase === 'waiting_runs') {
    // Live preflight is target-workspace-only. It includes unimported completion and uncertain input.
    let state: Inspection;
    if (initial) {
      if (prior || workspaceJournal(place.workspace) || linkTarget(releases, 'previous') !== null || observed?.running) throw new Error('Initial switch is not stopped and unselected');
      // The workspace writer and version-matched reader certify stopped DB state, independently of HTTP.
      await assertWorkspaceStopped(place.workspace);
      state = await inspect(place, target);
    } else {
      state = await liveInspection(place);
    }
    compatible(state, target, current);
    journal = { version: newJournalVersion(prior), opId: options.opId ?? journal?.opId ?? randomUUID(), workspace: place.workspace, old: current, target,
      previous: linkTarget(releases, 'previous'), phase: 'prepared', skillsWriteStarted: false, schema: state.schema, control: state.control, host: state.host };
    if(options.reservePrepared)await options.reservePrepared(journal);else save(place,journal);
  }
  if (journal.phase === 'prepared') {
    await stopOld(place, journal);
  }
  if (options.afterStopped && !['prepared', 'waiting_runs'].includes(journal.phase)) return options.afterStopped(journal);
  return continueStoppedSwitch(place, journal);
}
/** Shared switch Owner: local deploy and a target maintenance process use precisely the same transitions. */
export async function continueStoppedSwitch(place: SwitchPlace, journal: SwitchJournal): Promise<Serving> {
  const { releases, service, say } = place, target = journal.target;
  const definition = managedService(place);
  if(journal.phase==='restoring_old'){if(await restoreOld(place,journal))aborted(journal);throw new Problem(PROBLEM_CODE.unavailable,'Old serve recovery cannot be proved safe; resume the same journal for forward recovery');}
  if (journal.workspace !== place.workspace || !['old_stopped','maintenance_complete','target_selected','target_ready','committed'].includes(journal.phase)) throw new Error('Stopped switch identity/phase differs');
  if (journal.phase === 'old_stopped') {
    assertSwitchLinks(place, journal);
    // The target inspection executable understands the supported pre-migration schema without changing it.
    const state = await inspect(place, target);
    try {
      compatible(state, target);
      if (journal.old && !journal.backup) {
        journal.backup = await backupStoppedWorkspace(place, target, journal); save(place, journal);
      }
      await migrate(place, target);
    } catch (error) {
      // Keep the migration's own stderr: a later restore failure replaces the thrown error, and this is its only record.
      const stderr = error instanceof Problem ? (error.detail as { stderr?: unknown } | undefined)?.stderr : undefined;
      journal.abortReason = (error instanceof Error ? error.message : String(error)) +
        (typeof stderr === 'string' && stderr ? ' ' + JSON.stringify(stderr.slice(-4000)) : '');
      if (await restoreOld(place, journal)) aborted(journal);
      throw error;
    }
    const migrated = await inspect(place, target);
    compatible(migrated, target);
    if (!matches(migrated, target)) throw new Error('Stopped-server migration did not reach the target schema; journal retained');
    journal.phase = 'maintenance_complete'; save(place, journal);
  }
  if (journal.phase === 'maintenance_complete') {
    assertSwitchLinks(place, journal);
    const state = await inspect(place, target);
    compatible(state, target);
    if (!matches(state, target))
      throw new Error('Database changed after stopped-server maintenance; journal retained');
    if (journal.old) point(releases, 'previous', journal.old);
    point(releases, 'current', target);
    journal.phase = 'target_selected'; save(place, journal);
  }
  if (journal.phase === 'target_selected') {
    if (linkTarget(releases, 'current') !== target) throw new Error('Current disagrees with the switch journal');
    say(`current -> ${basename(target)}; starting ${service}`);
    const before = journal.drained?.generation ?? null;
    // launchd bootstrap may start immediately, so registration is an authorized start here only.
    const registered = platform.service.register(definition);
    const ready = registered ? await serving(place, target, before, 1) ?? (platform.service.restart(definition) ? await serving(place, target, before) : null) : null;
    if (!ready) {
      if (!platform.service.stop(definition)) throw new Error('Failed target could not be stopped for schema inspection; journal retained');
      journal.abortReason = 'Target did not become ready'; save(place, journal);
      if (await restoreOld(place, journal)) aborted(journal);
      throw new Problem(PROBLEM_CODE.unavailable, journal.old === null ? 'Initial target did not become ready; selected current and switch journal retained. Resume the same journal; no earlier serve exists' : 'Target did not become ready; switch journal retained. Schema changes require forward recovery');
    }
    journal.phase = 'target_ready'; save(place, journal);
  }
  const operation = updateFor(releases, journal.opId);
  if (operation) await completeUpdateSkills(place, journal, operation);
  const ready = await serving(place, target, journal.drained?.generation ?? null, 5);
  if (!ready) throw new Problem(PROBLEM_CODE.unavailable, 'Target readiness was lost before commit');
  journal.phase = 'committed'; journal.ready=ready; save(place, journal);
  return ready;
}
/** The caller holds the release-operation lock, shared with reservation through manager spawn.
 * Host argv protects live managers in all workspaces; only this workspace's durable reservations are inspected.
 * Stopped foreign workspaces with old unspawned reservations are outside this retention guarantee.
 */
export function prune(releases: string, keep: number, say: (line: string) => void, workspace?: string): string[] {
  const kept = new Set([linkTarget(releases, 'current'), linkTarget(releases, 'previous')]), removed: string[] = [];
  const pending = load({ releases });
  const backups = backupRetention(releases, pending, workspace);
  for (const source of [...backups.references, ...pendingUpdateReferences(releases)]) kept.add(source);
  if (pending && !terminal(pending)) { kept.add(pending.target); if (pending.old) kept.add(pending.old); }
  if (workspace && existsSync(controlDatabasePath(workspace))) {
    const db = new DatabaseSync(controlDatabasePath(workspace), { readOnly: true });
    try { for (const reference of executionReferences({ root: workspace, connection: db }).runtimeUsers) kept.add(reference.release); }
    finally { db.close(); }
  }
  const processes = platform.run.processes();
  let newer = 0;
  const unused: string[] = [];
  for (const release of builtReleases(releases)) {
    if (kept.has(release)) continue;
    if (newer < keep) { newer++; continue; }
    if (users(release, processes).length) { say(`keeping ${basename(release)}: code is in use`); continue; }
    unused.push(release);
  }
  // Finish every retention read before the first deletion, including orphan acquisition records.
  const metadata=provenanceDirectory(releases);
  const orphaned: string[] = [];
  for(const name of existsSync(metadata)?readdirSync(metadata):[]) {
    const match=/^([a-f0-9]{40}(?:-diagnostic)?)\.json(?:\.tmp)?$/.exec(name);if(!match)continue;
    const target=join(releases,match[1]!);
    if(!kept.has(target)&&(!existsSync(target)||unused.includes(target)))orphaned.push(join(metadata,name));
  }
  for (const folder of backups.obsolete) {
    // Invalidate the published receipt first. An interrupted removal is an unpublished group on retry.
    rmSync(join(folder,'backup.json'), { force: true }); syncFile(folder);
    rmSync(folder, { recursive: true }); syncFile(dirname(folder));
  }
  for (const release of unused) {
    rmSync(release, { recursive: true, force: true });
    removed.push(basename(release));
  }
  for (const path of orphaned) rmSync(path, { force: true });
  return removed;
}
export function status(releases: string) {
  const processes = platform.run.processes();
  return { current: linkTarget(releases, 'current') && basename(linkTarget(releases, 'current')!),
    previous: linkTarget(releases, 'previous') && basename(linkTarget(releases, 'previous')!),
    releases: builtReleases(releases).map(release => ({ release: basename(release), format: readFormat(release), processes: users(release, processes).length })) };
}

/** Invoke the known release's limited maintenance reader, rather than opening an arbitrary failed schema here. */
async function acquireGroup(place: SwitchPlace, reader: string, folder: string, files: readonly string[] = []): Promise<void> {
  await runMaintenance(process.execPath,[backendEntry('maintenance', reader),'recovery-snapshot',place.workspace,folder,...files],
    {...process.env}, place.say, 'Stopped-server DB group snapshot');
  readGroup(folder,place.workspace);
}
const recoveryCodeIdentity=(release:string)=>({source:readFileSync(join(release,'SOURCE'),'utf8').trim(),format:readFormat(release),
  schemaDigest:fileHash(join(release,'SCHEMA.json')),maintenanceDigest:fileHash(backendEntry('maintenance', release))});
/** Only an already stopped switch can publish a usable recovery group. */
export async function backupStoppedWorkspace(place:SwitchPlace,reader:string,journal:SwitchJournal):Promise<string> {
  if(journal.phase!=='old_stopped'||journal.workspace!==place.workspace||!journal.old||journal.target!==reader)
    throw new Error('DB group backup requires its stopped switch identity');
  validateRelease(place.releases,journal.old);validateRelease(place.releases,reader);
  const backup=join(place.releases,'backups',journal.opId);
  await acquireGroup(place,reader,backup,['config.yaml']);
  atomicJson(join(backup,'backup.json'),{version:1,workspace:place.workspace,source:journal.old,target:reader,
    protocol:RECOVERY_PROTOCOL,node:process.execPath,nodeVersion:process.version,
    code:{source:recoveryCodeIdentity(journal.old),target:recoveryCodeIdentity(reader)}});
  return backup;
}
const backupCodeShape = z.object({source:z.string(),format:z.string().nullable(),schemaDigest:z.string(),maintenanceDigest:z.string()}).strict();
const backupShape = z.object({version:z.literal(1),workspace:z.string(),source:z.string(),target:z.string(),
  protocol:z.number().int(),node:z.string(),nodeVersion:z.string(),code:z.object({source:backupCodeShape,target:backupCodeShape}).strict()});
const readBackupMetadata = (folder:string) => backupShape.parse(JSON.parse(readFileSync(join(folder,'backup.json'),'utf8')));
const backupMetadata = (folder:string) => {
  const data=readBackupMetadata(folder);
  if(data.node!==process.execPath||data.nodeVersion!==process.version||data.protocol!==RECOVERY_PROTOCOL)
    throw new Error('Backup release/Node identity is not usable');
  if(JSON.stringify(data.code)!==JSON.stringify({source:recoveryCodeIdentity(data.source),target:recoveryCodeIdentity(data.target)}))
    throw new Error('Backup code identity differs from its fixed releases');
  return data;
};
/** The terminal journal names the last acquired/selected backup, independent of clocks and directory order.
 * Before that boundary no backup expires. Recovery evidence has its own, unchanged lifetime.
 */
function backupRetention(releases:string,journal:SwitchJournal|null,workspace?:string):{references:string[];obsolete:string[]} {
  const parent=join(releases,'backups');
  if(existsSync(parent)){
    const info=lstatSync(parent);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Backup root must be a direct directory');
  }
  const references:string[]=[],obsolete:string[]=[];
  const latest=journal&&terminal(journal)?journal.backup:undefined;
  if(latest&&(resolve(latest)!==latest||dirname(latest)!==resolve(parent)))throw new Error('Retained backup is outside its backup root');
  const folders=(existsSync(parent)?readdirSync(parent):[]).filter(name=>!name.startsWith('.')).map(name=>join(parent,name));
  if(latest&&!folders.includes(latest))throw new Error('Retained backup is missing');
  for(const folder of folders) {
    const info=lstatSync(folder);
    if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Backup group must be a direct directory');
    if(latest&&folder!==latest){obsolete.push(folder);continue;}
    // A stopped acquisition may not yet have published its release receipt. The journal pins its code.
    if(!existsSync(join(folder,'backup.json'))&&!latest)continue;
    const saved=readBackupMetadata(folder);
    if(saved.workspace!==(workspace??journal?.workspace??saved.workspace))throw new Error('Backup belongs to another workspace');
    if(latest&&(saved.source!==journal!.old||saved.target!==journal!.target))throw new Error('Retained backup differs from its switch journal');
    if(latest)readGroupReceipt(folder,saved.workspace);
    validateRelease(releases,saved.source);validateRelease(releases,saved.target);
    references.push(saved.source,saved.target);
  }
  const failures=join(releases,'recovery-evidence');
  if(existsSync(failures))for(const name of readdirSync(failures)) {
    const file=join(failures,name,'recovery.json');if(!existsSync(file))continue;
    const record=JSON.parse(readFileSync(file,'utf8'));
    if(record.version!==1||typeof record.source!=='string'||typeof record.reader!=='string'||typeof record.target!=='string')throw new Error('Recovery retention record differs');
    references.push(record.source,record.reader,record.target);
  }
  return {references,obsolete};
}
function recoveryCapable(release:string):void {
  // A bounded executable capability is the wire contract. Distribution metadata derives it from this entry.
  const result=spawnSync(process.execPath,[backendEntry('maintenance', release),'recovery-protocol'],{encoding:'utf8',timeout:30_000});
  if(result.status!==0||result.stdout.trim()!==String(RECOVERY_PROTOCOL))throw new Error('Recovery target has no restore gate protocol; general recovery cannot reopen it');
}
type RecoveryCheckpoint = (phase:string,journal:SwitchJournal)=>void;
/** Explicit general restore; code-only failure continues to use restoreOld without touching DB bytes. */
export async function recoverBackup(place:SwitchPlace,backupInput:string,checkpoint:RecoveryCheckpoint=()=>{},authorization?:RecoveryGrant):Promise<Serving> {
  const backup=resolve(backupInput),meta=backupMetadata(backup);
  if(dirname(backup)!==join(place.releases,'backups')||meta.workspace!==place.workspace)throw new Error('Backup belongs to another release/workspace');
  const installation=checkedInstallationService({workspace:place.workspace,releases:place.releases,name:place.service});
  readGroup(backup,place.workspace,installation.installation.workspaceIdentity);
  validateRelease(place.releases,meta.source);validateRelease(place.releases,meta.target);recoveryCapable(meta.source);
  if(!platform.service.known(place.service))throw new Error('Recovery service is unavailable');
  let journal=load(place);
  const execution=journal?updateFor(place.releases,journal.opId):null;
  if(execution&&controllerAlive(execution))throw new Problem(PROBLEM_CODE.busy,'The update controller is still active; wait for its fixed result before DB recovery');
  if(journal&&recovering(journal)&&(journal.recovery?.backup!==backup||journal.recovery.target!==meta.source))
    throw new Error('Finish the same recovery target/backup first');
  if(journal&&!canRestorePreviousApplication(journal))
    throw new Problem(PROBLEM_CODE.conflict,
      'After an app update has overwritten skills, you cannot restore the previous version from this backup. The current version and data have not been changed.',
      undefined,{reason:{kind:'recovery_after_skill_update_unsupported'}});
  if(journal&&(journal.old!==meta.source||journal.target!==meta.target))
    throw new Problem(PROBLEM_CODE.conflict,
      'This backup does not belong to the last application switch. Use the backup recorded for that switch. The current version and data have not been changed.',
      undefined,{reason:{kind:'recovery_backup_switch_mismatch'}});
  if(journal?.phase==='recovered'&&journal.recovery?.backup===backup) {
    const ready=await serving(place,meta.source,null,5);
    if(ready)return ready;
    if(!platform.service.restart(managedService(place)))throw new Error('Restored code could not restart');
    const resumed=await serving(place,meta.source,null);if(resumed)return resumed;
    throw new Error('Restored code did not become ready; DB group remains restored');
  } else if(!journal||!recovering(journal)) {
    if(journal&&!terminal(journal)&&journal.target!==meta.target)throw new Error('Another switch owns this workspace');
    const current=linkTarget(place.releases,'current');
    if(!current)throw new Error('Recovery source release is absent');
    validateRelease(place.releases,current);
    const id=randomUUID(),reader=journal&&!terminal(journal)&&journal.target===meta.target?journal.target:current;
    journal={...journal,version:newJournalVersion(journal),opId:journal?.opId??randomUUID(),workspace:place.workspace,old:meta.source,target:meta.target,
      previous:journal?journal.previous:linkTarget(place.releases,'previous'),phase:'recovery_intent',schema:null,skillsWriteStarted:journal?.skillsWriteStarted??false,backup,
      recovery:{id,backup,source:current,reader,target:meta.source,replaced:[],failure:join(place.releases,'recovery-evidence',id),...authorization?{authorization}:{}}};
    save(place,journal);checkpoint('intent',journal);
  }
  const recovery=journal.recovery!;
  mkdirSync(recovery.failure,{recursive:true,mode:0o700});syncFile(dirname(recovery.failure));
  atomicJson(join(recovery.failure,'recovery.json'),{version:1,source:recovery.source,reader:recovery.reader,target:recovery.target,backup:recovery.backup,id:recovery.id,...recovery.authorization?{authorization:recovery.authorization}:{}});
  if(journal.phase==='recovery_intent'||journal.phase==='waiting_runs') {
    // Full Run drain is required for DB rollback. A stopped connection can be inspected by its known reader below.
    try {
      const connection=readConnection(connectionPath(place.workspace));
      const response=await fetch(new URL('/api/runtime/preflight',connection.url),{signal:AbortSignal.timeout(5000)});
      if(!response.ok)throw new Error('Recovery preflight unavailable');
      const state=await response.json() as Inspection;
      if(state.workspace!==place.workspace)throw new Error('Recovery preflight inspected another workspace');
      if(state.unfinishedRuns?.length||state.contractUsers.length||state.unpublishedStops) {
        journal.phase='waiting_runs';save(place,journal);
        throw new Problem(PROBLEM_CODE.busy,'Recovery waits for all unfinished execution and publication to finish naturally');
      }
      journal.drained=await drain(place);save(place,journal);
    } catch(error) {
      if(!(error instanceof TypeError)||!hasCode(error.cause,'ECONNREFUSED'))throw error;
    }
    if(!platform.service.stop(installation.definition))throw new Error('Recovery service did not stop');
    const stopped=await inspect(place,recovery.reader);
    if(stopped.unfinishedRuns?.length||stopped.contractUsers.length||stopped.unpublishedStops) {
      journal.phase='waiting_runs';save(place,journal);
      throw new Problem(PROBLEM_CODE.busy,'Recovery waits for all unfinished execution and publication to finish naturally');
    }
    try{recovery.beforeGeneration=readConnection(connectionPath(place.workspace)).generation;}catch{recovery.beforeGeneration=null;}
    journal.phase='recovery_stopped';save(place,journal);
  }
  const release=holdControlWriter(place.workspace);
  try {
    if(journal.phase==='recovery_stopped') {
      // Child takes the same workspace writer, so do not hold it across the subprocess.
      release();await acquireGroup(place,recovery.reader,recovery.failure,readGroup(backup,place.workspace).fileState.map(file=>file.path));
      journal.phase='recovery_saved';save(place,journal);
    }
  } finally {release();}
  // Reacquire after the version-matched snapshot process exited. All replacement/floor work shares this lifetime.
  const held=holdControlWriter(place.workspace),fileWriter=new FileWriter(place.workspace);
  try { await fileWriter.exclusive(async()=>{
    if(['recovery_saved','recovery_replacing'].includes(journal.phase)) {
      // Failure group is immutable before the first DB is replaced; resumption never re-snapshots a mixed group.
      readGroup(recovery.failure,place.workspace,installation.installation.workspaceIdentity);
      publishRestoreIdentity(place.workspace,{id:recovery.id,failure:recovery.failure,reader:recovery.reader});
      journal.phase='recovery_replacing';save(place,journal);
      for(const db of DATABASES) if(!recovery.replaced.includes(db.name)) {
        restoreGroupMember(place.workspace,backup,db.name);
        checkpoint('replaced:'+db.name,journal);
        recovery.replaced.push(db.name);save(place,journal);
      }
      restoreGroupFiles(place.workspace,backup);
      journal.phase='recovery_floor';save(place,journal);checkpoint('before-floor',journal);
    }
    if(journal.phase==='recovery_floor') {
      const floor=applyRecoveryFloor(place.workspace,backup,recovery.failure);
      atomicJson(join(recovery.failure,'floor.json'),{taskNext:floor.taskNext,runNext:floor.runNext,taskMax:floor.taskMax,runMax:floor.runMax});
      journal.phase='recovery_check';save(place,journal);
    }
  }); } finally {fileWriter.close();held();}
  if(journal.phase==='recovery_check') {
    // Parent writer lifetimes ended before the target's version-matched reader takes them.
    const diagnostic=JSON.parse(await runMaintenance(process.execPath,
      [backendEntry('maintenance', recovery.target),'recovery-files',place.workspace],
      {...process.env}, place.say, 'Restored file diagnosis')) as ReturnType<typeof inspectRecoveryFiles>;
    recovery.diagnostics=diagnostic;save(place,journal);atomicJson(join(recovery.failure,'files.json'),diagnostic);
    if(diagnostic.blocked)throw new Problem(PROBLEM_CODE.conflict,'Restored file references/intents need repair; evidence retained',diagnostic);
    const state=await inspect(place,recovery.target);
    if(!matches(state,recovery.target))throw new Error('Restored DB/schema does not match the fixed target');
    journal.phase='recovery_ready';save(place,journal);checkpoint('before-ready',journal);
  }
  if(journal.phase==='recovery_ready') {
    save(place,journal);
    point(place.releases,'current',recovery.target);point(place.releases,'previous',recovery.source);
    const ready=await serving(place,recovery.target,recovery.beforeGeneration??null,1,true)??
      (platform.service.restart(managedService(place))?await serving(place,recovery.target,recovery.beforeGeneration??null,90,true):null);
    if(!ready) {if(!platform.service.stop(managedService(place)))throw new Error('Failed recovery readiness could not be stopped');throw new Error('Restored code readiness failed; resume the same recovery');}
    journal.phase='recovered';save(place,journal);
  }
  const ready=await serving(place,recovery.target,recovery.beforeGeneration??null);
  if(!ready)throw new Error('Restored serve did not open after recovery commit; resume the same recovery');
  return ready;
}
