/** A lost manager never proves success. Recovery may signal only a recorded process incarnation. */
import { closeSync, constants } from 'node:fs';
import { join } from 'node:path';
import { platform, processGroupState, tryLock } from '@alpacawork/core';
import type { RunId } from '@alpacawork/contract/fields';
import { AWAITING_RECEIPT_SQL, type RunStore } from '@alpacawork/runs';
import { RUN_FILES, type RuntimeRunRecord } from '@alpacawork/contract/run';
import type { LaunchSnapshot } from '@alpacawork/contract/run-protocol';
import { terminateRecordedGroup } from './termination.js';
import { attemptOf } from './execution-control.js';
import { RunEventImporter } from './event-importer.js';
import { EventJournal, executionFolder, identityOf, names } from './execution-files.js';
import { openRunFile } from './files.js';
import { AgentInputReceipts } from './input.js';
import { runtimeAdapter, unavailableRuntimeMessage } from '../agents/registry.js';
import { appendReceipt, endOutcome, publishCompletion, readEnd, runExpired, type EndObservation } from './result-observation.js';
import { RunReviewState } from './reviews.js';
import { isProcessUnit } from './launch-agent.js';
/**
 * As every Run's manager does when it ends: once its group is gone, nothing it started outlives it, not even
 * what left the group but stayed in the manager's unit (Linux). Recovery reaches that unit by what the agent's start
 * recorded of it, and stops it only when it is this Run's manager's unit. True once nothing is left; a unit that
 * keeps processes leaves the end unconfirmed.
 */
async function stopRunUnit(store: RunStore, run: RuntimeRunRecord, started: { scope: string | null }): Promise<boolean> {
  if (started.scope === null) return true;
  try { await platform.run.stopUnitOthers({ scope: started.scope, ours: unit => isProcessUnit(store.root, run.id, unit) }); return true; }
  catch (error) { console.error('Lost manager unit cleanup failed', { runId: run.id, error }); return false; }
}
/**
 * Publish what a lost manager's attempt left: the receipts it can still prove, and how the Run ended once its group is
 * gone. Null when the agent may still be working. The stop or timeout is read from the record: the manager that saw which
 * came first was lost.
 */
function observeLostAttempt(store: RunStore, run: RuntimeRunRecord, launch: LaunchSnapshot, timedOut: boolean,
  groupGone: boolean, journal: EventJournal): EndObservation | null {
  const adapter = runtimeAdapter(launch.invocation.launch.adapter);
  const adapterInvocation = { mode: launch.invocation.mode, session: launch.invocation.session?.id ?? null };
  const inputs = store.connection.prepare(`SELECT * FROM run_inputs WHERE attempt_id=? AND state IN (${AWAITING_RECEIPT_SQL})`).all(launch.attemptId);
  let observed: ReturnType<AgentInputReceipts<string>['poll']> = { taken: [], refused: [], receipts: [] };
  if (inputs.length && adapter) {
    // Reconstruct every mapping from durable attempts; scan stdout from its start to find delayed receipts.
    const receipts = new AgentInputReceipts<string>(adapter.input);
    for (const input of inputs) receipts.watch(String(input.input_id), `R${input.instruction_run_no}`);
    const folder = store.folder(run.id);
    try { observed = receipts.poll(folder, run.session?.id ?? adapter.earlySession(adapterInvocation, folder)); }
    catch (error) { console.error('Lost manager receipt recovery failed', error); return null; }
  }
  for (const receipt of observed.receipts) {
    if (inputs.find(input => input.input_id === receipt.id)?.state === receipt.outcome) continue;
    appendReceipt(journal, receipt);
  }
  for (const input of inputs) if (input.state === 'attempted' && !observed.receipts.some(r => r.id === input.input_id))
    journal.append('input_uncertain', { inputId: String(input.input_id), receipt: { evidence: 'manager_lost_without_receipt' } });
  // Group absence permits a missing-result outcome only after Importer arbitration.
  if (!groupGone) return null;
  if (!adapter) return { outcome: { state: 'failed', reason: 'launch' },
    finalResult: { state: 'present', text: unavailableRuntimeMessage(launch.invocation.launch.adapter) },
    session: run.session?.id ?? null, measuredUsage: null, exit: null };
  // The exit status was lost with the manager. Preserve the declared reply without inventing success.
  const output = adapter.read(adapterInvocation, store.folder(run.id), { code: null, signal: null });
  const end = readEnd({
    // A stop outranks a timeout here.
    outcome: endOutcome(run.stop_requested ? 'stopped' : timedOut ? 'timeout' : null, output.outcome),
    observed: output, exit: null, measured: false });
  return end;
}
/**
 * Arbitrates one lost manager's completion. Holding manager.lock makes the journal stable and authorizes supervision.
 * Import faults and pending facts gate completion only: they never prevent supervision of a proven group. Receipt and
 * result recovery still wait for the Importer's history.
 */
async function recoverAttempt(store: RunStore, run: RuntimeRunRecord, launch: LaunchSnapshot,
  started: { scope: string | null } & Parameters<typeof processGroupState>[0] | null, timedOut: boolean): Promise<boolean> {
  const lock = openRunFile(store.folder(run.id), RUN_FILES.managerLock, constants.O_RDWR | constants.O_CREAT);
  try {
    if (!tryLock(lock)) return false;
    // Supervision is independent of import health. Only manager.lock exclusion and
    // recorded incarnation/witnesses authorize signals; uncertainty never does.
    const groupGone = started !== null &&
      (processGroupState(started) === 'gone' || (run.stop_requested || timedOut || !runtimeAdapter(launch.invocation.launch.adapter)) && await terminateRecordedGroup(started)) &&
      await stopRunUnit(store, run, started);
    const row = store.connection.prepare('SELECT next_seq,last_digest,completed_digest,diagnostic FROM run_attempts WHERE attempt_id=?').get(launch.attemptId)!;
    const spool = executionFolder(store.root, run.id, launch.attemptId);
    if (row.completed_digest !== null || row.diagnostic !== null ||
      names(join(spool, 'events')).length !== Number(row.next_seq) - 1) return false;
    const journal = new EventJournal(spool, identityOf(launch), { nextSeq: Number(row.next_seq), lastDigest: row.last_digest as string | null });
    const end = observeLostAttempt(store, run, launch, timedOut, groupGone, journal);
    // Recovery publishes observations; only the Importer commits completion and releases reserved inputs.
    if (end !== null) publishCompletion(journal, end);
    new RunEventImporter(store).pass([run.id]);
    return end !== null && store.runtimeGet(run.id)?.state !== 'needs_review';
  } finally { closeSync(lock); }
}
export async function recoverExecution(store: RunStore, reviews = new RunReviewState()): Promise<RunId[]> {
  const closed: RunId[] = [];
  for (const candidate of store.readUnfinished().filter(r => r.state === 'needs_review' && (r.reason === 'manager_lost' || r.reason === null))) {
    try {
      // A stop may commit after the scan; supervise and settle from the current record.
      const run = store.runtimeGet(candidate.id);
      if (!run || run.state !== 'needs_review') continue;
      const launch = attemptOf(store, run.id);
      if (!launch) continue;
      const row = store.connection.prepare('SELECT started_json,completed_digest FROM run_attempts WHERE attempt_id=?').get(launch.attemptId)!;
      if (row.completed_digest !== null) continue;
      const started = row.started_json ? JSON.parse(String(row.started_json)) : null;
      const timedOut = run.started_at !== null && runExpired(launch.runMinutes, Date.now() - Date.parse(run.started_at));
      const ended = await recoverAttempt(store, run, launch, started, timedOut);
      if (ended) closed.push(run.id);
      reviews.observe(run.id, 'recovery', []);
    } catch (error) {
      // One damaged execution must not starve every other Run's scheduling and reply routing.
      console.error('Lost manager recovery requires review', { runId: candidate.id, error });
      reviews.fault(candidate.id, 'recovery', error);
    }
  }
  return closed;
}
