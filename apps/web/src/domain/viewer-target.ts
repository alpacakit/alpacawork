import { fileKind } from "@alpacawork/contract";

/**
 * What the viewer reads, as the URL's `view` names it: `<Task ID>/<path>`, a file of that Task's folder when the path is
 * relative, or a file of its projects' code locations when it is absolute (`T150//home/me/repo/src/a.ts`). The Task is
 * whose words named the file: the server reads a code file only inside that Task's code locations.
 *
 * How it is read follows from the file alone: a diff (`.diff`, `.patch`) as the diff it holds, any other as its text.
 */
export type ViewerTarget = { owner: string; path: string; where: "task" | "code"; reads: "diff" | "file" };

export function viewerTarget(value: string): ViewerTarget | null {
  const at = /^(T\d+)\/(.+)$/.exec(value);
  if (!at || at[2]!.includes("\0")) return null;
  const path = at[2]!, where = path.startsWith("/") ? "code" : "task";
  if (where === "task" && path.split("/").some(part => part === ".." || part === "")) return null;
  return { owner: at[1]!, path, where, reads: fileKind(path) === "diff" ? "diff" : "file" };
}

export const viewerAddress = (owner: string, path: string) => `${owner}/${path}`;

/**
 * What copying the path of a file read whole in the viewer gives: a Task's file by its Task (`T151/samples/a.yml`, as a
 * reference to it reads anywhere), a code location's file by its absolute path; null for a diff, whose pages copy the
 * paths they change.
 */
export const viewerCopy = (target: ViewerTarget): string | null =>
  target.reads === "diff" ? null : target.where === "task" ? viewerAddress(target.owner, target.path) : target.path;
