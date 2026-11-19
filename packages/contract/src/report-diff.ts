/**
 * The one owner of a report diff: the file the CLI writes when a report names a `git diff` between two commits, and
 * the reader the screen uses to show it. A report diff is a Task file `diffs/<16 hex of its SHA-256>.diff`: a header
 * of `# <key> <JSON>` lines, then the git patch. A `.diff` without this header is an ordinary patch (no summary), and
 * a header this version cannot read is ignored the same way, never guessed at.
 *
 *   # alpacawork-diff 1
 *   # source {"command":"git -C /r diff a..b","repo":"/r","base":{"sha":"…40","written":"a"},"head":{…},"paths":[]}
 *   # commits {"title":"Japanese user documentation","total":8}
 *   # commit {"sha":"…40","date":"2026-11-01T10:00:00+09:00","subject":"docs: …"}
 *   …one `# commit` line per listed commit, newest first (at most REPORT_DIFF_COMMITS)
 *   # file {"path":"skills/x.md","oldPath":null,"change":"modified","added":3,"deleted":1,"kept":true}
 *   …one `# file` line per changed file, in git's order
 *   diff --git a/skills/x.md b/skills/x.md
 *   …
 *
 * `kept: false` names a file whose rows are not in the patch (the patch would pass REPORT_DIFF_LIMITS); the list of
 * files is always complete, each with what was done to it (`change`, from git's name status, so a file without rows
 * still says it is new). `oldPath` names where a renamed or copied file came from. `added`/`deleted` are null for a binary file.
 *
 * `commits` names the diff for a person, read from git when the report was sent (so it stays when its branch is gone):
 * `title` is the subject of the oldest piece of work on the head's first-parent line (merges that bring the main branch
 * into a work branch, and what they bring, are not its work), and the list holds the work's commits and the merges on
 * that line. A diff with no commit between its versions (or written before this line existed) has none.
 */

/** What any diff may hold to be drawn: checked before parsing, by the CLI that cuts a report diff and the screen. */
export const DIFF_LIMITS = { inputBytes: 1_048_576, sourceUnits: 200_000, lines: 5_000, lineUnits: 20_000 } as const;

export function acceptsDiffInput(text: string): boolean {
  if (text.length > DIFF_LIMITS.inputBytes) return false;
  let lines = 1, start = 0;
  for (;;) {
    const lf = text.indexOf("\n", start);
    const end = lf < 0 ? text.length : lf;
    if (end - start > DIFF_LIMITS.lineUnits + 1) return false;
    if (lf < 0) break;
    if (++lines > DIFF_LIMITS.lines) return false;
    start = lf + 1;
  }
  return new TextEncoder().encode(text).length <= DIFF_LIMITS.inputBytes;
}

/** How many `git diff` commands one report may attach, and how long the CLI may spend taking them all. */
export const REPORT_DIFF_COMMANDS = 8;
export const REPORT_DIFF_SECONDS = 20;

export type ReportDiffRevision = { sha: string; written: string };
export type ReportDiffSource = {
  /** The command as the report wrote it (one line, joined at `\` continuations). */
  command: string;
  repo: string;
  base: ReportDiffRevision;
  head: ReportDiffRevision;
  paths: string[];
};
export const REPORT_DIFF_CHANGES = ["added", "modified", "deleted", "renamed", "copied"] as const;
export type ReportDiffChange = typeof REPORT_DIFF_CHANGES[number];
export type ReportDiffFile = {
  path: string; oldPath: string | null; change: ReportDiffChange; added: number | null; deleted: number | null; kept: boolean;
};
export type ReportDiffCommit = { sha: string; date: string; subject: string };
/** What a diff is named by: its title's subject as git has it, how many commits it holds, and the newest of them listed. */
export type ReportDiffCommits = { title: string; total: number; list: ReportDiffCommit[] };
export type ReportDiff = { source: ReportDiffSource; commits: ReportDiffCommits | null; files: ReportDiffFile[]; patch: string };

/** How many of a diff's commits its header lists (the rest are only counted), and how long a subject it keeps. */
export const REPORT_DIFF_COMMITS = 100;
export const COMMIT_SUBJECT_UNITS = 1000;

const MAGIC = "# alpacawork-diff 1";

export { findDiffCommands, readDiffCommand, type ReportDiffCommand } from './report-diff-commands.js';

export function formatReportDiff(diff: ReportDiff): string {
  const commits = diff.commits ? [`# commits ${JSON.stringify({ title: diff.commits.title, total: diff.commits.total })}`,
    ...diff.commits.list.map(commit => `# commit ${JSON.stringify(commit)}`)] : [];
  const lines = [MAGIC, `# source ${JSON.stringify(diff.source)}`, ...commits, ...diff.files.map(file => `# file ${JSON.stringify(file)}`)];
  return lines.join("\n") + "\n" + diff.patch;
}

const isRevision = (value: unknown): value is ReportDiffRevision =>
  typeof value === "object" && value !== null && typeof (value as ReportDiffRevision).sha === "string" &&
  typeof (value as ReportDiffRevision).written === "string";
const count = (value: unknown) => value === null || (Number.isInteger(value) && (value as number) >= 0);

/**
 * A commit's subject as a person reads it: the task IDs it was written with at its start or alone in brackets taken off
 * (`Merge T4: x` → `x`, `x (T39)` → `x`, `x (T38 review 2)` → `x (review 2)`). One in the middle of a sentence stays, as
 * taking it would break the sentence; `fix(web):` and a review's round stay, for they say what the commit is.
 */
export function commitTitle(subject: string): string {
  const id = String.raw`[TU]\d+`;
  return subject.replace(new RegExp(String.raw`^Merge(?: ${id})?:\s*`), "").replace(new RegExp(String.raw`^${id}:\s*`), "")
    .replace(new RegExp(String.raw`\s*[(（]${id}[)）]`, "g"), "").replace(new RegExp(String.raw`([(（])${id}\s+`, "g"), "$1").trim();
}

const shellWord = (word: string) => /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
/**
 * The git command that shows this diff again, by the commits it compared when it was taken (its own command may name a
 * branch, which has moved since): what a person copies to read it in a terminal.
 */
export function pinnedDiffCommand(source: ReportDiffSource): string {
  return ["git", "-C", source.repo, "diff", `${source.base.sha}..${source.head.sha}`, ...source.paths.length ? ["--", ...source.paths] : []]
    .map(shellWord).join(" ");
}

/** The header of a report diff (its `# ` lines, without the patch), or "" for any other text: what a summary reads. */
export function reportDiffHead(text: string): string {
  if (!text.startsWith(MAGIC + "\n")) return "";
  let at = MAGIC.length + 1;
  while (text.startsWith("# ", at)) { const lf = text.indexOf("\n", at); at = lf < 0 ? text.length : lf + 1; }
  return text.slice(0, at);
}

/** The report diff a text holds, or null when it is not one (an ordinary patch, or a header this version cannot read). */
export function parseReportDiff(text: string): ReportDiff | null {
  if (!text.startsWith(MAGIC + "\n")) return null;
  let at = MAGIC.length + 1;
  let source: ReportDiffSource | null = null, commits: ReportDiffCommits | null = null;
  const files: ReportDiffFile[] = [];
  for (;;) {
    if (!text.startsWith("# ", at)) break;
    const lf = text.indexOf("\n", at);
    const line = text.slice(at, lf < 0 ? text.length : lf);
    const space = line.indexOf(" ", 2);
    if (space < 0) return null;
    const key = line.slice(2, space);
    let value: unknown;
    try { value = JSON.parse(line.slice(space + 1)); } catch { return null; }
    if (key === "source") {
      const s = value as ReportDiffSource;
      if (source || typeof s !== "object" || s === null || typeof s.command !== "string" || typeof s.repo !== "string" ||
          !isRevision(s.base) || !isRevision(s.head) || !Array.isArray(s.paths) || !s.paths.every(p => typeof p === "string")) return null;
      source = { command: s.command, repo: s.repo, base: s.base, head: s.head, paths: s.paths };
    } else if (key === "commits") {
      const c = value as ReportDiffCommits;
      if (commits || files.length || typeof c !== "object" || c === null || typeof c.title !== "string" || !Number.isInteger(c.total) || c.total < 1) return null;
      commits = { title: c.title, total: c.total, list: [] };
    } else if (key === "commit") {
      const c = value as ReportDiffCommit;
      if (!commits || files.length || typeof c !== "object" || c === null || typeof c.sha !== "string" || typeof c.date !== "string" ||
          typeof c.subject !== "string") return null;
      commits.list.push({ sha: c.sha, date: c.date, subject: c.subject });
    } else if (key === "file") {
      const f = value as ReportDiffFile;
      if (typeof f !== "object" || f === null || typeof f.path !== "string" || !(f.oldPath === null || typeof f.oldPath === "string") ||
          !REPORT_DIFF_CHANGES.includes(f.change) || !count(f.added) || !count(f.deleted) || typeof f.kept !== "boolean") return null;
      files.push({ path: f.path, oldPath: f.oldPath, change: f.change, added: f.added, deleted: f.deleted, kept: f.kept });
    } else return null;
    at = lf < 0 ? text.length : lf + 1;
  }
  return source ? { source, commits, files, patch: text.slice(at) } : null;
}

/** Where a report diff lives in its Task folder: named by its content, so the same diff is one file. */
export const reportDiffPath = (sha256Hex: string) => `diffs/${sha256Hex.slice(0, 16)}.diff`;
