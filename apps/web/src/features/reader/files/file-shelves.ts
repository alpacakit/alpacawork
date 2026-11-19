import { useMemo } from "react";
import { useWorkspaceInfo } from "@/data/queries";
import { fileShelves, type FileShelves, type ShelvedTask } from "@/domain/task-files";

/** The task's files sorted into deliverables and work files (fileShelves), as its tab, chips and lists read them. */
export function useFileShelves(task: ShelvedTask | undefined): FileShelves | undefined {
  const root = useWorkspaceInfo(info => info.root);
  return useMemo(() => task && fileShelves(task, root, location.origin), [task, root]);
}
