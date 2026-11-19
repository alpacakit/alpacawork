import { join } from 'node:path';
/** Ordinary access to files inside an existing Run folder. Reads are bounded, except agent output whose size the agent decides. */
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, readSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hasCode, Problem } from '@alpacawork/core';
import { RUN_RESULT_LIMIT } from '@alpacawork/contract/run';

export const RESULT_LIMIT = RUN_RESULT_LIMIT;
/** Largest prompt a caller may submit, counted in UTF-8 bytes. */
export const PROMPT_LIMIT = 256 * 1024;
/** Missing usable content is distinct from an I/O failure. */
export class RunFileRejected extends Error {
  constructor(message: string, readonly reason: 'too_large' | 'unreadable' = 'unreadable', readonly bytes: number | null = null) {
    super(message);
  }
}
/** Missing, oversized and non-regular files are absent; other I/O faults remain visible. */
export function optionalRunFile<T>(read: () => T): T | null {
  try { return read(); }
  catch (error) {
    if (error instanceof RunFileRejected || ['ENOENT', 'ELOOP', 'ENOTDIR'].some(code => hasCode(error, code))) return null;
    throw error instanceof Problem ? error : new Problem('runs_unavailable', 'Run file access failed', undefined, { reason: { kind: 'run_file_access_failed' }, cause: error });
  }
}
export function openRunFile(folder: string, name: string, flags: number): number {
  return openSync(join(folder, name), flags, 0o600);
}
/** The whole file, for agent output whose size only the agent decides. */
export function readWholeRunFile(folder: string, name: string): Buffer {
  const fd = openRunFile(folder, name, constants.O_RDONLY);
  try { return readFileSync(fd); } finally { closeSync(fd); }
}
/** A prefix read never allocates or reads more than limit bytes. */
export function readRunFile(folder: string, name: string, limit: number, prefix = false): Buffer {
  const fd = openRunFile(folder, name, constants.O_RDONLY);
  try {
    const size = fstatSync(fd).size;
    if (!prefix && size > limit) throw new RunFileRejected(`${name} exceeds ${limit} bytes`, 'too_large', size);
    const bytes = Buffer.alloc(limit + (prefix ? 0 : 1));
    let n = 0;
    while (n < bytes.length) {
      const count = readSync(fd, bytes, n, bytes.length - n, null);
      if (!count) break;
      n += count;
    }
    if (!prefix && n > limit) throw new RunFileRejected(`${name} exceeds ${limit} bytes`, 'too_large', n);
    return bytes.subarray(0, n);
  } finally { closeSync(fd); }
}
export function writeRunFile(folder: string, name: string, content: string | Buffer): void {
  const dir = openSync(folder, constants.O_RDONLY | constants.O_DIRECTORY), temp = `${name}-${randomUUID()}.tmp`;
  try {
    const fd = openSync(join(folder, temp), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(join(folder, temp), join(folder, name));
    fsyncSync(dir);
  } finally {
    try { unlinkSync(join(folder, temp)); } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
    finally { closeSync(dir); }
  }
}
