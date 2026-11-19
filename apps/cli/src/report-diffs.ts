/** Takes a submission's immutable commit diffs before any file or report is sent. */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { MAX_DETAIL_LENGTH } from '@alpacawork/contract/fields';
import { acceptsDiffInput, COMMIT_SUBJECT_UNITS, DIFF_LIMITS, findDiffCommands, formatReportDiff, parseReportDiff, reportDiffPath,
  REPORT_DIFF_COMMANDS, REPORT_DIFF_COMMITS, REPORT_DIFF_SECONDS, type ReportDiff, type ReportDiffChange, type ReportDiffCommand,
  type ReportDiffCommit, type ReportDiffCommits, type ReportDiffFile } from '@alpacawork/contract/report-diff';

type Comparison = Extract<ReportDiffCommand, { kind: 'compare' }>;
export type DiffSummary = { command: string; path: string; files: number; added: number; deleted: number; omitted: number } |
  { command: string; attached: false; reason: string };
export type PreparedDiffs = { description: string; files: { path: string; digest: string; bytes: Uint8Array }[]; summaries: DiffSummary[] };
const refused = (command: string, reason: string) => new Problem(PROBLEM_CODE.invalidInput,
  `git diff cannot be attached: ${command}: ${reason}. Write an existing literal repository and base..head revisions; commit SHAs remain usable after branch deletion.`);

/** Git has no inherited routing, execution, trace or configuration environment. In particular no lazy-fetch transport. */
function gitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_ATTR_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '',
    GIT_NO_REPLACE_OBJECTS: '1', LC_ALL: 'C' };
}
const gitPrefix = ['--no-pager', '-c', 'protocol.allow=never', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.attributesFile=/dev/null', '-c', 'core.quotePath=true', '-c', 'diff.noprefix=false',
  '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.suppressBlankEmpty=false', '-c', 'color.ui=false'];
const diffOptions = ['--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--no-relative',
  '--inter-hunk-context=0', '-O/dev/null', '--find-renames', '--find-copies', '--submodule=short', '--ignore-submodules=dirty', '--histogram', '--no-indent-heuristic'];

/** Bounded output and one deadline for all children. close (not exit) settles every killed child's pipes. */
function git(cwd: string, args: string[], deadline: number, command: string, max: number, allowTruncation = false,
  acceptedExitCodes: readonly number[] = [0]): Promise<{ text: string; bytes: Buffer; truncated: boolean; code: number | null }> {
  return new Promise((done, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) { reject(refused(command, 'diff collection timed out')); return; }
    const child = spawn('git', [...gitPrefix, ...args], { cwd, env: gitEnvironment(), shell: false,
      detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    };
    const chunks: Buffer[] = [];
    let size = 0, stderr = '', truncated = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stop(); }, remaining);
    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return;
      const keep = chunk.subarray(0, Math.max(0, max + 1 - size));
      chunks.push(keep); size += keep.length;
      if (size > max) { truncated = true; stop(); }
    });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 2048) stderr += chunk.toString('utf8').slice(0, 2048 - stderr.length); });
    child.once('error', error => { clearTimeout(timer); reject(refused(command, error.message)); });
    // A descendant must not retain a pipe or survive after the direct Git has ended, even on normal exit.
    child.once('exit', stop);
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut) { reject(refused(command, 'diff collection timed out')); return; }
      if (truncated && !allowTruncation) { reject(refused(command, 'the complete file list exceeds the attachment limit; narrow -- paths')); return; }
      if ((code === null || !acceptedExitCodes.includes(code)) && !truncated) { reject(refused(command, stderr.trim().split('\n')[0] || 'git failed')); return; }
      const bytes = Buffer.concat(chunks).subarray(0, max);
      let text: string;
      try { text = allowTruncation ? bytes.toString('latin1') : new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { reject(refused(command, 'git returned paths that are not UTF-8')); return; }
      done({ text, bytes, truncated, code });
    });
  });
}

/** --name-status -z is the authority for change, including files whose patch cannot be kept. */
function fileChanges(text: string, command: string): Map<string, { oldPath: string | null; change: ReportDiffChange }> {
  const parts = text.split('\0'), files = new Map<string, { oldPath: string | null; change: ReportDiffChange }>();
  if (parts.pop() !== '') throw refused(command, 'git returned incomplete file statuses');
  const kinds: Record<string, ReportDiffChange> = { A: 'added', M: 'modified', T: 'modified', D: 'deleted', R: 'renamed', C: 'copied' };
  for (let at = 0; at < parts.length; at++) {
    const status = parts[at]!;
    if (!/^(?:[AMTD]|[RC]\d+)$/.test(status)) throw refused(command, 'git returned an unsupported file status');
    const change = kinds[status[0]!]!, first = parts[++at];
    const oldPath = change === 'renamed' || change === 'copied' ? first ?? null : null;
    const path = oldPath === null ? first : parts[++at];
    if (!path || files.has(path)) throw refused(command, 'git returned incomplete or duplicate file statuses');
    files.set(path, { oldPath, change });
  }
  return files;
}

/** --numstat -z keeps tabs/newlines in names and uses a separate old/new record for renames and copies. */
function fileList(text: string, statuses: string, command: string): ReportDiffFile[] {
  const changes = fileChanges(statuses, command);
  const parts = text.split('\0'), files: ReportDiffFile[] = [];
  if (parts.pop() !== '') throw refused(command, 'git returned an incomplete file list');
  for (let at = 0; at < parts.length; at++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(parts[at]!);
    if (!match) throw refused(command, 'git returned an invalid file list');
    let path = match[3]!, oldPath: string | null = null;
    if (!path) { oldPath = parts[++at] ?? null; path = parts[++at] ?? ''; }
    if (!path) throw refused(command, 'git returned an incomplete renamed path');
    const status = changes.get(path);
    if (!status || oldPath !== status.oldPath) throw refused(command, 'git file statuses and statistics disagree');
    files.push({ path, ...status, added: match[1] === '-' ? null : Number(match[1]), deleted: match[2] === '-' ? null : Number(match[2]), kept: false });
  }
  if (files.length !== changes.size) throw refused(command, 'git file statuses and statistics disagree');
  return files;
}

const MAIN_BRANCHES = ['refs/remotes/origin/HEAD', 'refs/heads/main', 'refs/heads/master', 'refs/remotes/origin/main', 'refs/remotes/origin/master'];

/**
 * What names a diff for a person (ReportDiffCommits): its commits between base and head that touch its paths. A merge on
 * the head's first-parent line that brings a main branch into a work branch (its second parent on a main branch's
 * first-parent line, itself not) is no work of the diff, nor is what it brings. The title is the subject of the oldest
 * piece of work left on that line; the list, the work's commits and that line's merges, newest first. None when the
 * head did not grow from the base, or no commit is between them.
 */
async function rangeCommits(repo: string, base: string, head: string, paths: string[], deadline: number, command: string): Promise<ReportDiffCommits | null> {
  const run = async (args: string[]) => (await git(repo, args, deadline, command, DIFF_LIMITS.inputBytes * 4, true)).text;
  const shas = (text: string) => text.split('\n').filter(Boolean);
  // Only a head that grew from its base has its work between them; any other pair compares two lines of work.
  const grown = await git(repo, ['merge-base', '--is-ancestor', base, head], deadline, command, 0, false, [0, 1]);
  if (grown.code !== 0) return null;
  const range = [`${base}..${head}`, '--', ...paths];
  const line = shas(await run(['rev-list', '--first-parent', ...range]));
  if (!line.length) return null;
  // Every commit touching the paths, merges included (narrowed to paths, git log would otherwise skip a merge the line holds).
  const log = await git(repo, ['log', '-z', '--full-history', '--format=%H%x1f%cI%x1f%P%x1f%s', ...range], deadline, command, DIFF_LIMITS.inputBytes * 4, true);
  const commits = new Map<string, { date: string; parents: string[]; subject: string }>();
  for (const record of new TextDecoder().decode(log.bytes).split('\0')) {
    const [sha, date, parents, subject] = record.replace(/^\n/, '').split('\x1f');
    if (sha && date !== undefined && parents !== undefined && subject !== undefined) commits.set(sha, { date, parents: parents.split(' ').filter(Boolean), subject });
  }
  const refs = (await run(['for-each-ref', '--format=%(refname)', ...MAIN_BRANCHES])).split('\n').filter(Boolean);
  const mains = new Set(refs.length ? shas(await run(['rev-list', '--first-parent', ...refs])) : []);
  const excluded = new Set<string>();
  for (const sha of line) {
    const second = commits.get(sha)?.parents[1];
    if (!second || mains.has(sha) || !mains.has(second)) continue;
    excluded.add(sha);
    for (const brought of shas(await run(['rev-list', `${base}..${second}`]))) excluded.add(brought);
  }
  const onLine = new Set(line);
  const work = line.filter(sha => !excluded.has(sha));
  const oldest = commits.get(work.at(-1) ?? '');
  if (!oldest) return null;
  const keep = (subject: string) => Array.from(subject).slice(0, COMMIT_SUBJECT_UNITS).join('');
  const list: ReportDiffCommit[] = [...commits].filter(([sha, commit]) => !excluded.has(sha) && (commit.parents.length < 2 || onLine.has(sha)))
    .map(([sha, commit]) => ({ sha, date: commit.date, subject: keep(commit.subject) }));
  return { title: keep(oldest.subject), total: list.length, list: list.slice(0, REPORT_DIFF_COMMITS) };
}

/** The header always retains the complete list; only complete, renderable file patches are kept. */
function boundedDiff(diff: ReportDiff, raw: { text: string; bytes: Buffer; truncated: boolean }): string {
  const header = formatReportDiff(diff);
  if (!acceptsDiffInput(header)) throw refused(diff.source.command, 'the complete file list exceeds the display limit; narrow -- paths');
  const starts = [...raw.text.matchAll(/^diff --git /gm)].map(match => match.index);
  let bytes = Buffer.byteLength(header), lines = header.split('\n').length;
  const kept: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const file = diff.files[i];
    if (!file || (raw.truncated && i === starts.length - 1)) continue;
    let patch: string;
    try { patch = new TextDecoder('utf-8', { fatal: true }).decode(raw.bytes.subarray(starts[i], starts[i + 1] ?? raw.bytes.length)); }
    catch { throw refused(diff.source.command, 'a changed text file is not UTF-8; choose UTF-8 files with -- paths'); }
    const extraBytes = Buffer.byteLength(patch) - 1, extraLines = patch.split('\n').length - 1;
    if (!acceptsDiffInput(patch) || bytes + extraBytes > DIFF_LIMITS.inputBytes || lines + extraLines > DIFF_LIMITS.lines) continue;
    file.kept = true; kept.push(patch); bytes += extraBytes; lines += extraLines;
  }
  diff.patch = kept.join('');
  const formatted = formatReportDiff(diff);
  if (!acceptsDiffInput(formatted)) throw refused(diff.source.command, 'the complete file list exceeds the display limit; narrow -- paths');
  return formatted;
}

async function capture(found: Comparison, cwd: string, deadline: number): Promise<{ text: string } | { reason: string }> {
  let repo = cwd;
  for (const directory of found.directories) repo = resolve(repo, directory);
  try { repo = await realpath(repo); }
  catch { throw refused(found.command, 'the repository directory does not exist'); }
  const revision = async (written: string) => {
    const result = await git(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${written}^{commit}`], deadline, found.command, 256, false, [0, 1]);
    if (result.code === 1) return null;
    const sha = result.text.trim();
    if (!/^(?:[\da-f]{40}|[\da-f]{64})$/.test(sha)) throw refused(found.command, `cannot resolve revision ${written}`);
    return { sha, written };
  };
  let base = await revision(found.base);
  if (base === null) throw refused(found.command, `cannot resolve revision ${found.base}`);
  const head = await revision(found.head);
  if (head === null) {
    if (found.notation === 'pair') return { reason: 'The second argument is a path, not a commit; working-tree diffs are not attached. Write base..head to attach a commit diff' };
    throw refused(found.command, `cannot resolve revision ${found.head}`);
  }
  if (found.mergeBase) {
    const merged = await git(repo, ['merge-base', '--all', '--end-of-options', base.sha, head.sha], deadline, found.command, 1024);
    const sha = merged.text.trim();
    if (!/^(?:[\da-f]{40}|[\da-f]{64})$/.test(sha)) throw refused(found.command, 'no unique merge base');
    base = { ...base, sha };
  }
  const compare = [...diffOptions, base.sha, head.sha, '--', ...found.paths];
  const statuses = await git(repo, ['diff', '--name-status', '-z', ...compare], deadline, found.command, DIFF_LIMITS.inputBytes);
  const list = await git(repo, ['diff', '--numstat', '-z', ...compare], deadline, found.command, DIFF_LIMITS.inputBytes);
  const files = fileList(list.text, statuses.text, found.command);
  const commits = await rangeCommits(repo, base.sha, head.sha, found.paths, deadline, found.command);
  const diff: ReportDiff = { source: { command: found.command, repo, base, head, paths: found.paths }, commits, files, patch: '' };
  // The commits listed give way to the file list where both cannot fit; their count and title stay.
  if (commits && !acceptsDiffInput(formatReportDiff(diff))) commits.list = [];
  // Reject a list that cannot fit before taking any patch output.
  if (!acceptsDiffInput(formatReportDiff(diff))) throw refused(found.command, 'the complete file list exceeds the display limit; narrow -- paths');
  const patch = await git(repo, ['diff', '--patch', '-U3', ...compare], deadline, found.command, DIFF_LIMITS.inputBytes, true);
  return { text: boundedDiff(diff, patch) };
}

/** Nothing uploads until every named comparison and the expanded description have passed. */
export async function prepareReportDiffs(description: string, cwd: string, commands = findDiffCommands(description)): Promise<PreparedDiffs> {
  const supported = commands.filter(found => found.kind !== 'unsupported');
  if (supported.length > REPORT_DIFF_COMMANDS) throw new Problem(PROBLEM_CODE.invalidInput,
    `A report may attach at most ${REPORT_DIFF_COMMANDS} git diff commands; split this report (${supported.length} commands)`);
  const invalid = commands.find(found => found.kind === 'invalid');
  if (invalid?.kind === 'invalid') throw refused(invalid.command, invalid.reason);
  const deadline = Date.now() + REPORT_DIFF_SECONDS * 1000;
  const files: PreparedDiffs['files'] = [], summaries: DiffSummary[] = [];
  const additions = new Map<number, string[]>(), seen = new Set<string>();
  for (const found of commands) {
    if (found.kind !== 'compare') { summaries.push({ command: found.command, attached: false, reason: found.reason }); continue; }
    const captured = await capture(found, cwd, deadline);
    if ('reason' in captured) { summaries.push({ command: found.command, attached: false, reason: captured.reason }); continue; }
    const { text } = captured;
    // Source command spelling is provenance, not the identity of a comparison within this report.
    const diff = parseReportDiff(text)!;
    const identity = createHash('sha256').update(JSON.stringify([diff.source.repo, diff.source.base.sha, diff.source.head.sha,
      diff.source.paths, diff.files, diff.patch])).digest('hex');
    if (seen.has(identity)) continue;
    seen.add(identity);
    const bytes = Buffer.from(text), digest = createHash('sha256').update(bytes).digest('hex'), path = reportDiffPath(digest);
    files.push({ path, digest, bytes });
    const refs = additions.get(found.after) ?? [];
    refs.push(`![diff](${path})`); additions.set(found.after, refs);
    // The same writer/parser owns the header; this capture's numstat is already validated.
    const rows = diff.files;
    summaries.push({ command: found.command, path, files: rows.length, added: rows.reduce((n, f) => n + (f.added ?? 0), 0),
      deleted: rows.reduce((n, f) => n + (f.deleted ?? 0), 0), omitted: rows.filter(f => !f.kept).length });
  }
  for (const [at, refs] of [...additions].sort(([a], [b]) => b - a))
    description = description.slice(0, at) + (description[at - 1] === '\n' ? '\n' : '\n\n') + refs.join('\n') + '\n\n' + description.slice(at);
  const excess = Array.from(description).length - MAX_DETAIL_LENGTH;
  if (excess > 0) throw new Problem(PROBLEM_CODE.invalidInput,
    `Diff references exceed the ${MAX_DETAIL_LENGTH}-character description limit by ${excess}; shorten the description by ${excess} characters`);
  return { description, files, summaries };
}

/** Uploads share the report's stable identity but never collide with its own receipt. */
export function diffUploadId(opId: string, task: string, digest: string): string {
  const hash = createHash('sha256').update(JSON.stringify(['report-diff', opId, task, digest])).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
