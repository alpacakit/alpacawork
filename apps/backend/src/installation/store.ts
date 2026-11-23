/** Installation facts, serialized with a single OS lock. Workspace identity belongs to SQLite. */
import { closeSync, constants, fsyncSync, openSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PUBLIC_HOST_PATTERN } from '@alpacawork/contract/inputs';
import { userConfigDirectory } from '@alpacawork/cli-kit';
import { faultReason, hasCode, Problem, PROBLEM_CODE, tryLock } from '@alpacawork/core';
import { readControlWorkspaceIdentity } from '@alpacawork/db';
import { absolutePath, assertProductDirectory } from './files.js';
const absolute = z.string().refine(value => {
  try { absolutePath(value); return true; } catch { return false; }
}, 'Expected an absolute path');
export const installationVersion = 4 as const;
const serviceSettingsSchema = z.object({ name: z.string().min(1), port: z.number().int().min(1).max(65535),
  publicHost: z.string().regex(PUBLIC_HOST_PATTERN).nullable(), environmentPath: z.string(), mcp: z.literal(true).optional() }).strict();
const installationSchema = z.object({
  version: z.literal(installationVersion), home: absolute,
  uid: z.number().int().nonnegative(), nodeExecutable: absolute, releases: absolute.nullable(),
  workspace: absolute, workspaceIdentity: z.string().uuid(), service: serviceSettingsSchema.nullable(),
}).strict();
export type Installation = z.infer<typeof installationSchema>;
export type InstallationFacts = Pick<Installation, 'home' | 'uid' | 'nodeExecutable' | 'releases'>;

export function installationPath(env: Readonly<Record<string, string | undefined>>): string {
  return absolutePath(join(userConfigDirectory(env), 'installation.json'));
}
const RECORD_REPAIR = 'Stop serve before changing it; see skills/alpacawork/references/troubleshoot.md#installation-record';
function parse(data: Buffer): Installation {
  try { return installationSchema.parse(JSON.parse(data.toString('utf8'))); }
  catch (cause) { throw new Problem(PROBLEM_CODE.invalidInput, `Invalid installation record; inspect it before selecting a workspace. ${RECORD_REPAIR}`, undefined,
    { cause, reason: { kind: 'installation_record_invalid' } }); }
}
/** Installation identity accepts the DB Owner's known migration prefixes without advancing them. */
export function workspaceIdentity(root: string): string {
  return z.string().uuid().parse(readControlWorkspaceIdentity(root, { busyTimeoutMs: 1000 }));
}
function assertInstallationUser(record: Installation): void {
  if (record.uid !== process.getuid!()) throw new Problem(PROBLEM_CODE.unsafePath, `Installation belongs to another user. ${RECORD_REPAIR}`, undefined,
    { reason: { kind: 'installation_user_mismatch' } });
}
export function assertInstallationIdentity(record: Installation): void {
  assertInstallationUser(record);
  try {
    if (workspaceIdentity(record.workspace) === record.workspaceIdentity) return;
  } catch (cause) {
    throw new Problem(PROBLEM_CODE.conflict, `Recorded workspace is missing or unreadable: ${record.workspace}. ${RECORD_REPAIR}`, undefined,
      { cause, reason: { kind: 'installation_workspace_changed', path: record.workspace } });
  }
  throw new Problem(PROBLEM_CODE.conflict, `Recorded workspace identity changed: ${record.workspace}. ${RECORD_REPAIR}`, undefined,
    { reason: { kind: 'installation_workspace_changed', path: record.workspace } });
}
export class InstallationStore {
  readonly path: string;
  private readonly lockPath: string;
  constructor(path: string) { this.path = absolutePath(path); this.lockPath = join(dirname(this.path), 'installation.lock'); }
  prepareDirectory(home: string, expected: Installation | null): void {
    assertProductDirectory(dirname(this.path), home);
    if (JSON.stringify(this.read()) !== JSON.stringify(expected))
      throw new Problem(PROBLEM_CODE.conflict, 'Installation record changed after confirmation; inspect before retrying', undefined,
        { reason: { kind: 'installation_record_changed' } });
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
  }
  read(): Installation | null {
    let data: Buffer;
    try { data = readFileSync(this.path); }
    catch (error) { if (hasCode(error, 'ENOENT')) return null; throw error; }
    try {
      if (data.length > 16 * 1024) throw new Error('Installation record is too large');
      const record = parse(data); assertInstallationUser(record); return record;
    } catch (cause) { throw new Problem(PROBLEM_CODE.readFailed,
      `Cannot read installation: ${this.path}: ${cause instanceof Error ? cause.message : String(cause)}`, undefined,
      { cause, reason: { kind: 'installation_record_unavailable', path: this.path, cause: faultReason(cause) } }); }
  }
  /** The lock is never unlinked: all concurrent setup invocations lock the same OS file. */
  async locked<T>(work: (record: Installation | null, publish: (next: Installation) => void) => Promise<T>): Promise<T> {
    this.read();
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = openSync(this.lockPath, constants.O_RDWR | constants.O_CREAT, 0o600);
    try {
      if (!tryLock(lock)) throw new Problem(PROBLEM_CODE.conflict, 'Another installation operation is running; retry after it finishes', undefined,
        { reason: { kind: 'installation_busy' } });
      const before = this.read();
      return await work(before, next => {
        const record = installationSchema.parse(next); assertInstallationIdentity(record);
        const check = () => {
          if (JSON.stringify(this.read()) !== JSON.stringify(before))
            throw new Problem(PROBLEM_CODE.conflict, 'Installation record changed; inspect before retrying', undefined,
              { reason: { kind: 'installation_record_changed' } });
        };
        check();
        const temporary = join(dirname(this.path), `.installation-${randomUUID()}.tmp`);
        let published = false;
        try {
          const file = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
          try { writeFileSync(file, JSON.stringify(record) + '\n'); fsyncSync(file); } finally { closeSync(file); }
          this.checkpoint('before_publish'); check();
          renameSync(temporary, this.path); published = true;
          this.checkpoint('after_publish');
          const directory = openSync(dirname(this.path), constants.O_RDONLY | constants.O_DIRECTORY);
          try { fsyncSync(directory); } finally { closeSync(directory); }
          if (JSON.stringify(this.read()) !== JSON.stringify(record)) throw new Error('Installation verification failed');
        } catch (cause) {
          if (published) throw new Problem(PROBLEM_CODE.saveUnconfirmed, `Installation may have been saved: ${this.path}; inspect before retrying`, undefined,
            { cause, reason: { kind: 'installation_save_unconfirmed', path: this.path } });
          throw cause;
        } finally { try { unlinkSync(temporary); } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; } }
      });
    } finally { closeSync(lock); }
  }
  checkpoint(_point: 'before_publish' | 'after_publish'): void { /* Process termination seam. */ }
}
