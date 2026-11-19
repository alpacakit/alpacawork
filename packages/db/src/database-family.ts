/** SQLite family presence. SQLite owns format, integrity and snapshot consistency. */
import { existsSync } from 'node:fs';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
export const DATABASE_SUFFIXES = ['', '-wal', '-shm', '-journal'] as const;
export function checkDatabaseFiles(filename: string, requireMain = false): void {
  if (existsSync(filename)) return;
  if (requireMain) throw new Problem(PROBLEM_CODE.invalidRoot, 'Control database is absent', undefined,
    { reason: { kind: 'control_database_absent' } });
  if (DATABASE_SUFFIXES.slice(1).some(suffix => existsSync(filename + suffix)))
    throw new Problem(PROBLEM_CODE.invalidRoot, 'Orphan SQLite sidecar blocks database initialization', undefined,
      { reason: { kind: 'orphan_sqlite_sidecar_blocks_database_access' } });
}
