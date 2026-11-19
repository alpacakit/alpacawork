/** Prepare own and subtree Run time for display clocks. */
import { runSpan } from "@alpacawork/contract";
import type { ControlRunDTO } from "@alpacawork/contract/control";
import type { TaskIndex } from "./tasks";
import { isRunMoving } from "@alpacawork/contract/run";

type UsageParts = { doneMs: number; moving: readonly ControlRunDTO[] };

/** One task's completed time and moving Runs, regardless of their placement's role. */
function ownUsage(taskId: string, index: TaskIndex, runsByTask: ReadonlyMap<string, readonly ControlRunDTO[]>): UsageParts {
  const saved = index.byId.get(taskId)?.usage;
  const runs = runsByTask.get(taskId) ?? [];
  if (saved != null) return { doneMs: saved.runMs, moving: runs.filter(run => isRunMoving(run.state)) };
  const moving: ControlRunDTO[] = [];
  let doneMs = 0;
  runs.forEach(run => {
    if (isRunMoving(run.state)) { moving.push(run); return; }
    // Nonmoving Runs cannot have an open clock interval, so this total is independent of now.
    const span = runSpan(run, 0);
    if (span && span.to !== null) doneMs += span.to - span.from;
  });
  return { doneMs, moving };
}

/** Finished Run time plus the starts of Runs still running; the clock adds the rest. */
export type WorkTime = { doneMs: number; runningSince: readonly number[] };

export function taskWorkTime(taskId: string, index: TaskIndex, runsByTask: ReadonlyMap<string, readonly ControlRunDTO[]>): { own: WorkTime; subtree: WorkTime } {
  const own = ownUsage(taskId, index, runsByTask);
  const task = index.byId.get(taskId);
  const below = task?.usageBelow;
  const belowRunningSince = (task?.runsBelow ?? []).map(([, from]) => from);
  let ownDoneMs = own.doneMs;
  let subtreeDoneMs = own.doneMs + (below == null ? 0 : below.runMs);
  const runningSince: number[] = [];
  for (const run of own.moving) {
    const span = runSpan(run, null);
    if (!span) continue;
    if (span.to === null) runningSince.push(span.from);
    else {
      const duration = span.to - span.from;
      ownDoneMs += duration;
      subtreeDoneMs += duration;
    }
  }
  return { own: { doneMs: ownDoneMs, runningSince },
    subtree: { doneMs: subtreeDoneMs, runningSince: [...runningSince, ...belowRunningSince] } };
}

export function workTimeMs(time: WorkTime, now: number): number {
  return time.runningSince.reduce((total, since) => total + Math.max(0, now - since), time.doneMs);
}
