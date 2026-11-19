import type { Task } from "@/data/types";
import { crewOf, type PeopleIndex } from "./people";

/**
 * The title of the current responsible person's latest report in this round (a report from an earlier round is not
 * what the owner is doing now); null when it has none. Written for the reader, unlike a run's passing words.
 */
function ownerReport(task: Task, people: PeopleIndex, ownerId: string, roundStart: number): { at: string; text: string } | null {
  for (let i = task.stateLog.length - 1; i >= 0; i--) {
    const entry = task.stateLog[i]!;
    if (entry.kind === "reported" && entry.title?.trim() && entry.runId &&
      people.runs.get(entry.runId)?.placementId === ownerId && Date.parse(entry.at) >= roundStart) {
      return { at: entry.at, text: entry.title.trim() };
    }
  }
  return null;
}

/** Words from this task's current responsible person, never from its members or child tasks. */
export function currentWords(task: Task, people: PeopleIndex): { at: string; text: string } | null {
  const owner = crewOf(task.id, people).responsible;
  if (!owner || task.state !== "doing") return null;
  const runs = people.runsByPlacement.get(owner.id) ?? [];
  let roundStart = -Infinity, noteAt = -Infinity;
  let note: { at: string; text: string } | null = null;
  for (const run of runs) {
    if (run.startedAt) roundStart = Math.max(roundStart, Date.parse(run.startedAt));
    const candidate = run.state === "running" ? run.activity?.note : null;
    if (!candidate) continue;
    const at = Date.parse(candidate.at);
    // Equal times keep the first Run's note.
    if (!note || at > noteAt) { note = candidate; noteAt = at; }
  }
  const report = ownerReport(task, people, owner.id, roundStart);
  if (report && (!note || Date.parse(report.at) >= noteAt)) return report;
  return note;
}
