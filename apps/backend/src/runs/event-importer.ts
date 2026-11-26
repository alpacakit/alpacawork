import { assertImportAdmission } from '../release/journal.js';
import { thisRelease } from '../release/location.js';
/**
 * One transactional projection of validated execution facts and managed output's first session. Cursor, receipts, results, routing dirtiness and
 * coordinator message links move together. A coordinator's answer keeps its linked files first (`captureAnswer`).
 */
import { join } from 'node:path';
import { lstatSync } from 'node:fs';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { digestBytes, hasCode, publishImmutable, readImmutable, strictJson } from '@alpacawork/core';
import { ackSchema, eventSchema, launchSchema, protocolFingerprint, PROTOCOL_LIMITS, type RunEvent } from '@alpacawork/contract/run-protocol';
import { runNumber, type CoordinatorRunRecord, type RuntimeRunRecord } from '@alpacawork/contract/run';
import type { RunId } from '@alpacawork/contract/fields';
import { DELIVERY_STATE } from '@alpacawork/contract/control';
import { UNFINISHED_SQL, type RunStore, type RunTransaction } from '@alpacawork/runs';
import { touch } from '@alpacawork/db';
import type { RoutingTasks } from '../control/routing-work.js';
import { executionFolder, identityOf, messageName, names, sameIdentity } from './execution-files.js';
import { captureAnswer, recordEnd, type AnswerCapture } from './ending.js';
import { reserveAiFallback } from './ai-fallback.js';
import type { EndObservation, Outcome } from './result-observation.js';
import { automaticCoordinatorReset } from '../coordinator/continuation.js';
import { reserveCoordinatorReset } from '../coordinator/resets.js';
import { readRunActivityView } from '../agents/context-limits.js';
import { readAgentsSettings } from '../agents-settings.js';
import { linkMessage } from '../coordinator/messages.js';
import { executionImportCandidates, executionReference } from './execution-obligations.js';
import { runtimeAdapter } from '../agents/registry.js';
import { recordCompaction, settleCompaction } from './compactions.js';
const importFormat = protocolFingerprint();

/**
 * Records, in the caller's transaction on `db`, what became of one input handed to `into`'s agent (`input`, its
 * run_inputs row): `state`, proved by `receipt`; a taken input stays taken. When the agent took in a later message
 * (not its Run's own prompt), that message's queued Run joins `into` at `at`, and a coordinator's Request is linked.
 * The importer records the manager's receipts here, and recovery those it reads back after the manager was lost; no one else joins a Run or links a Request on a receipt.
 */
function recordReceipt(db: DatabaseSync, tx: RunTransaction, input: Record<string, SQLOutputValue>,
  state: 'taken' | 'not_sent' | 'uncertain', receipt: unknown, into: RunId, at: string): void {
  if (input.state !== 'taken' && db.prepare('UPDATE run_inputs SET state=?,receipt_json=? WHERE input_id=?')
    .run(state, JSON.stringify(receipt), String(input.input_id)).changes) touch(db, { kind: 'input', id: String(input.input_id) });
  if (state !== 'taken' || input.initial) return;
  const joined = tx.runtimeGet(`R${input.instruction_run_no}`);
  if (joined?.state !== 'queued') return;
  tx.finish({ ...joined, state: 'joined', into, ended_at: at }, { state: 'missing', text: null });
  tx.updateRequest(joined.requestId, DELIVERY_STATE.queued);
  if (joined.role === 'coordinator') linkMessage(db, joined);
}

/**
 * Reserved inputs with no durable attempt were never written. Called once the attempt can write no more: it completed, or
 * its manager never spawned.
 */
export function releaseReserved(db: DatabaseSync, attempt: string, receipt: { evidence: string; completedDigest?: string }): void {
  const inputs = db.prepare("UPDATE run_inputs SET state='not_sent',receipt_json=? WHERE attempt_id=? AND state='reserved' RETURNING input_id")
    .all(JSON.stringify(receipt), attempt);
  for (const input of inputs) touch(db, { kind: 'input', id: String(input.input_id) });
}

export type RoutingReceipt = { readonly attemptId: string; readonly nextSeq: number;
  readonly completedDigest: string | null; readonly record: string };

export class RunEventImporter {
  constructor(readonly store: RunStore) {}
  /**
   * An agent can call the CLI before its manager's next poll journals its first session. Read only a current attempt
   * whose start was already validated by pass(), through the same adapter reader the manager uses. The manager's
   * later session event must agree with this observation. No caller-supplied conversation establishes ownership.
   */
  discoverSessions(runIds: readonly string[]): void {
    if (!runIds.length) return;
    assertImportAdmission(this.store.root, thisRelease());
    for (const attempt of this.candidates('a.*,r.prompt', runIds)) {
      if (attempt.started_json === null || attempt.completed_digest !== null || attempt.diagnostic !== null) continue;
      const id = `R${attempt.run_no}`, run = this.store.runtimeGet(id);
      if (!run || run.state !== 'running' || run.session !== null || run.pids.agent === null) continue;
      if (executionReference(this.store, attempt).format !== importFormat) continue;
      const launch = launchSchema.parse({ ...JSON.parse(String(attempt.launch_json)), prompt: String(attempt.prompt) });
      const adapter = runtimeAdapter(launch.invocation.launch.adapter);
      const session = adapter?.earlySession({ mode: launch.invocation.mode, session: launch.invocation.session?.id ?? null },
        this.store.folder(id));
      if (!session) continue;
      this.store.write(tx => {
        const current = tx.runtimeGet(id);
        if (current?.state === 'running' && current.session === null && current.pids.agent === run.pids.agent)
          tx.update({ ...current, session: { provider: current.agent, id: session } });
      });
    }
  }
  /** Capture before the asynchronous business pass; a completion imported during that pass belongs to a later one. */
  routingReceipts(work: RoutingTasks): RoutingReceipt[] {
    return this.store.connection.prepare(`SELECT a.attempt_id,a.next_seq,a.completed_digest,r.record FROM run_attempts a
      JOIN runs r ON r.id=a.run_no WHERE a.dirty=1 AND r.task_id IN (SELECT value FROM json_each(?))
      AND (a.completed_digest IS NOT NULL OR r.state NOT IN (${UNFINISHED_SQL}))`)
      .all(JSON.stringify([...work.tasks])).map(row => ({ attemptId: String(row.attempt_id), nextSeq: Number(row.next_seq),
        completedDigest: row.completed_digest as string | null, record: String(row.record) }));
  }
  /** Acknowledge only processed seats and the evidence captured before processing. Protocol cursors are not screen facts. */
  acknowledgeRouting(work: RoutingTasks, receipts: readonly RoutingReceipt[]): void {
    if (!receipts.length || !work.tasks.size) return;
    this.store.write(() => {
      const update = this.store.connection.prepare(`UPDATE run_attempts SET dirty=0 WHERE dirty=1 AND attempt_id=?
        AND next_seq=? AND completed_digest IS ? AND EXISTS (SELECT 1 FROM runs r WHERE r.id=run_attempts.run_no
          AND r.task_id IN (SELECT value FROM json_each(?)) AND r.record=?)`);
      const tasks = JSON.stringify([...work.tasks]);
      for (const receipt of receipts) update.run(receipt.attemptId, receipt.nextSeq, receipt.completedDigest, tasks, receipt.record);
    });
  }
  /** The same indexed candidate set for demand and import; only pass validates and advances it. */
  private candidates(columns: string, runIds?: readonly string[]) {
    const read = this.store.connection.prepare(`SELECT ${columns} FROM run_attempts a JOIN runs r ON r.id=a.run_no WHERE a.attempt_id=?`);
    return executionImportCandidates(this.store, runIds).map(a => read.get(String(a.attempt_id))!);
  }
  private folder(attempt: Record<string, SQLOutputValue>): string {
    return executionFolder(this.store.root, `R${attempt.run_no}`, String(attempt.attempt_id));
  }
  /** Notifications are advisory. A published tail or an unacknowledged cursor still needs the same import pass.
   * Empty live journals and diagnosed faults do not demand repeated reconciliation; fault repair keeps its existing
   * notification/periodic path. The probe validates no bytes and never decides a Run's outcome.
   */
  hasPublishedTail(): boolean {
    try {
      for (const attempt of this.candidates('a.run_no,a.attempt_id,a.next_seq,a.acked_seq,a.completed_digest,a.diagnostic')) {
        if (attempt.diagnostic !== null) continue;
        if (Number(attempt.acked_seq) < Number(attempt.next_seq) - 1) return true;
        if (attempt.completed_digest !== null) continue;
        try { lstatSync(join(this.folder(attempt), 'events', messageName(Number(attempt.next_seq)))); return true; }
        catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
      }
      return false;
    } catch {
      // Only absence means no published input. A resource/permission/DB fault is demand for the real pass,
      // whose diagnostic/error path owns it; it must neither look like an absent event nor escape the caller.
      return true;
    }
  }
  pass(runIds?: readonly string[]): string[] {
    assertImportAdmission(this.store.root,thisRelease());
    if (runIds?.length === 0) return [];
    const imported: string[] = [];
    const attempts = this.candidates('a.*,r.prompt', runIds);
    for (const attempt of attempts) {
      if (executionReference(this.store, attempt).format !== importFormat)
        throw new Error(`Execution FORMAT differs for R${attempt.run_no}; settle the retained exchange with its recorded release before switching`);
      const launch = launchSchema.parse({ ...JSON.parse(String(attempt.launch_json)), prompt: String(attempt.prompt) }), spool = this.folder(attempt);
      let next = Number(attempt.next_seq), previous = attempt.last_digest as string | null;
      try {
        // The committed cursor owns the verified prefix. Recheck its boundary, then read only the new tail.
        if (next > 1) {
          let boundary: Buffer;
          try { boundary = readImmutable(join(spool, 'events'), messageName(next - 1), PROTOCOL_LIMITS.event); }
          catch (error) { if (hasCode(error, 'ENOENT')) throw new Error('Imported execution events are missing', { cause: error }); throw error; }
          if (digestBytes(boundary) !== previous) throw new Error('Imported event was modified');
        }
        const eventNames = names(join(spool, 'events')).filter(name => name >= messageName(next));
        for (const name of eventNames) {
          if (name !== messageName(next)) throw new Error(`Execution sequence gap: expected ${messageName(next)}, found ${name}`);
          const bytes = readImmutable(join(spool, 'events'), name, PROTOCOL_LIMITS.event);
          const event = eventSchema.parse(strictJson(bytes)) as RunEvent, digest = digestBytes(bytes);
          sameIdentity(event, launch);
          if (event.seq !== next || event.previousDigest !== previous) throw new Error('Execution sequence/digest mismatch');
          let text: string | null = null;
          if (event.type === 'completed' && event.payload.result.state === 'present') {
            const result = event.payload.result;
            if (!result.digest) throw new Error('Present result has no digest');
            const blob = readImmutable(join(spool, 'results'), `${result.digest}.bin`, PROTOCOL_LIMITS.result);
            if (blob.length !== result.size || digestBytes(blob) !== result.digest) throw new Error('Result digest/size mismatch');
            text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(blob);
          }
          const ending = event.type === 'completed' ? this.store.runtimeGet(launch.runId) : null;
          const answer = event.type === 'completed' && ending
            ? captureAnswer(this.store.root, ending, event.payload.outcome.state === 'succeeded', text) : undefined;
          const applied = this.store.write(tx => {
            const cursor = this.store.connection.prepare('SELECT next_seq,last_digest,completed_digest FROM run_attempts WHERE attempt_id=?').get(launch.attemptId)!;
            if (Number(cursor.next_seq) !== event.seq || cursor.last_digest !== event.previousDigest)
              throw new Error('Execution import cursor changed');
            if (cursor.completed_digest !== null) throw new Error('Event after completion');
            const run = tx.runtimeGet(launch.runId);
            if (!run) throw new Error('Execution Run disappeared');
            this.apply(tx, run, event, text, digest, answer);
            this.store.connection.prepare('UPDATE run_attempts SET next_seq=?,last_digest=? WHERE attempt_id=?')
              .run(event.seq + 1, digest, launch.attemptId);
            return true;
          });
          if (applied && !imported.includes(launch.runId)) imported.push(launch.runId);
          next++; previous = digest;
        }
        // Ack publication follows commit. Its durable cursor keeps completion eligible after a crash before publication.
        const cursor = this.store.connection.prepare('SELECT next_seq,last_digest,acked_seq FROM run_attempts WHERE attempt_id=?').get(launch.attemptId)!;
        if (Number(cursor.next_seq) - 1 > Number(cursor.acked_seq)) {
          const ack = ackSchema.parse({ ...identityOf(launch), throughSeq: Number(cursor.next_seq) - 1, eventDigest: cursor.last_digest });
          publishImmutable(join(spool, 'acks'), `${ack.throughSeq}-${ack.eventDigest}.json`, JSON.stringify(ack));
          this.store.write(() => this.store.connection.prepare('UPDATE run_attempts SET acked_seq=max(acked_seq,?) WHERE attempt_id=?')
            .run(ack.throughSeq, launch.attemptId));
          // A recovered completion must revisit exchange-file cleanup after its diagnostic stopped that cleanup.
          if (attempt.completed_digest !== null && !imported.includes(launch.runId)) imported.push(launch.runId);
        }
        // Recovery includes ack publication; clearing first would turn an ack fault into clear/restore commits each tick.
        if (attempt.diagnostic !== null && JSON.parse(String(attempt.diagnostic)).kind === 'execution_fault') this.store.write(() => {
          if (this.store.connection.prepare('UPDATE run_attempts SET diagnostic=NULL WHERE attempt_id=?').run(launch.attemptId).changes)
            touch(this.store.connection, { kind: 'attempt', id: launch.attemptId });
        });
      } catch (error) {
        const diagnostic = { kind: 'execution_fault', runId: launch.runId, attemptId: launch.attemptId,
          expectedSeq: next, message: error instanceof Error ? error.message : String(error) };
        this.store.write(tx => {
          // A retained fault is not new progress: republishing it would wake this same pass through data_version.
          const serialized = JSON.stringify(diagnostic);
          if (this.store.connection.prepare('UPDATE run_attempts SET diagnostic=? WHERE attempt_id=? AND diagnostic IS NOT ?')
            .run(serialized, launch.attemptId, serialized).changes)
            touch(this.store.connection, { kind: 'attempt', id: launch.attemptId });
          const run=tx.runtimeGet(launch.runId);
          // The diagnostic owns the cause; the existing generic review state is a boundary projection.
          if(run?.state==='running')tx.update({...run,state:'needs_review',reason:null});
        });
        console.error(JSON.stringify(diagnostic));
      }
    }
    return imported;
  }
  private apply(tx: RunTransaction, run: RuntimeRunRecord, event: RunEvent, text: string | null, digest: string,
    answer: AnswerCapture): void {
    const db = this.store.connection, attempt = event.attemptId;
    const row = db.prepare('SELECT * FROM run_attempts WHERE attempt_id=?').get(attempt)!;
    if (event.type === 'claimed') {
      if (row.claimed) throw new Error('Duplicate execution claim');
      db.prepare('UPDATE run_attempts SET claimed=1 WHERE attempt_id=?').run(attempt);
      tx.update({ ...run, pids: { ...run.pids, manager: event.payload.managerPid } });
    } else if (event.type === 'spawn_intent') {
      if (!row.claimed || row.spawn_intent) throw new Error('Invalid spawn intent');
      db.prepare('UPDATE run_attempts SET spawn_intent=1 WHERE attempt_id=?').run(attempt);
    } else if (event.type === 'started') {
      if (!row.spawn_intent || row.started_json !== null) throw new Error('Invalid process start');
      db.prepare('UPDATE run_attempts SET started_json=? WHERE attempt_id=?').run(JSON.stringify(event.payload), attempt);
      tx.update({ ...run, pids: { ...run.pids, agent: event.payload.pid } });
      if (run.role === 'coordinator') linkMessage(db, run);
    } else if (event.type === 'session') {
      if (run.session && run.session.id !== event.payload.id) throw new Error('Session identity changed');
      if (!run.session) tx.update({ ...run, session: { provider: run.agent, id: event.payload.id } });
    } else if (event.type === 'input_attempt') {
      const input = db.prepare('SELECT * FROM run_inputs WHERE input_id=? AND attempt_id=?').get(event.payload.inputId, attempt);
      if (!input || input.state !== 'reserved' || input.instruction_run_no !== runNumber(event.payload.instructionRunId) ||
        input.content_digest !== event.payload.contentDigest) throw new Error('Input attempt identity/state mismatch');
      db.prepare("UPDATE run_inputs SET state='attempted' WHERE input_id=?").run(event.payload.inputId);
      touch(db, { kind: 'input', id: event.payload.inputId });
    } else if (event.type === 'input_taken' || event.type === 'input_not_sent' || event.type === 'input_uncertain') {
      const input = db.prepare('SELECT * FROM run_inputs WHERE input_id=? AND attempt_id=?').get(event.payload.inputId, attempt);
      const state = event.type === 'input_taken' ? 'taken' : event.type === 'input_not_sent' ? 'not_sent' : 'uncertain';
      if (!input) throw new Error('Unknown input receipt');
      if (input.state === 'not_sent' && state === 'taken' || input.state === 'taken' && state === 'not_sent') throw new Error('Contradictory input receipt');
      if (state !== 'not_sent' && input.state === 'reserved') throw new Error('Receipt before transfer attempt');
      recordReceipt(db, tx, input, state, event.payload, run.id, event.occurredAt);
    } else if (event.type === 'compacted') {
      recordCompaction(tx, db, this.store.root, run, event.payload, event.occurredAt);
    } else if (event.type === 'completed') {
      const observation = event.payload;
      const outcome = { state: observation.outcome.state, ...(observation.outcome.reason ? { reason: observation.outcome.reason } : {}) } as Outcome;
      // Spelled out: the tests' non-strict program reads the protocol's nullable exit fields as optional.
      const exit = observation.exit && { code: observation.exit.code, signal: observation.exit.signal };
      const end: EndObservation = { outcome, session: observation.session, measuredUsage: observation.measuredUsage, exit,
        availability: observation.availability, handoffSafe: observation.handoffSafe, compaction: observation.compaction ?? null,
        finalResult: observation.result.state === 'present' ? { state: 'present', text: text! } : { state: observation.result.state, text: null } };
      releaseReserved(db, attempt, { evidence: 'completed_without_attempt', completedDigest: digest });
      settleCompaction(db, attempt, observation.compaction ?? null, event.occurredAt);
      const next = reserveAiFallback(this.store, tx, run, end, attempt);
      recordEnd(db, tx, run, end, event.occurredAt, answer, next);
      if (run.role === 'coordinator' && !next && outcome.state === 'succeeded' && answer !== 'unsaved' &&
          db.prepare('SELECT 1 FROM coordinator_conversations WHERE id=? AND cleared_at IS NULL').get(run.conversationId)) {
        const settings = readAgentsSettings(this.store.root);
        const context = readRunActivityView(this.store.root, run)?.context ?? null;
        const reason = settings.ok && automaticCoordinatorReset(context, settings.config.limits);
        if (reason) reserveCoordinatorReset(db, run.conversationId, reason, event.occurredAt);
      }
      db.prepare('UPDATE run_attempts SET completed_digest=? WHERE attempt_id=?').run(digest, attempt);
    }
  }
}
