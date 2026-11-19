/** The orders Tasks are listed in: by when each last moved, and by number. Only the facts they read; independent of storage and screen DTOs. */
type MovedTask = { id: string; parentId: string | null; updatedAt: string | null };
type MovedRun = { taskId: string; state: string; startedAt: string | null; endedAt: string | null };

/**
 * When each Task last changed: its latest durable record or Run start/end, including descendants so a parent
 * moves with its children. Running work has no priority over newer changes. Output/activity, elapsed clocks,
 * presence and personal read marks are not task changes and never enter this calculation.
 * Every list and search uses this timestamp, latest first.
 */
export function movedAt(tasks: Iterable<MovedTask>, runs: Iterable<MovedRun>): Map<string, number> {
  const all = [...tasks];
  const own = new Map(all.map(task => [task.id, Date.parse(task.updatedAt ?? '') || 0]));
  for (const run of runs) {
    const startedAt = Date.parse(run.startedAt ?? '') || 0;
    const at = Math.max(Date.parse(run.endedAt ?? '') || 0, startedAt);
    if (at > (own.get(run.taskId) ?? Infinity)) own.set(run.taskId, at);
  }
  const children = new Map<string | null, MovedTask[]>();
  for (const task of all) children.set(task.parentId, [...(children.get(task.parentId) ?? []), task]);
  const out = new Map<string, number>();
  const walk = (task: MovedTask): number => {
    const at = Math.max(own.get(task.id) ?? 0, ...(children.get(task.id) ?? []).map(walk));
    out.set(task.id, at);
    return at;
  };
  // A scoped/loaded list can omit the project above it; its boundary Tasks are roots of this calculation too.
  all.filter(task => task.parentId === null || !own.has(task.parentId)).forEach(walk);
  return out;
}

// Reuse the locale/options lookup across comparisons, including server-side list sorts.
const taskNumbers = new Intl.Collator('en', { numeric: true });
/** The order Tasks are made in: by number, T2 before T10. */
export const byTaskNumber = (a: { id: string }, b: { id: string }) => taskNumbers.compare(a.id, b.id);

/** Latest-moved first; Tasks that moved at the same time in the order they were made. */
export const byMoved = (moved: ReadonlyMap<string, number>) => (a: { id: string }, b: { id: string }) =>
  (moved.get(b.id) ?? 0) - (moved.get(a.id) ?? 0) || byTaskNumber(a, b);
