import { acceptsDiffInput, parseReportDiff, type ReportDiffChange } from "@alpacawork/contract/report-diff";
import { describeDiff, gitFilePaths } from "./diff-source";
import type { Change, DiffDocument, LineChange, StructuredDiffDocument } from "./diff-types";
import { excerpt, similar, wordChanges, type ExcerptPiece, type WordPiece } from "./word-changes";

/**
 * What the diff viewer reads of one diff file (pure): its files in git's order, each with what was done to it and how
 * many lines, and, for a file whose patch it holds, that patch. A report diff (`parseReportDiff`) names every file, also
 * those whose rows it did not keep; any other `.diff` names the files its patch holds. A text that is no patch the
 * viewer can list (too large to read, or no file in it) is left to the code frame as written (`raw`).
 */
export type DiffEntry = {
  key: string;
  path: string;
  oldPath: string | null;
  change: Change;
  /** A binary file: no lines to count or show. */
  binary: boolean;
  /** Null when not counted: a binary file, or a part the reader could not take. */
  added: number | null;
  deleted: number | null;
  /** False: the report diff did not keep this file's rows (they were too large). */
  kept: boolean;
  /** The file's own part of the patch, for the code frame. */
  patch: string | null;
  /** The git command that shows this file's diff, for a report diff (whose header names the repo and both versions). */
  command: string | null;
};
export type EntryRow = { kind: LineChange; text: string } | { kind: "hunk" };
export type ReadDiff =
  | { kind: "files"; files: DiffEntry[] }
  | { kind: "raw"; text: string; tooLarge: boolean };

export function readDiff(text: string): ReadDiff {
  const report = parseReportDiff(text);
  const patch = report?.patch ?? text;
  const tooLarge = !acceptsDiffInput(patch);
  const parts = tooLarge ? [] : fileParts(patch);
  if (!report) {
    const found = parts.flatMap((part, i) => partFiles(part, i));
    return found.length ? { kind: "files", files: found } : { kind: "raw", text, tooLarge };
  }
  // The saved header already owns names and counts. Index its patches without parsing closed files.
  const byPath = new Map<string, string>();
  for (const part of parts) {
    const head = /^diff --git (.+)$/m.exec(part)?.[1];
    const paths = head && gitFilePaths(head);
    if (paths) byPath.set(paths[1], part);
  }
  const { source } = report;
  return { kind: "files", files: report.files.map((file, i) => {
    const held = file.kept ? byPath.get(file.path) ?? (file.oldPath !== null ? byPath.get(file.oldPath) : undefined) : undefined;
    // What was done to the file is the header's (git's name status), also for a file whose rows were not kept.
    return { key: `${i}:${file.path}`, path: file.path, oldPath: file.oldPath, added: file.added, deleted: file.deleted, kept: file.kept,
      binary: file.added === null, change: CHANGES[file.change], patch: held ?? null,
      command: file.kept ? null : `git -C ${shellWord(source.repo)} diff ${source.base.sha.slice(0, 12)}..${source.head.sha.slice(0, 12)} -- ${shellWord(file.path)}` };
  }) };
}

const CHANGES: Record<ReportDiffChange, Change> = { added: "new", modified: "change", deleted: "deleted", renamed: "rename", copied: "copy" };
/** A word as a shell reads it back: as written when plain, else in single quotes. */
const shellWord = (word: string) => /^[\w./@:+=-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

/**
 * A git patch cut where each file starts, so a file the reader does not take (a binary one) costs only its own rows; a
 * patch without git's file lines is one part.
 */
function fileParts(patch: string): string[] {
  const starts = [...patch.matchAll(/^diff --git /gm)].map(found => found.index);
  if (!starts.length) return [patch];
  return starts.map((start, i) => patch.slice(start, starts[i + 1] ?? patch.length));
}

/**
 * The files one part holds. A mail's signature after the last file (git format-patch: a `-- ` line, then any words)
 * is not the file's: when the part reads only without what follows its last `-- ` line, that is cut off; the reader's
 * hunk counts tell it from a removed `- ` line. A git file part the reader still does not take (a binary one, or one
 * it cannot read) is listed by its `diff --git` line (git's quoting read as the reader reads it, or as written), its
 * part kept to be shown as written, never as no change.
 */
function partFiles(part: string, at: number): DiffEntry[] {
  const diff = readFilePatch(part);
  if (diff.kind === "structured") return patchFiles(diff, at);
  const head = /^diff --git (.+)$/m.exec(part)?.[1];
  if (head === undefined) return [];
  const [before, after] = gitFilePaths(head) ?? [head, head];
  const binary = /^(?:Binary files |GIT binary patch)/m.test(part);
  return [{ key: `${at}:${after}`, path: after, oldPath: before !== after ? before : null, kept: true, patch: part, command: null,
    binary, added: null, deleted: null,
    change: /^new file mode/m.test(part) ? "new" : /^deleted file mode/m.test(part) ? "deleted" : before !== after ? "rename" : "change" }];
}

/** The files a plain patch names, each retaining its complete metadata and body for display. */
function patchFiles(diff: StructuredDiffDocument, at: number): DiffEntry[] {
  return diff.files.map((file, i) => {
    const path = (file.newPath ?? file.oldPath)!;
    const next = diff.files[i + 1];
    return { key: `${at}.${file.id}:${path}`, path, oldPath: file.newPath !== null && file.oldPath !== file.newPath ? file.oldPath : null,
      change: file.change, added: file.stats.added, deleted: file.stats.deleted, kept: true, binary: false, command: null,
      patch: diff.text.slice(diff.lines[file.id]!.start, next ? diff.lines[next.id]!.start : diff.text.length) };
  });
}

/** Parse only the file being read; a mail signature is not part of its patch. */
export function readFilePatch(patch: string) {
  const doc = describeDiff(patch);
  if (doc.kind === "structured") return doc;
  const signed = patch.lastIndexOf("\n-- \n");
  return signed < 0 ? doc : describeDiff(patch.slice(0, signed + 1));
}

// Entries live with one viewer document. A parsed body is derived once and released with its entry.
const documents = new WeakMap<DiffEntry, DiffDocument>();
export function readDiffFile(file: DiffEntry): DiffDocument | null {
  if (!file.kept || file.binary || !file.patch) return null;
  let doc = documents.get(file);
  if (!doc) { doc = readFilePatch(file.patch); documents.set(file, doc); }
  return doc;
}
export const hasDiffRows = (doc: DiffDocument | null): doc is StructuredDiffDocument =>
  doc?.kind === "structured" && doc.parts.some(part => part.kind === "body");

/** A document's prose rows, derived only when its prose is displayed. Code consumes the document directly. */
export function proseRows(diff: StructuredDiffDocument): EntryRow[] {
  return diff.parts.flatMap((part): EntryRow[] => {
    if (part.kind === "hunk") return [{ kind: "hunk" }];
    if (part.kind !== "body") return [];
    const { start, contentEnd } = diff.lines[part.line]!;
    return [{ kind: part.change, text: diff.text.slice(start + 1, contentEnd) }];
  });
}

/** Files read as prose: their changes are shown by the words that changed; any other file is code, shown as rows. */
export const readsAsProse = (path: string) => /\.(?:md|markdown|mdx|txt)$/i.test(path);

/** What a diff's summary says before any of its rows is read: how many files, and lines added and removed. */
export type DiffSummary = { files: number; added: number; deleted: number };
export function summarizeFiles(files: readonly { added: number | null; deleted: number | null }[]): DiffSummary {
  return { files: files.length, added: files.reduce((sum, file) => sum + (file.added ?? 0), 0), deleted: files.reduce((sum, file) => sum + (file.deleted ?? 0), 0) };
}

/** A folder's files, in the viewer's list. */
export type FileGroup<T> = { folder: string; files: T[] };
export const folderOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);

/**
 * The files as the viewer lists them: by folder, the folders and each one's files in name order, so two files of one
 * name stand under their own folders. `query` keeps only the files whose path holds it (any case); a folder it empties
 * is left out.
 */
export function groupFiles<T extends { path: string }>(files: readonly T[], query = ""): FileGroup<T>[] {
  const words = query.trim().toLowerCase();
  const groups = new Map<string, T[]>();
  for (const file of files) {
    if (words && !file.path.toLowerCase().includes(words)) continue;
    const folder = folderOf(file.path);
    groups.set(folder, [...groups.get(folder) ?? [], file]);
  }
  return [...groups].sort(([a], [b]) => compare(a, b)).map(([folder, held]) => ({ folder, files: held.sort((a, b) => compare(a.path, b.path)) }));
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/**
 * A run of removed lines then added lines read as changes: a removed line and the next added line that reads as it
 * changed (`similar`, within LOOK_AHEAD) are one pair, compared by words; any other line is wholly removed or added, so
 * unrelated lines are never coloured as one. Rows are named by their index in `rows`; a kept line or a hunk's start
 * ends a run.
 */
export type ChangeStep = { kind: "del" | "add"; row: number } | { kind: "pair"; del: number; add: number };
const LOOK_AHEAD = 8;
export function pairChanges(rows: readonly { kind: string; text?: string }[]): ChangeStep[] {
  const steps: ChangeStep[] = [];
  let removed: number[] = [], added: number[] = [];
  const text = (row: number) => rows[row]!.text ?? "";
  const flush = () => {
    let next = 0;
    for (const before of removed) {
      let match = -1;
      for (let at = next; at < Math.min(added.length, next + LOOK_AHEAD) && match < 0; at++) if (similar(text(before), text(added[at]!))) match = at;
      if (match < 0) { steps.push({ kind: "del", row: before }); continue; }
      for (; next < match; next++) steps.push({ kind: "add", row: added[next]! });
      steps.push({ kind: "pair", del: before, add: added[match]! });
      next = match + 1;
    }
    for (; next < added.length; next++) steps.push({ kind: "add", row: added[next]! });
    removed = []; added = [];
  };
  rows.forEach((row, i) => {
    if (row.kind === "del") { if (added.length) flush(); removed.push(i); }
    else if (row.kind === "add") added.push(i);
    // A line kept as written between them (`\ No newline at end of file`) does not part a removed line from its new one.
    else if (row.kind === "ctx" || row.kind === "hunk") flush();
  });
  flush();
  return steps;
}

/** One change of a prose file: a removed line and the line in its place, by words; or a line only added or only removed. */
export type ProseChange = { pieces: ExcerptPiece[] };

/**
 * A prose file's changes in order (pairChanges): a changed paragraph is its changed words, the rest cut to `context`
 * letters around them; blank lines are not changes a reader sees.
 */
export function proseChanges(rows: readonly EntryRow[], context = 40): ProseChange[] {
  const text = (row: number) => { const at = rows[row]!; return at.kind === "hunk" ? "" : at.text; };
  return pairChanges(rows).flatMap((step): ProseChange[] => step.kind === "pair"
    ? [{ pieces: excerpt(wordChanges(text(step.del), text(step.add)), context) }]
    : text(step.row).trim() ? [{ pieces: [{ kind: step.kind, text: text(step.row) }] }] : [])
    .filter(change => change.pieces.some(piece => piece.kind !== "gap" && piece.kind !== "same"));
}

/** A new or deleted document's text: its added lines, or its removed ones. */
export const sideText = (rows: readonly EntryRow[], kind: "add" | "del") => rows.flatMap(row => row.kind === kind ? [row.text] : []).join("\n");

/**
 * A code file's rows as the viewer reads them: each line with its numbers in the old and the new file, and, for a
 * changed line paired with the line in its place (pairChanges), the letters that changed (`words`, offsets in its
 * source line, the +/- at 0); a hunk's start with its first line in each file and the words git writes after its `@@`
 * (the function it is in). git's notes between them (a mode, `\ No newline at end of file`) are left out: they say
 * nothing a reader decides by (a new file says so by its heading).
 */
type LineRow = { kind: "add" | "del" | "ctx"; line: number; old: number | null; next: number | null; words: readonly (readonly [number, number])[] | null };
export type CodeRow = { kind: "hunk"; line: number; old: number; next: number; context: string } | LineRow;
export function codeRows(diff: StructuredDiffDocument): CodeRow[] {
  const value = (line: number) => { const { start, contentEnd } = diff.lines[line]!; return diff.text.slice(start, contentEnd); };
  const hunks = new Map(diff.files.flatMap(file => file.hunks.map(hunk => [hunk.id, hunk] as const)));
  const rows: CodeRow[] = [];
  let old = 0, next = 0;
  for (const part of diff.parts) {
    if (part.kind === "file") continue;
    if (part.kind === "raw") continue;
    if (part.kind === "hunk") {
      const hunk = hunks.get(part.hunk)!;
      old = hunk.oldStart; next = hunk.newStart;
      rows.push({ kind: "hunk", line: part.hunk, old, next, context: /^@@ [^@]* @@ ?(.*)$/.exec(value(part.hunk))?.[1]?.trim() ?? "" });
      continue;
    }
    const kind = part.change;
    rows.push({ kind, line: part.line, old: kind === "add" ? null : old++, next: kind === "del" ? null : next++, words: null });
  }
  const text = rows.map(row => ({ kind: row.kind, text: row.kind === "hunk" ? "" : value(row.line).slice(1) }));
  for (const step of pairChanges(text)) {
    if (step.kind !== "pair") continue;
    const pieces = wordChanges(text[step.del]!.text, text[step.add]!.text);
    // A line that shares no letters with the one in its place is changed whole: its ground says so already.
    if (!pieces.some(piece => piece.kind === "same" && piece.text.trim())) continue;
    (rows[step.del] as LineRow).words = changedRanges(pieces, "del");
    (rows[step.add] as LineRow).words = changedRanges(pieces, "add");
  }
  return rows;
}

/** Where one side's changed words stand in its source line (after its +/-, at 1). */
function changedRanges(pieces: readonly WordPiece[], side: "add" | "del"): [number, number][] {
  const ranges: [number, number][] = [];
  let at = 1;
  for (const piece of pieces) {
    if (piece.kind !== "same" && piece.kind !== side) continue;
    if (piece.kind === side && piece.text.trim()) ranges.push([at, at + piece.text.length]);
    at += piece.text.length;
  }
  return ranges;
}

/**
 * A code file's rows side by side (a computer's split view): a kept line on both sides; a removed line and the line in
 * its place (pairChanges) on one row; between such pairs, the lines only removed beside the lines only added, as many
 * rows as the longer of them; a hunk's start or a line kept as written across both. Rows are named by their index in `rows`.
 */
export type SideRow = { kind: "band"; row: number } | { kind: "pair"; left: number | null; right: number | null };
export function sideBySide(rows: readonly { kind: string; text?: string }[]): SideRow[] {
  const out: SideRow[] = [];
  for (let at = 0; at < rows.length;) {
    const kind = rows[at]!.kind;
    if (kind === "ctx") { out.push({ kind: "pair", left: at, right: at }); at++; continue; }
    if (kind !== "del" && kind !== "add") { out.push({ kind: "band", row: at }); at++; continue; }
    let end = at;
    while (end < rows.length && (rows[end]!.kind === "del" || rows[end]!.kind === "add")) end++;
    let removed: number[] = [], added: number[] = [];
    const zip = () => {
      for (let i = 0; i < Math.max(removed.length, added.length); i++) out.push({ kind: "pair", left: removed[i] ?? null, right: added[i] ?? null });
      removed = []; added = [];
    };
    for (const step of pairChanges(rows.slice(at, end))) {
      if (step.kind === "pair") { zip(); out.push({ kind: "pair", left: at + step.del, right: at + step.add }); }
      else (step.kind === "del" ? removed : added).push(at + step.row);
    }
    zip();
    at = end;
  }
  return out;
}
