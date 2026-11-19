/**
 * This PC's folders as a person picks one for a project's code: the folders in one folder, by name. It reads no file
 * and no file's name, and can make one child folder. A Run cannot ask (both entries require a person's connection).
 * Disk operations are asynchronous, so a slow mount holds only this answer.
 */
import { mkdir, realpath, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { PROBLEM_CODE, Problem, parseInput, type ProblemReason } from '@alpacawork/core';
import { ControlStore } from '@alpacawork/db';
import { makeFolderInput, type Folders, type MadeFolder } from '@alpacawork/contract';
import { workspaceContains, underHome } from './launch-directory.js';
import { ownLocations } from './project-settings.js';

/** At most this many names in one answer: a folder of thousands is narrowed by typing the start of a name. */
const MAX_FOLDERS = 500;

const invalid = (code: string, message: string, reason?: ProblemReason, field = 'path'): never => {
  throw new Problem(PROBLEM_CODE.invalidInput, message, undefined, {
    reason: reason ?? { kind: 'validation_error', issues: [{ path: field, code, diagnostic: message }] },
    issues: [{ path: field, code, message }],
  });
};

/** A person's new folder: one mkdir, never recursive, and never in the workspace holding the records. */
export async function makeFolder(root: string, input: { path: string; name: string }): Promise<MadeFolder> {
  const { path: written, name } = parseInput(makeFolderInput, input);
  const parent = underHome(written);
  const reject = (code: string, field = 'path'): never => {
    const message = `Cannot make folder ${name} in ${parent}: ${code}`;
    return invalid(code, message, undefined, field);
  };
  if (!isAbsolute(parent)) reject('absolute_path');
  try {
    const destination = join(await realpath(parent), name);
    if (workspaceContains(await realpath(root), destination)) reject('inside_workspace');
    await mkdir(destination);
    return { path: destination };
  } catch (error) {
    if (error instanceof Problem) throw error;
    switch ((error as NodeJS.ErrnoException).code) {
      case 'EEXIST': return reject('folder_exists', 'name');
      case 'EACCES': case 'EPERM': case 'EROFS': return reject('unwritable_directory');
      case 'ENOENT': case 'ENOTDIR': return reject('missing_directory');
      case 'ENAMETOOLONG': return reject('folder_name', 'name');
      case 'ENOSPC': case 'EDQUOT': return reject('no_space');
      default: throw error;
    }
  }
}

const isFolder = async (path: string) => { try { return (await stat(path)).isDirectory(); } catch { return false; } };

/** Where a person starts looking: the folder holding the code of the newest active project with its own, else home. */
async function start(root: string, home: string): Promise<string> {
  let near: string[];
  try {
    const store = new ControlStore(root, { busyTimeoutMs: 1000 }, true);
    try { near = store.read(db => ownLocations(root, db)).map(project => dirname(project.cwd)); }
    finally { store.close(); }
  } catch { return home; }
  for (const folder of near) if (await isFolder(folder)) return folder;
  return home;
}

export async function listFolders(root: string, input: { path?: string; prefix?: string; hidden?: boolean }): Promise<Folders> {
  const home = homedir();
  const written = input.path || await start(root, home);
  if (!isAbsolute(underHome(written))) invalid('absolute_path', 'path must be an absolute path', { kind: 'path_must_absolute_path' });
  const path = resolve(underHome(written));
  let entries;
  try {
    if (!(await stat(path)).isDirectory()) invalid('not_directory', `path must be a directory, not a file: ${path}`, { kind: 'path_must_directory_not_file', path: String(path) });
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Problem) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    return invalid(code === 'EACCES' || code === 'EPERM' ? 'unreadable_directory' : 'missing_directory', `path must be a readable directory: ${path}`, { kind: 'path_must_readable_directory', path: String(path) });
  }
  // A typed start narrows the names before the cut, so a name past the first MAX_FOLDERS is still found.
  const prefix = input.prefix?.toLowerCase() ?? '';
  const named = entries.filter(entry => (input.hidden || !entry.name.startsWith('.')) && entry.name.toLowerCase().startsWith(prefix));
  const folders = (await Promise.all(named.map(async entry =>
    entry.isDirectory() || entry.isSymbolicLink() && await isFolder(join(path, entry.name)) ? [entry.name] : [])))
    .flat().sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  return { path, parent: path === '/' ? null : dirname(path), home,
    folders: folders.slice(0, MAX_FOLDERS), truncated: folders.length > MAX_FOLDERS };
}
