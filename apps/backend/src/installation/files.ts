/** Product path validation, independent of filesystem traversal. */
import { isAbsolute, normalize, relative, sep } from 'node:path';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';

export function absolutePath(value: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || !isAbsolute(value) || normalize(value) !== value || value === '/')
    throw new Problem(PROBLEM_CODE.invalidInput, `Expected an absolute non-root path: ${value}`, undefined,
      { reason: { kind: 'installation_path_invalid', path: value } });
  return value;
}

/** A product directory may not take over HOME or an ancestor merely because its path was supplied. */
export function assertProductDirectory(path: string, home: string): void {
  const child = relative(absolutePath(path), absolutePath(home));
  if (child === '' || child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
    throw new Problem(PROBLEM_CODE.unsafePath, `Product directory must be separate from HOME and its parents: ${path}`);
}
