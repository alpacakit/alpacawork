import { type Stats, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hasCode } from '@alpacawork/core';
import { RUN_FILES } from '@alpacawork/contract/run';
import { RunFileRejected } from '../runs/files.js';
import { tallySchema, type Tally } from '../agents/adapters/tally.js';

const MAX_TALLY = 8 * 1024 * 1024;

export function ordinaryFile<T>(path: string, read: (fd: number, size: number, stat: Stats) => T): T {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new RunFileRejected('Expected a regular Run file');
    return read(fd, stat.size, stat);
  } finally { closeSync(fd); }
}

/** One read of the current cache format, shared with the worker that replaces older versions. */
export type TallyObservation = { tally: Tally; observedAt: number };
export type RunTallyObservation = TallyObservation & { id: string };

export function readRunTally(folder: string): Tally | null {
  return readRunTallyObservation(folder)?.tally ?? null;
}

export function readRunTallyObservation(folder: string): TallyObservation | null {
  try {
    if (!lstatSync(dirname(folder)).isDirectory() || !lstatSync(folder).isDirectory()) return null;
    return ordinaryFile(join(folder, RUN_FILES.tally), (fd, size, stat) => {
      if (size > MAX_TALLY) return null;
      const parsed = tallySchema.safeParse(JSON.parse(readFileSync(fd, 'utf8')));
      return parsed.success ? { tally: parsed.data, observedAt: Math.ceil(stat.mtimeMs) } : null;
    });
  } catch (error) {
    if (error instanceof RunFileRejected || ['ENOENT', 'ELOOP', 'ENOTDIR'].some(code => hasCode(error, code)) || error instanceof SyntaxError) return null;
    throw error;
  }
}
