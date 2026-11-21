import type { Task } from "@/data/types";

/**
 * What an empty History says in place of its rows: where the task stands before anything is recorded, and what makes
 * it move. The words for each kind are the reader's `reportFeed.empty.<kind>`.
 *   unowned  no owner yet: nothing moves until someone is asked
 *   idle     it has an owner, but no request has reached it
 * Only a task not started can have an empty History: a request, a hold or a start order each leave a row of their own,
 * which says it better. null for anything else. The feed shows it only once History is read whole with no row, and not
 * beside the row of work going on.
 */
export type EmptyHistory = "unowned" | "idle";

export function emptyHistory(task: Pick<Task, "kind" | "state">, owned: boolean): EmptyHistory | null {
  if (task.kind !== "task" || task.state !== "todo") return null;
  return owned ? "idle" : "unowned";
}
