/** Workspace identity and the closed set of derived control synchronization files. */
import { dirname, join, resolve } from 'node:path';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';

const synchronizationFiles = {
  writer: '.alpacawork/writer.lock',
  fileWriter: '.alpacawork/lock',
  // The former common opener could create this inode. It is never unlinked or created now.
  databaseStartup: '.alpacawork/alpacawork.sqlite.lock',
} as const;
export const controlWriterPath = (root: string) => join(root, synchronizationFiles.writer);
export const isControlSynchronizationFile = (relative: string): boolean =>
  Object.values(synchronizationFiles).some(path => path === relative);
export const controlDatabasePath = (root: string) => join(root, '.alpacawork', 'alpacawork.sqlite');
/** Common control APIs refer to the single workspace database, never an unrelated arbitrary file. */
export function controlRootFromDatabasePath(filename: string): string {
  const absolute = resolve(filename), root = dirname(dirname(absolute));
  if (absolute !== controlDatabasePath(root)) {
    const message = 'Control database must use its workspace path';
    throw new Problem(PROBLEM_CODE.invalidInput, message, undefined,
      { reason: { kind: 'validation_error', issues: [{ code: 'custom', path: 'filename', diagnostic: message }] } });
  }
  return root;
}

export const automationSecretsTables: readonly string[] = ['automation_secrets', 'automation_destination_secrets'];
