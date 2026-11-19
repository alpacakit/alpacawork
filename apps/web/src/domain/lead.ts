import { userTurn, type Ball } from "@alpacawork/contract";
import type { Task } from "@/data/types";
import type { PeopleIndex } from "./people";
import type { ErrorCause } from "./run-labels";
import { turnRecord } from "./report-events";
import { currentWords } from "./work-progress";

/** What a task is to its reader now. */
type LeadKind = "question" | "review" | "error" | "doing" | "waiting" | "done" | "todo";

/**
 * The user's turn whose reason the screen writes out (TurnReason): automatic wakes stopped at their limit, a delivery
 * whose receipt is unknown, a refused wake, a failure of what the user asked. A review and a question say themselves.
 */
export const reasonedTurn = (ball: Ball | null) => {
  const turn = userTurn(ball);
  return turn && turn.reason !== "review" && turn.reason !== "question" ? turn : null;
};
export type ReasonedTurn = NonNullable<ReturnType<typeof reasonedTurn>>;

/** The record that put a failed Task in error, as the ball reads it: not a hold's return. */
const failureRecord = (task: Task, turn: ReasonedTurn) => task.stateLog.find(entry => entry.id === turn.key);

/**
 * The turn the reader says under a task's title (TurnReason): the ball's own reason, or the failure the ball carries
 * beneath the user's question. The question stays the ball, but its answer waits for a retry while the Task is
 * failed, so the failure still offers Retry and Stop there.
 */
export function titleTurn(task: Task): ReasonedTurn | null {
  const turn = reasonedTurn(task.ball);
  if (turn) return turn;
  const asked = userTurn(task.ball);
  return asked?.reason === "question" && asked.failure
    ? { ...asked, reason: "failed", at: asked.failure.at, key: asked.failure.key, questionId: null, failure: null } : null;
}

/**
 * The cause the backend read in the error words of the Run whose end failed the Task, while the reader says that
 * failure (titleTurn). The turn's key is the record that put the Task in error, as the ball chose it; that record names
 * its Run, which must still be an unresolved failure. Another failure, an end with no report, or a Run without a known
 * cause gives null.
 */
export function failureCause(task: Task, people: PeopleIndex): ErrorCause | null {
  const turn = titleTurn(task);
  if (turn?.reason !== "failed") return null;
  const record = failureRecord(task, turn);
  const failure = record?.runId === undefined ? undefined
    : people.failuresByTask.get(task.id)?.find(({ run, resolvedBy }) => run.id === record.runId && resolvedBy === null);
  return failure?.run.errorCause ?? null;
}

/**
 * The question the server lists on a task's row (its oldest open one), said as the user's only while the ball says a
 * question is asked of them (held or not): one asked of the parent (Consulting parent) is counted on the request's row and shown
 * in the time view, never said as the user's question.
 */
export const askedOfUser = (task: Task) => userTurn(task.ball)?.reason === "question" ? task.question || null : null;

/**
 * The line a list summary (BriefLine) says of a task, read from the task as the list has it (no body needed): for
 * your review the words of the report that asked for it; while it works, the owner's latest words and
 * when they were said; when its work stopped, why. A finished or untouched task has no line. The Task's error state
 * leads. The latest failed Run only explains its reason. The question asked of you and any other turn's reason are the
 * summary's own (askedOfUser, reasonedTurn).
 */
export function leadOf(task: Task, people: PeopleIndex): { kind: LeadKind; line: string | null; at: string | null; failureReason: string | null } {
  const turn = userTurn(task.ball);
  const failed = task.state === "error" ? people.failuresByTask.get(task.id)?.at(-1)?.run : undefined;
  const failureReason = task.state === "error" ? failed?.reason ?? "unknown" : null;
  if (failureReason) return { kind: "error", line: null, at: null, failureReason };
  if (turn?.reason === "question") return { kind: "question", line: null, at: null, failureReason };
  if (turn?.reason === "review") {
    const report = turnRecord(task);
    return { kind: "review", line: task.stateLog.find(entry => entry.id === report)?.title ?? null, at: null, failureReason };
  }
  if (task.state === "doing") {
    const said = currentWords(task, people);
    return { kind: "doing", line: said?.text ?? null, at: said?.at ?? null, failureReason };
  }
  if (task.state === "waiting") return { kind: "waiting", line: null, at: null, failureReason };
  return { kind: task.state === "todo" ? "todo" : "done", line: null, at: null, failureReason };
}
