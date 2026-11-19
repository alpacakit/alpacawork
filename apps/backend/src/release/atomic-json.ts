/** Ordinary durable JSON replacement shared by release records; callers own exclusion. */
import { closeSync, fsyncSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openMaintenanceStage, syncFile } from '@alpacawork/db';
export function atomicJson(path: string, value: unknown): void {
  const temporary = path + '.tmp', fd = openMaintenanceStage(temporary);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path); syncFile(join(path, '..'));
}
