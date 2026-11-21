import { useWorkspaceInfo } from "@/data/queries";
import { useViewStore } from "@/state/view-store";
import { GuideLine } from "./Guide";
import { useGuide } from "./use-guide";

/**
 * The guide over a list that holds Tasks, while the guide has something to say there. With no Task in view (a search's
 * list) the guide is the welcome's to show, not this line's.
 */
export function ListGuide() {
  const project = useViewStore((state) => state.project);
  const tasks = useWorkspaceInfo((info) => info.counts.tasks[project ?? "root"] ?? 0);
  return tasks > 0 ? <ListGuideLine tasks={tasks} /> : null;
}
function ListGuideLine({ tasks }: { tasks: number }) {
  const step = useGuide(tasks);
  return step ? <GuideLine step={step} /> : null;
}
