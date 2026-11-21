import type { Task } from "@/data/types";

/**
 * Where a task stands before its first report, as History says it at its top:
 *   unassigned  no AI owner yet: History says it waits for one, and that sending what to do from the input brings one
 *   assigned    an AI owner is placed: History shows it at work from then on, as it does a Run at work
 * Only a task not started is before its first report. null for anything else.
 */
export type BeforeWork = "unassigned" | "assigned";

export function beforeWork(task: Pick<Task, "kind" | "state">, owned: boolean): BeforeWork | null {
  if (task.kind !== "task" || task.state !== "todo") return null;
  return owned ? "assigned" : "unassigned";
}
