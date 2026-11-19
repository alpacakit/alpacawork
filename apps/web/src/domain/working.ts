import { isFinished } from "@alpacawork/contract/branch";
import type { ControlRunDTO } from "@alpacawork/contract/control";
import { isRunMoving } from "@alpacawork/contract/run";
import type { PeopleIndex } from "./people";

/**
 * The Task's people at work now: each placement's moving Run, the responsible person's first. Read as the Task's Runs
 * are, whatever its state: the open Task's own Runs are always read with it, so a member at work on a finished Task
 * is shown.
 */
export function working(taskId: string, people: PeopleIndex): ControlRunDTO[] {
  const byPlacement = new Map<string, ControlRunDTO>();
  for (const run of people.runsByTask.get(taskId) ?? []) {
    if (!run.startedAt || run.endedAt || !isRunMoving(run.state)) continue;
    const held = byPlacement.get(run.placementId);
    if (!held || held.state !== "running" || run.state === "running") byPlacement.set(run.placementId, run);
  }
  const lead = (run: ControlRunDTO) => people.placements.get(run.placementId)?.responsible ? 0 : 1;
  return [...byPlacement.values()].sort((a, b) => lead(a) - lead(b));
}

/** One Task under the open one where someone runs now: its path from the open Task, and its running Runs, latest first. */
export type ChildWork = { id: string; path: string[]; title: string; runs: ControlRunDTO[] };

/**
 * The Tasks under the open one where someone works now, each read as its own people are (working) unless it is
 * finished, in one order for the
 * row folded or not: children before grandchildren and so on down, and at one depth the latest started first. One line
 * per Task, so a Task with two people working is one line saying so: Tasks, not people, are counted.
 */
export function childWork(taskId: string, people: PeopleIndex): ChildWork[] {
  const work: ChildWork[] = [];
  const walk = (parentId: string, path: string[]) => {
    for (const child of people.children.get(parentId) ?? []) {
      // Only the Tasks the live index holds are at work below: a finished child is not, whatever Run of it is still
      // closing and whether or not this screen has read its view. What is under it is read as before.
      const runs = isFinished(child.state) ? [] : working(child.id, people);
      if (runs.length) work.push({ id: child.id, path: [...path, child.id], title: child.title, runs });
      walk(child.id, [...path, child.id]);
    }
  };
  walk(taskId, []);
  // Children before grandchildren, and so on down; at one depth, the latest started first. Folded or not, one order.
  work.sort((a, b) => a.path.length - b.path.length || b.runs[0]!.startedAt!.localeCompare(a.runs[0]!.startedAt!));
  return work;
}
