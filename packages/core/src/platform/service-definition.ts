/** Native definition identity belongs to the service adapter; no installation or release state lives here. */
import { closeSync, constants, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync, mkdirSync, linkSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hasCode } from '../errors.js';
export type ServiceDefinition = { name: string; executable: string; args: string[]; environment: Record<string, string>; workingDirectory: string };
export type ServiceObservation = { state: 'unavailable' | 'absent' | 'matching' | 'conflict'; running: boolean; registrationStarts: boolean };
export type ServiceCommand = (command: string, args: string[]) => { status: number | null; stdout: string; stderr?: string };
export function validateService(definition: ServiceDefinition): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(definition.name) || !isAbsolute(definition.executable) || !isAbsolute(definition.workingDirectory) ||
      !isAbsolute(definition.environment.HOME ?? '') || [...definition.args, ...Object.values(definition.environment), definition.executable, definition.workingDirectory].some(value => /[\x00\r\n]/.test(value)) ||
      Object.keys(definition.environment).some(key => !/^[A-Z_][A-Z0-9_]*$/.test(key))) throw new Error('Invalid service definition');
}
export function definitionText(path: string): string | null {
  try { return readFileSync(path, 'utf8'); }
  catch (error) { if (hasCode(error, 'ENOENT')) return null; throw error; }
}
export function createDefinition(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID() + '.tmp';
  const dir = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    linkSync(temporary, path);
    unlinkSync(temporary);
    fsyncSync(dir);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
    finally { closeSync(dir); }
  }
}
export function removeDefinition(path: string, text: string): void {
  if (definitionText(path) !== text) throw new Error('Service definition changed; retained');
  unlinkSync(path);
  const fd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
