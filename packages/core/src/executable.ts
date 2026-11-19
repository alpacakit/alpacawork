/** Resolve executable files without a shell. Explicit locations never fall back to PATH. */
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';
import type { ExecutableIssue } from './business-reasons.js';
export type { ExecutableIssue } from './business-reasons.js';
const messages: Record<ExecutableIssue, string> = { not_absolute: 'Executable path must be absolute', not_found: 'Executable was not found', not_file: 'Executable path is not a file', not_executable: 'Executable is not accessible or executable' };
export function executableIssue(path: string): ExecutableIssue | null {
  try {
    if (!isAbsolute(path)) return 'not_absolute';
    if (!statSync(path).isFile()) return 'not_file';
    accessSync(path, constants.X_OK);
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'not_found';
    if (code === 'EACCES' || code === 'EPERM') return 'not_executable';
    throw error;
  }
}
export function executableCandidates(command: string, path: string, cwd = process.cwd()): string[] {
  return [...new Set(path.split(delimiter).map(directory => resolve(cwd, directory, command)))].filter(path => executableIssue(path) === null);
}
export class ExecutableUnavailable extends Error {
  constructor(readonly path: string, readonly detail: ExecutableIssue) { super(`${messages[detail]}: ${path}`); }
}
export function resolveExecutable(command: string, explicit: string | undefined, path: string, cwd = process.cwd()): string {
  const target = explicit ?? executableCandidates(command, path, cwd)[0];
  const issue = target ? executableIssue(target) : 'not_found';
  if (issue) throw new ExecutableUnavailable(target ?? command, issue);
  return target!;
}
