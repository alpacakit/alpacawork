import type { Task } from "@/data/types";

/**
 * Where a task stands before its first report, as History says it at its top:
 *   unassigned  no AI owner yet: History says it has not started, and that sending what to do from the input starts it
 *   assigned    an AI owner is placed: History shows it at work from then on, as it does a Run at work
 * Only a task not started is before its first report, and one waiting for others to finish first is not at work. null for
 * anything else.
 */
export type BeforeWork = "unassigned" | "assigned";

export function beforeWork(task: Pick<Task, "kind" | "state" | "startOrder">, owned: boolean): BeforeWork | null {
  if (task.kind !== "task" || task.state !== "todo") return null;
  // Waiting for other tasks to finish first, it is not at work: its start order row says what it waits for.
  if (owned && task.startOrder?.waiting) return null;
  return owned ? "assigned" : "unassigned";
}
