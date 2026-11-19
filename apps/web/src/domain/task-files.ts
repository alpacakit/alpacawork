import type { TaskDetail } from "@/data/types";
import { fieldCatalog, fileInline, fileKind, inGallery, renderContext } from "@alpacawork/contract";
import { fileReferences } from "./file-references";
import { viewerAddress } from "./viewer-target";

/**
 * How the Files tab reads a Task folder: which files are the user's to look at and which only the agents use, how a
 * path in the URL names a folder or a file, and which images belong together so they can be compared (light/dark,
 * desktop/mobile, before/after).
 */
export type TaskFile = TaskDetail["files"][number];

/** The work files' place: the agents keep there what only they use, and the Files tab opens it as the work files' list. */
export const WORK_FOLDER = "work/";

/** What a reader opens to read or look at: written words, a page, a printed page, a change, or media. */
const DOCUMENTS = new Set(["md", "markdown", "mdx", "html", "htm", "pdf", "diff", "patch"]);
const forReader = (name: string) => {
  const own = baseName(name), dot = own.lastIndexOf(".");
  return isMedia(name) || dot > 0 && DOCUMENTS.has(own.slice(dot + 1).toLowerCase());
};

/** A file the Deliverables field links, under the name written there. */
export type ListedFile = { file: TaskFile; label: string };
/**
 * A Task folder split in two, every file in exactly one: the deliverables, which the user looks at (counted on the tab),
 * and the work files, which only the agents use. Work files are the files the Deliverables field does not link that
 * are in work/ or are no document, image, video or sound; `listed` the field's files in its order, each once.
 */
export type FileShelves = { listed: ListedFile[]; deliverables: TaskFile[]; work: TaskFile[] };
export type ShelvedTask = Pick<TaskDetail, "id" | "files" | "values">;

/** The field's own: what the Deliverables field is named in a Task's values. */
const DELIVERABLES = "artifact";

/**
 * Sort a Task's files by its Deliverables field (the value `artifact`). A file counts when the field, drawn on the
 * Context page as written there (renderContext), shows a link to it (fileReferences: a link, an image, a path in code or
 * in words, this screen's address of it) and it is now in this Task's folder; a folder, a web address, a code path,
 * another Task's file or a path to nothing changes nothing. A file listed more than once is one, named by the first
 * link that has words, else by its file's name.
 */
export function fileShelves(task: ShelvedTask, root: string | null, origin: string): FileShelves {
  // The field holds one deliverable per item.
  const items = [task.values.values[DELIVERABLES]].flat().filter((item): item is string => typeof item === "string");
  const text = items.length ? renderContext([DELIVERABLES], { [DELIVERABLES]: items }, fieldCatalog([])) : "";
  const found = new Map<string, { file: TaskFile; label: string | null }>();
  for (const { target, label } of fileReferences(text, { task, root, origin })) {
    const file = target.id === task.id && target.file?.name === target.path ? target.file : undefined;
    if (!file) continue;
    const seen = found.get(file.name);
    if (!seen) found.set(file.name, { file, label });
    else seen.label ??= label;
  }
  const listed = new Map([...found].map(([name, { file, label }]) => [name, { file, label: label?.trim() || baseName(name) }]));
  const deliverables: TaskFile[] = [], work: TaskFile[] = [];
  for (const file of task.files)
    (listed.has(file.name) || !file.name.startsWith(WORK_FOLDER) && forReader(file.name) ? deliverables : work).push(file);
  return { listed: [...listed.values()], deliverables, work };
}

/** A folder's sheet: the files it lists, and whether they are the work files. */
export type Sheet = { work: boolean; files: TaskFile[] };
/**
 * The sheet a folder of the URL opens: the Task folder every deliverable, work/ every work file wherever it lies, and
 * any other folder the deliverables under it, or its work files where it holds no deliverable.
 */
export function folderSheet(shelves: FileShelves, folder: string): Sheet {
  if (folder === "") return { work: false, files: shelves.deliverables };
  if (folder === WORK_FOLDER) return { work: true, files: shelves.work };
  const under = (files: TaskFile[]) => files.filter(file => file.name.startsWith(folder));
  const deliverables = under(shelves.deliverables);
  return deliverables.length ? { work: false, files: deliverables } : { work: true, files: under(shelves.work) };
}
/**
 * The folder whose sheet lists a file, where it opens: its own folder's, or else its shelf's whole one (the Task folder
 * for a deliverable, work/ for a work file).
 */
export function sheetOfFile(shelves: FileShelves, name: string): string {
  const own = folderOf(name);
  if (folderSheet(shelves, own).files.some(file => file.name === name)) return own;
  return shelves.work.some(file => file.name === name) ? WORK_FOLDER : "";
}

export type MediaKind = "image" | "video" | "audio";
/** How a file plays on screen, by the shared format table (EMBEDS' gallery kinds); null for any other file. */
export const mediaKind = (name: string): MediaKind | null => { const kind = fileKind(name); return kind && inGallery(kind) ? kind : null; };
export const isImage = (name: string) => mediaKind(name) === "image";
export const isVideo = (name: string) => mediaKind(name) === "video";
export const isAudio = (name: string) => mediaKind(name) === "audio";
/** A file in the gallery: an image, a video or a sound. */
export const isMedia = (name: string) => mediaKind(name) !== null;
/**
 * Text above `limit` (the attachment limit, which the server reads a file inline up to) is linked instead of shown.
 * Media is always shown: the server streams it at any size (fileStreams).
 */
export const showable = (file: Pick<TaskFile, "name" | "readable" | "size">, limit: number) => file.readable !== false && (isMedia(file.name) || file.size <= limit);

/**
 * Whether a browser tab shows a file from its own address: one the address answers inline (fileInline: a format the
 * shared table knows), being an image or a document the server reads whole (up to the attachment limit). A video's or
 * a sound's tab cannot load it under the file's sandbox, a larger document is refused, and a file of no known format is
 * answered as a download, so links to those lead to the original instead (originalUrl). Media alone needs no size.
 */
export const showsInTab = (name: string, size = 0, limit = Infinity) =>
  fileInline(name) && (isImage(name) || !isMedia(name) && size <= limit);

/** A path names a folder when it is empty (the Task folder) or ends with "/". */
export const isFolderPath = (path: string) => path === "" || path.endsWith("/");
/** The folder a path is in: a folder path is its own folder. */
export const folderOf = (path: string) => isFolderPath(path) ? path : path.slice(0, path.lastIndexOf("/") + 1);
/**
 * Where a path of a Task's folder opens: a folder as the Files tab's sheet; a picture or a video as its slide over the
 * sheet of its folder; any other file read in the viewer (`view`) over that sheet. The Files tab's `path` is always a
 * folder: a link that names a file there (one written before files opened in the viewer) opens it by this too.
 */
export function fileOpening(taskId: string, path: string): { path: string; image: string | null; view: string | null } {
  const folder = folderOf(path);
  if (folder === path) return { path, image: null, view: null };
  return isMedia(path) ? { path: folder, image: path, view: null } : { path: folder, image: null, view: viewerAddress(taskId, path) };
}
export const baseName = (path: string) => {
  const name = path.replace(/\/$/, "");
  return name.slice(name.lastIndexOf("/") + 1);
};

/** Whether `path` names a file in the list or a folder that holds one. */
export function pathExists(path: string, names: readonly string[]): boolean {
  return isFolderPath(path) ? path === "" || names.some(name => name.startsWith(path)) : names.includes(path);
}

/** The files and folders directly in `folder`, each folder with how many of `files` it holds. */
export function listFolder(folder: string, files: readonly TaskFile[]) {
  const folders = new Map<string, number>();
  const direct: TaskFile[] = [];
  for (const file of files) {
    if (!file.name.startsWith(folder)) continue;
    const rest = file.name.slice(folder.length);
    const slash = rest.indexOf("/");
    if (slash < 0) direct.push(file);
    else {
      const child = `${folder}${rest.slice(0, slash + 1)}`;
      folders.set(child, (folders.get(child) ?? 0) + 1);
    }
  }
  return { folders: Array.from(folders, ([path, count]) => ({ path, count })), files: direct };
}

export type Facet = "device" | "theme" | "phase";
type FacetValue = "desktop" | "mobile" | "light" | "dark" | "before" | "after";
const FACET_WORDS: Record<string, [Facet, FacetValue]> = {
  light: ["theme", "light"], dark: ["theme", "dark"],
  desktop: ["device", "desktop"], mobile: ["device", "mobile"],
  before: ["phase", "before"], after: ["phase", "after"],
};
const ORDER: FacetValue[] = ["before", "after", "desktop", "mobile", "light", "dark"];
const FACETS: Facet[] = ["phase", "device", "theme"];

/** Read the comparison words of a file name: `login-desktop-dark.png`, `tree-390-light.png`. */
function facetsOf(name: string) {
  const folder = folderOf(name);
  const stem = name.slice(folder.length).replace(/\.[^.]+$/, "");
  const facets: Partial<Record<Facet, FacetValue>> = {};
  const rest: string[] = [];
  for (const word of stem.split(/[-_.]/)) {
    const known = FACET_WORDS[word.toLowerCase()];
    // A screen width names the device: the narrow layout starts at 700px.
    const width = /^\d{3,4}$/.test(word) ? Number(word) : NaN;
    if (known && !facets[known[0]]) facets[known[0]] = known[1];
    else if (!Number.isNaN(width) && !facets.device) facets.device = width > 700 ? "desktop" : "mobile";
    else rest.push(word);
  }
  return { key: `${folder}${rest.join("-")}`, facets };
}

export type MediaSet = {
  /** Folder and the name without its comparison words; also the set's label. */
  key: string;
  label: string;
  items: { file: TaskFile; facets: Partial<Record<Facet, FacetValue>> }[];
  /** Facets whose value differs inside the set, in display order. */
  varies: Facet[];
};

/**
 * Group media whose names differ only in comparison words. A name that has no
 * partner stays a set of one, so every media file is in exactly one set.
 */
export function mediaSets(files: readonly TaskFile[]): MediaSet[] {
  const groups = new Map<string, MediaSet["items"]>();
  for (const file of files) {
    if (!isMedia(file.name)) continue;
    const { key, facets } = facetsOf(file.name);
    const items = groups.get(key);
    if (items) items.push({ file, facets });
    else groups.set(key, [{ file, facets }]);
  }
  const sets: MediaSet[] = [];
  for (const [key, items] of groups) {
    if (items.length === 1) {
      sets.push({ key: items[0]!.file.name, label: baseName(items[0]!.file.name).replace(/\.[^.]+$/, ""), items, varies: [] });
      continue;
    }
    items.sort((a, b) => {
      for (const facet of FACETS) {
        const av = a.facets[facet], bv = b.facets[facet];
        const difference = (av ? ORDER.indexOf(av) : -1) - (bv ? ORDER.indexOf(bv) : -1);
        if (difference !== 0) return difference;
      }
      return a.file.name.localeCompare(b.file.name);
    });
    const varies = FACETS.filter(facet => items.some(item => item.facets[facet] !== items[0]!.facets[facet]));
    const name = key.slice(folderOf(key).length);
    sets.push({ key, label: name || baseName(folderOf(key)) || key, items, varies });
  }
  return sets.sort((a, b) => a.key.localeCompare(b.key));
}

/** The sets of the files on a sheet (filesInView) by name, with each folder's loose media gathered at their first occurrence. */
export function visibleFileMedia(files: readonly TaskFile[]): (MediaSet & { folder: string; single: boolean })[] {
  const rows: (MediaSet & { folder: string; single: boolean })[] = [];
  const loose = new Map<string, (typeof rows)[number]>();
  for (const set of mediaSets(files)) {
    const setFolder = folderOf(set.key);
    if (set.items.length > 1) rows.push({ ...set, folder: setFolder, single: false });
    else {
      const row = loose.get(setFolder);
      if (row) row.items.push(set.items[0]!);
      else {
        const first = { ...set, items: [...set.items], key: `${setFolder}*`, folder: setFolder, single: true };
        loose.set(setFolder, first);
        rows.push(first);
      }
    }
  }
  return rows;
}
