import type { TaskState } from '@alpacawork/raw';

type StateChange = { at: string; toState: TaskState | null };
type TaskStateInterval = { from: number; to: number; state: TaskState };

/** Explicit instructions to the responsible person begin a new estimate round; automatic returns do not. */
export const startsEstimateRound = (request: { purpose: string }, run: { role: string }): boolean =>
  request.purpose !== 'return_continuation' && run.role === 'owner';
/** The repository's derived classification is preserved across every public projection. */
export const invalidatesEstimate = (entry: { startsEstimateRound?: boolean }): boolean =>
  entry.startsEstimateRound === true;

/** Task state, not Run lifetime, owns the clock used by a reported estimate. */
export function taskStateIntervals(log: readonly StateChange[], until: number): TaskStateInterval[] {
  const intervals: TaskStateInterval[] = [];
  let state: TaskState = 'todo';
  for (let index = 0; index < log.length; index++) {
    const entry = log[index]!;
    const from = Date.parse(entry.at);
    if (!Number.isFinite(from)) continue;
    if (entry.toState !== null) state = entry.toState;
    const next = index + 1 < log.length ? Date.parse(log[index + 1]!.at) : until;
    if (Number.isFinite(next) && next > from)
      intervals.push({ from, to: Math.min(next, until), state });
  }
  return intervals;
}

export function taskStateMinutes(intervals: readonly TaskStateInterval[], from: number, to: number,
  state: TaskState): number {
  return intervals.reduce((sum, interval) => interval.state === state
    ? sum + Math.max(0, Math.min(to, interval.to) - Math.max(from, interval.from)) : sum, 0) / 60_000;
}
