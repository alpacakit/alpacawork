/** CLI and HTTP stop boundary. Run changes commit in one write. */
import { isSandboxed, Problem, type ProblemReason } from '@alpacawork/core';
import { runNumber, type RunRecord } from '@alpacawork/contract/run';
import type { RunId } from '@alpacawork/contract/fields';
import type { z } from 'zod';
import { runStopInput } from '@alpacawork/contract/inputs';
import { RunStore, UNSETTLED_INPUTS_SQL, relationships, type RunTransaction } from '@alpacawork/runs';
import { settle } from './scheduler.js';
import { StopDeliveryOwner, attemptOf } from './execution-control.js';

const options = { busyTimeoutMs: 10_000 };
function refuse(code: 'invalid_input' | 'not_found' | 'sandboxed_caller', message: string, reason: ProblemReason): never {
  throw new Problem(code, message, undefined, { reason });
}
export function refuseSandboxedCaller(): void {
  if (isSandboxed()) refuse('sandboxed_caller', 'Cannot manage runs from inside a sandbox', { kind: 'cannot_manage_runs_from_inside_sandbox' });
}

/** What a stop did: the Runs it cancelled and those it asked to stop, and the Runs whose manager was lost. */
type StopResult = { result: { cancelled: string[]; stop_requested: string[] }; lost: { id: string; pid: number }[] };

/**
 * `roots` and the Runs below them down the caller chain, oldest first: what a stop reads, never the workspace's other
 * Runs. A coordinator's Run is no Task's, so it is not read (tx.get) and calls none.
 */
function calledFrom(store: RunStore, tx: RunTransaction, roots: readonly RunId[]): RunRecord[] {
  return store.connection.prepare(`WITH RECURSIVE below(id) AS (SELECT value FROM json_each(?)
    UNION SELECT r.id FROM runs r JOIN below b ON r.caller_run = 'R' || b.id
    UNION SELECT next.id FROM runs current JOIN below b ON current.id=b.id
      JOIN runs next ON 'R'||next.id=json_extract(current.record,'$.supersededBy')) SELECT id FROM below ORDER BY id`)
    .all(JSON.stringify(roots.map(runNumber))).flatMap(row => tx.get(`R${Number(row.id)}`) ?? []);
}

/**
 * Stops `roots` and every Run below them in `tx`: each Run's stop effect, with its stop and cancel-input deliveries
 * reserved under `operationId`. requestStop (run stop) and a stopped state report (task-reports) call it.
 */
export function stopRunsIn(store: RunStore, tx: RunTransaction, roots: readonly RunId[], operationId?: string): StopResult {
  const runs = calledFrom(store, tx, roots), graph = relationships(runs);
  const result = { cancelled: [] as string[], stop_requested: [] as string[] };
  const lost: { id: string; pid: number }[] = [], stops = new StopDeliveryOwner(store);
  for (const run of runs) {
    const effect = graph.stopEffect(run);
    if (effect) {
      stops.reserve(run.id, operationId);
      const inputs = store.connection.prepare(`SELECT * FROM run_inputs WHERE instruction_run_no=? AND state IN (${UNSETTLED_INPUTS_SQL})`).all(runNumber(run.id));
      for (const reserved of inputs) {
        const target = store.connection.prepare('SELECT run_no FROM run_attempts WHERE attempt_id=?').get(String(reserved.attempt_id))!;
        stops.cancelInput(attemptOf(store, 'R' + target.run_no)!, String(reserved.input_id), run.id, operationId);
      }
    }
    if (effect === 'cancel') {
      tx.update({ ...run, state: 'cancelled', reason: 'stopped', ended_at: run.ended_at ?? new Date().toISOString() });
      result.cancelled.push(run.id);
    } else if (effect === 'request') {
      if (run.state === 'needs_review') lost.push({ id: run.id, pid: run.pids.agent! });
      if (!run.stop_requested) {
        tx.update({ ...run, stop_requested: true }); result.stop_requested.push(run.id);
      }
    } else if (effect === 'hold' && !run.stop_requested) {
      tx.update({ ...run, stop_requested: true }); result.stop_requested.push(run.id);
    }
  }
  return { result, lost };
}

/** run stop: the Run and every Run below it. A Task's unfinished work stops by its stopped report instead. */
export function requestStop(root: string, input: z.infer<typeof runStopInput>, operationId?: string): StopResult {
  refuseSandboxedCaller();
  const store = new RunStore(root, options);
  try {
    return store.write(tx => {
      if (!tx.get(input.run)) refuse('not_found', 'Run does not exist', { kind: 'run_does_not_exist' });
      const stopped = stopRunsIn(store, tx, [input.run], operationId);
      if (!Object.values(stopped.result).some(ids => ids.length) && !stopped.lost.length) refuse('not_found', 'No runs to stop', { kind: 'no_runs_stop' });
      return stopped;
    });
  } finally { store.close(); }
}
