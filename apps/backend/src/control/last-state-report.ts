import type { TaskLog } from '@alpacawork/raw';

/** The last explicit state report from one Run at the requested read point, in repository order. */
export function lastStateReport(log: readonly TaskLog[], runId: string, until?: number): TaskLog | null {
  for (let index = log.length - 1; index >= 0; index--) {
    const entry = log[index]!;
    if (entry.kind === 'reported' && entry.runId === runId && entry.toState !== null &&
      (until === undefined || Date.parse(entry.at) <= until)) return entry;
  }
  return null;
}
