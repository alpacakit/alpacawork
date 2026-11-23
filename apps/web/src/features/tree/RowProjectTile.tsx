import { ProjectTile } from "@/components/ui/project-tile";
import { useMarksTasks, useProjectMarks } from "@/data/project-marks";

/**
 * A list row's project, before its ID, when the list holds more than one project (useMarksTasks). A reader hears
 * its name with the row, before the row's own ID; the row's press lies over it, so it has no hover of its own.
 */
export function RowProjectTile({ project, className }: { project: string; className?: string }) {
  const shows = useMarksTasks();
  const mark = useProjectMarks().get(project);
  if (!shows || !mark) return null;
  return <ProjectTile name={mark.name} color={mark.color} size={16} label={mark.name} quiet className={className} />;
}
