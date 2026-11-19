/** Durability and resumable stages used by migration and recovery. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fsyncSync, openSync, readSync } from 'node:fs';
/** Stream large database backups without allocating their entire contents. */
export function fileHash(file: string): string {
  const hash = createHash('sha256'), buffer = Buffer.alloc(1 << 20), fd = openSync(file, constants.O_RDONLY);
  try { let n; while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, n)); }
  finally { closeSync(fd); }
  return hash.digest('hex');
}
export function syncFile(file: string): void {
  const fd = openSync(file, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function openMaintenanceStage(file: string): number {
  return openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
}
