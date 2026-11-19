import type { StateLogEntryDTO, TaskRowDTO } from "@alpacawork/contract/control";
import { invalidatesEstimate, taskStateIntervals, taskStateMinutes } from "@alpacawork/contract";

export type TaskEstimate = {
  /** What the latest report declared, and the working time since it. */
  minutes: number;
  usedMinutes: number;
  remainingMinutes: number;
  /** An instruction came after it, so it waits for an update. */
  pending: boolean;
};

/**
 * The report log is the sole source of an estimate; state intervals stop the work clock while waiting. The row's log
 * keeps every entry this reads: state changes, estimates and instructions to the responsible person.
 */
export function estimateOf(row: Pick<TaskRowDTO, "stateLog">, now: number): TaskEstimate | null {
  const log = row.stateLog;
  let latest: StateLogEntryDTO | undefined;
  for (let index = log.length - 1; index >= 0; index--) {
    const entry = log[index]!;
    if (entry.kind === "reported" && entry.estimateMinutes !== undefined) {
      latest = entry;
      break;
    }
  }
  if (!latest || latest.estimateMinutes === undefined) return null;
  const usedMinutes = taskStateMinutes(taskStateIntervals(log, now), Date.parse(latest.at), now, "doing");
  return { minutes: latest.estimateMinutes, usedMinutes, remainingMinutes: latest.estimateMinutes - Math.floor(usedMinutes),
    pending: log.slice(log.indexOf(latest) + 1).some(invalidatesEstimate) };
}
