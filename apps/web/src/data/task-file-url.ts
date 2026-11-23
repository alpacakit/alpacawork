import { taskFileRoute } from "@alpacawork/contract/task-file-route";
import { screenLink } from "@/state/screen-settings";
import { fileOpening, showsInTab } from "@/domain/task-files";

/** The bytes of a file in a Task folder (the server's file route). */
export function taskFileUrl(taskId: string, name: string, revision?: string) {
  return taskFileRoute(taskId, name) + (revision ? `&v=${encodeURIComponent(revision)}` : "");
}

/**
 * A managed file's original bytes at any size, saved under its own name (`download=1` on a Task's or the coordinator's
 * file address): where a link leads for a file a browser tab cannot show from the address itself.
 */
export const originalUrl = (fileUrl: string) => `${fileUrl}&download=1`;

/** Where a link to a file itself leads, and whether following it saves the file rather than opening it in a tab. */
export type FileLink = { href: string; saves: boolean };
/** A link that saves a managed file's original under its own name. */
export const savedFileLink = (fileUrl: string): FileLink => ({ href: originalUrl(fileUrl), saves: true });

/** A link that opens a Task file itself: in a tab where one shows it (showsInTab), saving its original otherwise. */
export function taskFileLink(taskId: string, file: { name: string; size: number; revision?: string }, limit: number): FileLink {
  const url = taskFileUrl(taskId, file.name, file.revision);
  return showsInTab(file.name, file.size, limit) ? { href: url, saves: false } : savedFileLink(url);
}

/** A file of a Task's code locations (code-files.ts on the server), by its absolute path. */
export const taskCodeUrl = (taskId: string, path: string) => `/api/tasks/${encodeURIComponent(taskId)}/code?path=${encodeURIComponent(path)}`;

/** The file sheet replaces the report column while it is open. */
const FILES_TAB = "files";

/** The screen opened on a path of a Task's folder, as it opens there (fileOpening): a folder, a picture, or a file read in the viewer. */
export function taskFilesLink(taskId: string, path = ""): string {
  const opening = fileOpening(taskId, path);
  return screenLink({ task: taskId, tab: FILES_TAB, path: opening.path, image: opening.image ?? undefined, view: opening.view ?? undefined });
}
