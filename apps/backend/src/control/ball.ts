import { questionSnapshot, questionApplicable } from './question-rules.js';
/**
 * Whose move a Task waits on (its ball): derived here and nowhere else, from the facts of one read point. The tree,
 * the list, unread marks, push and the hold check read it; the wake rules never do, since the ball reads their block.
 */
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { currentReview, isTaskReview, reviewTarget } from '@alpacawork/contract';
import type { RunId } from '@alpacawork/contract/fields';
import { openQuestions, type ControlTask, type TaskLifecycle, type TaskState } from '@alpacawork/raw';
import type { StoredRequest } from '@alpacawork/runs';
import { failureRequester, requesterOf, taskFailure } from './return-rules.js';
import { seatFactsOf, wakeBlock, type SeatSource, type WakeBlock } from './wake.js';

import type { BallFacts } from '@alpacawork/contract/task-policy';
export { policyBall as ballOf, type BallFacts } from '@alpacawork/contract/task-policy';

/**
 * What ballFactsOf reads a Task's ball facts from: a seat's source (the ball reads the seat's block and open Requests
 * through it), with the read point's Tasks and the Requests to each. Screen records and transaction facts implement it.
 */
export interface BallSource extends SeatSource {
  readonly tasks: readonly Pick<ControlTask, 'id' | 'meta'>[];
  readonly questions: ReturnType<typeof questionSnapshot>;
  /** Whether a Run of the Task has not ended, and whether one is queued or running: every ball asks, so indexed once. */
  moving(taskId: string): boolean;
  working(taskId: string): boolean;
  /** The Requests to a Task, out of `requests`: the ones requesterOf chooses the requester from. */
  requestsTo(taskId: string): readonly StoredRequest[];
}

/**
 * A Task's ball facts at the source's read point: the only assembly of BallFacts (review-target for the hold and the
 * review, raw questions for the open questions, return-rules requesterOf, wake.seatFactsOf for the block).
 */
export function ballFactsOf(source: BallSource, taskId: string): BallFacts {
  const task = source.task(taskId);
  if (!task) throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist', { task: taskId }, { reason: { kind: 'task_does_not_exist' } });
  const { lifecycle, state, baseState, log } = task.meta;
  const mark = currentReview(task.meta, source.moving(taskId));
  const failed = baseState === 'error' ? taskFailure(log) : undefined;
  const responsible = source.responsible(taskId), seat = seatFactsOf(source, taskId);
  const requests = source.requestsTo(taskId);
  const seatId = failed ? failureRequester(taskId, failed, requests, source.facts) : requesterOf(taskId, requests, source.facts);
  const questions = source.questions;
  const asking = !failed || seatId === null ? undefined : source.task(seatId);
  const requesterAskedUser = !!asking && openQuestions(asking.meta.log)
    .some(q => q.askedTo === null && questionApplicable(asking.id, q, questions)) &&
    !source.working(asking.id);
  return {
    lifecycle, state, baseState,
    review: mark ? { logId: mark.id, at: mark.at, taskSnapshot: isTaskReview(task.meta),
      runId: reviewTarget(task.meta, responsible && source.head(responsible.id)) } : null,
    failure: failed ? { logId: failed.id, at: failed.at } : null,
    openQuestions: openQuestions(log).filter(q => questionApplicable(task.id, q, questions)).map(asked => ({ id: asked.id, askedTo: asked.askedTo, at: asked.at })),
    requester: seatId === null ? 'user' : 'parent',
    requesterAskedUser,
    block: wakeBlock(seat),
    openRequests: seat.openRequests,
  };
}
