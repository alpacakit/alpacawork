import { TASK_POLICY, evaluate } from '@alpacawork/contract/task-policy';
import { urgentRecipient } from '@alpacawork/contract/access-boundaries';
/**
 * The return rules: who a Task's requester is, when a Request closed and which Requests a seat still waits on. Pure
 * functions over the facts typed here; the return lifecycle, the ball and the wake rules read them.
 */
import { createHash } from 'node:crypto';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { hasRequesterSeat, isSeatContinuation, type RETURN_CLOSURES, type RETURN_NOTICES } from '@alpacawork/contract';
import { DELIVERY_STATE, type DeliveryState, type RequestPurpose } from '@alpacawork/contract/control';
import { isRunEnded, type ReadRunRecord } from '@alpacawork/contract/run';
import type { TaskKind, TaskLifecycle, TaskLog, TaskState, TaskActor } from '@alpacawork/raw';

/** Where a return or a question goes: a seat's Task ID, or null for the user. */
export type Seat = string | null;
export type ReturnClosure = (typeof RETURN_CLOSURES)[number];
export type ReturnNotice = (typeof RETURN_NOTICES)[number];
/** A Request as these rules read it. */
export type RequestFacts = { id: string; taskId: string; purpose: RequestPurpose; author: TaskActor; submittedAt: string;
  deliveryState: DeliveryState };
/** A Run as these rules read it: the Run that carried a Request, and the Run that called it. */
export type RunFacts = Pick<ReadRunRecord, 'id' | 'task' | 'role' | 'requestId' | 'caller' | 'state' | 'reason' | 'into' |
  'stop_requested' | 'ended_at'>;
/** A Task as these rules read it; `responsible` is whether an active responsible placement holds it now. */
export type TaskFacts = { id: string; kind: TaskKind; parentId: string | null; lifecycle: TaskLifecycle;
  userRequested: boolean; log: readonly TaskLog[]; responsible: boolean };
/** One read point's facts, indexed once: Runs by ID and by the Request each carried, Tasks by ID. */
export type ReturnFacts = { runs: ReadonlyMap<string, RunFacts>; runOf: ReadonlyMap<string, RunFacts>;
  tasks: ReadonlyMap<string, TaskFacts>; closedRequests: ReadonlySet<string> };
/** How a Request closed: a worker's by the Run whose end closed it, a child's by the log that closed it. */
type Closure = { outcome: ReturnClosure; runId: string | null; causeLogId: string | null };

export function returnFacts(tasks: Iterable<TaskFacts>, runs: Iterable<RunFacts>,
  returns: Iterable<{ requestId: string | null }> = []): ReturnFacts {
  const byId = new Map<string, RunFacts>(), byRequest = new Map<string, RunFacts>();
  for (const run of runs) { byId.set(run.id, run); byRequest.set(run.requestId, run); }
  return { runs: byId, runOf: byRequest, tasks: new Map([...tasks].map(task => [task.id, task])),
    closedRequests: new Set([...returns].flatMap(row => row.requestId === null ? [] : [row.requestId])) };
}

/**
 * The seat that sent a Request, where its closing return goes: a placement's Request's calling Run's Task. A person's,
 * a main conversation's Request came from the user; review purpose keeps its author's requester seat. A continuation is
 * its seat going on by itself.
 */
export function requesterSeat(request: RequestFacts, facts: ReturnFacts): Seat {
  if (isSeatContinuation(request.purpose)) throw new Error('A continuation has no requester seat');
  if (!hasRequesterSeat(request)) return null;
  const callerId = facts.runOf.get(request.id)?.caller?.run;
  const caller = callerId === undefined ? undefined : facts.runs.get(callerId);
  if (!caller) throw new Error(`Request ${request.id} has no caller seat`);
  return caller.task;
}

/**
 * A Task's requester, where its urgent notes and failure go: the user for a Task the user asked for, or
 * while a Request from the user to its responsible is open; else the seat of the latest open Request to its
 * responsible; else its parent Task, or the user when the parent is a project. It only chooses the Request:
 * requesterSeat names the seat for its closing return. Questions choose a separate fixed destination. The Task is read
 * from the same facts its Requests' closures are.
 */
export function requesterOf(taskId: string, requests: readonly RequestFacts[], facts: ReturnFacts): Seat {
  const task = facts.tasks.get(taskId);
  if (!task) throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist', { task: taskId }, { reason: { kind: 'task_does_not_exist' } });
  let openHuman = false;
  let latest: { at: number; seat: string } | undefined;
  for (const request of requests) {
    if (request.taskId !== taskId || facts.runOf.get(request.id)?.role !== 'owner' || !isOpen(request, facts)) continue;
    const seat = requesterSeat(request, facts);
    if (seat === null) { openHuman = true; continue; }
    const at = Date.parse(request.submittedAt);
    if (!latest || at >= latest.at) latest = { at, seat };
  }
  const parent = task.parentId === null ? null : facts.tasks.get(task.parentId);
  if (task.parentId !== null && !parent) throw new Problem(PROBLEM_CODE.parentUnavailable, 'Logical parent cannot be read', { task: task.id }, { reason: { kind: 'logical_parent_cannot_read' } });
  const result = evaluate(TASK_POLICY.requester, { userRequested: task.userRequested, openHuman, latestSeat: latest?.seat ?? null,
    parentId: parent?.kind === 'task' ? parent.id : null });
  if (result.seat === undefined) throw new Error('Requester policy omitted its destination');
  return result.seat;
}

/**
 * The seat an urgent comment or done report wakes: the requester. Both commands ask here, so they refuse alike; the
 * user is asked by a question instead.
 */
export function urgentTarget(taskId: string, requests: readonly RequestFacts[], facts: ReturnFacts): string {
  const requester = requesterOf(taskId, requests, facts);
  if (!urgentRecipient.allows(requester)) throw new Problem(PROBLEM_CODE.urgentToUser, 'Cannot send an urgent notification when the requester is the user; ask a question instead');
  return requester;
}

const CHILD_CLOSURES: Partial<Record<TaskState, ReturnClosure>> = { done: 'succeeded', stopped: 'stopped', error: 'failed' };
/**
 * Whether and how a Request closed. A worker's closes when its actual Run (a joined one's `into`) ends. A child's
 * responsible's closes at the first done (a review's approval too), stop, failure or move its Task records since the
 * Request came, or when the Task is no longer active or has no responsible; a question or a review wait closes nothing.
 * Work whose admission scope was invalidated also closes its accepted Request at that Run boundary. An aborted admission
 * is excluded by awaitsClosure; ending accepted work must leave its requester this result, even after an ancestor move.
 */
export function closureOf(request: RequestFacts, facts: ReturnFacts): Closure | null {
  const run = facts.runOf.get(request.id);
  if (!run) return null;
  if (run.role === 'worker') {
    const actual = run.state === 'joined' && run.into !== null ? facts.runs.get(run.into) : run;
    const outcome = actual ? workerClosure(actual) : null;
    return actual && outcome ? { outcome, runId: actual.id, causeLogId: null } : null;
  }
  const task = facts.tasks.get(request.taskId);
  if (!task) return { outcome: 'closed', runId: null, causeLogId: null };
  const since = Date.parse(request.submittedAt);
  const cancelled = run.state === 'cancelled' && run.reason === 'scope_invalidated' && run.ended_at !== null;
  for (const entry of task.log) {
    if (entry.stage?.action === 'hold' || entry.stage?.action === 'unhold') continue;
    const outcome = entry.kind === 'moved' ? 'moved' : entry.toState === null ? undefined : CHILD_CLOSURES[entry.toState];
    // Most history entries cannot close a Request. Compare times only for a closing candidate.
    if (outcome && !(Date.parse(entry.causeAt ?? entry.at) < since)) {
      if (cancelled && Date.parse(run.ended_at!) < Date.parse(entry.causeAt ?? entry.at)) break;
      return { outcome, runId: null, causeLogId: entry.id };
    }
  }
  if (cancelled) return { outcome: 'stopped', runId: run.id, causeLogId: null };
  return task.lifecycle !== 'active' || !task.responsible ? { outcome: 'closed', runId: null, causeLogId: null } : null;
}

/** A Run that ended its own work; a joined Run ended in the Run it joined. */
export const endedOwnWork = (state: ReadRunRecord['state']): state is 'succeeded' | 'failed' | 'cancelled' =>
  isRunEnded(state) && state !== 'joined';

/** A Run that ended by itself in success: a stop asked of it makes its end a stop, whatever state it reached. */
export const ranToSuccess = (run: Pick<RunFacts, 'state' | 'stop_requested'>) => run.state === 'succeeded' && !run.stop_requested;

/** A worker's Run closes its Request when it ends; one that found its conversation busy waits for a person. */
function workerClosure(run: RunFacts): ReturnClosure | null {
  if (run.state === 'needs_review') return run.reason === 'conversation_busy' ? 'needs_review' : null;
  if (!endedOwnWork(run.state)) return null;
  if (run.state === 'failed') return 'failed';
  return ranToSuccess(run) ? 'succeeded' : 'stopped';
}

/**
 * A Request waits for its closing return unless it is a continuation, was aborted, or waits unconfirmed for a person:
 * the return lifecycle writes a closing return only for one that does.
 */
export const awaitsClosure = (request: Pick<RequestFacts, 'purpose' | 'deliveryState'>) => !isSeatContinuation(request.purpose) &&
  request.deliveryState !== DELIVERY_STATE.aborted && request.deliveryState !== DELIVERY_STATE.recorded_unconfirmed;
// The closing return is permanent. Current availability may close a Request
// before routing runs, but restore or reassignment cannot undo a committed close.
const isOpen = (request: RequestFacts, facts: ReturnFacts) => awaitsClosure(request) &&
  !facts.closedRequests.has(request.id) && closureOf(request, facts) === null;

/**
 * The Requests a seat sent that have not closed: the only derivation of what a seat waits on, read by the ball, the
 * finish conditions and the wake rules (the requester judges a Task's own Requests by the same `isOpen`). A stored
 * cycle's closing time is never read for it. The Requests come back as the caller passed them.
 */
export function openRequests<R extends RequestFacts>(seat: string, requests: readonly R[], facts: ReturnFacts): R[] {
  return requests.filter(request => isOpen(request, facts) && requesterSeat(request, facts) === seat);
}

/**
 * openRequests of every seat at once: the open Requests by the seat that sent them, each Request judged once, so the
 * seats of one read point are not each judged over every Request.
 */
export function openRequestsBySeat<R extends RequestFacts>(requests: readonly R[],
  facts: ReturnFacts): ReadonlyMap<string, readonly R[]> {
  const bySeat = new Map<string, R[]>();
  for (const request of requests) {
    const seat = isOpen(request, facts) ? requesterSeat(request, facts) : null;
    if (seat === null) continue;
    const sent = bySeat.get(seat);
    if (sent) sent.push(request); else bySeat.set(seat, [request]);
  }
  return bySeat;
}

/** Whether every Request of one wait cycle closed; an aborted Request waits on nothing. */
export function cycleClosed(requests: readonly RequestFacts[], facts: ReturnFacts): boolean {
  return !requests.some(request => isOpen(request, facts));
}

/** A return's ID: a closing return's from its Request alone (a Request closes once), a notice's from its cause and kind. */
export const returnIdOf = (key: { requestId: string } | { causeLogId: string; outcome: ReturnNotice }): string =>
  'RET' + createHash('sha256').update(JSON.stringify('requestId' in key ? [key.requestId] : [key.causeLogId, key.outcome]))
    .digest('hex');

/** Closed Requests whose closing return has not been materialized yet, at this same read point. */
export function arrivingRequests(requests: readonly RequestFacts[], facts: ReturnFacts): RequestFacts[] {
  return requests.filter(request => awaitsClosure(request) && !facts.closedRequests.has(request.id) && closureOf(request, facts) !== null);
}
