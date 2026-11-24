import { TASK_POLICY, evaluate } from '@alpacawork/contract/task-policy';
/**
 * Questions and the records that go to a requester at once: a question to its chosen destination, its
 * answer, its withdrawal, and a comment, urgent or not. The actor is authorize's, which alone says who may ask,
 * answer, withdraw or comment; these check the Task's facts only (the question is open, the Task has not stopped) and
 * write through TaskTransition and ReturnLifecycle in the caller's transaction.
 */
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import type { RunId } from '@alpacawork/contract/fields';
import { digest, now, questionsOf, type ControlTask, type FieldItem, type TaskActor, type TaskLog, type ConversationCheckpoint, type TaskValues } from '@alpacawork/raw';
import { assertQuestionOpen, destinationGone, questionDestination, questionSnapshot, questionApplicable, validQuestionDestination } from './question-rules.js';
import { validateReportMedia } from './report-media.js';
import { ReturnLifecycle } from './return-lifecycle.js';
import type { ReturnNotice } from './return-rules.js';
import { startBeforeReport } from './task-reports.js';
import { assertActive, assertAtHash } from './task-store.js';
import { TaskTransition, operationFingerprint, operationIdUse, returnsAt, tasksIn, type ControlTx } from './task-transition.js';

/**
 * Whether the operation `id` already wrote this record: a retry with the same input changes nothing. An ID that
 * another operation took (a record of another kind or input, or a Request, which share the IDs) is refused.
 */
function replayed(tx: ControlTx, task: ControlTask, id: string, kind: TaskLog['kind'],
  fingerprint: string): boolean {
  const ordinal = tx.store.connection.prepare('SELECT CAST(ordinal AS TEXT) AS ordinal FROM task_log WHERE id=? AND task_id=(SELECT id FROM tasks WHERE external_id=?)').get(id, task.id);
  const indexed = ordinal ? task.meta.log[Number(ordinal.ordinal)] : undefined;
  const previous = indexed?.id === id ? indexed : ordinal ? task.meta.log.find(entry => entry.id === id) : undefined;
  if (previous) {
    if (previous.kind !== kind || previous.operationFingerprint !== fingerprint)
      throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Operation ID has different input', undefined, { reason: { kind: 'operation_id_has_different_input' } });
    return true;
  }
  const used = operationIdUse(tx, id);
  if (used.logged || used.request)
    throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Operation ID belongs to another operation', undefined,
      { reason: { kind: 'operation_id_belongs_another_operation' } });
  return false;
}

/**
 * Refuses a record on a Task no longer active, or changed since the caller read it at `expectedTaskHash` (an answer
 * names its question instead).
 */
function assertWritable(task: ControlTask, expectedTaskHash?: string): void {
  assertActive(task);
  if (expectedTaskHash !== undefined) assertAtHash(task, expectedTaskHash);
}

/** Notices `toTaskId` of the record `causeLogId`, by the return lifecycle of `project` as this write has written it. */
function notify(tx: ControlTx, project: string, kind: ReturnNotice, toTaskId: string, causeLogId: string): void {
  new ReturnLifecycle(tx.store.connection, tx.runs, [], project, undefined, tx.store.root).notice(kind, toTaskId, causeLogId);
}

/**
 * Asks the chosen destination (questionDestination, fixed as askedTo) the Task's decide value, fixed in the asking
 * record as it is now, summarized by `description`, and notices a requesting Task. A report that writes
 * values with its question writes them before it asks, so the question is the value it saved. The question keeps the
 * state; only the asking Run's own start, not applied yet, goes before it. TaskReportService calls it for task report
 * --state waiting.
 */
export function ask(tx: ControlTx, input: { actor: TaskActor; runId: RunId; taskId: string; opId: string;
  expectedTaskHash: string; title: string; description: string; askTo: string;
  /** The write's values as sent (what its fingerprint keeps) and the Task's values after it, saved with the question. */
  values?: unknown; written?: TaskValues; nextConversation?: 'new'; checkpoint?: ConversationCheckpoint }): void {
  const { checkpoint, written, ...operation } = input;
  const tasks = tasksIn(tx), read = tasks.get(input.taskId), fingerprint = operationFingerprint(operation);
  if (replayed(tx, read, input.opId, 'asked', fingerprint)) return;
  assertWritable(read, input.expectedTaskHash);
  const transition = new TaskTransition();
  // The asking Run's own start goes first, as a state report's does, so a Run that a Request sent to a stopped Task
  // asks on the Task its start made doing again.
  startBeforeReport(tx, transition, read, input.runId);
  const task = tasks.get(input.taskId);
  // A stop expires the questions asked before it (raw questionsOf); one asked after it would never close.
  if (evaluate(TASK_POLICY.questionAdmission, task.meta).kind === 'reject')
    throw new Problem(PROBLEM_CODE.questionStopped, 'Cannot ask a question from a stopped Task', { task: task.id });
  validateReportMedia(tx.store.root, task.path, input.description);
  const decide = (written ?? task.values).decide as FieldItem[] | undefined;
  if (!decide?.length) throw new Problem(PROBLEM_CODE.invalidInput, 'The Task has no question in its decide value; write the full question there before asking', { task: task.id },
    { reason: { kind: 'no_question_in_decide_value_write_full_question_before_asking' } });
  const project = tasks.projectFor(task.id), askedTo = questionDestination(input.askTo, task.id, questionSnapshot(tasks.related(task.id).tasks),
    id => tx.runs.responsiblePlacements(project, [id]).length > 0);
  transition.appendRecord(tx, task.id, { id: input.opId, kind: 'asked', at: now(), title: input.title,
    description: input.description, actor: input.actor, fromState: null, toState: null, runId: input.runId, askedTo,
    decide, operationFingerprint: fingerprint, ...(checkpoint ? { checkpoint } : {}) }, undefined,
    written === undefined ? undefined : { values: written });
  if (askedTo !== null) {
    transition.reopenForQuestion(tx, askedTo, input.opId, input.actor);
    notify(tx, project, 'question', askedTo, input.opId);
  }
}

/**
 * Answers an open question of `taskId` with `body`, its full text, and notices the asking Task. It makes no Request or
 * Run. An instruction carrying a loan delivers the answer itself.
 */
export function answer(tx: ControlTx, input: { actor: TaskActor; taskId: string; questionId: string; body: string;
  opId: string }, delivery: 'notice' | 'instruction' = 'notice'): void {
  const tasks = tasksIn(tx), task = tasks.get(input.taskId), fingerprint = operationFingerprint(input);
  if (replayed(tx, task, input.opId, 'answered', fingerprint)) return;
  assertWritable(task);
  const { asked } = assertQuestionOpen(task.id, task.meta.log, input.questionId);
  if (!questionApplicable(task.id, asked, questionSnapshot(tasks.related(task.id).tasks))) throw destinationGone(task.id, asked.id);
  new TaskTransition().appendRecord(tx, task.id, { id: input.opId, kind: 'answered', at: now(), title: null,
    description: null, actor: input.actor, fromState: null, toState: null, questionId: input.questionId,
    operationFingerprint: fingerprint }, input.body);
  if (delivery === 'notice') notify(tx, tasks.projectFor(task.id), 'answer', task.id, input.opId);
}

/**
 * Withdraws an open question of the Task; ReturnLifecycle.reconcile clears what was not delivered of it.
 * TaskReportService calls it for task report --withdraw.
 */
export function withdraw(tx: ControlTx, input: { actor: TaskActor; runId: RunId; taskId: string; questionId: string;
  opId: string; expectedTaskHash: string }): void {
  const task = tasksIn(tx).get(input.taskId), fingerprint = operationFingerprint(input);
  if (replayed(tx, task, input.opId, 'question_withdrawn', fingerprint)) return;
  assertWritable(task, input.expectedTaskHash);
  assertQuestionOpen(task.id, task.meta.log, input.questionId);
  new TaskTransition().appendRecord(tx, task.id, { id: input.opId, kind: 'question_withdrawn', at: now(), title: null,
    description: null, actor: input.actor, fromState: null, toState: null, runId: input.runId,
    questionId: input.questionId, operationFingerprint: fingerprint });
}

/**
 * Records a comment that keeps the state; with `urgentReason` it goes to return-rules urgentTarget at once (refused,
 * as a done --urgent is, when that is the user). task comment calls it.
 */
export function comment(tx: ControlTx, input: { actor: TaskActor; runId: RunId | null; taskId: string; opId: string;
  expectedTaskHash: string; title?: string; description?: string; urgentReason?: string }): void {
  const tasks = tasksIn(tx), task = tasks.get(input.taskId), fingerprint = operationFingerprint(input);
  if (replayed(tx, task, input.opId, 'reported', fingerprint)) return;
  assertWritable(task, input.expectedTaskHash);
  validateReportMedia(tx.store.root, task.path, input.description);
  const project = tasks.projectFor(task.id);
  const target = input.urgentReason === undefined ? null : returnsAt(tx, task.id).urgentTarget(task.id);
  new TaskTransition().appendRecord(tx, task.id, { id: input.opId, kind: 'reported', at: now(),
    title: input.title ?? null, description: input.description ?? null, actor: input.actor, fromState: null,
    toState: null, ...(input.runId === null ? {} : { runId: input.runId }),
    ...(input.urgentReason === undefined ? {} : { urgentReason: input.urgentReason }), operationFingerprint: fingerprint });
  if (target) notify(tx, project, 'urgent', target, input.opId);
}

/** A move invalidates only questions whose fixed Task seat left their ancestor chain; never retargets them. */
export function expireInvalidDestinations(tx: ControlTx, taskIds: readonly string[], actor: TaskActor): void {
  const tasks = tasksIn(tx);
  if (!taskIds.length) return;
  const snapshot = questionSnapshot(tasks.related(taskIds[0]!).tasks);
  for (const id of taskIds) {
    const task = tasks.get(id);
    for (const asked of questionsOf(task.meta.log).filter(q => q.closing === null).map(q => q.asked)) {
      if (validQuestionDestination(id, asked.askedTo, snapshot)) continue;
      const opId = `QEXPIRE:${digest(Buffer.from(asked.id))}`;
      new TaskTransition().appendRecord(tx, id, { id: opId, kind: 'question_expired', at: now(), title: null,
        description: null, actor, fromState: null, toState: null, questionId: asked.id,
        closureReason: 'destination_invalid' });
      notify(tx, tasks.projectFor(id), 'answer', id, opId);
    }
  }
}
