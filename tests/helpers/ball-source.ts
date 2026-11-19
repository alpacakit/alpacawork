/** Eager ball sources for tests that compare a full snapshot with the screen projection. */
import { isRunEnded, type Ball } from '@alpacawork/contract';
import { policyBall } from '@alpacawork/contract/task-policy';
import { ballFactsOf, type BallSource } from '@alpacawork/backend/test-dist/control/ball.js';
import { questionSnapshot } from '@alpacawork/backend/test-dist/control/question-rules.js';
import { rowsByTask, type SeatSource } from '@alpacawork/backend/test-dist/control/wake.js';

/**
 * The ball source of a seat source and its read point's Tasks, with the Requests to each Task indexed once: how the
 * tree's snapshot and TaskTransition's transaction make theirs.
 */
export function ballSourceOf(seats: SeatSource, tasks: BallSource['tasks']): BallSource {
  const requestsTo = rowsByTask(seats.requests, request => request.taskId);
  const moving = new Set<string>(), working = new Set<string>();
  for (const run of seats.facts.runs.values()) {
    if (!isRunEnded(run.state)) moving.add(run.task);
    if (run.state === 'queued' || run.state === 'running') working.add(run.task);
  }
  return { ...seats, tasks, questions: questionSnapshot(tasks), moving: taskId => moving.has(taskId),
    working: taskId => working.has(taskId), requestsTo: taskId => requestsTo.get(taskId) ?? [] };
}

/**
 * The balls of `ids` (every Task of the source without them) at one read point, as the tree lists them: a Task without
 * one is left out.
 */
export function ballsOf(source: BallSource,
  ids: readonly string[] = source.tasks.map(task => task.id)): Record<string, Ball> {
  const balls: Record<string, Ball> = {};
  for (const id of ids) {
    const ball = policyBall(ballFactsOf(source, id));
    if (ball) balls[id] = ball;
  }
  return balls;
}
