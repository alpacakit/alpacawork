import type { ProjectShelfInfo } from "@alpacawork/contract/control";
import type { TaskState } from "@/data/types";

/** What restoring acts on: the outermost archived project the server names (`shelf.restoreTarget`), with its hash. */
export type ShelfTarget = NonNullable<ProjectShelfInfo["restoreTarget"]>;
/**
 * Why serve refused to archive, as the caller read it from the refusal: the Tasks still at work below
 * (`tasks_below_still_at_work`) and the unfinished Runs (`task_has_unfinished_runs`). A title or state is given only
 * where the caller already holds that Task's row.
 */
export type ArchiveRefusal = { tasks: { id: string; title?: string; state?: TaskState }[]; runs: string[] };
