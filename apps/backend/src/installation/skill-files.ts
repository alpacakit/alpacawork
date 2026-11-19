/** Ordinary filesystem operations used by the overwrite writer. */
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { withResources } from '@alpacawork/core';
export function syncDirectory(path: string): void {
  withResources(resources => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
    resources.defer(() => closeSync(fd)); fsyncSync(fd);
  });
}
export function readRecord(path: string): unknown | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  return withResources(resources => { resources.defer(() => closeSync(fd)); return JSON.parse(readFileSync(fd, 'utf8')); });
}
export function publishRecord(path: string, value: unknown): void {
  const temporary = path + '.' + randomUUID() + '.tmp';
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  withResources(resources => {
    resources.defer(() => rmSync(temporary, { force: true }));
    withResources(file => {
      const fd = openSync(temporary, 'wx', 0o600);
      file.defer(() => closeSync(fd)); writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd);
    });
    renameSync(temporary, path); syncDirectory(dirname(path));
  });
}
export const exists = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;
