import type { Task } from "@/data/types";
import { childrenOf, descendants, pathTo, type TaskIndex } from "@/domain/tasks";
import { panelPosition } from "./reader-panel";

/**
 * The parent and child tasks of a task, as the panel under its title shows them. The family is the tree of the
 * work right under the task's project (`root`), so a grandchild opened by its own link still shows where it sits. This
 * file owns the panel's rules; FamilyTree draws them.
 */

/** The work right under the project that `id` is in: the family's root. */
export const familyRoot = (id: string, index: TaskIndex): Task | undefined => pathTo(id, index)[0];

/**
 * How many tasks the family holds, its root included; one means there is no family to show. The server counts every
 * active task under the root (`below`), finished ones too, which the live index does not hold until their pages are read.
 */
export const familySize = (root: string, index: TaskIndex): number =>
  1 + (index.childCounts?.[root]?.below ?? descendants(root, index).length);

/**
 * Whether `id` has children to show: the server's count of its active children, live and finished, else those the index
 * holds. A branch whose children are all finished has none in the live index until its finished page is read.
 */
export function hasChildren(id: string, index: TaskIndex): boolean {
  const count = index.childCounts?.[id];
  return (count ? count.live + count.finished : 0) > 0 || childrenOf(id, index).length > 0;
}

/**
 * A branch's finished children: how many the server counts (`count`), and whether every child it counts under the
 * branch has joined the list by now (`joined`): the list's way back to where it was waits for those still coming.
 */
export function finishedChildren(id: string, index: TaskIndex): { count: number; joined: boolean } {
  const counted = index.childCounts?.[id];
  const count = counted?.finished ?? 0;
  return { count, joined: childrenOf(id, index).length >= (counted?.live ?? 0) + count };
}

/** Rows a level shows before "N more"; the branch toward the task being read is always among them. */
export const FAMILY_LEVEL_CAP = 8;

/** Indent stops at this many levels; a deeper row says how many levels it is below the root instead. */
export const FAMILY_INDENT_CAP = 3;

/**
 * What the panel remembers of a family while the page lives, by its root: branches the person opened or folded
 * (`folds`), levels shown whole (`more`), its shared panel scroll position, and the task that was being read when it was
 * last opened (`at`). Opening and folding are the person's; the reader's own history keeps its own scroll.
 */
export type FamilyShape = { folds: Map<string, boolean>; more: Set<string>; position: { scroll: number }; at: string | null };
const shapes = new Map<string, FamilyShape>();
export function familyShape(root: string): FamilyShape {
  let shape = shapes.get(root);
  if (!shape) shapes.set(root, shape = { folds: new Map(), more: new Set(), position: panelPosition("family", root), at: null });
  return shape;
}
/** Tests start from no memory. */
export function forgetFamilyShapes() { shapes.clear(); }

/**
 * The one rule the panel follows each time it opens on `current`: the branches the person saw stay as they were (when
 * the task being read changed, the way to the one read before stays open), and the way to `current` is always open,
 * even if the person folded it before. A branch nobody chose is open when it leads to `current`.
 */
export function openOn(shape: FamilyShape, current: string, index: TaskIndex) {
  if (shape.at && shape.at !== current && index.byId.has(shape.at))
    for (const { id } of pathTo(shape.at, index)) if (hasChildren(id, index) && !shape.folds.has(id)) shape.folds.set(id, true);
  for (const { id } of pathTo(current, index)) shape.folds.delete(id);
  shape.at = current;
}

/** Whether a branch is open: the person's choice, else open when it leads to the task being read. */
export function branchOpen(shape: FamilyShape, id: string, current: string, index: TaskIndex): boolean {
  const choice = shape.folds.get(id);
  return choice ?? pathTo(current, index).some((task) => task.id === id);
}

/**
 * The children a level shows: the first `FAMILY_LEVEL_CAP`, or all once the person asked for the rest, with the branch
 * toward `current` always among them; `rest` is how many are left out.
 */
export function shownChildren(shape: FamilyShape, parent: string, current: string, index: TaskIndex): { shown: Task[]; rest: number } {
  const kids = childrenOf(parent, index);
  if (shape.more.has(parent) || kids.length <= FAMILY_LEVEL_CAP) return { shown: kids, rest: 0 };
  const onWay = new Set<string>();
  for (const task of pathTo(current, index)) onWay.add(task.id);
  const shown = kids.slice(0, FAMILY_LEVEL_CAP);
  const toward = kids.find((kid) => onWay.has(kid.id));
  if (toward && !shown.includes(toward)) shown[FAMILY_LEVEL_CAP - 1] = toward;
  return { shown, rest: kids.length - shown.length };
}
