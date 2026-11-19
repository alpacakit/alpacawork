/**
 * The user's completion of a Task: TASK_POLICY decides whether its confirmation needs a review.
 * Only the user's proxy decides (authorize); the shown Task and any required review must still be current.
 */
import { Problem, PROBLEM_CODE, type ProblemReason } from '@alpacawork/core';
import { currentReview, isTaskReview, reviewTarget } from '@alpacawork/contract';
import type { ReviewInput } from '@alpacawork/contract/control';
import type { RunId } from '@alpacawork/contract/fields';
import type { RunTransaction } from '@alpacawork/runs';
import { now, type ControlTask, type TaskActor } from '@alpacawork/raw';
import { validateReportMedia } from './report-media.js';
import { assertActive } from './task-store.js';
import { TaskTransition, operationFacts, operationFingerprint, operationIdUse, tasksIn, type ControlTx } from './task-transition.js';
import { ownerHead } from './wake.js';
import { evaluate, TASK_POLICY } from '@alpacawork/contract/task-policy';

/** A decision as the contract's reviewInputSchema has it, without the action its method names. */
type Decision<Action extends ReviewInput['action']> = Omit<Extract<ReviewInput, { action: Action }>, 'action'>;
/** What the user was shown: the Task's and its responsible placement's versions, and the Run under review. */
type Shown = { expectedTaskHash: string; expectedPlacementRevision?: number; aboutRunId?: RunId };

const conflict = (message: string, reason: ProblemReason, detail?: Record<string, unknown>) =>
  new Problem(PROBLEM_CODE.conflict, message, detail, { reason });
/** What a review of the Task's snapshot refuses: it has no Run to name. */
function assertNoRunTarget(shown: Shown): void {
  if (shown.aboutRunId !== undefined)
    throw conflict('A Task snapshot review has no Run target', { kind: 'task_snapshot_review_has_no_run_target' });
}

/**
 * The Run the user confirms, when the review is still the one the user was shown: the Task is active
 * and at the version shown, it awaits review, its responsible placement is at the revision shown, nothing runs on it
 * and `aboutRunId` is its reviewTarget, never a later Run filled in. What else keeps
 * a confirmed Task from finishing (Runs below it too) is TaskTransition's confirm's, by TASK_POLICY.finish.
 */
function reviewedRun(runs: RunTransaction, task: ControlTask, shown: Shown, needsReview: boolean): RunId | null {
  assertActive(task);
  if (task.hash !== shown.expectedTaskHash)
    throw conflict('Task changed; reload before review', { kind: 'task_changed_reload_before_review' }, { currentTaskHash: task.hash });
  if (!needsReview) { assertNoRunTarget(shown); return null; }
  const snapshotReview = isTaskReview(task.meta);
  if (!snapshotReview && (shown.aboutRunId === undefined || shown.expectedPlacementRevision === undefined)) {
    const message = 'Confirming a review needs --about-run (the reviewRun task get shows) and --expected-placement-revision';
    throw new Problem(PROBLEM_CODE.invalidInput, message, undefined, {
      reason: { kind: 'confirming_review_needs_about_run_reviewrun_task_get_shows_and_expected_placement_revision' },
      issues: [{ path: 'aboutRun', code: 'invalid_combination', message }] });
  }
  if (!currentReview(task.meta)) throw conflict('Task is not waiting for review', { kind: 'task_not_waiting_for_review' });
  if (snapshotReview) assertNoRunTarget(shown);
  const placement = runs.responsiblePlacement(task.id);
  // A snapshot review's placement revision is optional: the hash includes placement changes.
  if (shown.expectedPlacementRevision !== undefined && placement?.revision !== shown.expectedPlacementRevision)
    throw conflict('Responsible placement changed', { kind: 'responsible_placement_changed' });
  if (runs.unfinishedIn([task.id]).length)
    throw new Problem(PROBLEM_CODE.handoffPending, 'Task still has unfinished Runs', undefined, { reason: { kind: 'task_still_has_unfinished_runs' } });
  // Never infer a Run from a newly assigned responsible.
  if (snapshotReview) return null;
  const head = ownerHead(runs.conversationRuns(placement!.id));
  const target = reviewTarget(task.meta, head);
  if (target === null || target !== shown.aboutRunId) throw conflict('Review Run is not the current completed head', { kind: 'review_run_not_current_completed_head' });
  return target;
}

export class ReviewService {
  constructor(readonly root: string) {}

  /**
   * Confirms the review in the caller's transaction: TaskTransition's confirm of the reviewed Run, recorded under the
   * decision's ID; a retry with the same input changes nothing. TaskReportService calls it.
   */
  approve(tx: ControlTx, input: Decision<'approve'>, actor: TaskActor): void {
    const task = tasksIn(tx).get(input.taskId);
    const fingerprint = operationFingerprint({ ...input, actor });
    const previous = task.meta.log.find(entry => entry.id === input.operationId);
    if (previous) {
      if (previous.kind !== 'review_approved' || previous.operationFingerprint !== fingerprint)
        throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Review ID belongs to another decision', undefined, { reason: { kind: 'review_id_belongs_another_decision' } });
      return;
    }
    // An operation ID names one record of one Task, so one another Task's log holds is refused.
    const used = operationIdUse(tx, input.operationId);
    if (used.logged)
      throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Review ID belongs to another Task; use a new operation ID', undefined,
        { reason: { kind: 'review_id_belongs_another_task_use_new_operation_id' } });
    // A Request reserves its ID even if delivery is later aborted.
    if (used.request)
      throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Review ID belongs to a Request; use a new operation ID', undefined,
        { reason: { kind: 'review_id_belongs_request_use_new_operation_id' } });
    validateReportMedia(this.root, task.path, input.description);
    const decision = evaluate(TASK_POLICY.transition, operationFacts(task.meta, 'confirm', actor));
    // Unknown/stale confirmations retain the review checks; only an admitted table row can omit them.
    const aboutRun = reviewedRun(tx.runs, task, input, decision.kind === 'reject' || decision.needsReview !== false);
    new TaskTransition().apply(tx, { actor, taskId: task.id, at: now(), action: 'confirm', aboutRun,
      record: { id: input.operationId, title: input.title ?? null, description: input.description ?? null,
        operationFingerprint: fingerprint } });
  }
}
