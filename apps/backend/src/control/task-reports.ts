import { controlReadContext } from './read-context.js';
import { TASK_POLICY, evaluate } from '@alpacawork/contract/task-policy';
/**
 * The state a Task's reports and its responsible Runs make: a state report, a stop with its Runs, the
 * boundaries of the owner Runs, and the record of an accepted instruction. The actor is authorize's, which alone says
 * who may report; these check the Task's facts only and write through TaskTransition in the caller's transaction.
 */
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import type { RunId } from '@alpacawork/contract/fields';
import type { RunRecord } from '@alpacawork/contract/run';
import type { RunStore, RunTransaction } from '@alpacawork/runs';
import { now, type ConversationCheckpoint, type ControlTask, type TaskActor, type TaskLog, type TaskState, type TaskValues } from '@alpacawork/raw';
import { stopRunsIn } from '../runs/entry.js';
import { validateReportMedia } from './report-media.js';
import { endedOwnWork } from './return-rules.js';
import { TaskTree, assertActive, assertAtHash } from './task-store.js';
import { TaskTransition, operationFingerprint, operationIdUse, returnsAt, tasksIn, type ControlTx } from './task-transition.js';

import { routingContext, routingContextSteps, routingTasks, type RoutingTasks } from './routing-work.js';
import type { RoutingTask } from './routing-facts.js';
import { finishRoutingRead, type RoutingReadContext, type RoutingReadSteps } from './routing-read-work.js';

const sameActor = (a: TaskActor, b: TaskActor) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The active Task an operation writes, and the record the operation already wrote on it, if any. An operation ID
 * names one record of one Task, so one that another Task's log holds is refused.
 */
function operationTask(tx: ControlTx, taskId: string, opId: string): { task: ControlTask; previous?: TaskLog } {
  const task = tasksIn(tx).get(taskId);
  assertActive(task);
  const previous = task.meta.log.find(entry => entry.id === opId);
  if (!previous && operationIdUse(tx, opId).logged)
    throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Operation ID belongs to another Task', undefined, { reason: { kind: 'operation_id_belongs_another_task' } });
  return { task, previous };
}

/** A Run's start or end as TaskTransition takes it, under the ID of the record it writes. */
type Boundary = { id: string; at: string; run: RunRecord; action: 'run_started' | 'run_ended' };
/** What a boundary's record is named by, with its Run's ID. */
const BOUNDARY_LOG = { started: 'LSTART', ended: 'LEND' } as const;
/** The boundaries of owner Runs, oldest first, and a start before an end at the same time. */
function boundariesOf(runs: readonly RunRecord[]): Boundary[] {
  return runs.flatMap(run => [
    ...(run.started_at ? [{ id: `${BOUNDARY_LOG.started}${run.id}`, at: run.started_at, run, action: 'run_started' as const }] : []),
    ...(run.ended_at && run.supersededBy === undefined && endedOwnWork(run.state)
      ? [{ id: `${BOUNDARY_LOG.ended}${run.id}`, at: run.ended_at, run, action: 'run_ended' as const }] : []),
  ]).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) ||
    (a.action === b.action ? 0 : a.action === 'run_started' ? -1 : 1));
}
/** What decides a Task's boundaries, read once per version of its log: the records written, and its latest state change. */
const logFacts = (task: { meta: { log: readonly TaskLog[] } }) => {
  let latestChange = -Infinity;
  for (const entry of task.meta.log) if (entry.toState !== null) {
    const at = Date.parse(entry.causeAt ?? entry.at);
    if (at > latestChange) latestChange = at;
  }
  return { ids: new Set(task.meta.log.map(entry => entry.id)), latestChange };
};
/** Whether a boundary is written already, or a state change of the Task caused after it decides instead. */
const boundarySettled = (facts: ReturnType<typeof logFacts>, boundary: Pick<Boundary, 'id' | 'at'>) =>
  facts.ids.has(boundary.id) || facts.latestChange > Date.parse(boundary.at);
/** Hands a boundary of the Task's owner Run to TaskTransition at its own time, unless it is settled; returns whether it was handed over. */
function applyBoundary(tx: ControlTx, transition: TaskTransition, task: Pick<ControlTask, 'id' | 'meta'>, boundary: Boundary): boolean {
  if (boundarySettled(logFacts(task), boundary)) return false;
  const result = transition.apply(tx, { action: boundary.action, runId: boundary.run.id, taskId: task.id, at: boundary.at,
    actor: { kind: 'placement', placementId: boundary.run.placementId } });
  if (result.stoppedRuns.length) stopRunsIn(tx.store, tx.runs, result.stoppedRuns, boundary.id);
  return true;
}
/**
 * A Run reports on the Task as its own start made it: the start reconcileStateLinks has not applied yet goes first, so
 * the report or the question of a Run that a Request sent to a stopped Task is not refused. reportState and
 * task-questions.ask call it.
 */
export function startBeforeReport(tx: ControlTx, transition: TaskTransition, task: ControlTask, runId: RunId): void {
  const run = tx.runs.get(runId);
  const start = run !== null && run.task === task.id && run.role === 'owner'
    ? boundariesOf([run]).find(boundary => boundary.action === 'run_started') : undefined;
  if (start) applyBoundary(tx, transition, task, start);
}

/**
 * A state report: doing, done (--urgent to ReturnLifecycle.urgentTarget), held, a held Task's return to the state it was
 * held from, and stopped, whose Runs runs/entry.stopRunsIn stops in the same transaction; the stop
 * and cancel-input deliveries it reserves are published once the report's receipt commits
 * (StopDeliveryOwner.completeOperation). TaskReportService calls it.
 * TASK_POLICY.intent decides which of these a report is (reportIntent), with authorize on the same table; the rest
 * of it, a question (task-questions.ask) and a confirmation (ReviewService), TaskReportService sends elsewhere.
 */
export function reportState(tx: ControlTx, report: { actor: TaskActor; runId: RunId | null; taskId: string; opId: string;
  expectedTaskHash: string; state: TaskState; intent: string;
  title?: string; description?: string; estimateMinutes?: number; urgentReason?: string;
  /** The write's values as sent (what its fingerprint keeps) and the Task's values after it. */
  values?: unknown; written?: TaskValues; nextConversation?: 'new' | 'compact'; checkpoint?: ConversationCheckpoint }): void {
  const { task, previous } = operationTask(tx, report.taskId, report.opId);
  validateReportMedia(tx.store.root, task.path, report.description);
  if (operationIdUse(tx, report.opId).request)
    throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Operation ID belongs to a Request', undefined, { reason: { kind: 'operation_id_belongs_request' } });
  const { actor, checkpoint, intent, written, ...operation } = report, { runId } = report;
  const fingerprint = operationFingerprint(operation);
  if (previous) {
    if (previous.operationFingerprint !== fingerprint || !sameActor(previous.actor, actor))
      throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Operation ID has different report input', undefined,
        { reason: { kind: 'operation_id_has_different_report_input' } });
    // A retried stop stops nothing anew; its receipt publishes what the committed stop reserved.
    return;
  }
  assertAtHash(task, report.expectedTaskHash);
  // An urgent done goes to the requester as it is before the done closes a Request, and is refused, as an urgent
  // comment is, when that is the user.
  const urgent = report.state === 'done' && report.urgentReason !== undefined ? urgentTo(tx, task.id) : null;
  const transition = new TaskTransition();
  if (runId !== null) startBeforeReport(tx, transition, task, runId);
  // Taken after the start, so the report follows it in the log's time too.
  const base = { actor, taskId: task.id, at: now(), record: { id: report.opId, title: report.title ?? null,
    description: report.description ?? null, estimateMinutes: report.estimateMinutes, operationFingerprint: fingerprint,
    values: written, checkpoint } };
  switch (intent) {
    case 'hold': transition.apply(tx, { ...base, action: 'hold' }); return;
    case 'stop':
      stopRunsIn(tx.store, tx.runs, transition.apply(tx, { ...base, action: 'stop', runId }).stoppedRuns, report.opId);
      return;
    case 'submit_review': transition.apply(tx, { ...base, action: 'submit_review' }); return;
    case 'report_doing': transition.apply(tx, { ...base, action: 'report_doing', runId: reportingRun(runId) }); return;
    case 'report_done':
      transition.apply(tx, { ...base, action: 'report_done', runId: reportingRun(runId), urgentReason: report.urgentReason });
      if (urgent !== null) urgent.lifecycle.notice('urgent', urgent.seat, report.opId);
      return;
    // Only a hold's return names any other state; one naming another stage than the current is the transition's to refuse.
    case 'unhold': case 'invalid_report_intent':
      transition.apply(tx, { ...base, action: 'unhold', priorState: report.state });
      return;
    default: throw new Error(`Unlisted report intent: ${intent}`);
  }
}

/** report_doing and report_done are a Run's by TASK_POLICY.intent. */
function reportingRun(runId: RunId | null): RunId {
  if (runId === null) throw new Error("A doing or done report is a Run's");
  return runId;
}

/** The seat an urgent report of `taskId` goes to (ReturnLifecycle.urgentTarget), with the lifecycle that notices it. */
function urgentTo(tx: ControlTx, taskId: string) {
  const lifecycle = returnsAt(tx, taskId);
  return { lifecycle, seat: lifecycle.urgentTarget(taskId) };
}

/** A boundary of an owner Run that its Task's log does not settle yet. */
export type StateLink = { taskId: string; boundary: Boundary };
/**
 * The selected seats' owner Run boundaries (a predecessor's too) still to apply, deepest Task first and each
 * Task's oldest first, with the Tasks they were found in. A log only grows, so what `applyBoundary` would refuse now it
 * refuses later too, and a boundary kept here is one that applying would write.
 */
type StateLinkReads = { store: RunStore; runs: Pick<RunTransaction, 'decidingMany'> };
type StateLinkFacts = { snapshot: { tasks: RoutingTask[] }; links: StateLink[] };
export function stateLinks(tx: StateLinkReads, work: RoutingTasks | string, context: RoutingReadContext | undefined = controlReadContext(tx.store.connection)): StateLinkFacts {
  return finishRoutingRead(stateLinksSteps(tx, work, context));
}
export function* stateLinksSteps(tx: StateLinkReads, work: RoutingTasks | string, context: RoutingReadContext | undefined = controlReadContext(tx.store.connection)): RoutingReadSteps<StateLinkFacts> {
  const scope = routingTasks(tx.store.connection, work);
  yield;
  const snapshot = { tasks: yield* routingContextSteps(tx.store.root, tx.store.connection, scope, context) }, tree = new TaskTree(snapshot.tasks);
  yield;
  const working = snapshot.tasks.filter(task => scope.tasks.has(task.id) && task.meta.lifecycle === 'active' && task.meta.kind !== 'project');
  const taskFacts = new Map(working.map(task => [task.id, logFacts(task)]));
  const owned = new Map<string, RunRecord[]>();
  // Select only boundary facts before decoding records. A later Task state can settle an unwritten boundary too.
  const candidates = tx.store.connection.prepare(`SELECT id,task_id,state,json_extract(record,'$.started_at') AS started_at,
    json_extract(record,'$.ended_at') AS ended_at FROM runs WHERE task_id IN (SELECT value FROM json_each(?))
    AND json_extract(record,'$.role')='owner' AND
    ((json_extract(record,'$.started_at') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM task_log WHERE id=? || 'R' || runs.id)) OR
     (state IN ('succeeded','failed','cancelled') AND json_extract(record,'$.supersededBy') IS NULL AND json_extract(record,'$.ended_at') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM task_log WHERE id=? || 'R' || runs.id))) ORDER BY id`)
    .all(JSON.stringify(working.map(task => task.id)), BOUNDARY_LOG.started, BOUNDARY_LOG.ended);
  yield;
  const needed: RunId[] = [];
  for (const row of candidates) {
    const id = `R${row.id}` as RunId, facts = taskFacts.get(String(row.task_id))!;
    if ((row.started_at !== null && !boundarySettled(facts, { id: `${BOUNDARY_LOG.started}${id}`, at: String(row.started_at) })) ||
        (row.ended_at !== null && endedOwnWork(String(row.state) as RunRecord['state']) &&
        !boundarySettled(facts, { id: `${BOUNDARY_LOG.ended}${id}`, at: String(row.ended_at) }))) needed.push(id);
    yield;
  }
  const runsById = tx.runs.decidingMany(needed);
  yield;
  for (const run of runsById.values()) {
    const runs = owned.get(run.task);
    if (runs) runs.push(run); else owned.set(run.task, [run]);
  }
  working.sort((a, b) => tree.depth(b.id) - tree.depth(a.id));
  yield;
  const links: StateLink[] = [];
  for (const task of working) {
    const runs = owned.get(task.id);
    if (runs) {
      const facts = taskFacts.get(task.id)!;
      links.push(...boundariesOf(runs).filter(boundary => !boundarySettled(facts, boundary))
        .map(boundary => ({ taskId: task.id, boundary })));
    }
    yield;
  }
  return { snapshot, links };
}
/** One boundary as TaskTransition's run_started or run_ended, on its Task as it is now: one applied before may have reopened it. */
export function applyStateLink(tx: ControlTx, transition: TaskTransition, { taskId, boundary }: StateLink): void {
  applyBoundary(tx, transition, tasksIn(tx).get(taskId), boundary);
}
/** Apply a captured set of links in one transaction and return its current Tasks; eager test snapshots use this path. */
export function reconcileStateLinks(tx: ControlTx, work: RoutingTasks | string, found = stateLinks(tx, work), context?: RoutingReadContext): { tasks: RoutingTask[] } {
  if (!found.links.length) return found.snapshot;
  const transition = new TaskTransition();
  for (const link of found.links) applyStateLink(tx, transition, link);
  return { tasks: routingContext(tx.store.root, tx.store.connection, routingTasks(tx.store.connection, work), context) };
}
