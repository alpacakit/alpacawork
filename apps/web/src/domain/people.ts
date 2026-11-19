import type { ProjectedIndexDTO, ControlRunDTO, PlacementDTO, TaskRowDTO, TaskProjectedTimelineDTO } from "@alpacawork/contract/control";
import { runFailureResolution } from "@alpacawork/contract/run";
import type { TimelineLog, TimelineRun } from "./history";

/**
 * People on tasks, read from the index. The
 * backend owns every rule about who is responsible and what a dot means
 * (`runtime.displayState`); this module only indexes, orders and counts what
 * it returned, so the tree, the map bar and the reader agree.
 */

type Crew = {
  /** The current responsible placement; null when the task has none. */
  responsible: PlacementDTO | null;
  /** Active placements other than the responsible one, in the order they started. */
  members: PlacementDTO[];
};
export type PeopleIndex = {
  tasks: ReadonlyMap<string, TaskRowDTO>;
  children: ReadonlyMap<string | null, TaskRowDTO[]>;
  placements: ReadonlyMap<string, PlacementDTO>;
  crews: ReadonlyMap<string, Crew>;
  runs: ReadonlyMap<string, ControlRunDTO>;
  runsByTask: ReadonlyMap<string, ControlRunDTO[]>;
  failuresByTask: ReadonlyMap<string, { run: ControlRunDTO; resolvedBy: ControlRunDTO | null }[]>;
  runsByPlacement: ReadonlyMap<string, ControlRunDTO[]>;
};

const byStart = (a: PlacementDTO, b: PlacementDTO) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id);
const runNumbers = new Intl.Collator(undefined, { numeric: true });
/** Request order: accepted time, then the Run ID, so equal times stay fixed. */
const byRequest = (a: ControlRunDTO, b: ControlRunDTO) =>
  a.createdAt.localeCompare(b.createdAt) || runNumbers.compare(a.id, b.id);

const emptyCrew: Crew = { responsible: null, members: [] };

const sameItems = <T,>(left: readonly T[], right: readonly T[]) =>
  left.length === right.length && left.every((item, index) => item === right[index]);

/** Items by key, each list in the order given. */
function groupBy<T, K>(items: readonly T[], keyOf: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const list = groups.get(keyOf(item));
    if (list) list.push(item); else groups.set(keyOf(item), [item]);
  }
  return groups;
}

/** Lists whose items did not change stay the arrays they were, so what reads them is not drawn again. */
function keepLists<K, T>(lists: Map<K, T[]>, prior: ReadonlyMap<K, T[]> | undefined) {
  for (const [key, list] of lists) {
    const before = prior?.get(key);
    if (before && sameItems(list, before)) lists.set(key, before);
  }
}

export function indexPeople(tree: Pick<ProjectedIndexDTO, "tasks" | "placements" | "runs"> | ProjectedIndexDTO, previous?: PeopleIndex): PeopleIndex {
  const tasks = new Map<string, TaskRowDTO>();
  const children = new Map<string | null, TaskRowDTO[]>();
  for (const task of tree.tasks) {
    tasks.set(task.id, task);
    const siblings = children.get(task.parentId);
    if (siblings) siblings.push(task); else children.set(task.parentId, [task]);
  }
  keepLists(children, previous?.children);
  const placements = new Map<string, PlacementDTO>();
  const crews = new Map<string, Crew>();
  for (const placement of tree.placements) {
    placements.set(placement.id, placement);
    let crew = crews.get(placement.taskId);
    // Even an inactive placement establishes the task's crew and its input order.
    if (!crew) {
      crew = { responsible: null, members: [] };
      crews.set(placement.taskId, crew);
    }
    if (!placement.active) continue;
    if (placement.responsible) crew.responsible ??= placement;
    else crew.members.push(placement);
  }
  for (const [taskId, crew] of crews) {
    crew.members.sort(byStart);
    const prior = previous?.crews.get(taskId);
    if (prior && crew.responsible === prior.responsible && sameItems(crew.members, prior.members)) {
      crews.set(taskId, prior);
    }
  }
  const runs = new Map<string, ControlRunDTO>();
  const runsByPlacement = new Map<string, ControlRunDTO[]>();
  const runsByTask = new Map<string, ControlRunDTO[]>();
  // All three indexes read the same Runs; retain input order until the placement lists are sorted below.
  for (const run of tree.runs) {
    runs.set(run.id, run);
    const placementRuns = runsByPlacement.get(run.placementId);
    if (placementRuns) placementRuns.push(run); else runsByPlacement.set(run.placementId, [run]);
    const taskRuns = runsByTask.get(run.taskId);
    if (taskRuns) taskRuns.push(run); else runsByTask.set(run.taskId, [run]);
  }
  keepLists(runsByTask, previous?.runsByTask);
  for (const list of runsByPlacement.values()) list.sort(byRequest);
  keepLists(runsByPlacement, previous?.runsByPlacement);
  return {
    tasks, children, crews, runsByPlacement, runsByTask,
    failuresByTask: groupBy(runFailureResolution(tree.runs), (failure) => failure.run.taskId),
    placements,
    runs,
  };
}

const awaitingDecision = new WeakMap<PeopleIndex, string>();
const runsAwaitingDecision = (people: PeopleIndex) => {
  let known = awaitingDecision.get(people);
  if (known === undefined) {
    const ids: string[] = [];
    for (const run of people.runs.values()) if (run.state === "needs_review") ids.push(run.id);
    known = ids.join();
    awaitingDecision.set(people, known);
  }
  return known;
};
/**
 * All a Task's feed reads of the people: this Task's crew and Runs, and which Runs (a child's too) await a decision. An
 * update elsewhere changes neither, so it draws none of the feed's rows.
 */
export const sameForFeed = (a: PeopleIndex, b: PeopleIndex, taskId: string) => a === b || a.crews.get(taskId) === b.crews.get(taskId)
  && a.runsByTask.get(taskId) === b.runsByTask.get(taskId) && runsAwaitingDecision(a) === runsAwaitingDecision(b);

export const crewOf = (taskId: string, people: PeopleIndex): Crew => people.crews.get(taskId) ?? emptyCrew;

/** Responsible first, then members: the people currently placed on the task. */
export function placedOn(taskId: string, people: PeopleIndex): PlacementDTO[] {
  const crew = crewOf(taskId, people);
  return crew.responsible ? [crew.responsible, ...crew.members] : crew.members;
}

/** Chronology has only the Run and placement facts needed to draw intervals. */
export type TimeTaskRow = Omit<TaskRowDTO, "stateLog"> & { stateLog: TimelineLog[] };
export type TimePeopleIndex = {
  tasks: ReadonlyMap<string, TimeTaskRow>;
  placements: ReadonlyMap<string, TaskProjectedTimelineDTO["placements"][number]>;
  runsByTask: ReadonlyMap<string, TimelineRun[]>;
};
export function indexTimePeople(tasks: TimeTaskRow[], runs: TimelineRun[],
  placements: TaskProjectedTimelineDTO["placements"]): TimePeopleIndex {
  return { tasks: new Map(tasks.map(task => [task.id, task])),
    placements: new Map(placements.map(placement => [placement.id, placement])), runsByTask: groupBy(runs, run => run.taskId) };
}
