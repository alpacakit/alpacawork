/** Prepare own and subtree Run time for display clocks. */
import { runUsage, sumUsage, TOKEN_COUNTER_KEYS, type TokenCounters } from "@alpacawork/contract";
import type { ControlRunDTO } from "@alpacawork/contract/control";
import type { TaskIndex } from "./tasks";

/** Recorded elapsed time plus the starts of live Runs; the display clock adds the time still passing. */
export type WorkTime = { doneMs: number; runningSince: readonly number[] };

export function taskWorkTime(taskId: string, index: TaskIndex, runsByTask: ReadonlyMap<string, readonly ControlRunDTO[]>): { own: WorkTime; subtree: WorkTime } {
  const task = index.byId.get(taskId);
  const runs = runsByTask.get(taskId) ?? [];
  const doneMs = task?.usage?.runMs ?? sumUsage(runs, null).runMs;
  const runningSince = runs.flatMap(run => {
    const usage = runUsage(run);
    return usage?.live ? [usage.started] : [];
  });
  const below = task?.usageBelow;
  const belowRunningSince = (task?.runsBelow ?? []).map(([, from]) => from);
  return { own: { doneMs, runningSince },
    subtree: { doneMs: doneMs + (below?.runMs ?? 0), runningSince: [...runningSince, ...belowRunningSince] } };
}

export function workTimeMs(time: WorkTime, now: number): number {
  return time.runningSince.reduce((total, since) => total + Math.max(0, now - since), time.doneMs);
}

type SavedUsage = { tokens: TokenCounters | null; tokensUnknown: number } | null | undefined;
/** Recorded tokens on a task and the tasks under it, and how many of those Runs recorded none. */
export function subtreeTokens(own: SavedUsage, below: SavedUsage): { tokens: TokenCounters | null; unknown: number } {
  let tokens: TokenCounters | null = null, unknown = 0;
  for (const usage of [own, below]) {
    if (!usage) continue;
    unknown += usage.tokensUnknown;
    if (!usage.tokens) continue;
    tokens ??= { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    for (const key of TOKEN_COUNTER_KEYS) tokens[key] += usage.tokens[key];
  }
  return { tokens, unknown };
}
