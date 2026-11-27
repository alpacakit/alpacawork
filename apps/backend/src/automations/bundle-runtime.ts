import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ProgramCaller } from './program-credentials.js';
import { setTimeout as pause } from 'node:timers/promises';
import { AUTOMATION_SDK_CONTRACT_VERSION, automationProgramPreviewSchema, type ProgramAutomationEvent } from '@alpacawork/contract/automation-program';
import { hasCode, Problem, PROBLEM_CODE, redactSecrets } from '@alpacawork/core';
import { ControlStore, touch } from '@alpacawork/db';
import { restoreId } from '../release/journal.js';
import type { TaskActor } from '@alpacawork/raw';
import {
  bundleLifecycle, bundleProject, bundleVersion, readBundleAutomation,
  type BundleAutomation, type PreparedAutomationVersion,
} from './bundle-store.js';
import {
  bundleLimit, bundleRunRow, operationViews, readBundleEvent, requestBundleStop, safeBundleSettlement, settleBundleRun, touchBundleRun,
  type BundleSettlement, type RunKey,
} from './bundle-runs.js';
import { recoverAutomationBundle, runAutomationBundle, type BundleCallbacks, type BundleCompletion, type BundleIdentity, type BundlePhase, type ObservedBundleResult } from './bundle-process.js';
import { bundleError, type BundleError } from './bundle-ipc.js';
import { createBundleOperator, type BundleOperationContext } from './bundle-operations.js';

const START_MS = 60_000;
const SERVER_SHUTDOWN = Symbol('server shutdown');
type RunIdentity = { id: string; tokenDigest: string; generation: string; identity?: BundleIdentity; settlement?: BundleSettlement; cancelledAt?: number };
type ClaimedRun = { key: RunKey; automation: BundleAutomation; version: ReturnType<typeof bundleVersion>;
  event: ProgramAutomationEvent; identity: RunIdentity; token: string; revision: number; trial: boolean };

type Grant = { operate: BundleCallbacks['operate']; control: AbortController; stop: AbortSignal;
  receipts: Map<string, { fingerprint: string; result: Promise<unknown> }> };
type OrderedWrite = <T>(work: () => T | Promise<T>) => Promise<T>;

export function bundleNowWrite<T>(root: string, work: (db: DatabaseSync) => T): T {
  const control = new ControlStore(root);
  try { return control.write(work); } finally { control.close(); }
}
export function bundleNowRead<T>(root: string, work: (db: DatabaseSync) => T): T {
  const control = new ControlStore(root, { busyTimeoutMs: 1000 }, true);
  try { return control.read(work); } finally { control.close(); }
}
const parseAttempt = (value: unknown): RunIdentity | null => typeof value === 'string' ? JSON.parse(value) : null;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

function writeRunAttempt(db: DatabaseSync, key: RunKey, attempt: RunIdentity) {
  db.prepare('UPDATE automation_runs SET attempt=? WHERE automation_id=? AND number=?')
    .run(JSON.stringify(attempt), key.uuid, key.number);
}

function failedRun(error: BundleError, started: boolean, resolveTrigger = started): BundleSettlement {
  return { state: 'failed', kind: error.code ?? 'program_failed', reason: error.message ?? undefined,
    failedPhase: started ? 'run' : 'trigger', resolveTrigger, error };
}

function interruptedRun(started: boolean): BundleSettlement {
  return failedRun(bundleError('interrupted'), started, false);
}

function cancelledRun(started: boolean): BundleSettlement {
  return { state: started ? 'stopped' : 'skipped', kind: 'cancelled', reason: 'The automation was stopped' };
}

function previewSummary(summary: string | undefined, operations: ReturnType<typeof operationViews>): string | null {
  if (summary === undefined) return null;
  const titles = new Map<string, string>();
  for (const { name, replaced, outcome, result, input } of operations) {
    if (name !== 'tasks.create' || !replaced || outcome !== 'done') continue;
    const id = result && typeof result === 'object' && 'id' in result ? result.id : null;
    const title = input && typeof input === 'object' && 'title' in input ? input.title : null;
    if (typeof id === 'string' && typeof title === 'string') titles.set(id, title);
  }
  const composed = redactSecrets(summary).replace(/preview-\d+/g, id => titles.get(id) ?? id);
  return redactSecrets(composed);
}

/** Each content address is immutable. Publish the ESM tree only after every file is written. */
export async function materializeBundle(root: string, version: PreparedAutomationVersion): Promise<string> {
  const parent = join(root, '.automations'), destination = join(parent, version.digest), entry = join(destination, 'main.ts');
  try {
    if ((await lstat(destination)).isDirectory() && (await lstat(entry)).isFile()) return entry;
    throw new Error('The automation bundle cache has an unexpected entry');
  } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(join(parent, '.bundle-'));
  const directories = new Set([scratch]);
  let published = false;
  try {
    await writeFile(join(scratch, 'package.json'), '{"type":"module"}\n', { mode: 0o400, flag: 'wx' });
    for (const { path, source } of version.files) {
      const parts = path.split('/'), file = parts.pop()!;
      let directory = scratch;
      for (const part of parts) {
        directory = join(directory, part);
        if (directories.has(directory)) continue;
        await mkdir(directory, { mode: 0o700 });
        directories.add(directory);
      }
      await writeFile(join(directory, file), source, { mode: 0o400, flag: 'wx' });
    }
    for (const directory of directories) await chmod(directory, 0o500);
    try { await rename(scratch, destination); published = true; }
    catch (error) { if (!hasCode(error, 'EEXIST') && !hasCode(error, 'ENOTEMPTY')) throw error; }
    return entry;
  } finally {
    if (!published) {
      for (const directory of directories) await chmod(directory, 0o700);
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

export class BundleRuntime {
  private readonly active = new Map<string, { stop: AbortController; work: Promise<void>; automation: string | null }>();
  private readonly grants = new Map<string, Grant>();
  private readonly previewAbort = new Map<string, { stop: AbortController; automation: string | null; done: Promise<void> }>();
  private stopping = false;
  private loop: ReturnType<typeof setInterval> | undefined;
  private pumping: Promise<void> | undefined;
  private closing: Promise<void> | undefined;

  constructor(readonly root: string, readonly server: string, private readonly orderedWrite: OrderedWrite,
    private readonly operations: Parameters<typeof createBundleOperator>[2] = {}) {}

  private write<T>(work: (db: DatabaseSync) => T) { return this.orderedWrite(() => bundleNowWrite(this.root, work)); }

  start() {
    if (this.loop) return;
    this.loop = setInterval(() => this.kick(), 250);
    this.loop.unref();
    this.kick();
  }

  kick() {
    if (this.pumping || this.stopping) return;
    this.pumping = this.pump().catch(error => console.error('Automation process scan failed', error)).finally(() => { this.pumping = undefined; });
  }

  close() {
    return this.closing ??= (async () => {
      this.stopping = true;
      clearInterval(this.loop);
      for (const item of this.active.values()) item.stop.abort(SERVER_SHUTDOWN);
      for (const { stop } of this.previewAbort.values()) stop.abort();
      await this.pumping;
      await Promise.allSettled([...this.active.values()].map(item => item.work));
      await Promise.allSettled([...this.previewAbort.values()].map(item => item.done));
      await this.pump(true);
      const unconfirmed = bundleNowRead(this.root, db => db.prepare(`SELECT 1 FROM automation_runs WHERE state='running' AND attempt IS NOT NULL
        UNION ALL SELECT 1 FROM automation_previews WHERE result IS NULL AND attempt IS NOT NULL LIMIT 1`).get());
      if (unconfirmed) throw new Problem(PROBLEM_CODE.conflict, 'An automation process has not been confirmed stopped');
    })().catch(error => { this.closing = undefined; throw error; });
  }

  private isCurrent(db: DatabaseSync, run: ClaimedRun, phase?: BundlePhase): boolean {
    const row = bundleRunRow(db, run.key);
    const automation = readBundleAutomation(db, run.automation.id);
    const attempt = parseAttempt(row?.attempt);
    return row?.state === 'running' && row.phase !== 'stopping' && (!phase || phase === row.phase)
      && !automation.deleted && run.identity.generation === restoreId(this.root)
      && attempt?.id === run.identity.id && !attempt.settlement
      && (run.trial ? row.activation_epoch === automation.activationEpoch
        : automation.live !== null && row.activation_epoch === automation.activationEpoch);
  }

  private recordOutcome(db: DatabaseSync, automation: BundleAutomation, key: RunKey, attempt: RunIdentity,
    stopped: boolean, outcome: BundleSettlement): void {
    if (stopped) {
      settleBundleRun(db, automation, key.number, new Date(), outcome, this.root);
    } else {
      const row = bundleRunRow(db, key);
      if (attempt.settlement && row?.phase === 'stopping' && row.reason_kind === (outcome.kind ?? null)) return;
      const settlement = attempt.settlement ?? safeBundleSettlement(outcome);
      db.prepare(`UPDATE automation_runs SET phase='stopping',reason_kind=?,attempt=?,version=version+1
        WHERE automation_id=? AND number=?`).run(settlement.kind ?? null, JSON.stringify({ ...attempt, settlement }), key.uuid, key.number);
      touchBundleRun(db, automation, key.number);
    }
  }

  private async pump(recoveryOnly = false) {
    let unknownStops = 0;
    const stalePreviews = bundleNowRead(this.root, db => db.prepare(`SELECT id,attempt FROM automation_previews
      WHERE result IS NULL AND attempt IS NOT NULL`).all());
    for (const row of stalePreviews) {
      const active = this.previewAbort.get(String(row.id));
      if (active) {
        if (JSON.parse(String(row.attempt)).phase === 'stopping') active.stop.abort();
        continue;
      }
      const attempt = parseAttempt(row.attempt);
      if (attempt?.identity && !await recoverAutomationBundle(attempt.identity)) { unknownStops++; continue; }
      await this.write(db => {
        db.prepare('UPDATE automation_previews SET attempt=NULL WHERE id=? AND attempt=?').run(row.id!, row.attempt!);
        db.prepare(`UPDATE automation_operations SET outcome='failed',code=CASE WHEN name='send' THEN 'unknown_result' ELSE 'temporary' END
          WHERE preview_id=? AND outcome='running'`).run(row.id!);
      });
    }
    const stale = bundleNowRead(this.root, db => db.prepare(`SELECT a.external_id,r.automation_id,r.number,r.attempt
      FROM automation_runs r JOIN automations a ON r.automation_id=a.id
      WHERE r.state='running' AND r.attempt IS NOT NULL ORDER BY r.at LIMIT 128`).all());
    for (const row of stale) {
      if (this.stopping && !recoveryOnly) return;
      const key = { uuid: String(row.automation_id), number: Number(row.number) };
      const marker = parseAttempt(row.attempt)!;
      const active = this.active.get(marker.id);
      if (active) {
        const valid = bundleNowRead(this.root, db => {
          const current = bundleRunRow(db, key);
          const automation = readBundleAutomation(db, String(row.external_id));
          return current?.state === 'running' && current.phase !== 'stopping' && !automation.deleted
            && current.activation_epoch === automation.activationEpoch;
        });
        if (!valid) active.stop.abort();
      } else {
        const stopped = !marker.identity || await recoverAutomationBundle(marker.identity);
        if (!stopped) unknownStops++;
        await this.write(db => {
          const current = bundleRunRow(db, key);
          const attempt = parseAttempt(current?.attempt);
          if (current?.state !== 'running' || attempt?.id !== marker.id) return;
          const automation = readBundleAutomation(db, String(row.external_id));
          const started = current.run_started_at !== null;
          const outcome = attempt.settlement ?? (current.reason_kind === 'cancelled' ? cancelledRun(started) : interruptedRun(started));
          this.recordOutcome(db, automation, key, attempt, stopped, outcome);
        });
      }
    }
    while (!this.stopping && this.active.size + this.previewAbort.size + unknownStops < 4) {
      const claim = await this.write(db => this.claim(db, new Date()));
      if (!claim || this.stopping) break;
      const stop = new AbortController();
      const work = this.execute(claim, stop.signal).catch(error => console.error('Automation run failed to settle', error))
        .finally(() => { this.active.delete(claim.identity.id); this.kick(); });
      this.active.set(claim.identity.id, { stop, work, automation: claim.automation.uuid });
    }
  }

  private claim(db: DatabaseSync, now: Date): ClaimedRun | null {
    const rows = db.prepare(`SELECT a.external_id,r.automation_id,r.number FROM automation_runs r
      JOIN automations a ON a.id=r.automation_id WHERE r.state='running' AND r.attempt IS NULL AND r.phase='trigger'
      ORDER BY r.at,a.number,r.number LIMIT 128`).all();
    for (const row of rows) {
      const automation = readBundleAutomation(db, String(row.external_id));
      const key = { uuid: automation.uuid, number: Number(row.number) };
      const candidate = bundleRunRow(db, key)!;
      const cancelled = automation.deleted || candidate.activation_epoch !== automation.activationEpoch;
      if (cancelled || now.getTime() - Date.parse(String(candidate.phase_started_at ?? candidate.at)) >= START_MS) {
        settleBundleRun(db, automation, key.number, now, { state: 'skipped', kind: cancelled ? 'cancelled' : 'start_wait_expired',
          reason: cancelled ? 'The automation was turned off' : 'No execution slot became available in time' });
        continue;
      }
      if (db.prepare(`SELECT 1 FROM automation_runs WHERE automation_id=? AND state='running' AND attempt IS NOT NULL`).get(automation.uuid)
        || [...this.active.values()].some(x => x.automation === automation.uuid)
        || [...this.previewAbort.values()].some(x => x.automation === automation.uuid)
        || db.prepare('SELECT 1 FROM automation_previews WHERE automation_id=? AND result IS NULL AND attempt IS NOT NULL').get(automation.uuid)) continue;
      const version = bundleVersion(db, key.uuid, String(candidate.digest));
      if (version.contractVersion !== AUTOMATION_SDK_CONTRACT_VERSION) {
        settleBundleRun(db, automation, key.number, now, { state: 'skipped', kind: 'program_contract_changed', reason: 'Save with the current SDK' });
        continue;
      }
      const refusal = candidate.mode === 'live' ? bundleLimit(db, automation, version.config, now) : null;
      if (refusal) {
        settleBundleRun(db, automation, key.number, now, { state: 'skipped', ...refusal });
        continue;
      }
      const event = readBundleEvent(db, key);
      if (!event) throw new Error('An admitted automation has no event');
      const token = randomBytes(32).toString('hex');
      const identity = { id: randomUUID(), tokenDigest: digest(token), generation: restoreId(this.root) };
      const at = now.toISOString();
      db.prepare(`UPDATE automation_runs SET attempt=?,started_at=?,phase_started_at=?,version=version+1
        WHERE automation_id=? AND number=?`).run(JSON.stringify(identity), at, at, key.uuid, key.number);
      touchBundleRun(db, automation, key.number);
      const revision = candidate.activation_revision === null ? automation.revision : Number(candidate.activation_revision);
      return { key, automation, event, identity, token, version, revision, trial: candidate.mode === 'trial' };
    }
    return null;
  }

  private async execute(run: ClaimedRun, stop: AbortSignal) {
    let result: BundleCompletion;
    let cwd: string | undefined;
    let refusal: { kind: string; reason: string } | null = null;
    const operate = createBundleOperator(this.root, {
      project: { id: run.automation.project, uuid: run.automation.projectUuid }, automation: run.automation, config: run.version.config,
      event: run.event, target: { runNumber: run.key.number, revision: run.revision, digest: run.version.digest, trial: run.trial },
      permit: (db, phase) => this.isCurrent(db, run, phase),
    }, this.operations);
    this.openGrant(run.identity.id, operate, stop);
    const saveCompletion = async (observed: ObservedBundleResult, stopped: boolean) => {
      await this.write(db => {
        const row = bundleRunRow(db, run.key), attempt = parseAttempt(row?.attempt);
        if (row?.state !== 'running' || attempt?.id !== run.identity.id) return;
        const automation = readBundleAutomation(db, run.automation.id), started = row.run_started_at !== null;
        if (attempt.settlement) {
          this.recordOutcome(db, automation, run.key, attempt, stopped, { ...attempt.settlement, output: observed.outputTail });
          return;
        }
        const { outcome } = observed;
        const trigger = outcome?.trigger ? { run: outcome.trigger.run, reason: redactSecrets(outcome.trigger.reason) } : null;
        const finish = (value: BundleSettlement) =>
          this.recordOutcome(db, automation, run.key, attempt, stopped, { ...value, output: observed.outputTail, trigger });
        // A user stop recorded before the process completed owns the outcome even if polling delivered it later.
        if (attempt.cancelledAt !== undefined && attempt.cancelledAt <= observed.completedAt) return finish(cancelledRun(started));
        if (observed.timedOut) return finish(failedRun(bundleError('timeout'), started));
        if (observed.abortedBySignal)
          return finish(stop.reason === SERVER_SHUTDOWN ? interruptedRun(started) : cancelledRun(started));
        if (refusal) return finish({ state: 'skipped', ...refusal, resolveTrigger: true });
        if (outcome?.limit) return finish({ state: started ? 'stopped' : 'skipped', kind: 'limit:' + outcome.limit, reason: outcome.reason ?? 'Operation limit reached' });
        if (outcome?.state === 'skipped') return finish({ state: 'skipped', kind: 'trigger_rejected', reason: outcome.reason ?? trigger?.reason ?? 'Trigger did not match', resolveTrigger: true });
        if (outcome?.state === 'done') return finish({ state: 'done', resolveTrigger: true, ...outcome.result });
        return finish(failedRun(outcome?.error ?? bundleError('program_no_result'), started));
      });
    };
    try {
      cwd = await mkdtemp(join(this.root, '.automation-run-'));
      const entry = await materializeBundle(this.root, run.version);
      result = await runAutomationBundle({ entry, cwd, event: run.event, preview: false,
        timeoutMinutes: run.version.config.limits.timeoutMinutes ?? 10, token: run.token, server: this.server, restoreId: run.identity.generation }, {
        recordIdentity: identity => this.write(db => {
          const current = bundleRunRow(db, run.key);
          const attempt = parseAttempt(current?.attempt);
          if (current?.state !== 'running' || attempt?.id !== run.identity.id) throw new Error('Automation no longer active');
          // A stop can precede identification. Recovery still needs the identity of that process.
          writeRunAttempt(db, run.key, { ...attempt, identity });
        }),
        beforeImport: () => !stop.aborted && bundleNowRead(this.root, db => this.isCurrent(db, run, 'trigger')),
        beforeRun: trigger => this.write(db => {
          if (stop.aborted || !this.isCurrent(db, run, 'trigger')) return { allowed: false, reason: 'The automation was stopped' };
          const current = readBundleAutomation(db, run.automation.id), now = new Date();
          refusal = run.trial ? null : bundleLimit(db, current, run.version.config, now);
          if (refusal) return { allowed: false, reason: refusal.reason };
          const at = now.toISOString();
          db.prepare(`UPDATE automation_runs SET version=version+1,phase='run',phase_started_at=?,run_started_at=?,trigger_result=?
            WHERE automation_id=? AND number=?`).run(at, at, trigger ? JSON.stringify({ run: trigger.run, reason: redactSecrets(trigger.reason) }) : null,
            run.key.uuid, run.key.number);
          touchBundleRun(db, current, run.key.number);
          return { allowed: true };
        }),
        operate, beforeStopping: outcome => saveCompletion(outcome, false),
      }, stop);
    } catch {
      result = { stopped: true, abortedBySignal: stop.aborted, completedAt: Date.now(), timedOut: false, phase: 'trigger', exitCode: null, signal: null, outputTail: [],
        outcome: { state: 'failed', trigger: null, result: null, error: bundleError('program_start_failed') } };
    } finally {
      await this.closeGrant(run.identity.id);
      if (cwd) await rm(cwd, { force: true, recursive: true }).catch(() => {});
    }

    await saveCompletion(result, result.stopped);
  }

  private openGrant(id: string, operate: BundleCallbacks['operate'], stop: AbortSignal) {
    const control = new AbortController();
    this.grants.set(id, { operate, control, stop: AbortSignal.any([stop, control.signal]), receipts: new Map() });
  }

  private async closeGrant(id: string) {
    const grant = this.grants.get(id);
    this.grants.delete(id);
    if (!grant) return;
    grant.control.abort();
    await Promise.allSettled([...grant.receipts.values()].map(receipt => receipt.result));
  }

  operate(caller: ProgramCaller, operationId: string, operation: Parameters<BundleCallbacks['operate']>[1], input: unknown) {
    const grant = this.grants.get(caller.attemptId);
    if (!grant || grant.stop.aborted) throw new Problem(PROBLEM_CODE.forbidden, 'Automation credential is not active');
    const fingerprint = digest(JSON.stringify([operation, input]));
    const previous = grant.receipts.get(operationId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Operation ID belongs to a different operation');
      return previous.result;
    }
    if (grant.receipts.size >= 1000) throw new Problem(PROBLEM_CODE.conflict, 'The run reached its CLI operation limit');
    const result = Promise.resolve().then(() => grant.operate(
      caller.stage === 'condition' ? 'trigger' : 'run', operation, input, grant.stop, 0));
    grant.receipts.set(operationId, { fingerprint, result });
    return result;
  }

  async preview(project: string, automation: BundleAutomation | null, version: PreparedAutomationVersion, event: ProgramAutomationEvent,
    by: TaskActor, executeRun: boolean) {
    const deadline = Date.now() + START_MS;
    const hasSlot = () => bundleNowRead(this.root, db => {
      const attempts = db.prepare("SELECT automation_id FROM automation_runs WHERE state='running' AND attempt IS NOT NULL").all();
      const previews = db.prepare("SELECT id,automation_id FROM automation_previews WHERE result IS NULL AND attempt IS NOT NULL").all()
        .filter(row => !this.previewAbort.has(String(row.id)));
      return attempts.length + previews.length + this.previewAbort.size < 4 && (!automation ||
        ![...attempts, ...previews].some(row => row.automation_id === automation.uuid) &&
        ![...this.previewAbort.values()].some(row => row.automation === automation.uuid));
    });
    while (!this.stopping && !hasSlot()) {
      if (Date.now() >= deadline) throw new Problem(PROBLEM_CODE.busy, 'No automation execution slot became available in time');
      await pause(100);
    }
    if (this.stopping) throw new Problem(PROBLEM_CODE.unavailable, 'The workspace is closing');
    const uuid = randomUUID(), stop = new AbortController(), token = randomBytes(32).toString('hex');
    const generation = restoreId(this.root);
    const attempt = { tokenDigest: digest(token), generation, by, phase: 'trigger' };
    let finished!: () => void;
    const done = new Promise<void>(resolve => { finished = resolve; });
    this.previewAbort.set(uuid, { stop, automation: automation?.uuid ?? null, done });
    let cwd: string | undefined;
    try {
      const at = new Date().toISOString();
      const projectUuid = await this.write(db => {
        const projectUuid = bundleProject(db, project);
        db.prepare('INSERT INTO automation_previews(id,project_task_id,automation_id,digest,event,attempt,at) VALUES (?,?,?,?,?,?,?)')
          .run(uuid, projectUuid, automation?.uuid ?? null, version.digest, JSON.stringify(event), JSON.stringify(attempt), at);
        return projectUuid;
      });
      const entry = await materializeBundle(this.root, version);
      cwd = await mkdtemp(join(this.root, '.automation-preview-'));
      const permit: BundleOperationContext['permit'] = (db, phase) => !stop.signal.aborted && generation === restoreId(this.root) &&
        !!db.prepare("SELECT 1 FROM automation_previews WHERE id=? AND result IS NULL AND json_extract(attempt,'$.phase')=?").get(uuid, phase)
        && (!automation || !readBundleAutomation(db, automation.id).deleted);
      const operate = createBundleOperator(this.root, {
        project: { id: project, uuid: projectUuid }, automation, config: version.config, event, target: { previewId: uuid }, permit,
      }, this.operations);
      this.openGrant(uuid, operate, stop.signal);
      const result = await runAutomationBundle({ entry, cwd, event, preview: true, previewRun: executeRun,
        timeoutMinutes: version.config.limits.timeoutMinutes ?? 10, token, server: this.server, restoreId: generation }, {
        recordIdentity: identity => this.write(db => {
          db.prepare("UPDATE automation_previews SET attempt=json_set(attempt,'$.identity',json(?)) WHERE id=?").run(JSON.stringify(identity), uuid);
        }),
        beforeImport: () => bundleNowRead(this.root, db => permit(db, 'trigger')),
        beforeRun: () => this.write(db => {
          if (!executeRun || !permit(db, 'trigger')) return { allowed: false };
          db.prepare("UPDATE automation_previews SET attempt=json_set(attempt,'$.phase','run','$.ran',1) WHERE id=?").run(uuid);
          return { allowed: true };
        }),
        operate,
      }, stop.signal);
      await this.closeGrant(uuid);
      if (!result.stopped) throw new Problem(PROBLEM_CODE.conflict, 'Waiting to confirm the preview stopped');
      const preview = await this.write(db => {
        const outcome = result.outcome, trigger = outcome?.trigger ?? null;
        const records = operationViews(db, { previewId: uuid });
        const operations = records.map(({ ordinal: _ordinal, at: _at, durationMs: _duration,
          taskState: _taskState, usage, ...operation }) => ({ ...operation, usage: usage && { model: usage.model, costUsd: usage.costUsd } }));
        const state = result.timedOut ? 'failed' : outcome?.state ?? 'failed';
        const error = result.timedOut ? bundleError('timeout')
          : outcome?.error ?? (state === 'failed' ? bundleError(result.abortedBySignal ? 'interrupted' : 'program_no_result') : null);
        const preview = automationProgramPreviewSchema.parse({
          hash: digest(JSON.stringify([uuid, projectUuid, version.digest, event])),
          at, by, event: { kind: event.kind, ref: event.ref, manual: event.manual },
          ran: db.prepare("SELECT json_extract(attempt,'$.ran') AS ran FROM automation_previews WHERE id=?").get(uuid)?.ran === 1,
          trigger: trigger && { run: trigger.run, reason: redactSecrets(trigger.reason) }, operations,
          outcome: { state, summary: previewSummary(outcome?.result?.summary, records),
            report: outcome?.result?.report ?? null, notify: !!outcome?.result?.notify,
            error },
        });
        db.prepare('UPDATE automation_previews SET result=?,attempt=NULL WHERE id=?').run(JSON.stringify(preview), uuid);
        if (automation) touch(db, { kind: 'automation', id: automation.id });
        return preview;
      });
      if (executeRun && preview.trigger?.run === false)
        throw new Problem(PROBLEM_CODE.conflict, 'The trigger declined the event', preview);
      return preview;
    } finally {
      await this.closeGrant(uuid);
      this.previewAbort.delete(uuid);
      try { if (cwd) await rm(cwd, { force: true, recursive: true }); }
      finally { finished(); }
    }
  }
}

export function stopBundleRun(db: DatabaseSync, automation: BundleAutomation, number: number, version: number, now: Date) {
  const row = bundleRunRow(db, { uuid: automation.uuid, number });
  if (!row) throw new Problem(PROBLEM_CODE.notFound, 'Automation run does not exist');
  if (row.version !== version || row.finished_at !== null) throw new Problem(PROBLEM_CODE.conflict, 'The run changed; read it again');
  if (row.phase === 'stopping') return null;
  if (!row.attempt) return settleBundleRun(db, automation, number, now, cancelledRun(false));
  requestBundleStop(db, automation, now, number);
  return null;
}
