import { useMemo } from "react";
import { useViewStore } from "@/state/view-store";
import { useProjects } from "./queries";
import type { WorkspaceInfo } from "./types";

/** What a project's mark is drawn from: its name and its colour (`settings.color`, `#rrggbb`). */
export type ProjectMark = { id: string; name: string; color: string };

/** Every listed project's mark, by its ID. */
export function useProjectMarks(): ReadonlyMap<string, ProjectMark> {
  const projects = useProjects();
  return useMemo(() => {
    const marks = new Map<string, ProjectMark>();
    for (const { id, title, color } of projects) marks.set(id, { id, name: title, color });
    return marks;
  }, [projects]);
}

/** Whether a view holds two projects or more: all of them, or the one in view and those nested in it. */
function hasMultipleProjectsInView(project: string | null, projects: WorkspaceInfo["projects"]): boolean {
  if (project === null) return projects.length > 1;
  const parent = new Map<string, string | null>();
  for (const { id, parentId } of projects) parent.set(id, parentId);
  const within = (id: string | null): boolean => id !== null && (id === project || within(parent.get(id) ?? null));
  let found = false;
  for (const { id } of projects) {
    if (!within(id)) continue;
    if (found) return true;
    found = true;
  }
  return false;
}

/**
 * Whether the places that say which project a Task is in draw its mark (design v2 §4): a list row, the list's name, the
 * reader's path. They do when the view holds two projects or more; with one, every Task is that project's. The places
 * that show a project itself (the project menu, a label and its card) draw it always.
 */
export function useMarksTasks(): boolean {
  const projects = useProjects();
  const project = useViewStore((state) => state.project);
  return useMemo(() => hasMultipleProjectsInView(project, projects), [project, projects]);
}
