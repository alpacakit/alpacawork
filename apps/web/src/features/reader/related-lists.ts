import type { Task } from "@/data/types";
import type { TaskIndex } from "@/domain/tasks";
import { startOrderOf, waitersOf } from "@/domain/start-order";
import { familyRoot, familySize } from "./family";

/** Which related lists this task has, and their entry counts: shared by the entries and the open surface.
 * A tree already open still shows a lone root, although a lone task has no tree entry. */
export function relatedListsOf(task: Task, index: TaskIndex) {
  const root = familyRoot(task.id, index);
  const count = root ? familySize(root.id, index) : 0;
  const after = startOrderOf(task, index)?.after.length ?? 0;
  const waiters = waitersOf(task.id, index).length;
  return {
    family: root ? { count, entry: count >= 2, root } : null,
    dependencies: after + waiters ? { count: after + waiters, entry: true } : null,
  };
}
