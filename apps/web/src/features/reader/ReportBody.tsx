import { useQuery } from "@tanstack/react-query";
import { useTaskIndex, useWorkspaceInfo, taskDetail } from "@/data/queries";
import { resources } from "@/data/resources";
import { MarkdownBody, type GalleryImage, type MarkdownTask } from "./MarkdownBody";

/** The same complete report body is read in the column and in a time note. */
export function ReportBody({ text, sourceTaskId, parentTask, gallery, galleryReportKey, onFollow, variant }: {
  text: string; sourceTaskId: string; parentTask?: MarkdownTask; gallery?: GalleryImage[]; galleryReportKey?: string; onFollow: (id: string) => void; variant?: "note";
}) {
  const root = useWorkspaceInfo(info => info.root);
  const index = useTaskIndex();
  const child = sourceTaskId !== parentTask?.id;
  const query = useQuery({ ...resources.taskView(root, sourceTaskId), enabled: child });
  const row = index.byId.get(sourceTaskId);
  const task = child ? row && query.data && taskDetail(row, query.data) : parentTask;
  if (!task) return <div className="py-2 text-xs text-muted">…</div>;
  return <MarkdownBody text={text} task={task} onFollow={onFollow} report variant={variant}
    gallery={gallery} galleryReportKey={galleryReportKey} />;
}
