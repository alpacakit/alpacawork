import type { Task } from "@/data/types";
import { requestKey, runSpan } from "@alpacawork/contract";
import { standingRecord } from "@alpacawork/contract/control";
import { isFinished } from "@alpacawork/contract/branch";
import type { TimePeopleIndex } from "./people";
import { byTime, eventKey, logKey, runEvents, type TimelineNote, type MarkSource } from "./history";
import { turnRecord } from "./report-events";
import { finishedBy, stateSince } from "./tasks";

/** A wait is a review waiting (waiting is only ever one), a hold, or a stop on an error. */
/** `open`: still going, so it ends at now (and a Run begun this instant is a stretch of none). */
export type Segment = { from: number; to: number; kind: "work" | "member" | "below" | "review" | "stuck" | "held"; open?: true };
/** An ended Run under a row, as the server sends it: [Run, from, to]. */
export type BelowRun = readonly [run: string, from: number, to: number];
/** Who is at work on a row: its own responsible and members, and the Runs under it. */
export const isHand = (segment: Pick<Segment, "kind">) => segment.kind === "work" || segment.kind === "member" || segment.kind === "below";
export type TimeEvent = { key: string; at: number; source: MarkSource };
export type TaskHistory = { taskId: string; start: number; end: number | null; events: TimeEvent[]; segments: Segment[] };
export type TimeHistoryBase = Omit<TaskHistory, "start" | "segments"> & {
  start: number | null;
  segments: (Omit<Segment, "to"> & { to: number | null })[];
};

/**
 * The line uses the same event keys as the reader's History tab, from the index: the row's
 * state, estimate, report, question and review entries and the task's runs. `notes` are the task's records the server
 * sends the time view (its timeline notes, what its row's lane shows of it): each comes with its own entry's source, or
 * as one of its own, and only those the Task stands on now have a mark. `below` are the ended Runs under the row; with
 * those running now, which the row itself says, the line counts what its running count counts.
 */
export function timeHistoryBase(task: Pick<Task, "id" | "createdAt">, people: TimePeopleIndex, notes: readonly TimelineNote[], below: readonly BelowRun[] = []): TimeHistoryBase | null {
  const control = people.tasks.get(task.id);
  if (!control) return null;
  const finished = finishedBy(control)?.id;
  const yours = turnRecord(control);
  const noted = new Map<string, TimelineNote>();
  for (const note of notes) noted.set(eventKey(note), note);
  const logs = control.stateLog.map((log) => {
    const key = log.startsEstimateRound === true ? requestKey(log.id) : logKey(task.id, log.id);
    const note = noted.get(key);
    noted.delete(key);
    return { key, at: log.causeAt ?? log.at, log, finished: log.id === finished, yours: log.id === yours, ...(note ? { note } : {}) };
  });
  const runs: (ReturnType<typeof runEvents>[number] & { note?: TimelineNote })[] = [];
  (people.runsByTask.get(task.id) ?? []).forEach((run) => {
    runEvents(run).forEach((source) => {
      const note = noted.get(source.key);
      noted.delete(source.key);
      runs.push(note ? { ...source, note } : source);
    });
  });
  const sources = [
    ...logs,
    ...runs,
    ...Array.from(noted, ([key, note]) => ({ key, at: note.at, note })),
  ].sort(byTime);
  const standing = standingRecord(control);
  const events: TimeEvent[] = [];
  for (const source of sources) {
    const event = { key: source.key, at: Date.parse(("note" in source ? source.note?.at : undefined) ?? source.at),
      source: "note" in source && source.note && standing(source.note.id) === "stopped" ? { ...source, stopped: true } : source };
    if (Number.isFinite(event.at)) events.push(event);
  }
  const segments: TimeHistoryBase["segments"] = [];
  for (const run of people.runsByTask.get(task.id) ?? []) {
    if (!run.startedAt) continue;
    const span = runSpan(run, null);
    const member = people.placements.get(run.placementId)?.responsible === false;
    if (span) segments.push({ from: span.from, to: span.to, kind: member ? "member" : "work" });
  }
  // A Run is in the window once it has ended, and on the row while it runs. Either may be read first: an ended Run is
  // ended, so the window's word wins.
  const ended = new Set<string>();
  for (const [run, from, to] of below) {
    ended.add(run);
    segments.push({ from, to, kind: "below" });
  }
  for (const [run, from] of control.runsBelow ?? []) if (!ended.has(run)) segments.push({ from, to: null, kind: "below" });
  let waitingFrom: number | null = null;
  let openWaitKind: "review" | "held" | "stuck" = "review";
  for (const log of control.stateLog) {
    const at = Date.parse(log.causeAt ?? log.at);
    if (!Number.isFinite(at) || log.toState === null) continue;
    if (waitingFrom !== null && at > waitingFrom)
      segments.push({ from: waitingFrom, to: at, kind: openWaitKind });
    waitingFrom = log.toState === "waiting" || log.toState === "held" || log.toState === "error" ? at : null;
    if (waitingFrom !== null) openWaitKind = log.toState === "held" ? "held" : log.toState === "error" ? "stuck" : "review";
  }
  if (waitingFrom !== null) segments.push({ from: waitingFrom, to: null, kind: openWaitKind });
  // A stopped task ends where it was stopped, as a done one ends where it was done.
  const doneAt = isFinished(control.state) ? stateSince(control) : null;
  const end = doneAt ? Date.parse(doneAt) : null;
  // Find the start without copying the full history or spreading it as function arguments.
  const created = Date.parse(task.createdAt ?? control.createdAt ?? "");
  let first = Number.isFinite(created) ? created : Infinity;
  for (const event of events) if (Number.isFinite(event.at)) first = Math.min(first, event.at);
  for (const segment of segments) if (isHand(segment) && Number.isFinite(segment.from)) first = Math.min(first, segment.from);
  return { taskId: task.id, start: Number.isFinite(first) ? first : null, end: end !== null && Number.isFinite(end) ? end : null,
    events, segments };
}

/** Only unclosed intervals need the clock. A wholly historical row keeps its identity between ticks. */
export function projectTimeHistory(base: TimeHistoryBase | null, now: number): TaskHistory | null {
  if (!base) return null;
  if (base.start !== null && base.segments.every((segment) => segment.to !== null)) return base as TaskHistory;
  const segments: Segment[] = [];
  base.segments.forEach((segment) => {
    if (segment.to !== null) segments.push({ ...segment, to: segment.to });
    else if (now >= segment.from) segments.push({ ...segment, to: now, open: true });
  });
  return { ...base, start: base.start ?? now, segments };
}
