import { syncFile } from '@alpacawork/db';
/** The RAW write Owner: OS lock, request comparison and atomic file publication. */
import { openSync, closeSync, fstatSync, readSync, writeSync, fsyncSync, constants, type Stats, type BigIntStats, mkdirSync, readdirSync, statSync, linkSync, unlinkSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PROBLEM_CODE, Problem, hasCode, tryLock, unlock } from '@alpacawork/core';
import {
  MAX_DOCUMENT,
  META_DIRECTORY,
  CONFIG_FILE,
  WORKSPACE_MARKER,
  digest,
} from '@alpacawork/raw';
const PLACEMENT_JOURNAL = /^placement-([0-9a-f]{32})-journal$/;
function managedPath(path: string) {
  if (path !== CONFIG_FILE)
    throw new Problem(PROBLEM_CODE.unsafePath, 'Only managed workspace files are accepted', undefined, { reason: { kind: 'only_managed_workspace_files_accepted' } });
}
function resolvedRoot(root: string): string {
  const absolute = resolve(root === '~' ? homedir() : root.startsWith('~/') ? homedir() + root.slice(1) : root);
  if (absolute === '/') throw new Problem(PROBLEM_CODE.unsafePath, 'Filesystem root cannot be a task root', undefined,
    { reason: { kind: 'filesystem_root_cannot_task_root' } });
  return absolute;
}
/** The same file attributes name the version in a Task listing and in a byte response. */
export function fileRevision(stat: Pick<Stats, 'size' | 'mtimeMs' | 'ctimeMs'>): string {
  return `${stat.size.toString(16)}-${Math.round(stat.mtimeMs * 1000).toString(16)}-${Math.round(stat.ctimeMs * 1000).toString(16)}`;
}

export type OpenedFile = { fd: number; size: number; revision: string };

function openFile(parent: string, name: string): number | null {
  try { return openSync(join(parent, name), constants.O_RDONLY | constants.O_NONBLOCK); }
  catch (error) { if (hasCode(error, 'ENOENT')) return null; throw error; }
}

export function checkFileSize(size: number, max: number): void {
  if (size > max) throw new Problem(PROBLEM_CODE.tooLarge, 'File exceeds size limit', undefined, { reason: { kind: 'file_exceeds_size_limit' } });
}

/** Read at most the limit, even if the opened file grows after its stat. */
export function readOpenedFile(fd: number, size: number, max: number): Buffer {
  checkFileSize(size, max);
  const limit = max + 1;
  let data = Buffer.allocUnsafe(Math.min(limit, size + 1));
  let n = 0;
  for (;;) {
    if (n === data.length) {
      if (data.length === limit) break;
      const expanded = Buffer.allocUnsafe(limit);
      data.copy(expanded, 0, 0, n);
      data = expanded;
    }
    const count = readSync(fd, data, n, data.length - n, null);
    if (!count) break;
    n += count;
  }
  checkFileSize(n, max);
  return data.subarray(0, n);
}

export class FileWriter {
  readonly root: string;
  readonly meta: string;
  lockFd = -1;
  constructor(root: string, create = false) {
    this.root = resolvedRoot(root);
    this.meta = join(this.root, META_DIRECTORY);
    if (create) mkdirSync(this.root, { recursive: true, mode: 0o700 });
    else statSync(this.root);
    mkdirSync(this.meta, { recursive: true, mode: 0o700 });
    this.lockFd = openSync(join(this.meta, 'lock'), constants.O_RDWR | constants.O_CREAT, 0o600);
  }
  /** The exclusive metadata directory claim elects one initializer. Existing bytes are preserved. */
  static createFresh(root: string): FileWriter {
    const absolute = resolvedRoot(root);
    mkdirSync(absolute, { recursive: true, mode: 0o700 });
    if (readdirSync(absolute).length !== 0)
      throw new Problem(PROBLEM_CODE.invalidRoot, 'Workspace initialization requires an empty directory; existing bytes are preserved', undefined,
        { reason: { kind: 'workspace_initialization_requires_empty_directory' } });
    mkdirSync(join(absolute, META_DIRECTORY), { mode: 0o700 });
    syncFile(absolute);
    return new FileWriter(absolute);
  }
  close() { if (this.lockFd >= 0) { closeSync(this.lockFd); this.lockFd = -1; } }
  regular(fd: number, info: Stats | BigIntStats = fstatSync(fd)) {
    if (!info.isFile()) throw new Problem(PROBLEM_CODE.invalidInput, 'Expected a regular file', undefined,
      { reason: { kind: 'expected_regular_file' } });
  }
  directory(relative: string): string {
    if (relative && relative.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0')))
      throw new Problem(PROBLEM_CODE.unsafePath, 'Invalid managed directory', undefined, { reason: { kind: 'invalid_managed_directory' } });
    const directory = join(this.root, relative);
    if (!statSync(directory).isDirectory()) throw Object.assign(new Error('Expected a directory'), { code: 'ENOTDIR' });
    return directory;
  }
  entries(directory: string) {
    return readdirSync(directory, { withFileTypes: true }).map(entry => ({ name: entry.name,
      type: entry.isDirectory() ? 4 : entry.isFile() ? 8 : entry.isSymbolicLink() ? 10 : 0 }));
  }
  /** The caller owns the descriptor. Its stat describes the same file from which it reads. */
  openVersionedAt(parent: string, name: string): OpenedFile | null {
    const fd = openFile(parent, name);
    if (fd === null) return null;
    try {
      this.checkpoint('after_open');
      const stat = fstatSync(fd);
      this.regular(fd, stat);
      if (!Number.isSafeInteger(stat.size) || stat.size < 0)
        throw new Problem(PROBLEM_CODE.tooLarge, 'File size cannot be represented safely', undefined, { reason: { kind: 'file_size_cannot_represented_safely' } });
      return { fd, size: stat.size, revision: fileRevision(stat) };
    } catch (error) { closeSync(fd); throw error; }
  }
  readAt(parent: string, name: string, max = MAX_DOCUMENT): Buffer | null {
    return this.readStampedAt(parent, name, max)?.data ?? null;
  }
  /**
   * Reads like readAt and names the version read by a stamp: device, inode, size and the
   * nanosecond mtime and ctime of the opened file. When `known` equals that stamp the bytes are
   * not read and `data` is null. Writers publish by rename, so a new version is a new inode.
   */
  readStampedAt(parent: string, name: string, max = MAX_DOCUMENT, known?: string): { stamp: string; data: Buffer | null } | null {
    const fd = openFile(parent, name);
    if (fd === null) return null;
    try {
      this.checkpoint('after_open');
      const info = fstatSync(fd, { bigint: true });
      this.regular(fd, info);
      const stamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
      if (stamp === known) return { stamp, data: null };
      return { stamp, data: readOpenedFile(fd, Number(info.size), max) };
    } finally {
      closeSync(fd);
    }
  }
  read(path: string) {
    managedPath(path);
    return this.readAt(this.root, path, MAX_DOCUMENT);
  }
  /** Exclusion without ordinary draft recovery, also used by the integrated maintenance Owner. */
  async exclusive<T>(run: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + 3000;
    for (;;) {
      if (tryLock(this.lockFd)) break;
      if (Date.now() >= deadline)
        throw new Problem(PROBLEM_CODE.busy, 'Root is in use; retry after the current operation', undefined, { reason: { kind: 'root_use_retry_after_current_operation' } });
      await delay(10);
    }
    try { return await run(); } finally { unlock(this.lockFd); }
  }
  async locked<T>(run: () => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      for (const directory of [this.root, this.meta]) {
        for (const { name } of this.entries(directory))
          if (/^pending-[0-9a-f]{32}$/.test(name) || directory === this.meta && /^placement-[0-9a-f]{32}-draft$/.test(name))
            unlinkSync(join(directory, name));
      }
      return await run();
    });
  }
  checkpoint(_point: string): void {
    /* Inert process-termination seam; no policy is selected here. */
  }
  private unlink(name: string) {
    try {
      unlinkSync(join(this.meta, name));
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
  }
  private writeExclusive(parent: string, name: string, data: Buffer) {
    const fd = openSync(join(parent, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      let position = 0;
      while (position < data.length) {
        const n = writeSync(fd, data, position, data.length - position, null);
        if (!n) throw new Error('Zero-byte write');
        position += n;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  /** Publish a completed new file in this workspace, with no replacement of any existing entry. */
  createFile(parent: string, name: string, data: Buffer): void {
    if (![this.root, this.meta].includes(parent) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name))
      throw new Problem(PROBLEM_CODE.unsafePath, 'Invalid new workspace file', undefined,
        { reason: { kind: 'new_workspace_file_invalid' } });
    const temporary = 'pending-' + randomUUID().replaceAll('-', '');
    let published = false;
    try {
      this.writeExclusive(this.meta, temporary, data);
      this.checkpoint('before_replace');
      linkSync(join(this.meta, temporary), join(parent, name));
      published = true;
      unlinkSync(join(this.meta, temporary));
      this.checkpoint('after_replace');
      syncFile(parent); syncFile(this.meta);
      if (!this.readAt(parent, name, data.length)?.equals(data)) throw new Error('New workspace file verification failed');
    } catch (cause) {
      if (published) throw new Problem(PROBLEM_CODE.saveUnconfirmed, 'New workspace file may have been saved; inspect before retrying', undefined,
        { cause, reason: { kind: 'new_workspace_file_save_unconfirmed' } });
      throw cause;
    } finally { this.unlink(temporary); }
  }
  /** Private, durable placement intent. The Task lock must be held by the caller. */
  placementIntents(): { id: string; data: Buffer }[] {
    return this.entries(this.meta).flatMap(({ name }) => {
      const match = PLACEMENT_JOURNAL.exec(name);
      if (!match) return [];
      const data = this.readAt(this.meta, name, 16 * 1024);
      if (data === null) throw new Problem(PROBLEM_CODE.saveUnconfirmed, 'Placement intent disappeared', undefined, { reason: { kind: 'placement_intent_disappeared' } });
      return [{ id: match[1]!, data }];
    });
  }
  savePlacementIntent(id: string, data: Buffer): void {
    if (!/^[0-9a-f]{32}$/.test(id) || data.length > 16 * 1024)
      throw new Problem(PROBLEM_CODE.invalidInput, 'Invalid placement intent', undefined, { reason: { kind: 'invalid_placement_intent' } });
    const draft = `placement-${id}-draft`;
    this.writeExclusive(this.meta, draft, data);
    renameSync(join(this.meta, draft), join(this.meta, `placement-${id}-journal`));
    syncFile(this.meta);
  }
  removePlacementIntent(id: string): void {
    if (!/^[0-9a-f]{32}$/.test(id)) throw new Problem(PROBLEM_CODE.invalidInput, 'Invalid placement intent ID', undefined, { reason: { kind: 'invalid_placement_intent_id' } });
    this.unlink(`placement-${id}-journal`);
    syncFile(this.meta);
  }
  initialize() {
    this.createFile(this.meta, WORKSPACE_MARKER, Buffer.alloc(0));
  }
  checkExpected(path: string, expected: string | null) {
    const current = this.read(path);
    if ((current === null ? null : digest(current)) !== expected)
      throw new Problem(PROBLEM_CODE.conflict, 'File changed; reload before retrying', { path }, { reason: { kind: 'file_changed_reload_before_retrying' } });
  }
  save(path: string, before: string | null, after: Buffer) {
    managedPath(path);
    if (after.length > MAX_DOCUMENT)
      throw new Problem(PROBLEM_CODE.tooLarge, 'Document exceeds size limit', undefined, { reason: { kind: 'document_exceeds_size_limit' } });
    this.checkExpected(path, before);
    const temp = 'pending-' + randomUUID().replaceAll('-', '');
    let published = false;
    try {
      this.writeExclusive(this.root, temp, after);
      this.checkpoint('before_replace');
      this.checkExpected(path, before);
      if (before === null) {
        linkSync(join(this.root, temp), join(this.root, path));
        published = true;
        unlinkSync(join(this.root, temp));
      } else {
        renameSync(join(this.root, temp), join(this.root, path));
        published = true;
      }
      this.checkpoint('after_replace');
      syncFile(this.root);
      syncFile(this.meta);
      const current = this.read(path);
      if (current === null || digest(current) !== digest(after))
        throw new Problem(PROBLEM_CODE.saveUnconfirmed, 'Document changed during save verification; inspect current files before retrying', { path },
          { reason: { kind: 'document_changed_during_save_verification_inspect_current_files_before_retrying' } });
    } catch (cause) {
      if (published && !(cause instanceof Problem && cause.code === PROBLEM_CODE.saveUnconfirmed))
        throw new Problem(PROBLEM_CODE.saveUnconfirmed, 'Document may have been saved; inspect current files before retrying', { path },
          { reason: { kind: 'document_may_have_been_saved_inspect_current_files_before_retrying' }, cause });
      throw cause;
    } finally {
      try { unlinkSync(join(this.root, temp)); } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
    }
  }
}
