import { continuationSession } from './session-continuation.js';
import { existsSync } from 'node:fs';
import { controlSchemaState, inspectDatabaseHistory, inTransaction, touch } from '@alpacawork/db';
import { startDecision } from '../control/task-start-facts.js';
/** Serve owns invocation reservations and command delivery. The DB outbox is authoritative until published. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { AWAITING_RECEIPT_SQL, UNSETTLED_INPUTS_SQL, type RunStore, type RunTransaction } from '@alpacawork/runs';
import { digestBytes, Problem, PROBLEM_CODE } from '@alpacawork/core';
import type { Limits } from '@alpacawork/contract';
import { DELIVERY_STATE } from '@alpacawork/contract/control';
import { inputUnsettled, launchSchema, commandSchema, protocolFingerprint, type LaunchSnapshot, type RunCommand } from '@alpacawork/contract/run-protocol';
import { RUN_ENDED_STATES, runNumber, type ReadRunRecord, type RunRecord, type RuntimeRunRecord } from '@alpacawork/contract/run';
import { connectionPath, readConnection } from '@alpacawork/contract/connection';
import { issueRunCredential } from '../control/credentials.js';
import { invocationForRun, type AgentInvocation } from './launch-agent.js';
import { identityOf, publishCommand, publishLaunch, executionFolder } from './execution-files.js';
import { releaseForEntry, packageVersionForEntry } from '@alpacawork/core';
import { executionObligations, executionReference } from './execution-obligations.js';

/**
 * The folder a coordinator's agent works in: empty and its own (0700, made by the scheduler before it reserves the
 * attempt), never the workspace or a Task's code. It is under the root, so the agent finds the root's skills.
 */
export const coordinatorCwd = (root: string): string => join(root, '.alpacawork', 'coordinator', 'cwd');
/** A warm-up only has the coordinator read its skills and references. */
const WARM_MINUTES = 2;

export function attemptOf(store: Pick<RunStore, 'connection'>, id: string): LaunchSnapshot | null {
  const row = store.connection.prepare('SELECT a.launch_json,r.prompt FROM run_attempts a JOIN runs r ON r.id=a.run_no WHERE a.run_no=?').get(runNumber(id));
  return row ? launchSchema.parse({ ...JSON.parse(String(row.launch_json)), prompt: String(row.prompt) }) : null;
}
/**
 * Fixes what one attempt launches. A Task's Run calls alpacawork with its own credential, below its callers, in its
 * own directory, for `run_minutes`. A coordinator's Run gets no credential and no callers (its agent is the user's direct
 * caller), works in its empty folder, and runs for at most a coordinator turn (a warm-up for less). `invocation` is
 * the Run's own unless the scheduler starts the coordinator's conversation anew.
 */
export function reserveAttempt(store: RunStore, tx: RunTransaction, run: RuntimeRunRecord, entry: string,
  limits: Pick<Limits, 'run_minutes' | 'coordinator_run_minutes' | 'coordinator_command_seconds'>, invocation: AgentInvocation = invocationForRun(run)): LaunchSnapshot {
  if (attemptOf(store, run.id)) throw new Error(`Run already has an invocation: ${run.id}`);
  const db = store.connection;
  const row = db.prepare('SELECT prompt FROM runs WHERE id=?').get(runNumber(run.id))!;
  const workspaceId = String(db.prepare('SELECT id FROM workspace_identity WHERE singleton=1').get()!.id);
  const ancestors: string[] = [], seen = new Set<string>([run.id]);
  let caller = run.caller?.run;
  while (caller) {
    if (seen.has(caller)) throw new Error('Run caller cycle'); seen.add(caller); ancestors.push(caller);
    caller = tx.get(caller)?.caller?.run;
  }
  let server: string | null = null;
  try { server = readConnection(connectionPath(store.root)).url.origin; } catch { /* Offline maintenance does not launch. */ }
  const coordinator = run.role === 'coordinator';
  const warm = coordinator && !!db.prepare('SELECT 1 FROM coordinator_conversations WHERE warm_request_id=?').get(run.requestId);
  const runMinutes = !coordinator ? limits.run_minutes : warm ? WARM_MINUTES : limits.coordinator_run_minutes;
  const launch = launchSchema.parse({ protocol: 1, workspaceId, runId: run.id,
    attemptId: randomUUID(), cwd: coordinator ? coordinatorCwd(store.root) : run.cwd, invocation, prompt: String(row.prompt),
    initialInputId: randomUUID(), format: protocolFingerprint(), runMinutes, commandSeconds: coordinator ? limits.coordinator_command_seconds : null,
    credential: coordinator ? null : issueRunCredential(store.root, run.id), entry, version: packageVersionForEntry(entry), server, ancestors, release: releaseForEntry(entry) });
  const { prompt: _prompt, ...storedLaunch } = launch;
  db.prepare('INSERT INTO run_attempts(run_no,attempt_id,launch_json) VALUES (?,?,?)')
    .run(runNumber(run.id), launch.attemptId, JSON.stringify(storedLaunch));
  touch(db, { kind: 'attempt', id: launch.attemptId });
  db.prepare(`INSERT INTO run_inputs(input_id,attempt_id,instruction_run_no,content_digest,state,initial) VALUES (?,?,?,?,'reserved',1)`)
    .run(launch.initialInputId, launch.attemptId, runNumber(run.id), digestBytes(launch.prompt));
  touch(db, { kind: 'input', id: launch.initialInputId });
  return launch;
}
export function enqueueCommand(store: RunStore, launch: LaunchSnapshot, input: {
  type: RunCommand['type']; inputId?: string; instructionRunId?: string; text?: string; operationId?: string;
}): RunCommand {
  const db = store.connection;
  if (!db.isTransaction) throw new Error('Commands must be reserved in the control transaction');
  const seq = Number(db.prepare('SELECT coalesce(max(seq),0)+1 AS next FROM run_commands WHERE attempt_id=?').get(launch.attemptId)!.next);
  const command = commandSchema.parse({ ...identityOf(launch), seq, commandId: randomUUID(), type: input.type,
    inputId: input.inputId ?? null, instructionRunId: input.instructionRunId ?? null, text: input.text ?? null,
    contentDigest: input.text === undefined ? null : digestBytes(input.text), operationId: input.operationId ?? null });
  db.prepare(`INSERT INTO run_commands(attempt_id,seq,command_id,type,input_id,instruction_run_no,operation_id,text,content_digest) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(launch.attemptId, seq, command.commandId, command.type, command.inputId,
      command.instructionRunId ? runNumber(command.instructionRunId) : null, command.operationId, command.text, command.contentDigest);
  return command;
}
/** The attempt fixes execution identity; the outbox row owns each command fact once. */
export function commandOf(row: Record<string, SQLOutputValue>): RunCommand {
  const identity = identityOf(JSON.parse(String(row.launch_json)));
  if (identity.attemptId !== row.attempt_id || identity.runId !== `R${row.run_no}`)
    throw new Error(`Command ${row.command_id} launch identity mismatch`);
  return commandSchema.parse({ ...identity, seq: row.seq, commandId: row.command_id, type: row.type,
    inputId: row.input_id, instructionRunId: row.instruction_run_no === null ? null : `R${row.instruction_run_no}`,
    operationId: row.operation_id, text: row.text, contentDigest: row.content_digest });
}
/**
 * Queued work with a reservation stays queued while delivery remains uncertain. A resolved one holds no Run: its instruction
 * ended when it was resolved (`resolveUncertainInputs`).
 */
export function queuedInputReservations(store: RunStore, runIds?: readonly string[]): Set<number> {
  if (runIds?.length === 0) return new Set();
  return new Set(store.connection.prepare(`SELECT i.instruction_run_no FROM runs q JOIN run_inputs i ON i.instruction_run_no=q.id JOIN run_attempts a USING(attempt_id)
    WHERE q.state='queued' ${runIds ? 'AND q.id IN (SELECT value FROM json_each(?))' : ''}
      AND (i.state NOT IN ('not_sent','resolved') OR a.completed_digest IS NULL)`)
    .all(...runIds ? [JSON.stringify(runIds.map(runNumber))] : []).map(r => Number(r.instruction_run_no)));
}
export function blockedInvocations(store: RunStore, runIds: readonly string[]): Set<number> {
  if (!runIds.length) return new Set();
  return new Set(store.connection.prepare(`SELECT DISTINCT a.run_no FROM run_attempts a LEFT JOIN run_inputs i USING(attempt_id)
    WHERE a.run_no IN (SELECT value FROM json_each(?)) AND ((a.diagnostic IS NOT NULL AND json_extract(a.diagnostic,'$.kind')<>'launch_aborted') OR i.state IN (${AWAITING_RECEIPT_SQL}) OR (a.completed_digest IS NOT NULL AND i.state='reserved'))`).all(JSON.stringify(runIds.map(runNumber))).map(r => Number(r.run_no)));
}
/**
 * A person's proxy dealt with the inputs to this placement's agents whose receipt is unknown: its Request carries
 * what they held (ReturnLifecycle.resendUnconfirmed). They are `resolved` and hold the placement no longer. A queued
 * Run whose instruction was one of them is never sent again (its input keeps the reservation), so it ends with its
 * Request. Called in the caller's control transaction on `db`.
 */
export function resolveUncertainInputs(db: DatabaseSync, tx: RunTransaction, placementId: string): void {
  const inputs = db.prepare(`SELECT i.input_id,i.instruction_run_no FROM run_inputs i JOIN run_attempts a USING(attempt_id)
    JOIN runs r ON r.id=a.run_no WHERE r.placement_id=? AND i.state='uncertain'`).all(placementId);
  for (const input of inputs) {
    const instruction = tx.get(`R${input.instruction_run_no}`);
    if (instruction?.state === 'queued') tx.abortRequest(instruction, instruction.requestId);
    db.prepare("UPDATE run_inputs SET state='resolved' WHERE input_id=?").run(String(input.input_id));
    touch(db, { kind: 'input', id: String(input.input_id) });
  }
}
/**
 * Whether a working Run takes queued work as input now: it runs with a session and an input channel, nobody asked it to
 * stop, and its input is not `closed` (its attempt has a diagnostic, or an input whose receipt is not settled).
 * planInputs feeds by it, and wake reads a busy seat by the same predicate.
 */
export function takesInput<Run extends Pick<ReadRunRecord, 'state' | 'stop_requested' | 'session' | 'launch'>>(run: Run,
  closed: boolean): run is Run & { session: NonNullable<Run['session']> } {
  return run.state === 'running' && !run.stop_requested && run.session !== null && !closed;
}
/**
 * Whether a queued Task Run's Request lets it go now, by launch (the scheduler) or into a working agent (planInputs):
 * the Request must stand and be confirmed, and the Task's start policy must allow it. How each path holds or skips is
 * its own; a rule about whether the work may start belongs here.
 */
export function queuedStart(store: Pick<RunStore, 'connection'>, tx: RunTransaction, run: RunRecord) {
  const request = tx.getRequest(run.requestId);
  if (!request || request.deliveryState === DELIVERY_STATE.recorded_unconfirmed || request.deliveryState === DELIVERY_STATE.aborted)
    return { kind: 'reject' as const, code: 'request decision is not confirmed', invalidateRequest: false };
  const start = startDecision(store.connection, run.requestId, run.task);
  if (start.kind === 'reject') return { kind: 'reject' as const, code: start.code, invalidateRequest: start.invalidateRequest === true };
  return start.kind === 'wait' ? { kind: 'wait' as const } : { kind: 'go' as const, request };
}
/**
 * FeedPlanner alone decides whether queued work can join a live invocation. A Task's queued work joins its
 * placement's working Run by itself; a message to the screen's coordinator joins only when the person sends it now
 * (`joinRequested`), and a later one may go before an earlier one that waits.
 */
export function planInputs(store: RunStore): void {
  const stops = new StopDeliveryOwner(store);
  store.write(tx => {
    const runs = tx.forSettle();
    for (const run of runs) {
      // The settle graph includes ended resume ancestors; only unfinished Runs own input delivery.
      if (RUN_ENDED_STATES.some(state => state === run.state)) continue;
      const launch = attemptOf(store, run.id);
      if (!launch) continue;
      if (run.stop_requested) stops.reserve(run.id);
      const inputs = store.connection.prepare('SELECT * FROM run_inputs WHERE attempt_id=?').all(launch.attemptId);
      for (const input of inputs) {
        const instruction = tx.runtimeGet(`R${input.instruction_run_no}`);
        if (!instruction?.stop_requested && instruction?.state !== 'cancelled') continue;
        if (!inputUnsettled(input.state)) continue;
        stops.cancelInput(launch, String(input.input_id), instruction.id);
      }
      const closed = !!store.connection.prepare('SELECT diagnostic FROM run_attempts WHERE attempt_id=?').get(launch.attemptId)?.diagnostic ||
        inputs.some(i => inputUnsettled(i.state));
      if (!takesInput(run, closed)) continue;
      const lane: readonly RuntimeRunRecord[] = run.role === 'coordinator'
        ? tx.coordinatorRuns(run.conversationId) : tx.conversationRuns(run.placementId);
      for (const next of lane) {
        if (next.state !== 'queued' || next.role === 'coordinator' && !next.joinRequested) continue;
        if (next.role !== 'coordinator' && queuedStart(store, tx, next).kind !== 'go') break;
        const reserved = store.connection.prepare('SELECT state FROM run_inputs WHERE instruction_run_no=?').get(runNumber(next.id));
        if (reserved) { if (reserved.state === 'taken') continue; break; }
        // One the working invocation cannot take: a Task's work waits in order; a coordinator message answers on its
        // own and holds back no later one.
        const session = continuationSession(runs, next, { kind: 'input', working: run });
        if (next.stop_requested || !session) { if (next.role === 'coordinator') continue; break; }
        const promptRow = store.connection.prepare('SELECT prompt FROM runs WHERE id=?').get(runNumber(next.id));
        const prompt = promptRow ? String(promptRow.prompt) : null;
        if (!prompt) break;
        if (!next.session) tx.update({ ...next, session });
        const inputId = randomUUID();
        store.connection.prepare(`INSERT INTO run_inputs(input_id,attempt_id,instruction_run_no,content_digest,state,initial)
          VALUES (?,?,?,?,'reserved',0)`).run(inputId, launch.attemptId, runNumber(next.id), digestBytes(prompt));
        touch(store.connection, { kind: 'input', id: inputId });
        enqueueCommand(store, launch, { type: 'input', inputId, instructionRunId: next.id, text: prompt });
        break;
      }
    }
  });
}
/** The commands a stop reserves; unpublished commands use the outbox partial index. */
const STOP_COMMANDS = "type IN ('stop','cancel-input')";
/** Publishes the commands `where` selects, stops first. */
function publish(store: RunStore, where: string, ...values: SQLInputValue[]): void {
  const rows = store.connection.prepare(`SELECT c.*,a.run_no,a.launch_json FROM run_commands c JOIN run_attempts a USING(attempt_id)
    WHERE published=0 ${where} ORDER BY CASE type WHEN 'stop' THEN 0 WHEN 'cancel-input' THEN 1 ELSE 2 END,seq`).all(...values);
  for (const row of rows) {
    const command = commandOf(row);
    publishCommand(store.root, command);
    store.write(() => store.connection.prepare('UPDATE run_commands SET published=1 WHERE command_id=? AND published=0').run(String(row.command_id)));
  }
}
export function publishCommands(store: RunStore, stopsOnly = false): void {
  publish(store, stopsOnly ? `AND ${STOP_COMMANDS}` : '');
}
export function publishAttempt(store: RunStore, launch: LaunchSnapshot): void { publishLaunch(store.root, launch); }
/** StopDeliveryOwner owns the meaning of stop success for HTTP, replay, query, quiesce and restart. */
export class StopDeliveryOwner {
  constructor(readonly store: RunStore) {}
  /**
   * A receipt proves its save; one whose operation reserved stop and cancel-input commands (run stop, and a stopped
   * task report, which stops the Task's Runs in its own transaction) additionally promises their publication. Only
   * the operation's own commands (`opId`) decide it: a stop another operation left pending is that one's to answer.
   */
  completeOperation(opId: string): void {
    this.gated(() => publish(this.store, `AND ${STOP_COMMANDS} AND operation_id=?`, opId));
  }
  reserve(id: string, operationId?: string): void {
    const launch = attemptOf(this.store, id);
    if (!launch) return; // queued work has no external execution to stop.
    const prior = this.store.connection.prepare("SELECT 1 FROM run_commands WHERE attempt_id=? AND type='stop'").get(launch.attemptId);
    if (!prior) enqueueCommand(this.store, launch, { type: 'stop', operationId });
  }
  /** One cancel-input per input, whichever stop or cancellation noticed it first; the first one's operation answers for it. */
  cancelInput(launch: LaunchSnapshot, inputId: string, instructionRunId: string, operationId?: string): void {
    const prior = this.store.connection.prepare("SELECT 1 FROM run_commands WHERE attempt_id=? AND type='cancel-input' AND input_id=?").get(launch.attemptId, inputId);
    if (!prior) enqueueCommand(this.store, launch, { type: 'cancel-input', inputId, instructionRunId, operationId });
  }
  gate(): void {
    this.gated(() => publishCommands(this.store, true));
  }
  private gated(publication: () => void): void {
    try { publication(); }
    catch (cause) { throw new Problem(PROBLEM_CODE.unavailable, 'Stop committed but publication is pending; query or retry the same operation ID', { state: 'committed_pending_delivery' },
      { reason: { kind: 'stop_committed_but_publication_pending_query_or_retry_same_operation_id' }, cause }); }
  }
}
/** Select and decode this workspace's durable execution-contract users at one SQLite read point. */
export function executionReferences(store: Pick<RunStore, 'connection' | 'root'>) {
  return inTransaction({ root: store.root, db: store.connection, borrowed: true, savepoint: 'execution',
    exec: sql => store.connection.exec(sql),
    notSynchronous: () => new Problem(PROBLEM_CODE.invalidInput, 'Execution reference reads must be synchronous', undefined,
      { reason: { kind: 'control_transaction_callback_must_synchronous' } }),
  }, 'BEGIN', () => {
    // Only live contract users are retained; historical prompts can exceed a gigabyte in aggregate.
    const contractUsers: { runId: string; attemptId: string; format: string }[] = [];
    const runtimeUsers: { runId: string; attemptId: string; release: string }[] = [];
    for (const a of executionObligations(store)) {
      const launch = executionReference(store, a);
      contractUsers.push({ runId: launch.runId, attemptId: launch.attemptId, format: launch.format });
      if (launch.release) runtimeUsers.push({ runId: launch.runId, attemptId: launch.attemptId, release: launch.release });
    }
    return { contractUsers, runtimeUsers };
  });
}
/** Same execution references for FORMAT preflight and release collection. */
export function inspectExecution(store: Pick<RunStore, 'connection' | 'root'>) {
  const db = store.connection;
  const { contractUsers, runtimeUsers } = executionReferences(store);
  const unpublishedStops = Number(db.prepare("SELECT count(*) AS n FROM run_commands WHERE type IN ('stop','cancel-input') AND published=0").get()!.n);
  const host = join(store.root, '.alpacawork', 'host.sqlite');
  return { workspace: store.root, schema: Number(db.prepare('PRAGMA user_version').get()!.user_version),
    control: controlSchemaState(db), host: existsSync(host) ? inspectDatabaseHistory(host, 'host', { busyTimeoutMs: 1000 }) : null,
    // The state index contains id+state; scan it without reading historical Run records.
    // NOT IN deliberately retains unknown states, and NULL needs its explicit arm.
    unfinishedRuns: db.prepare(`SELECT id FROM runs INDEXED BY runs_state
      WHERE state IS NULL OR state NOT IN (${RUN_ENDED_STATES.map(() => '?').join(',')}) ORDER BY id`)
      .all(...RUN_ENDED_STATES).map(row => 'R' + row.id), contractUsers, runtimeUsers, unpublishedStops };
}
