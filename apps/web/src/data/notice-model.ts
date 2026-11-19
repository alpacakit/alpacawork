import { noticeStateSchema, userTurn } from "@alpacawork/contract";
import type { TaskRowDTO } from "@alpacawork/contract/control";

export type TaskBaseline = {
  log: number;
  state: TaskRowDTO["state"];
  body: string;
  turnKey?: string | null;
};

/**
 * The row's notice facts as a reader's baseline: how long the log was, the state, the body's hash and the key of the
 * user's turn, each as the server projects it.
 */
export function taskBaseline(task: Pick<TaskRowDTO, "notice" | "state">): TaskBaseline {
  return { log: task.notice.logCount, state: task.state, body: task.notice.bodyHash,
    turnKey: task.notice.turnKey };
}

type EventBase = { id: string; task: TaskRowDTO; at?: string };
export type NoticeEvent = EventBase & (
  | { kind: "created" }
  | { kind: "reported"; line: string }
  | { kind: "state"; from: TaskRowDTO["state"]; to: TaskRowDTO["state"] }
  | { kind: "body" }
  | { kind: "turn" }
);

/**
 * Compare facts only. Report identity does not depend on the task's mutable state.
 * A report is news when the latest noticed log entry (NOTICED_LOG_KINDS: a report, a question or its answer, a
 * change of the responsible person, a review decision, a move or shelving) came after the baseline. A turn is news
 * when the row's turn key differs from the baseline's: the key is compared as projected, never derived here.
 */
export function taskEvents(tasks: TaskRowDTO[], baselines: Record<string, TaskBaseline>): NoticeEvent[] {
  return tasks.flatMap((task) => {
    const baseline = baselines[task.id];
    const current = taskBaseline(task);
    const events: NoticeEvent[] = [];
    if (!baseline) {
      events.push({ id: `${task.id}|created`, kind: "created", task, at: task.createdAt ?? undefined });
    } else {
      if (current.turnKey && baseline.turnKey !== current.turnKey) events.push({
        id: `${task.id}|turn|${current.turnKey}`, kind: "turn", task, at: userTurn(task.ball)?.at,
      });
      if (baseline.state !== current.state) events.push({
        id: `${task.id}|state|${baseline.state}|${current.state}`,
        kind: "state", task, from: baseline.state, to: current.state,
      });
      if (baseline.body !== current.body) events.push({
        id: `${task.id}|body|${current.body}`, kind: "body", task,
      });
    }
    const noticed = task.notice.lastNoticed;
    if (noticed && noticed.position >= (baseline?.log ?? 0))
      events.push({ id: `${task.id}|log|${noticed.position}`, kind: "reported", task,
        line: noticed.title ?? noticed.kind, at: noticed.at });
    return events;
  });
}

export type NoticeCheckpoint = { at: string; tasks: Record<string, TaskBaseline> };
/** The saved read marks' version: the contract's (`noticeStateSchema`), the only one the server takes. */
export const NOTICE_VERSION = noticeStateSchema.shape.version.value;
export type NoticeSaved = { version: typeof NOTICE_VERSION; checkpoint: NoticeCheckpoint; reads: Record<string, TaskBaseline> };

export function readTaskIds(tasks: TaskRowDTO[], checkpoint: NoticeCheckpoint | undefined, reads: Record<string, TaskBaseline>) {
  const unread = new Set(taskEvents(tasks, { ...checkpoint?.tasks, ...reads }).map((event) => event.task.id));
  return new Set(tasks.filter((task) => !unread.has(task.id)).map((task) => task.id));
}

/** When a task was first seen changed on this device: what marks it new until it is read. */
export type FirstSeen = { at: number };
