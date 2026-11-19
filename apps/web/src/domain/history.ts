import type { TaskHistoryDTO, TaskProjectedTimelineDTO } from "@alpacawork/contract/control";
import { isRunInTrouble } from "@alpacawork/contract/run";

/** What an event's mark is read from: a log entry as the index has it, or a run. */
export type MarkSource = { log?: TimelineLog; run?: TimelineRun;
  /** The record's event as the server sends it to the time view (a timeline note): a record has a mark only with one. */
  note?: TimelineNote;
  phase?: "accepted" | "started" | "finished";
  /** The record that finished the task, while it is still done (finishedBy). */
  finished?: boolean;
  /** The record the user's turn waits on (turnRecord): their open question, or the report their review is of. */
  yours?: boolean;
  /** The record that stopped the task, while it is still stopped (standingRecord). */
  stopped?: boolean };

export type TimelineLog = Extract<TaskProjectedTimelineDTO["events"][number], { kind: "log" }>["entry"];
export type TimelineRun = TaskProjectedTimelineDTO["runs"][number];
export type TimelineNote = Extract<TaskProjectedTimelineDTO["events"][number], { kind: "note" }>["event"];

/** One record of a Task's History, as the server projects it. */
export type HistoryEvent = TaskHistoryDTO["events"][number];

export { logKey, historyEventKey as eventKey } from '@alpacawork/contract';
import { runPhaseKey } from '@alpacawork/contract';

/** A Run's phases on its own Task's time line. */
export function runEvents(run: TimelineRun) {
  const kind = isRunInTrouble(run.state) ? "error" : "run";
  const result: { key: string; at: string; kind: "run" | "error"; run: TimelineRun;
    phase: "accepted" | "started" | "finished" }[] = [];
  result.push({ key: runPhaseKey(run.id, "accepted"), at: run.createdAt, kind: "run", run, phase: "accepted" });
  if (run.startedAt) result.push({ key: runPhaseKey(run.id, "started"), at: run.startedAt, kind: "run", run, phase: "started" });
  if (run.endedAt || kind === "error")
    result.push({ key: runPhaseKey(run.id, "finished"), at: run.endedAt ?? run.startedAt ?? run.createdAt, kind, run, phase: "finished" });
  return result;
}

const phaseOrder = { accepted: 0, started: 1, finished: 2 };
/** Time, then a run's phases in order, then the key. */
export const byTime = (a: { at: string; key: string; run?: TimelineRun; phase?: keyof typeof phaseOrder },
  b: { at: string; key: string; run?: TimelineRun; phase?: keyof typeof phaseOrder }) =>
  Date.parse(a.at) - Date.parse(b.at)
    || (a.run?.id === b.run?.id && a.phase && b.phase ? phaseOrder[a.phase] - phaseOrder[b.phase] : 0)
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
