/** The one classification of filesystem entries as Task folders. */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { hasCode } from '@alpacawork/core';
import { TASK_SEGMENT } from '@alpacawork/raw';

type Entry = { name: string; type: number };

/** Classifies a Task directory, a Task link, or an artifact. */
function openTaskEntry(parent: string, { name, type }: Entry): boolean | 'link' | null {
  if (!TASK_SEGMENT.test(name)) return null;
  if (type === 10) return 'link';
  if (type !== 4 && type !== 0) return null;
  try {
    return statSync(join(parent, name)).isDirectory() ? true : null;
  } catch (error) {
    if (hasCode(error, 'ENOTDIR') || hasCode(error, 'ENOENT')) return null;
    if (hasCode(error, 'ELOOP')) return 'link';
    throw error;
  }
}

/** True when an uninitialized root already contains a Task or an unsafe Task link. */
export function hasTaskEntry(parent: string, entries: readonly Entry[]): boolean {
  for (const entry of entries) {
    const opened = openTaskEntry(parent, entry);
    if (opened === 'link') return true;
    if (opened !== null) return true;
  }
  return false;
}
