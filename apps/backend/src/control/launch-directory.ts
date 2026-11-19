import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { Problem, PROBLEM_CODE, type ProblemReason } from '@alpacawork/core';

/** A path a person wrote: `~` and `~/…` are under home; anything else is as written. */
export const underHome = (written: string) => written === '~' || written.startsWith('~/') ? join(homedir(), written.slice(1)) : written;

/** Whether a path is below the workspace; callers resolve symlinks before deciding. */
function insideWorkspace(base: string, path: string): boolean {
  const child = relative(base, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

/** Creation also excludes the workspace itself, before mkdir can answer EEXIST. */
export const workspaceContains = (base: string, path: string) => relative(base, path) === '' || insideWorkspace(base, path);

/** Where a Run may start: an existing absolute directory outside the data directory. */
export function launchDirectory(root: string, written: string, field = 'cwd'): string {
  const cwd = underHome(written);
  const invalid = (code: 'absolute_path' | 'missing_directory' | 'not_directory' | 'inside_workspace', message: string, reason: ProblemReason): never => {
    throw new Problem(PROBLEM_CODE.invalidInput, message, undefined, { reason: reason, issues: [{ path: field, code, message }] });
  };
  if (!isAbsolute(cwd)) return invalid('absolute_path', 'cwd must be an absolute path', { kind: 'cwd_must_absolute_path' });
  let resolved: string;
  try {
    if (!statSync(cwd).isDirectory()) return invalid('not_directory', `cwd must be a directory, not a file: ${cwd}`, { kind: 'cwd_must_directory_not_file', cwd: String(cwd) });
    resolved = realpathSync(cwd);
  } catch (error) {
    if (error instanceof Problem) throw error;
    return invalid('missing_directory', `cwd must be an existing directory: ${cwd}`, { kind: 'cwd_must_existing_directory', cwd: String(cwd) });
  }
  if (insideWorkspace(root, cwd) || insideWorkspace(realpathSync(root), resolved))
    return invalid('inside_workspace', 'cwd cannot be inside the task workspace root', { kind: 'cwd_cannot_inside_task_workspace_root' });
  return resolved;
}
