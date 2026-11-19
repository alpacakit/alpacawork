import { parseTaskId } from "@alpacawork/contract";
import type { TaskDetail } from "@/data/types";

import type { TaskFile } from "./task-files";
import { webTarget } from "./web-link";

/** What a written path needs of the Task it is written in: which Task, and the files its folder holds. */
type PathTask = Pick<TaskDetail, "id" | "files">;

/**
 * What a path written in a task's text points at, as this UI can open it: a file or folder in some
 * Task folder (opened in that task's Files tab; a folder's path ends in "/"), or a place outside every
 * Task folder (only its path can be copied: the server does not serve it). Null when the text is not a
 * local path this UI knows (a URL, a task ID, an anchor, a relative path to nothing in the Task folder).
 */
export type LocalTarget = { kind: "task"; id: string; path: string; file?: TaskFile } | { kind: "outside"; path: string };

/** A Task's ID names its owner independently of the visible tree (whether or not the tree has loaded it). */
export function taskIdAtAddress(address: string): string | null {
  return parseTaskId(address) ? address : null;
}

/**
 * The file in a Task folder that an address of this screen names (a server route may be written from its root, `/api/…`);
 * null when it names none. Only the opened task's files are known here, as in `localTarget`.
 */
export function managedFileTarget(href: string, origin: string, task: PathTask | null): LocalTarget | null {
  const web = webTarget(href.startsWith("/api/") ? new URL(href, origin).href : href, origin);
  if (web.kind !== "here" || !web.task?.path) return null;
  const { address, path } = web.task;
  const id = taskIdAtAddress(address);
  return id ? { kind: "task", id, path, file: id === task?.id ? task.files.find(file => file.name === path) : undefined } : null;
}

/**
 * Absolute local paths written as bare text: a home or system folder and at least one more part. A path is
 * printable ASCII but for "`", brackets, "," and ";", and any other script's letters and signs. Another script's
 * separating punctuation (\p{Po}: "・", "、", "，", "،" …) and the full-width brackets prose puts round a path end
 * it, so paths listed in a sentence of any language stay apart; dashes, quotes and other brackets (【】, 〜, ’)
 * stay part of a file's name.
 */
export const BARE_PATH = /(?<![\w/.~:-])((?:~|\/(?:Users|home|private|tmp|var|Volumes|opt))\/(?:(?![`(),;])[!-~]|[^\s\p{Po}\uff08\uff09\u300c-\u300f\x00-\x7f])+)/gu;

/**
 * `base` is the Task-folder path of the file the text is written in (a run's file); relative paths
 * start from its folder, otherwise from the Task folder. The opened task's files are known; a path
 * into another Task folder is taken as written (its file list is read when that task is opened).
 * Text written outside any task (`task` null, the coordinator's answers) has no Task folder: only its
 * absolute paths point anywhere.
 */
export function localTarget(written: string, task: PathTask | null, root: string | null, base?: string): LocalTarget | null {
  let path = written.trim().replace(/[.:]$/, "");
  if (/^file:\/\//i.test(path)) path = safeDecode(path.slice("file://".length));
  else if (!path || path.startsWith("#") || /^[a-z][a-z\d+.-]*:/i.test(path)) return null;
  if (path.startsWith("/") || path.startsWith("~/")) {
    const top = root?.replace(/\/$/, "");
    if (top && path.startsWith(`${top}/`)) {
      const inRoot = path.slice(top.length + 1);
      // Each Task's canonical path is its folder, `tasks/T42`.
      const [tasks, number = "", ...parts] = inRoot.split("/");
      const id = tasks === "tasks" ? taskIdAtAddress(number) : null;
      const inFolder = parts.join("/");
      if (id && id !== task?.id && inFolder.replace(/\/$/, "")) return { kind: "task", id, path: inFolder };
      const found = id && id === task?.id ? inTaskFolder(task.files, inFolder) : null;
      if (id && found !== null) return { kind: "task", id, ...found };
    }
    return { kind: "outside", path };
  }
  if (!task) return null;
  const parts = [...(base ? base.split("/").slice(0, -1) : []), ...path.split("/")];
  const resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!resolved.length) return null; resolved.pop(); }
    else resolved.push(part);
  }
  const found = inTaskFolder(task.files, resolved.join("/") + (path.endsWith("/") ? "/" : ""));
  return found === null ? null : { kind: "task", id: task.id, ...found };
}

/** A file's own name, or a folder's (ending in "/") when files lie under it, with its matching file; null when neither. */
function inTaskFolder(files: readonly TaskFile[], path: string): { path: string; file: TaskFile | undefined } | null {
  const name = path.replace(/\/$/, "");
  if (!name) return null;
  if (!path.endsWith("/")) {
    const file = files.find((file) => file.name === name);
    if (file) return { path: name, file };
  }
  const folder = `${name}/`;
  return files.some((file) => file.name.startsWith(folder))
    ? { path: folder, file: files.find((file) => file.name === folder) } : null;
}

const safeDecode = (text: string) => { try { return decodeURI(text); } catch { return text; } };
