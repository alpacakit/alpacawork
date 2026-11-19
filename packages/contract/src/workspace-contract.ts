/** Browser-safe wire contract for this PC's folders, plus the Task ID forms owned by raw. */
import { z } from "zod";
export { TASK_ID_PATTERN, parseTaskId, publicTaskId, PUBLIC_TASK_ID_SQL } from "@alpacawork/raw/task-id";
/**
 * The folders in one folder of this PC, for a person choosing where a project's code is: names only, never files or
 * their contents. `path` is the folder listed (`~` read as `home`); `parent` is null at the top.
 */
export const foldersSchema = z.object({ path: z.string(), parent: z.string().nullable(), home: z.string(),
  folders: z.array(z.string()), truncated: z.boolean() }).strict();
export type Folders = z.infer<typeof foldersSchema>;

/** A single folder name, before asking the disk; the caller trims it first. */
export function folderNameProblem(name: string): "empty" | "slash" | "dots" | "long" | null {
  if (!name) return "empty";
  if (/[/\u0000]/.test(name)) return "slash";
  if (name === "." || name === "..") return "dots";
  if (new TextEncoder().encode(name).length > 255) return "long";
  return null;
}
/** Make exactly one folder below `path` and return its absolute path. */
export const madeFolderSchema = z.object({ path: z.string() }).strict();
export type MadeFolder = z.infer<typeof madeFolderSchema>;
