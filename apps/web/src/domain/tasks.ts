import { currentTransition } from "@alpacawork/contract/control";
import { byTaskNumber } from "@alpacawork/contract/moved";
import { parseTaskId } from "@alpacawork/contract";
import type { Task } from "@/data/types";
import type { TimelineLog } from "./history";
import type { ProjectedIndexDTO } from "@alpacawork/contract/control";

/**
 * Pure rules about tasks that more than one part of the screen needs.
 */
export type TaskIndex = {
  /** The list's tasks: the work. A project Task is not one of them (the project menu lists it). */
  tasks: Task[];
  /** Every task by its ID, a project Task too: a reference, a URL or a notice may name one. */
  byId: Map<string, Task>;
  /** Children in ID order (T2 before T10); `null` holds the roots, the work right under its project. */
  children: Map<string | null, Task[]>;
  roots: Task[];
  /** Reverse start-order edges, built once with this index; each row only looks up its waiters. */
  waitersByTask: ReadonlyMap<string, Task[]>;
  childCounts?: ProjectedIndexDTO["counts"]["children"];
};

export function indexTasks(tasks: Task[], childCounts?: TaskIndex["childCounts"]): TaskIndex {
  const byId = new Map<string, Task>();
  const work: Task[] = [];
  const children = new Map<string | null, Task[]>();
  for (const task of tasks) {
    byId.set(task.id, task);
    if (task.kind !== "task") continue;
    work.push(task);
    const siblings = children.get(task.parent);
    if (siblings) siblings.push(task); else children.set(task.parent, [task]);
  }
  const waitersByTask = new Map<string, Task[]>();
  for (const task of byId.values()) if (task.startOrder?.waiting) for (const after of task.startOrder.after) {
    if (after.finished) continue;
    const waiters = waitersByTask.get(after.task);
    if (waiters) waiters.push(task); else waitersByTask.set(after.task, [task]);
  }
  for (const list of children.values()) list.sort(byTaskNumber);
  return { tasks: work, byId, children, roots: children.get(null) ?? [], childCounts, waitersByTask };
}

/** A URL names a Task by its ID (`T14`), as a text does (`resolveReference`); an address of any other form names none. */
export const taskAtAddress = (address: string, index: TaskIndex): Task | undefined => index.byId.get(address);

type ProjectIndex = { byId: ReadonlyMap<string, Pick<Task, "projectId">>; projects: readonly Pick<ProjectedIndexDTO["projects"][number], "id" | "parentId">[] };

/**
 * Whether `id` is in `project`'s part of the list: the project its row names (`projectId`, the server's) is that
 * project or one nested in it, as the index lists the projects. Every project (null) holds every task. A task's
 * parents are not walked: its row says where it belongs.
 */
export function withinProject(id: string, project: string | null, index: ProjectIndex): boolean {
  if (project === null) return true;
  const parentOf = (at: string) => index.projects.find((item) => item.id === at)?.parentId ?? null;
  let at = index.byId.get(id)?.projectId ?? null;
  while (at !== null && at !== project) at = parentOf(at);
  return at !== null;
}

/** One list pass shares the membership answer for tasks in the same project. */
export function withinProjectFilter(project: string | null, index: ProjectIndex): (id: string) => boolean {
  const membership = new Map<string, boolean>();
  return (id) => {
    if (project === null) return true;
    const ownProject = index.byId.get(id)?.projectId;
    if (ownProject === undefined) return false;
    let found = membership.get(ownProject);
    if (found === undefined) {
      found = withinProject(id, project, index);
      membership.set(ownProject, found);
    }
    return found;
  };
}

export function childrenOf(id: string, index: TaskIndex): Task[] {
  return index.children.get(id) ?? [];
}

/** Every task below `id`, depth first. */
export function descendants(id: string, index: TaskIndex): Task[] {
  const list: Task[] = [];
  const walk = (parent: string) => {
    for (const child of childrenOf(parent, index)) {
      list.push(child);
      walk(child.id);
    }
  };
  walk(id);
  return list;
}

/** From the root down to `id` itself. */
export function pathTo(id: string, index: TaskIndex): Task[] {
  const list: Task[] = [];
  let task = index.byId.get(id);
  while (task) {
    list.push(task);
    task = task.parent ? index.byId.get(task.parent) : undefined;
  }
  return list.reverse();
}

type TimedTask = { state: Task["state"]; stateLog: TimelineLog[] };

export const stateSince = (task: TimedTask): string | null => {
  const transition = currentTransition(task);
  return transition?.causeAt ?? transition?.at ?? null;
};
export { finishedBy } from "@alpacawork/contract/control";

/** One choice of the state popup: a direct state report by the person. */
export type StateChoice = "approve" | "hold" | "unhold" | "stop";
/** The state each choice reports. Restore has none of its own: it reports the state the hold kept. */
export const REPORT_STATE = { approve: "done", hold: "held", stop: "stopped" } as const satisfies Record<Exclude<StateChoice, "unhold">, string>;
/**
 * What the user may report directly from a task's state popup, the only list the popup reads: Review OK while it
 * awaits their review (a held one too), Hold when it may be held, Restore while held, and Stop while it is unfinished.
 * The server policy supplies candidates; the state report carries out the
 * choice, and the server refuses what it may not do.
 */
export function stateChoices(task: Pick<Task, "allowedActions">): StateChoice[] {
  const labels = { confirm: "approve", hold: "hold", unhold: "unhold", stop: "stop" } as const;
  return (["confirm", "hold", "unhold", "stop"] as const).filter(action => task.allowedActions.includes(action)).map(action => labels[action]);
}

/**
 * Finished children of a task at work, for "Done 2/8", as the server counts them (counts.children): a task the projection
 * lists no children of has none. Stopped children are not in the total.
 */
export function childProgress(id: string, index: TaskIndex): { done: number; total: number } {
  const count = index.childCounts?.[id];
  return { done: count?.states.done ?? 0, total: (count?.live ?? 0) + (count?.states.done ?? 0) };
}

/** A reference names an ID, regardless of list membership. Titles are only those already read. */
export const resolveReference = (reference: string, index?: Pick<TaskIndex, 'byId'>): Pick<Task, 'id' | 'title'> | undefined =>
  parseTaskId(reference) ? index?.byId.get(reference) ?? { id: reference, title: '' } : undefined;
