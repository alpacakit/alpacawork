/**
 * A # or / list has one chosen place. The # list holds the projects (a row of their labels on top) and the tasks
 * under them, as one list. What is chosen as the list changes is the one rule here: a project the words name (its
 * P-number in full, or the start of its name from two characters on, so one character typed while looking for a task
 * does not take a project); else the item already chosen, while it is still listed; else the first task (the one the
 * detail panel shows leads the tasks), or the first item when there is none.
 */
export type Choice = { id: string; project?: { name: string } };

const fold = (s: string) => s.normalize('NFKC').toLowerCase();

export function choose(items: readonly Choice[], query: string, kept?: string): number {
  const typed = fold(query.trim());
  const named = items.findIndex(({ id, project }) => project && (fold(id) === typed || (typed.length >= 2 && fold(project.name).startsWith(typed))));
  if (named >= 0) return named;
  const still = kept === undefined ? -1 : items.findIndex(item => item.id === kept);
  if (still >= 0) return still;
  const task = items.findIndex(item => !item.project);
  return task >= 0 ? task : 0;
}

/**
 * ← and → move along the project row while a project is chosen, and stop at its ends; while a task is chosen they are
 * the caret's (null).
 */
export function sideways(items: readonly Choice[], index: number, step: -1 | 1): number | null {
  if (!items[index]?.project) return null;
  const next = index + step;
  return items[next]?.project ? next : index;
}
