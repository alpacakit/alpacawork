import { acceptsDiffInput } from "@alpacawork/contract/report-diff";
import type { DiffDocument, DiffFile, DiffHunk, DiffPart, LineChange, SourceLine } from "./diff-types";

/** Where a hunk's side starts counting rows: a side of no rows names the line before it, any other its first line. */
export const hunkBoundary = (start: number, count: number) => start - (count === 0 ? 0 : 1);

type RawReason = Extract<DiffDocument, { kind: "raw" }>["reason"];
class Unstructured extends Error { constructor(readonly reason: RawReason) { super(reason); } }
const reject = (reason: RawReason = "invalid"): never => { throw new Unstructured(reason); };

/** Git C strings encode octal escapes as UTF-8 bytes, not Unicode code points. */
function pathValue(value: string): string {
  if (!value.startsWith('"')) {
    if (!value || value.includes('"')) return reject();
    return value;
  }
  if (!value.endsWith('"') || value.length < 2) return reject();
  const bytes: number[] = [];
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  const encoder = new TextEncoder();
  for (let i = 1; i < value.length - 1;) {
    const char = value[i]!;
    if (char === '"') return reject();
    if (char !== "\\") {
      const start = i;
      while (i < value.length - 1 && value[i] !== "\\" && value[i] !== '"') i++;
      bytes.push(...encoder.encode(value.slice(start, i)));
    } else {
      i++;
      if (i >= value.length - 1) return reject();
      const escape = value[i++]!;
      if (/[0-7]/.test(escape)) {
        const octal = value.slice(i - 1, i + 2);
        if (!/^[0-7]{3}$/.test(octal) || parseInt(octal, 8) > 255) return reject();
        bytes.push(parseInt(octal, 8)); i += 2;
      } else if (Object.hasOwn(escapes, escape)) bytes.push(escapes[escape]!);
      else return reject();
    }
  }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
    return decoded || reject();
  } catch { return reject(); }
}
function gitPaths(value: string): [string, string] {
  // A quoted first token ends only at an unescaped quote. Unquoted Git names may contain spaces.
  let split = -1;
  if (value.startsWith('"')) {
    for (let i = 1; i < value.length; i++) {
      if (value[i] === "\\") { i++; continue; }
      if (value[i] === '"') { if (value[i + 1] !== " ") return reject(); split = i + 1; break; }
    }
  } else {
    const candidates = [...value.matchAll(/ (?=b\/|"b\/)/g)];
    if (candidates.length === 1) split = candidates[0]!.index;
  }
  if (split < 0) return reject();
  const old = pathValue(value.slice(0, split)), next = pathValue(value.slice(split + 1));
  if (!old.startsWith("a/") || !next.startsWith("b/") || old.length < 3 || next.length < 3) return reject();
  return [old.slice(2), next.slice(2)];
}
/** The two paths of a `diff --git` line (what follows `diff --git `), quoted and escaped as git writes them; null if unread. */
export function gitFilePaths(value: string): [string, string] | null {
  try { return gitPaths(value); }
  catch (error) { if (error instanceof Unstructured) return null; throw error; }
}
function patchPath(value: string, git: boolean, side: "a" | "b"): string | null {
  const path = pathValue(value.split("\t")[0]!);
  if (path === "/dev/null") return null;
  if (!git) return path;
  if (!path.startsWith(`${side}/`) || path.length < 3) return reject();
  return path.slice(2);
}

/**
 * The sole source of structure, paths, row identities and patch statistics, and of which of its three readings a text
 * gets: a whole patch, its lines, or its text alone. No vendor or UI dependency.
 */
export function describeDiff(text: string): DiffDocument {
  if (!acceptsDiffInput(text)) return { kind: "raw", text, reason: "limit" };
  const lines = sourceLines(text);
  const value = (i: number) => { const row = lines[i]; return row ? text.slice(row.start, row.contentEnd) : ""; };
  try { return scan(text, lines, value); }
  catch (error) {
    if (!(error instanceof Unstructured)) throw error;
    // A text with a whole file head is a patch, whole or not: only one without is read by its lines. A name line alone
    // (--- old) is not a head: it is as likely a removed line, and the first letter reads it as one.
    const changes = error.reason === "pathless" ? lines.map((_, i) => lineChange(value(i))) : [];
    return changes.some(change => change !== "ctx") ? { kind: "lines", text, lines, changes } : { kind: "raw", text, reason: error.reason };
  }
}
function sourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (;;) {
    const lf = text.indexOf("\n", start);
    const end = lf < 0 ? text.length : lf + 1;
    const contentEnd = lf < 0 ? end : lf - (text[lf - 1] === "\r" ? 1 : 0);
    lines.push({ start, contentEnd, end });
    if (lf < 0) return lines;
    start = end;
  }
}
/** A line's change, by its first letter. */
const lineChange = (line: string): LineChange => line[0] === "+" ? "add" : line[0] === "-" ? "del" : "ctx";
function scan(text: string, lines: readonly SourceLine[], value: (i: number) => string): DiffDocument {
  const files: DiffFile[] = [], parts: DiffPart[] = [];
  function range(kind: "file" | "raw", index: number, file = 0): void {
    const previous = parts.at(-1);
    if (previous?.kind === kind && previous.source[1] === index && (previous.kind === "raw" || previous.file === file)) {
      previous.source = [previous.source[0], index + 1];
    } else parts.push(kind === "raw" ? { kind, source: [index, index + 1] } : { kind, file, source: [index, index + 1] });
  }
  let i = 0;
  while (i < lines.length) {
    const line = value(i);
    const git = line.startsWith("diff --git ");
    const unified = line.startsWith("--- ") && value(i + 1).startsWith("+++ ");
    if (!git && !unified) {
      if (/^(?:diff |GIT binary patch|Binary files )/.test(line)) return reject("unsupported-format");
      if (/^(?:@@|--- |\+\+\+ )/.test(line)) return reject("pathless");
      range("raw", i++); continue;
    }
    const id = i;
    const paths = git ? gitPaths(line.slice(11)) : undefined;
    let oldPath: string | null | undefined, newPath: string | null | undefined;
    let operation: "rename" | "copy" | undefined, from: string | undefined, to: string | undefined;
    let indexMode: string | undefined;
    let oldMode: string | undefined, newMode: string | undefined, creation: "new" | "deleted" | undefined;
    const seen = new Set<string>();
    const once = (key: string) => { if (seen.has(key)) return reject(); seen.add(key); };
    if (git) range("file", i++, id);
    let paired = false;
    // Only positively understood metadata is summarized. Mode lines remain visible raw parts.
    while (i < lines.length) {
      const row = value(i);
      if (row.startsWith("--- ")) {
        once("paths");
        if (!value(i + 1).startsWith("+++ ")) return reject();
        oldPath = patchPath(row.slice(4), git, "a");
        newPath = patchPath(value(i + 1).slice(4), git, "b");
        range("file", i++, id); range("file", i++, id); paired = true;
        break;
      }
      if (!git) return reject();
      let match: RegExpMatchArray | null;
      if ((match = row.match(/^(old mode|new mode|new file mode|deleted file mode) ([0-7]{6})$/))) {
        const key = match[1]!, mode = match[2]!; once(key);
        if (key === "old mode") oldMode = mode;
        else if (key === "new mode") newMode = mode;
        else { if (creation) return reject(); creation = key === "new file mode" ? "new" : "deleted"; if (creation === "new") newMode = mode; else oldMode = mode; }
        range("raw", i++); continue;
      }
      if ((match = row.match(/^(rename|copy) (from|to) (.+)$/))) {
        const kind = match[1] as "rename" | "copy", side = match[2]!; once(side);
        if (operation && operation !== kind) return reject();
        operation = kind;
        if (side === "from") from = pathValue(match[3]!); else to = pathValue(match[3]!);
        range("file", i++, id); continue;
      }
      if ((match = row.match(/^index [\da-f]+\.\.[\da-f]+(?: ([0-7]{6}))?$/))) { once("index"); indexMode = match[1]; range("file", i++, id); continue; }
      if ((match = row.match(/^(similarity|dissimilarity) index (\d{1,3})%$/))) {
        once("similarity"); if (+match[2]! > 100) return reject(); range("file", i++, id); continue;
      }
      break;
    }
    if (operation && (!from || !to || creation)) return reject();
    if ((oldMode === undefined) !== (newMode === undefined) && !creation) return reject();
    if (creation && (seen.has("old mode") || seen.has("new mode"))) return reject();
    if (indexMode && (newMode ?? oldMode) && indexMode !== (newMode ?? oldMode)) return reject();
    if (paths) {
      const expectedOld = creation === "new" ? null : paths[0];
      const expectedNew = creation === "deleted" ? null : paths[1];
      if (paired && (oldPath !== expectedOld || newPath !== expectedNew)) return reject();
      if (oldPath === undefined) oldPath = expectedOld;
      if (newPath === undefined) newPath = expectedNew;
      if (operation && (from !== paths[0] || to !== paths[1])) return reject();
      if (!operation && paths[0] !== paths[1]) return reject();
    }
    if (oldPath === undefined || newPath === undefined || (oldPath === null && newPath === null)) return reject();
    // Null sides are meaningful in unified patches too. Git null sides require their mode declaration.
    const change = operation ?? (oldPath === null ? "new" : newPath === null ? "deleted" : "change");
    if (git && (change === "new" || change === "deleted") && creation !== change) return reject();
    const hunks: DiffHunk[] = [], stats = { added: 0, deleted: 0 };
    let oldEnd = 0, newEnd = 0, oldEOF = false, newEOF = false;
    while (i < lines.length && value(i).startsWith("@@")) {
      const specs = value(i).match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/);
      if (!specs) return reject();
      const oldStart = +specs[1]!, oldCount = specs[2] === undefined ? 1 : +specs[2];
      const newStart = +specs[3]!, newCount = specs[4] === undefined ? 1 : +specs[4];
      if (![oldStart, oldCount, newStart, newCount, oldStart + oldCount, newStart + newCount].every(Number.isSafeInteger)
        || (oldCount > 0 && oldStart === 0) || (newCount > 0 && newStart === 0)
        || hunkBoundary(oldStart, oldCount) < oldEnd || hunkBoundary(newStart, newCount) < newEnd
        || (oldPath === null && (oldStart !== 0 || oldCount !== 0)) || (newPath === null && (newStart !== 0 || newCount !== 0))) return reject();
      const hunk: DiffHunk = { id: i, oldStart, oldCount, newStart, newCount };
      hunks.push(hunk); parts.push({ kind: "hunk", file: id, hunk: i, source: [i, i + 1] }); i++;
      let old = 0, next = 0;
      let previous: "add" | "del" | "ctx" | undefined;
      while (old < oldCount || next < newCount || value(i) === "\\ No newline at end of file") {
        const body = value(i);
        if (body === "\\ No newline at end of file") {
          if (!previous) return reject();
          if (previous !== "add") oldEOF = true;
          if (previous !== "del") newEOF = true;
          previous = undefined; range("raw", i++); continue;
        }
        const kind = body[0] === "+" ? "add" : body[0] === "-" ? "del" : body[0] === " " ? "ctx" : undefined;
        if (!kind || i >= lines.length) return reject();
        if (kind !== "add" && (++old > oldCount || oldEOF)) return reject();
        if (kind !== "del" && (++next > newCount || newEOF)) return reject();
        if (kind === "add") stats.added++;
        if (kind === "del") stats.deleted++;
        parts.push({ kind: "body", file: id, hunk: hunk.id, line: i, change: kind }); previous = kind; i++;
      }
      oldEnd = hunkBoundary(oldStart, oldCount) + oldCount; newEnd = hunkBoundary(newStart, newCount) + newCount;
    }
    if (!hunks.length && (!git || (!operation && !creation && !oldMode))) return reject("unsupported-format");
    const file: DiffFile = { id, oldPath, newPath, change, stats, hunks };
    if (oldMode || newMode) file.mode = { ...(oldMode ? { old: oldMode } : {}), ...(newMode ? { next: newMode } : {}) };
    files.push(file);
    // A completed hunk cannot reinterpret surplus body/header-extension rows as harmless tail text.
    while (i < lines.length && !value(i).startsWith("diff --git ") && !(value(i).startsWith("--- ") && value(i + 1).startsWith("+++ "))) {
      const tail = value(i);
      if (/^[+\- \\]/.test(tail) && tail !== "") return reject();
      if (/^(?:diff |@@|index |old mode|new mode|new file mode|deleted file mode|similarity |dissimilarity |rename |copy |GIT binary patch|Binary files |[A-Za-z-]+:)/.test(tail)) return reject("unsupported-format");
      if (!hunks.length && tail !== "") return reject("unsupported-format");
      range("raw", i++);
    }
  }
  if (!files.length) return reject("pathless");
  return { kind: "structured", text, lines, files, parts };
}
