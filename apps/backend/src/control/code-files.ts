/**
 * The files of a project's code location a Task's words name (an absolute path in a report or a body), read for the
 * screen's viewer. Read only, and only inside the places this PC registered for the projects the Task is in and, where
 * such a place is a git repository, the checkouts git really keeps for it. Never inside git's own folder (its config
 * may hold secrets) or alpacawork's data, never past a link or `..` to anywhere else: what is judged is where the file
 * really is, before it is opened and again where it was opened. No git process runs: a worktree is found from the
 * repository's `worktrees/<name>/gitdir` and counts only when that checkout's `.git` points back to the same entry. A
 * file is opened without waiting (a named pipe answers at once) and read only when it is a regular file, at most to the
 * attachment limit; one that is not text is refused.
 */
import { closeSync, constants, fstatSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { Problem, PROBLEM_CODE, type ProblemReason } from '@alpacawork/core';
import { attachmentLimit, fileTooLarge } from '../agents-settings.js';
import { chainLocations } from './project-settings.js';

/** How many worktrees of one repository are looked at: enough for any working set, bounded for a strange one. */
const WORKTREES = 256;
/** How much of a `.git` or `gitdir` file is read: a path, not a document. */
const POINTER_BYTES = 4096;

const real = (path: string): string | null => { try { return realpathSync(path); } catch { return null; } };
const isDirectory = (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } };
/** Whether `path` is `top` or lies under it. */
const within = (path: string, top: string) => path === top || path.startsWith(top.endsWith(sep) ? top : top + sep);
const inGitFolder = (path: string) => path.split(sep).includes('.git');

/**
 * A regular file opened for reading, without waiting on what is no regular file (a named pipe, a device) and without
 * following a last link; null for anything else. The caller closes it.
 */
function openRegular(path: string): number | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try { if (fstatSync(fd).isFile()) return fd; } catch { /* closed below */ }
  closeSync(fd);
  return null;
}
/** At most `limit` + 1 bytes of an open file: one more than allowed says it is too large, however it grows. */
function readBounded(fd: number, limit: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= limit) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, limit + 1 - total));
    const length = readSync(fd, chunk, 0, chunk.length, null);
    if (!length) break;
    chunks.push(chunk.subarray(0, length)); total += length;
  }
  return Buffer.concat(chunks, total);
}
/** The first line of a small regular file (a `.git` or `gitdir` file), or null. */
function pointer(path: string): string | null {
  const fd = openRegular(path);
  if (fd === null) return null;
  try { return readBounded(fd, POINTER_BYTES).toString('utf8').split('\n')[0]!.trim(); } finally { closeSync(fd); }
}
const gitdirOf = (top: string) => /^gitdir: (.+)$/.exec(pointer(join(top, '.git')) ?? '')?.[1] ?? null;

/**
 * Where no checkout may be: inside git's own folder, or at or above a place it would open wholly (this PC's home,
 * alpacawork's data, the registered location it was found from: a registered location's checkout is beside it or in it,
 * never what holds it).
 */
const refusedTop = (top: string, guarded: readonly string[]) => inGitFolder(top) || guarded.some(place => within(place, top));

/**
 * The checkouts of the repository whose own folder is `common` (`<repo>/.git`): its main one, and each worktree whose
 * `.git` names the same entry of `common/worktrees` back. Anything a `gitdir` file names without that answer is not one.
 */
function checkouts(common: string): string[] {
  const found = [dirname(common)];
  let names: string[] = [];
  try { names = readdirSync(join(common, 'worktrees')).slice(0, WORKTREES); } catch { /* no worktrees */ }
  for (const name of names) {
    const entry = real(join(common, 'worktrees', name));
    const named = entry && pointer(join(entry, 'gitdir'));
    if (!entry || !named || !isAbsolute(named) || basename(named) !== '.git') continue;
    const top = real(dirname(named));
    const back = top && gitdirOf(top);
    if (top && back && real(isAbsolute(back) ? back : resolve(top, back)) === entry) found.push(top);
  }
  return found;
}

/**
 * The repository's own folder for the checkout at `top`: its `.git` folder; or, for a worktree, the folder holding the
 * `worktrees/<name>` entry its `.git` file names, when that entry's `gitdir` names `top` back. Null otherwise.
 */
function commonFolder(top: string): string | null {
  const dotGit = join(top, '.git');
  // A repository's own folder is the `.git` folder in it, not a link to one elsewhere.
  if (isDirectory(dotGit)) return real(dotGit) === dotGit ? dotGit : null;
  const named = gitdirOf(top);
  const entry = named ? real(isAbsolute(named) ? named : resolve(top, named)) : null;
  if (!entry || basename(dirname(entry)) !== 'worktrees') return null;
  const common = dirname(dirname(entry));
  const back = pointer(join(entry, 'gitdir'));
  return basename(common) === '.git' && back && isAbsolute(back) && real(dirname(back)) === top ? common : null;
}

/** The real places a Task's words may name files in: its projects' code locations and, for a git one, its checkouts. */
export function codeRoots(root: string, taskId: string): string[] {
  const data = real(root) ?? root, home = real(homedir()) ?? homedir();
  const roots = new Set<string>();
  for (const location of chainLocations(root, taskId)) {
    const top = real(location);
    // What this PC registered is read as registered (alpacawork's data in it never is: readCodeFile); not git's own folder.
    if (!top || !isDirectory(top) || inGitFolder(top)) continue;
    roots.add(top);
    const common = commonFolder(top);
    if (!common) continue;
    for (const checkout of checkouts(common)) if (checkout === top || !refusedTop(checkout, [home, data, top])) roots.add(checkout);
  }
  return [...roots];
}

const refuse = (code: typeof PROBLEM_CODE[keyof typeof PROBLEM_CODE], message: string, reason: ProblemReason) => new Problem(code, message, undefined, { reason });

/** A file of a Task's code locations, as text (a leading BOM is not its text); refused, with why, for any other path. */
export const readCodeFile = (root: string, taskId: string, path: string): string => new TextDecoder().decode(readCodeBytes(root, taskId, path));

/**
 * A file of a Task's code locations as it is stored, its bytes saved as they are; refused, with why, wherever it would
 * not be read as text (readCodeFile).
 */
export function readCodeBytes(root: string, taskId: string, path: string): Buffer {
  if (!isAbsolute(path) || path.includes('\0'))
    throw refuse(PROBLEM_CODE.invalidInput, 'Write an absolute path', { kind: 'code_file_outside', path });
  const data = real(root) ?? root;
  const roots = codeRoots(root, taskId);
  const outside = () => refuse(PROBLEM_CODE.forbidden, `Outside the project's working folder: ${path}`, { kind: 'code_file_outside', path });
  /** Why a real place may not be read, or null: what every check before and after opening asks. */
  const refusal = (place: string): Problem | null => {
    const top = roots.find(each => within(place, each) && place !== each);
    if (!top || within(place, data)) return outside();
    if (inGitFolder(place.slice(top.length))) return refuse(PROBLEM_CODE.forbidden, `Files in git's own folder are not read: ${path}`, { kind: 'code_file_in_git_folder', path });
    return null;
  };
  // A path is judged where it really is. One that names nothing is judged by its folder, so a path outside answers the
  // same whether or not something is there.
  const target = real(path);
  if (!target) {
    const folder = real(dirname(path));
    const problem = folder ? refusal(join(folder, basename(path))) : outside();
    throw problem ?? refuse(PROBLEM_CODE.notFound, `No such file: ${path}`, { kind: 'code_file_missing', path });
  }
  const before = refusal(target);
  if (before) throw before;
  const fd = openRegular(target);
  if (fd === null) throw refuse(PROBLEM_CODE.notFound, `No such file: ${path}`, { kind: 'code_file_missing', path });
  let bytes: Buffer;
  try {
    // Judged again where it was opened: a folder on the way swapped for a link meanwhile leads nowhere else.
    const after = refusal(openedPlace(fd, target));
    if (after) throw after;
    // A file of more than one name may be one outside under a name inside: no path tells them apart, so none is read.
    if (fstatSync(fd).nlink > 1) throw refuse(PROBLEM_CODE.forbidden, `Shares its contents with another place: ${path}`, { kind: 'code_file_shared', path });
    const limit = attachmentLimit(root);
    if (fstatSync(fd).size > limit) throw fileTooLarge(limit);
    bytes = readBounded(fd, limit);
    if (bytes.length > limit) throw fileTooLarge(limit);
  } finally { closeSync(fd); }
  // Text only: no NUL, and UTF-8 throughout.
  const text = !bytes.includes(0) && (() => { try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true; } catch { return false; } })();
  if (!text) throw refuse(PROBLEM_CODE.invalidInput, `Not a text file: ${path}`, { kind: 'code_file_binary', path });
  return bytes;
}

/**
 * Where an open file is: the system's own record of the descriptor where it keeps one (Linux), else the real place of
 * `target` when it is the very file opened (same device and inode); an empty answer, refused, when neither holds.
 */
function openedPlace(fd: number, target: string): string {
  try { return readlinkSync(`/proc/self/fd/${fd}`); } catch { /* no /proc */ }
  const now = real(target);
  if (!now) return '';
  try {
    const opened = fstatSync(fd), there = statSync(now);
    return opened.dev === there.dev && opened.ino === there.ino ? now : '';
  } catch { return ''; }
}
