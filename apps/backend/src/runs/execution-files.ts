/** The execution spool is independent of the database and the current release's Run representation. */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { digestBytes, hasCode, publishImmutable, readImmutable, strictJson } from '@alpacawork/core';
import { commandSchema, eventSchema, launchSchema, PROTOCOL_LIMITS,
  type ExecutionIdentity, type LaunchSnapshot, type RunCommand, type RunEvent, type EventType } from '@alpacawork/contract/run-protocol';

export const executionFolder = (root: string, id: string, attempt: string) => {
  if (!/^R[1-9][0-9]*$/.test(id) || !/^[a-f0-9-]{36}$/.test(attempt)) throw new Error('Invalid execution path identity');
  return join(root, '.alpacawork', 'runs', id, 'protocol', attempt);
};
export const messageName = (seq: number) => `${String(seq).padStart(12, '0')}.json`;
export function names(path: string): string[] {
  try { return readdirSync(path).filter(name => !name.startsWith('tmp-')).sort(); }
  catch (error) { if (hasCode(error, 'ENOENT')) return []; throw error; }
}
const jsonBytes = (value: unknown) => Buffer.from(JSON.stringify(value));
export function sameIdentity(a: ExecutionIdentity, b: ExecutionIdentity): void {
  for (const key of ['protocol', 'workspaceId', 'runId', 'attemptId'] as const)
    if (a[key] !== b[key]) throw new Error(`Execution identity mismatch: ${key}`);
}
export const identityOf = (launch: ExecutionIdentity): ExecutionIdentity => ({ protocol: launch.protocol, workspaceId: launch.workspaceId,
  runId: launch.runId, attemptId: launch.attemptId });
export function readLaunch(root: string, id: string, attempt: string): LaunchSnapshot {
  const launch = launchSchema.parse(strictJson(readImmutable(executionFolder(root, id, attempt), 'launch.json', PROTOCOL_LIMITS.launch)));
  if (launch.runId !== id || launch.attemptId !== attempt) throw new Error('Launch identity mismatch');
  return launch;
}
export function publishLaunch(root: string, launch: LaunchSnapshot): void {
  const parsed = launchSchema.parse(launch), bytes = jsonBytes(parsed);
  if (bytes.length > PROTOCOL_LIMITS.launch) throw new Error('Launch exceeds protocol limit');
  publishImmutable(executionFolder(root, launch.runId, launch.attemptId), 'launch.json', bytes);
}
export function publishCommand(root: string, command: RunCommand): void {
  const parsed = commandSchema.parse(command), bytes = jsonBytes(parsed);
  if (bytes.length > PROTOCOL_LIMITS.command) throw new Error('Command exceeds protocol limit');
  publishImmutable(join(executionFolder(root, command.runId, command.attemptId), 'commands'), messageName(command.seq), bytes);
}
/** Stops are discoverable even behind a missing/corrupt/awaiting input. Validation errors are returned, never ignored. */
export function readCommands(folder: string, identity: ExecutionIdentity): { commands: RunCommand[]; faults: Error[] } {
  const commands: RunCommand[] = [], faults: Error[] = [], path = join(folder, 'commands');
  for (const name of names(path)) try {
    const command = commandSchema.parse(strictJson(readImmutable(path, name, PROTOCOL_LIMITS.command)));
    sameIdentity(command, identity);
    if (messageName(command.seq) !== name) throw new Error('Command sequence/name mismatch');
    if (command.type === 'input' && digestBytes(command.text!) !== command.contentDigest) throw new Error('Command content mismatch');
    commands.push(command);
  } catch (error) { faults.push(error instanceof Error ? error : new Error(String(error))); }
  return { commands, faults };
}
export class EventJournal {
  private seq = 0;
  private digest: string | null = null;
  /** Recovery resumes only an imported, stable prefix while holding manager.lock. */
  constructor(readonly folder: string, readonly identity: ExecutionIdentity,
    cursor?: { nextSeq: number; lastDigest: string | null }) {
    if (cursor) { this.seq = cursor.nextSeq - 1; this.digest = cursor.lastDigest; }
  }
  append<K extends EventType>(type: K, payload: Extract<RunEvent, { type: K }>['payload']): RunEvent {
    const event = eventSchema.parse({ ...this.identity, seq: this.seq + 1, occurredAt: new Date().toISOString(),
      previousDigest: this.digest, type, payload }) as RunEvent;
    const bytes = jsonBytes(event);
    if (bytes.length > PROTOCOL_LIMITS.event) throw new Error('Event exceeds protocol limit');
    publishImmutable(join(this.folder, 'events'), messageName(event.seq), bytes);
    this.seq = event.seq; this.digest = digestBytes(bytes);
    return event;
  }
}
