import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hasCode } from '@alpacawork/core';
import { RUN_FILES } from '@alpacawork/contract/run';
import { tallySchema, type Tally } from '../agents/adapters/tally.js';

const MAX_TALLY = 8 * 1024 * 1024;

export function ordinaryFile<T>(path: string, read: (fd: number, size: number) => T): T {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('Expected a regular Run file');
    return read(fd, stat.size);
  } finally { closeSync(fd); }
}

/** One read of the current cache format, shared with the worker that replaces older versions. */
export function readRunTally(folder: string): Tally | null {
  try {
    if (!lstatSync(dirname(folder)).isDirectory() || !lstatSync(folder).isDirectory()) return null;
    const parsed = ordinaryFile(join(folder, RUN_FILES.tally), (fd, size) => size <= MAX_TALLY
      ? tallySchema.safeParse(JSON.parse(readFileSync(fd, 'utf8'))) : null);
    return parsed?.success ? parsed.data : null;
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'ENOTDIR'].some(code => hasCode(error, code)) || error instanceof SyntaxError) return null;
    throw error;
  }
}
