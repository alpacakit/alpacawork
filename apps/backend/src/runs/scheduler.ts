import { touch } from '@alpacawork/db';
import { backendEntry } from '../app-paths.js';
import { releaseAdmission } from '../release/journal.js';
/** One transaction owns liveness and slot decisions; spawning follows commit. */
import { closeSync, constants, existsSync, statSync, writeSync, mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { hasCode, platform, tryLock } from '@alpacawork/core';
import { RUN_FILES, compareRunIds, runNumber, type CoordinatorRunRecord, type RunRecord, type RuntimeRunRecord } from '@alpacawork/contract/run';
import { DELIVERY_STATE } from '@alpacawork/contract/control';
import { taskBaseStateSchema, type RunId } from '@alpacawork/contract/fields';
import { RunStore, conversationInUse, isEnded, usesSlot, laneAhead, type RunTransaction } from '@alpacawork/runs';
import { readAgentsSettings, type AgentsSettingsResult } from '../agents-settings.js';
import { agentLaunchSchema } from '@alpacawork/contract/agent-launch';
import { AGENT_ADAPTERS, builtinAdapterIdSchema } from '@alpacawork/contract/agent-adapters';
import { randomUUID } from 'node:crypto';
import { failedDeliveryBlocked, seatFailed, seatRunBefore } from '../control/wake.js';
import { agentEnvironment } from './env.js';
import { continuationSession } from './session-continuation.js';
import { processUnit, type AgentInvocation } from './launch-agent.js';
import { openRunFile } from './files.js';
import { RunEventImporter, releaseReserved } from './event-importer.js';
import { attemptOf, coordinatorCwd, reserveAttempt, planInputs, publishCommands, publishAttempt, queuedInputReservations,
  queuedStart, blockedInvocations } from './execution-control.js';
import { executionFolder, names } from './execution-files.js';
import { tryHoldReleases } from '../release/layout.js';
import { importLocalStops, publishWorkspaceIdentity } from './local-stops.js';
import { recoverExecution } from './recovery.js';
import { RunReviewState } from './reviews.js';
import { dirname, join } from 'node:path';
import { releaseForEntry } from '@alpacawork/core';

interface SettleSummary { launched: RunId[]; lost: RunId[]; closed: RunId[]; failed: RunId[]; skipped: { run: RunId; reason: string }[] }
export interface RunLaunch { id: RunId; lockFd: number; attemptId?: string; releaseLock?: () => void }
interface SettleContext { store: RunStore; settings: AgentsSettingsResult; launches: RunLaunch[];
  releaseLocks: Map<string, { close: () => void; references: number } | null>; prepared: Set<RunId>; folderFailures: Map<RunId, string>; unmanaged: Map<RunId, number> }
interface SettleDecision { summary: SettleSummary; launches: RunLaunch[] }
const summary = (): SettleSummary => ({ launched: [], lost: [], closed: [], failed: [], skipped: [] });
/** What a later decision adds to one already made: each Run is told once. */
function absorb(into: SettleSummary, later: SettleSummary): void {
  into.lost.push(...later.lost);
  into.closed.push(...later.closed.filter(id => !into.closed.includes(id)));
  into.skipped.push(...later.skipped.filter(item => !into.skipped.some(old => old.run === item.run)));
}
const endedOf = (store: RunStore, ids: readonly RunId[]): RunId[] => ids.filter(id => { const run = store.runtimeGet(id); return run !== null && isEnded(run); });
const lockFile = (store: RunStore, id: RunId) => openRunFile(store.folder(id), RUN_FILES.managerLock, constants.O_RDWR | constants.O_CREAT);
function folderFailure(error: unknown): string {
  return hasCode(error, 'ENOENT') ? 'run folder is missing'
    : typeof error === 'object' && error !== null && 'code' in error ? String(error.code)
    : error instanceof Error ? error.message : String(error);
}
function prepareQueued(store: RunStore, runs: readonly RuntimeRunRecord[], context: SettleContext): void {
  for (const run of runs) {
    try {
      store.prepareFolder(run.id);
      if (run.role === 'coordinator') mkdirSync(coordinatorCwd(store.root), { recursive: true, mode: 0o700 });
      context.prepared.add(run.id);
    } catch (error) { context.folderFailures.set(run.id, folderFailure(error)); }
  }
}
/** wake.seatFailed for the seat a queued Run would wake: its Task, and the seat's owner Run before it (seatRunBefore). */
function seatFailedBefore(store: RunStore, tx: RunTransaction, run: RunRecord): boolean {
  const task = store.connection.prepare('SELECT base_state FROM tasks WHERE external_id=?').get(run.task);
  return seatFailed({ baseState: taskBaseStateSchema.parse(task?.base_state) },
    seatRunBefore(tx.conversationRuns(run.placementId), run));
}
/** Whether the returns a seat's continuation still carries (its unreleased deliveries) make it the server's (W0). */
const carriedRows = (tx: RunTransaction, run: RunRecord) => tx.returns(undefined, [run.task])
  .filter(row => row.deliveries.some(delivery => delivery.wakeRequestId === run.requestId && !delivery.releasedAt));
/**
 * The coordinator's conversation has no session to continue when no turn before succeeded in one (its first
 * launch failed): this turn starts it anew with the same agent and choices, rather than waiting for a session that
 * never comes. Undefined when the agent can no longer start as the coordinator.
 */
function freshStart(run: CoordinatorRunRecord): AgentInvocation | undefined {
  if (run.restartArgv === null) return undefined;
  const checked = agentLaunchSchema.safeParse({ ...run.launch, argv: run.restartArgv });
  if (!checked.success) return undefined;
  const launch = checked.data;
  const id = builtinAdapterIdSchema.safeParse(launch.adapter);
  const session = id.success && AGENT_ADAPTERS[id.data].system.start.includes('session')
    ? { provider: run.agent, id: randomUUID() } : null;
  return { launch, mode: 'start', session };
}
/** Writes that must not be lost retry busy; finite SQLite waits let Node keep servicing other events. */
export async function retryBusy<T>(operation: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
  for (;;) {
    try { return await operation(); }
    catch (error) {
      if (!hasCode(error, 'busy')) throw error;
      signal?.throwIfAborted();
      console.log('Run database is busy; retrying');
      try { await delay(50, undefined, { signal }); }
      catch (error) { signal?.throwIfAborted(); throw error; }
    }
  }
}
type Write = <T>(operation: () => T | Promise<T>) => Promise<T>;
export function closeLaunches(launches: RunLaunch[]): void {
  for (const item of launches) {
    if (item.lockFd >= 0) { closeSync(item.lockFd); item.lockFd = -1; }
    item.releaseLock?.(); item.releaseLock = undefined;
  }
}

/** Borrow one existing release-operation exclusion for this decision and its committed launches.
 * A busy release is left queued for a later settle. The manager's argv takes over retention after spawn.
 */
function holdLaunchRelease(context: SettleContext, entry: string): (() => void) | null {
  const release = releaseForEntry(entry);
  if (!release) return () => {};
  const releases = dirname(release);
  if (!context.releaseLocks.has(releases)) {
    const close = tryHoldReleases(releases);
    context.releaseLocks.set(releases, close ? { close, references: 1 } : null);
  }
  const held = context.releaseLocks.get(releases);
  if (!held) return null;
  held.references++;
  let borrowed = true;
  return () => { if (borrowed) { borrowed = false; if (--held.references === 0) held.close(); } };
}

export function decide(tx: RunTransaction, context: SettleContext): SettleSummary {
  const { store, settings, launches } = context, result = summary();
  let runs = tx.forSettle();
  const reservations = queuedInputReservations(store), blocked = blockedInvocations(store, runs.map(run => run.id));
  for (const run of runs) if (run.state === 'running' && context.unmanaged.has(run.id)) {
    // The preflight still holds this manager.lock and has imported its stable journal. Never probe a live
    // manager again here: it may have published completion after the earlier import and just exited.
    const fd = context.unmanaged.get(run.id)!;
    const attempt = attemptOf(store, run.id);
    const observed = store.connection.prepare('SELECT claimed,spawn_intent,completed_digest,diagnostic FROM run_attempts WHERE run_no=?').get(runNumber(run.id));
    if (fd >= 0 && attempt && !observed?.claimed && !observed?.spawn_intent && !observed?.completed_digest &&
      !existsSync(join(executionFolder(store.root, run.id, attempt.attemptId), 'claim.json')) &&
      names(join(executionFolder(store.root, run.id, attempt.attemptId), 'events')).length === 0) {
      // Recovery reuses the saved release; the same release operation lock covers reservation through spawn.
      const releaseLock = holdLaunchRelease(context, attempt.entry);
      if (releaseLock === null) continue;
      launches.push({ id: run.id, lockFd: fd, attemptId: attempt.attemptId, releaseLock });
      context.unmanaged.delete(run.id);
      continue;
    }
    if (observed?.completed_digest || observed?.diagnostic) continue;
    tx.update({ ...run, state: 'needs_review', reason: 'manager_lost' });
    result.lost.push(run.id);
  }
  runs = tx.forSettle();
  if (!settings.ok) return result;
  const { limits } = settings.config;
  // A coordinator Run answers the person at the screen: it takes no slot and never waits for one.
  let occupied = runs.filter(r => r.role !== 'coordinator' && (usesSlot(r) || blocked.has(runNumber(r.id)))).length;
  const queued = runs.filter(r => r.state === 'queued').sort(compareRunIds);
  for (let run of queued) {
    if(releaseAdmission(store.root)!=='accepting')break;
    // Uncertain input delivery retains its existing exclusion, including during scope invalidation.
    if (laneAhead(runs, run, blocked, reservations)?.kind === 'delivery') continue;
    if (run.role === 'coordinator') {
      const conversation = store.connection.prepare('SELECT cleared_at FROM coordinator_conversations WHERE id=?').get(run.conversationId);
      if (!conversation || conversation.cleared_at !== null) {
        result.skipped.push({ run: run.id, reason: 'conversation was cleared after request admission' });
        continue;
      }
    } else {
      const start = queuedStart(store, tx, run);
      if (start.kind === 'wait') continue;
      if (start.kind === 'reject') {
        result.skipped.push({ run: run.id, reason: start.code });
        if (start.invalidateRequest) {
          tx.invalidateRequest(run);
          runs = tx.forSettle();
        }
        continue;
      }
      if (occupied >= limits.parallel) continue;
      const placement = tx.getPlacement(run.placementId);
      if (!placement || !placement.active || placement.taskId !== run.task ||
        (run.role === 'owner' && !placement.responsible)) {
        result.skipped.push({ run: run.id, reason: 'placement changed after request admission' });
        continue;
      }
      // Returns wake the responsible seat, and a failed seat takes none until its requester retries. The Run
      // stays queued for the router to abort, so its returns go with that retry. The server's own Request (W0) goes on.
      if (start.request.purpose === 'return_continuation' && failedDeliveryBlocked(seatFailedBefore(store, tx, run), carriedRows(tx, run))) continue;
    }
    // Requests in one lane are serialized even when `mode=new` selected a
    // different session. A queued reply waits for its predecessor to finish.
    if (laneAhead(runs, run, blocked, reservations)) continue;
    let restart: AgentInvocation | undefined;
    if (run.resumes) {
      const predecessor = runs.find(other => other.id === run.resumes);
      if (!predecessor || predecessor.state === 'queued' || usesSlot(predecessor)) continue;
      const session = continuationSession(runs, predecessor, { kind: 'launch', coordinator: run.role === 'coordinator' });
      if (session) {
        if (!run.session || run.role === 'coordinator' && run.session.id !== session.id) {
          const bound = { ...run, session };
          tx.update(bound);
          runs = runs.map(other => other.id === run.id ? bound : other);
          run = bound;
        }
      } else {
        // A Task's continuation waits for its conversation's session; the coordinator's starts anew.
        if (run.role !== 'coordinator') continue;
        restart = freshStart(run);
        if (!restart) {
          result.skipped.push({ run: run.id, reason: 'agent cannot start a coordinator conversation' });
          continue;
        }
      }
    }
    if (run.session && conversationInUse(runs, run.session.id)) continue;
    if (!context.prepared.has(run.id)) {
      const reason = context.folderFailures.get(run.id);
      if (reason) result.skipped.push({ run: run.id, reason });
      continue;
    }
    const releaseLock = holdLaunchRelease(context, managerScript);
    if (releaseLock === null) continue;
    let fd: number;
    // A folder can still disappear between preflight and lock; keep this Run queued.
    try { fd = lockFile(store, run.id); }
    catch (error) {
      result.skipped.push({ run: run.id, reason: folderFailure(error) });
      releaseLock(); continue;
    }
    let held = false, retained = false;
    try {
      held = tryLock(fd);
      if (!held) continue;
      // Register ownership before any later operation can throw.
      const attempt = reserveAttempt(store, tx, run, managerScript, limits, restart);
      launches.push({ id: run.id, lockFd: fd, attemptId: attempt.attemptId, releaseLock }); retained = true;
      // A conversation started anew holds the session its attempt starts.
      const running = { ...run, session: attempt.invocation.session, state: 'running' as const, started_at: new Date().toISOString() };
      tx.update(running); runs = runs.map(r => r.id === run.id ? running : r);
      tx.updateRequest(run.requestId, DELIVERY_STATE.queued);
      if (run.role !== 'coordinator') occupied += 1;
    } finally { if (!retained) { closeSync(fd); releaseLock(); } }
  }
  return result;
}

/**
 * Observe manager absence once. A held lock makes its journal stable; the existing Importer commits that final
 * history outside the decision transaction before any manager_lost decision. Locks remain held through COMMIT,
 * or transfer to the recovery launch when the reservation was never claimed.
 */
function observeUnmanaged(store: RunStore, context: SettleContext): RunId[] {
  for (const run of store.readUnfinished()) if (run.state === 'running') {
    let fd = -1;
    try {
      fd = lockFile(store, run.id);
      if (!tryLock(fd)) { closeSync(fd); continue; }
    } catch (error) {
      if (fd >= 0) closeSync(fd);
      if (!hasCode(error, 'ENOENT')) throw error;
      fd = -1;
    }
    context.unmanaged.set(run.id, fd);
  }
  return new RunEventImporter(store).pass([...context.unmanaged.keys()]);
}

/**
 * Also protects lock descriptors on callback, decision, or COMMIT failure. The decision sees every Run in the
 * workspace: every Task's Runs share the parallel limit.
 */
export async function settleTransaction(store: RunStore, settings: AgentsSettingsResult,
  before?: (tx: RunTransaction) => void): Promise<SettleDecision> {
  const context: SettleContext = { store, settings, releaseLocks: new Map(), launches: [], prepared: new Set(), folderFailures: new Map(), unmanaged: new Map() };
  try {
    const imported = observeUnmanaged(store, context);
    // Preflight only committed queued Runs. Filesystem work never runs under BEGIN IMMEDIATE.
    const existing = store.readUnfinished().filter(run => run.state === 'queued');
    const existingIds = new Set(existing.map(run => run.id));
    prepareQueued(store, existing, context);
    let fresh: RuntimeRunRecord[] = [];
    const result = store.write(tx => {
      before?.(tx);
      fresh = tx.forSettle().filter(run => run.state === 'queued' && !existingIds.has(run.id));
      return decide(tx, context);
    });
    // Runs admitted by `before` were invisible to preflight. Their first launch decision follows commit.
    if (fresh.length) {
      prepareQueued(store, fresh.filter(run => store.runtimeGet(run.id)?.state === 'queued'), context);
      absorb(result, store.write(tx => decide(tx, context)));
    }
    result.closed.push(...endedOf(store, imported));
    return { summary: result, launches: context.launches };
  } catch (error) { closeLaunches(context.launches); throw error; }
  finally {
    for (const fd of context.unmanaged.values()) if (fd >= 0) closeSync(fd);
    for (const held of context.releaseLocks.values()) if (held && --held.references === 0) held.close();
  }
}
export const managerScript = backendEntry('run-manager');

/** The reservation and original never-spawn cause close atomically, both for preparation and spawn faults. */
function failUnlaunched(store: RunStore, tx: RunTransaction, id: RunId, attempt: string, cause: unknown): void {
  const run = tx.runtimeGet(id);
  if (run?.state !== 'running') return;
  tx.update({ ...run, state: 'failed', reason: 'launch', ended_at: new Date().toISOString() });
  releaseReserved(store.connection, attempt, { evidence: 'manager_spawn_failed_before_transfer' });
  const fault = cause instanceof Error ? { message: cause.message, code: 'code' in cause ? String(cause.code) : null }
    : typeof cause === 'object' && cause ? cause : { message: String(cause), code: null };
  store.connection.prepare('UPDATE run_attempts SET diagnostic=? WHERE attempt_id=?').run(JSON.stringify({ kind: 'launch_aborted',
    evidence: 'manager_spawn_failed_before_transfer', cause: fault }), attempt);
  touch(store.connection, { kind: 'attempt', id: attempt });
}

/** Optional script path supports alternate internal packaging as well as missing-entry tests. */
export async function launch(store: RunStore, decision: SettleDecision, options: {
  script?: string; write?: Write; canLaunch?: () => boolean;
} = {}): Promise<SettleSummary> {
  const write = options.write ?? (async <T>(operation: () => T): Promise<T> => operation());
  const result = decision.summary;
  let pending = decision.launches;
  // One recovery pass. Persistent packaging failures must not create an endless launch loop.
  for (let pass = 0; pass < 2; pass++) {
    const failed: RunLaunch[] = [];
    const causes = new Map<RunId, unknown>();
    try {
      for (const item of pending) {
        if (options.canLaunch?.() === false || releaseAdmission(store.root)!=='accepting') { closeLaunches(pending); return result; }
        let logFd = -1;
        try {
          logFd = openRunFile(store.folder(item.id), RUN_FILES.managerLog, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND);
          const snapshot = attemptOf(store, item.id);
          if (!snapshot || snapshot.attemptId !== item.attemptId) throw new Error('Launch reservation disappeared');
          const script = options.script ?? snapshot.entry;
          publishAttempt(store, snapshot);
          publishCommands(store, true);
          writeSync(logFd, JSON.stringify({ release: snapshot.release, entry: snapshot.entry, version: snapshot.version }) + '\n');
          if (!statSync(script).isFile()) throw new Error(`Manager entry is not a file: ${script}`);
          const child = platform.run.spawnDetached(process.execPath, [script, store.root, item.id, snapshot.attemptId], {
            stdio: ['ignore', logFd, logFd, item.lockFd],
            env: { ...agentEnvironment(process.env, process.env.PATH ?? '', snapshot.server ?? undefined, snapshot.invocation.launch.env) },
          }, processUnit(store.root, item.id));
          await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
          if (child.pid === undefined) throw new Error('Manager did not receive a pid');
          child.unref(); result.launched.push(item.id);
          closeLaunches([item]);
        } catch (error) {
          try { if (logFd >= 0) writeSync(logFd, `Manager launch failed: ${String(error)}\n`); }
          catch { /* Diagnostics cannot prevent recording failed(launch). */ }
          causes.set(item.id, error); failed.push(item);
        } finally { if (logFd >= 0) closeSync(logFd); }
      }
      if (!failed.length) return result;
      const markFailed = (tx: RunTransaction) => {
        for (const item of failed) {
          failUnlaunched(store, tx, item.id, item.attemptId!, causes.get(item.id));
        }
      };
      // Keep our locks until the failed(launch) records commit, so a competing settle cannot call them lost.
      if (pass === 0) {
        const settings = readAgentsSettings(store.root);
        await write(() => store.write(markFailed));
        for (const item of pending) { item.releaseLock?.(); item.releaseLock = undefined; }
        const recovery = await write(() => settleTransaction(store, settings));
        absorb(result, recovery.summary);
        closeLaunches(pending); pending = recovery.launches;
      } else { await write(() => store.write(markFailed)); closeLaunches(pending); }
      result.failed.push(...failed.map(item => item.id));
    } catch (error) { closeLaunches(pending); throw error; }
  }
  return result;
}

/** Every settle point: close lost Runs whose agents are gone, read config.yaml, decide in one transaction, then launch. */
export async function settle(store: RunStore, write?: Write, canLaunch?: () => boolean, reviews = new RunReviewState()): Promise<SettleSummary> {
  publishWorkspaceIdentity(store);
  importLocalStops(store);
  const imported = new RunEventImporter(store).pass();
  const recovered = await recoverExecution(store, reviews);
  planInputs(store);
  publishCommands(store);
  const result = canLaunch?.() === false ? summary()
    : await launch(store, await settleTransaction(store, readAgentsSettings(store.root)), { write, canLaunch });
  result.closed = [...new Set([...result.closed, ...recovered, ...endedOf(store, imported)])];
  // Preflight may have imported a manager's final tail after the first scan; it owns the same file cleanup.
  const lateBlocked = blockedInvocations(store, result.closed);
  for (const id of result.closed) {
    const run = store.runtimeGet(id);
    if (run && !lateBlocked.has(runNumber(id))) reviews.cleanup(store, run);
  }
  reviews.retryCleanup(store);
  return result;
}
