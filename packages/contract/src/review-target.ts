import { TASK_POLICY, evaluate } from './task-policy.js';
/**
 * Browser-safe: the record that put a Task into review, whether a Task awaits the user's review, the state a hold set
 * aside, and which Run a review confirms. The ball, `task get`, the approval check, the estimate examples, the history
 * and the screen's choices all read these; none derives them again.
 */
import type { TaskBaseState } from '@alpacawork/raw/task-enums';
import type { TaskLog } from '@alpacawork/raw/task-log-schema';
import type { RunId } from './fields.js';
import { isRunEnded, type RunState } from './run-contract.js';

/** What these read of a log entry: the state it left and the state it set (null when it kept the state). */
type StateChange = Pick<TaskLog, 'fromState' | 'toState'>;
type ReviewLog = StateChange & Pick<TaskLog, 'kind' | 'runId' | 'startsEstimateRound'>;

/**
 * The record that put the Task into waiting for the user's review: a report leading to waiting. A hold's return to the
 * review is not one; the review it returns to began with the report before the hold.
 */
export const isReviewMark = (entry: StateChange & { kind: string; stage?: { baseState: TaskBaseState; action: string } }) =>
  entry.kind === 'reported' && entry.toState === 'waiting' && (entry.stage !== undefined
    ? entry.stage.action === 'report_done' || entry.stage.action === 'submit_review' : entry.fromState !== 'held');

/** The original submission, including across a hold and its restoration. */
const reviewMark = <Log extends ReviewLog>(log: readonly Log[]): Log | null =>
  [...log].reverse().find(isReviewMark) ?? null;

/**
 * The current submission of the waiting stage. TaskTransition already invalidates that stage on new owner input;
 * unfinished execution still prevents confirming a submission before its reporting Run ends.
 */
export function currentReview<Log extends ReviewLog>(task: { baseState: TaskBaseState; log: readonly Log[] },
  unfinished = false): Log | null {
  if (!awaitsReview(task) || unfinished) return null;
  return reviewMark(task.log);
}

/** A submitted Task snapshot has no reporting Run; its Task hash identifies what the user reviews. */
export const isTaskReview = (task: { baseState: TaskBaseState; log: readonly ReviewLog[] }): boolean => {
  const mark = awaitsReview(task) ? reviewMark(task.log) : null;
  return mark !== null && mark.runId === undefined;
};

/** Waiting for the user's review, or such a wait the user has held. */
export const awaitsReview = (task: { baseState: TaskBaseState }) => evaluate(TASK_POLICY.actionCandidates, { baseState: task.baseState, hold: false, userRequested: true }, true).all.some(row => row.code === 'confirm');

/** The reporting Run of the current submission, finished and still the owner head; never a later head substituted. */
export function reviewTarget(task: { baseState: TaskBaseState; log: readonly ReviewLog[] },
  headRun: { id: RunId; state: RunState } | null, unfinished = false): RunId | null {
  const mark = currentReview(task, unfinished);
  return mark?.runId !== undefined && headRun !== null && mark.runId === headRun.id && isRunEnded(headRun.state)
    ? mark.runId : null;
}

/** The original submission's closure, across holds and later submissions. */
export function reviewClosure(log: readonly TaskLog[], id: string): { open: boolean; closure?: 'confirmed' | 'invalidated' | 'stopped' } {
  const index = log.findIndex(entry => entry.id === id);
  if (index < 0 || !isReviewMark(log[index]!)) throw new Error('Unknown review submission');
  for (const entry of log.slice(index + 1)) {
    if (entry.kind === 'review_approved') return { open: false, closure: 'confirmed' };
    if (entry.stage?.baseState === 'stopped' || entry.toState === 'stopped') return { open: false, closure: 'stopped' };
    if (isReviewMark(entry) || entry.stage && entry.stage.baseState !== 'waiting' ||
        !entry.stage && entry.toState !== null && !['waiting', 'held'].includes(entry.toState))
      return { open: false, closure: 'invalidated' };
  }
  return { open: true };
}
