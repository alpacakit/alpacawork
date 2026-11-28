import { join } from 'node:path';
import { closeSync, fstatSync, readFileSync, openSync, constants } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { Problem, PROBLEM_CODE, hasCode } from '@alpacawork/core';
import { validTaskFileName } from '@alpacawork/contract/inputs';
import { taskFileRoute } from '@alpacawork/contract/task-file-route';
import { FileWriter, fileRevision, type OpenedFile } from '../raw/storage.js';
import { requirePublished, FileJournal, fileDigest, isReserved, reservedPaths, type WriteGrant } from './file-journal.js';
import { attachmentLimit, fileTooLarge } from '../agents-settings.js';

function parts(name: string): string[] {
  const segments = name.split('/');
  if (!validTaskFileName(name))
    throw new Problem(PROBLEM_CODE.unsafePath, 'Invalid task file path', undefined, { reason: { kind: 'invalid_task_file_path' } });
  return segments;
}

type File = { name: string; size: number; revision: string; at: string; readable?: false };
/**
 * A server's file lists, Task folder by Task folder, so that a change costs that folder's walk, whatever the number of
 * files in the workspace. A folder is walked again once marked (`invalidate`): by the notification that names it, or,
 * with no folder named, every folder.
 */
export class TaskFileIndex {
  private readonly listed = new Map<string, File[]>();
  private readonly stale = new Set<string>();
  private everything = false;
  /** One Task's folder (`tasks/T42`), or without one every folder. */
  invalidate(folder?: string) {
    if (folder === undefined) this.everything = true;
    else this.stale.add(folder);
  }
  private settleEverything() {
    if (!this.everything) return;
    this.everything = false;
    for (const folder of this.listed.keys()) this.stale.add(folder);
  }
  /**
   * Walk the folders already listed that are marked, one at a time with a turn between them, so a whole repair never
   * holds the event loop for its total. Outside any read transaction: a yielding walk must not hold a read lock.
   */
  async refresh(open: () => FileWriter, turn: () => Promise<void>): Promise<void> {
    this.settleEverything();
    for (const folder of [...this.stale]) {
      if (!this.listed.has(folder)) { this.stale.delete(folder); continue; }
      // A folder that cannot be read stays marked: its project's read meets the fault and reports it, for that project alone.
      try {
        const writer = open();
        try { this.walk(writer, [folder]); } finally { writer.close(); }
      } catch { /* reported by the read */ }
      await turn();
    }
  }
  /** Whether a folder's list differs from what is listed: for changes no notification reports (`work/`). */
  differs(writer: FileWriter, folder: string): boolean {
    const listed = this.listed.get(folder);
    if (!listed) return false;
    return JSON.stringify(taskFiles(writer, [folder]).get(folder)) !== JSON.stringify(listed);
  }
  private walk(writer: FileWriter, folders: readonly string[]) {
    // Unmarked only when the walk succeeded; marks made before it are covered by it, later ones by the next.
    for (const [folder, files] of taskFiles(writer, folders)) { this.listed.set(folder, files); this.stale.delete(folder); }
  }
  read(writer: FileWriter, ids: readonly string[]) {
    this.settleEverything();
    const missing = ids.filter(id => this.stale.has(id) || !this.listed.has(id));
    if (missing.length) this.walk(writer, missing);
    return new Map(ids.map(id => [id, this.listed.get(id)!]));
  }
}

/** Callers can prune a walk without replacing filesystem classification or failure handling. */
type TaskFileSelection = {
  /** Explicit walk origins must open as directories when present; absent origins are empty. */
  directories?: readonly string[];
  descend?: (folder: string, name: string) => boolean;
  include?: (folder: string, name: string) => boolean;
  maxBytes?: number;
  onError?: (path: string, error: unknown) => void;
};
/** Scan once, then give each Task every selected regular file below its folder. */
export function taskFiles(writer: FileWriter, folders: readonly string[]) {
  const files = new Map(folders.map(folder => [folder, [] as File[]]));
  visitTaskFiles(writer, folders, {}, (folder, file) => files.get(folder)!.push(file));
  for (const list of files.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

/** Listing and content readers share Task file classification. */
export function visitTaskFiles(writer: FileWriter, folders: readonly string[], selection: TaskFileSelection,
  onFile: (folder: string, file: File, directory: string, basename: string) => void): void {
  const roots = new Set(folders);
  const directories = new Set<string>();
  for (const origin of selection.directories ?? []) {
    const segments = origin.split('/');
    for (let length = 1; length <= segments.length; length++) directories.add(segments.slice(0, length).join('/'));
  }
  const visit = (directory: string, path: string, owners: readonly string[]) => {
    for (const entry of writer.entries(directory).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.' || entry.name === '..' || ![0, 4, 8].includes(entry.type)) continue;
      const childPath = path ? `${path}/${entry.name}` : entry.name;
      if (!owners.length && !folders.some(folder => folder === childPath || folder.startsWith(`${childPath}/`))) continue;
      const childOwners = roots.has(childPath) ? [...owners, childPath] : owners;
      const include = () => owners.some(owner => selection.include?.(owner, childPath.slice(owner.length + 1)) !== false);
      const descend = () => !childOwners.length || childOwners.some(owner =>
        selection.descend?.(owner, childPath === owner ? '' : childPath.slice(owner.length + 1)) !== false);
      const requiredDirectory = directories.has(childPath);
      // d_type=0 must be opened and classified with fstat, even without a document extension.
      if (!requiredDirectory && (entry.type === 4 && !descend() || entry.type === 0 && !descend() && !include() ||
        entry.type !== 4 && entry.type !== 0 && !include())) continue;
      let fd = -1;
      try {
        if (entry.type === 4 || requiredDirectory) {
          visit(join(directory, entry.name), childPath, childOwners);
        } else {
          fd = openSync(join(directory, entry.name), constants.O_RDONLY | constants.O_NONBLOCK);
          const stat = fstatSync(fd);
          if (stat.isDirectory()) {
            if (descend()) visit(join(directory, entry.name), childPath, childOwners);
            continue;
          }
          if (!include() || selection.maxBytes !== undefined && stat.size > selection.maxBytes) continue;
          if (!stat.isFile()) {
            selection.onError?.(childPath, new Problem(PROBLEM_CODE.unsafePath, 'Expected a regular file',
              undefined, { reason: { kind: 'expected_regular_file_without_hard_links' } }));
            continue;
          }
          for (const owner of owners) {
            const name = childPath.slice(owner.length + 1);
            if (selection.include?.(owner, name) === false) continue;
            onFile(owner, { name, size: stat.size, at: stat.mtime.toISOString(),
              revision: fileRevision(stat) }, directory, entry.name);
          }
        }
      } catch (error) {
        if (requiredDirectory && hasCode(error, 'ENOENT')) continue;
        if (selection.onError) { selection.onError(childPath, error); continue; }
        if (hasCode(error, 'EACCES') && entry.type === 8) {
          for (const owner of owners) onFile(owner, { name: childPath.slice(owner.length + 1),
            size: 0, at: new Date(0).toISOString(), revision: 'unreadable', readable: false }, directory, entry.name);
          continue;
        }
        if (!hasCode(error, 'ELOOP') && !hasCode(error, 'ENOENT') && !hasCode(error, 'ENOTDIR')) throw error;
      } finally { if (fd >= 0) closeSync(fd); }
    }
  };
  visit(writer.root, '', []);
}

async function withTaskFile<T>(root: string, id: string, name: string,
  read: (writer: FileWriter, directory: string, basename: string) => T): Promise<T> {
  const basename = parts(name).at(-1)!;
  const journal = new FileJournal(root);
  const target = journal.taskPath(id, name);
  return journal.withAvailablePath(target, () => {
    const writer = new FileWriter(root);
    let directory = '';
    try {
      directory = writer.directory(target.slice(0, -basename.length - 1));
      return read(writer, directory, basename);
    } catch (error) {
      if (hasCode(error, 'ELOOP') || hasCode(error, 'ENOTDIR'))
        throw new Problem(PROBLEM_CODE.unsafePath, 'Task file path contains a link', undefined, { reason: { kind: 'task_file_path_contains_link' } });
      throw error;
    } finally { writer.close(); }
  });
}

export async function readTaskFile(root: string, id: string, name: string): Promise<Buffer> {
  return withTaskFile(root, id, name, (writer, directory, basename) => {
    const bytes = writer.readAt(directory, basename, attachmentLimit(root));
    if (bytes === null) throw new Problem(PROBLEM_CODE.notFound, 'Task file does not exist', undefined, { reason: { kind: 'task_file_does_not_exist' } });
    return bytes;
  });
}

/** The caller owns the descriptor and closes it after the HTTP response finishes or is cancelled. */
export async function openTaskFile(root: string, id: string, name: string): Promise<OpenedFile> {
  return withTaskFile(root, id, name, (writer, directory, basename) => {
    const file = writer.openVersionedAt(directory, basename);
    if (file === null) throw new Problem(PROBLEM_CODE.notFound, 'Task file does not exist', undefined, { reason: { kind: 'task_file_does_not_exist' } });
    return file;
  });
}

/** An attachment is one file directly in its request's folder. */
const validAttachmentName = (name: string) => validTaskFileName(name) && !name.includes('/');

/** As much of `stem` as fits the 100-byte cap in front of `suffix`, which is always kept whole. */
function fitName(stem: string, suffix: string): string {
  let prefix = '';
  for (const character of stem) {
    if (Buffer.byteLength(prefix + character + suffix) > 100) break;
    prefix += character;
  }
  return prefix + suffix;
}

/** A display name becomes one safe component; its extension survives the 100-byte cap. */
export function attachmentFileName(raw: string): string {
  let name = raw.split(/[\\/]/).at(-1)!.replace(/[\x00-\x1f\x7f/\\]/g, '_').replace(/^\./, '_') || 'file';
  if (Buffer.byteLength(name) > 100) {
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 ? name.slice(dot) : '';
    const suffix = Buffer.byteLength(extension) < 100 ? extension : '';
    name = fitName(name.slice(0, suffix ? dot : undefined), suffix);
  }
  if (!validAttachmentName(name)) throw new Problem(PROBLEM_CODE.invalidInput, 'Invalid attachment name', undefined, { reason: { kind: 'invalid_attachment_name' } });
  return name;
}

function attachmentRequestId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value))
    throw new Problem(PROBLEM_CODE.invalidInput, 'Invalid attachment request ID', undefined, { reason: { kind: 'invalid_attachment_request_id' } });
  return value;
}

/** A request and a DELETE use the same Task lock; check its file paths before reserving a Run. */
export function verifyRequestAttachments(writer: FileWriter, id: string,
  requestId: string, body: string, db?: DatabaseSync): void {
  const folder = new FileJournal(writer.root).taskLocation(id).folder;
  const prefix = `attachments/${requestId}/`;
  const names = body.split('\n').flatMap(line => {
    const path = /^!?\[[^\]]*\]\((\/[^)]*)\)$/.exec(line.trim())?.[1];
    if (!path) return [];
    const url = new URL(path, 'http://localhost');
    const name = url.searchParams.get('path');
    return url.pathname === `/api/tasks/${encodeURIComponent(id)}/file` && name?.startsWith(prefix)
      ? [name.slice(prefix.length)] : [];
  });
  if (!names.length) return;
  if (db && isReserved(reservedPaths(db), `${folder}/attachments/${requestId}`))
    throw new Problem(PROBLEM_CODE.busy, 'Attachment publication is pending', undefined, { reason: { kind: 'attachment_publication_pending' } });
  let directory = '';
  try {
    directory = writer.directory(folder);
    for (const segment of ['attachments', requestId]) {
      directory = join(directory, segment);
    }
    for (const name of names) {
      if (!validAttachmentName(name)) throw new Problem(PROBLEM_CODE.conflict, 'Attached file is missing', undefined, { reason: { kind: 'attached_file_missing' } });
      const fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) throw new Problem(PROBLEM_CODE.conflict, 'Attached file is missing', undefined, { reason: { kind: 'attached_file_missing' } });
      } finally { closeSync(fd); }
    }
  } catch (error) {
    if (hasCode(error, 'ENOENT') || hasCode(error, 'ELOOP') || hasCode(error, 'ENOTDIR'))
      throw new Problem(PROBLEM_CODE.conflict, 'Attached file is missing; remove it from the draft and try again', undefined,
        { reason: { kind: 'attached_file_missing_remove_it_from_draft_and_try_again' } });
    throw error;
  }
}

function collisionName(name: string, number: number): string {
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot) : '';
  return fitName(name.slice(0, extension ? dot : undefined), `-${number}${extension}`);
}

/**
 * Attachment changes share FileJournal's path reservations and receipt boundary. `same` says a file holds `like`;
 * only files of its size are read, so a request folder of large files is not held in memory to save one more.
 */
function attachmentFiles(root: string, id: string, requestId: string, like?: Buffer): { name: string; size: number; same: boolean }[] {
  const path = new FileJournal(root).taskPath(id, `attachments/${requestId}/probe`);
  const folder = path.slice(0, -'/probe'.length);
  const writer = new FileWriter(root);
  let directory = '';
  try {
    try { directory = writer.directory(folder); }
    catch (error) { if (hasCode(error, 'ENOENT')) return []; throw error; }
    return writer.entries(directory).filter(entry => entry.type === 8).map(entry => {
      const fd = openSync(join(directory, entry.name), constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        writer.regular(fd, stat);
        return { name: entry.name, size: stat.size, same: !!like && stat.size === like.length && readFileSync(fd).equals(like) };
      } finally { closeSync(fd); }
    });
  } finally { writer.close(); }
}

/** A request whose attachments moved to another request takes no new operation; a saved one is still answered. */
function assertRequestNotReplaced(journal: FileJournal, id: string, requestId: string, opId: string): void {
  const { folder } = journal.taskLocation(id, true);
  if (journal.operationGet(opId).state === 'not_found' && journal.managedRequestWasMoved(`${folder}/attachments/${requestId}`))
    throw new Problem(PROBLEM_CODE.attachmentRequestReplaced, 'Attachment request ID was replaced');
}

export async function saveTaskAttachment(root: string, id: string,
  rawRequestId: string, rawName: string, bytes: Buffer, opId: string,
  grant: WriteGrant
): Promise<{ path: string; absolutePath: string; size: number }> {
  if (!opId.trim()) throw new Problem(PROBLEM_CODE.invalidInput, 'Operation ID is required', undefined, { reason: { kind: 'operation_id_required' } });
  const limit = attachmentLimit(root);
  if (bytes.length > limit) throw fileTooLarge(limit);
  const requestId = attachmentRequestId(rawRequestId), name = attachmentFileName(rawName);
  const journal = new FileJournal(root);
  assertRequestNotReplaced(journal, id, requestId, opId);
  const files = attachmentFiles(root, id, requestId, bytes);
  let chosen = files.find(file => file.same)?.name ?? name;
  let collision = 2;
  while (files.some(file => file.name === chosen && !file.same)) chosen = collisionName(name, collision++);
  const existing = files.find(file => file.name === chosen);
  const result = { path: `attachments/${requestId}/${chosen}`,
    absolutePath: taskFileRoute(id, `attachments/${requestId}/${chosen}`), size: bytes.length };
  const outcome = journal.putTaskFile({ task: id, name: result.path, opId, bytes,
    ...(existing ? { expectedDigest: fileDigest(bytes) } : {}), result,
    fingerprintKey: ['attachment', requestId, name], grant });
  requirePublished(outcome);
  return outcome.body;
}

export async function removeTaskAttachment(root: string, id: string,
  rawRequestId: string, rawName: string, opId: string,
  grant: WriteGrant): Promise<{ removed: true }> {
  if (!opId.trim()) throw new Problem(PROBLEM_CODE.invalidInput, 'Operation ID is required', undefined, { reason: { kind: 'operation_id_required' } });
  const requestId = attachmentRequestId(rawRequestId);
  if (!validAttachmentName(rawName))
    throw new Problem(PROBLEM_CODE.invalidInput, 'Invalid attachment name', undefined, { reason: { kind: 'invalid_attachment_name' } });
  const journal = new FileJournal(root);
  const name = `attachments/${requestId}/${rawName}`;
  assertRequestNotReplaced(journal, id, requestId, opId);
  const prior = journal.priorTaskDigest(id, name, opId, 'delete');
  let digest = prior;
  const key = ['attachment', requestId, rawName];
  if (prior === undefined && journal.operationGet(opId).state==='committed')
    return journal.recordMissingAttachmentDelete(id,name,opId,key,grant);
  if (digest === undefined) {
    let bytes: Buffer;
    try { bytes = journal.readTaskFile(id, name); }
    catch (error) { if (error instanceof Problem && error.code === PROBLEM_CODE.notFound)
      return journal.recordMissingAttachmentDelete(id,name,opId,key,grant); throw error; }
    digest = fileDigest(bytes);
  }
  if (digest === null) throw new Problem(PROBLEM_CODE.conflict, 'Attachment delete has no prior file', undefined, { reason: { kind: 'attachment_delete_has_no_prior_file' } });
  const outcome = journal.deleteTaskFile({ task: id, name, opId,
    expectedDigest: digest, result: {removed:true as const}, fingerprintKey: key, grant });
  requirePublished(outcome);
  return outcome.body;
}

export async function moveTaskAttachments(root: string, id: string,
  rawFrom: string, rawTo: string, opId: string, grant: WriteGrant
): Promise<{ path: string; absolutePath: string; size: number }[]> {
  if (!opId.trim()) throw new Problem(PROBLEM_CODE.invalidInput, 'Operation ID is required', undefined, { reason: { kind: 'operation_id_required' } });
  const from = attachmentRequestId(rawFrom), to = attachmentRequestId(rawTo);
  if (from === to) throw new Problem(PROBLEM_CODE.invalidInput, 'Attachment request IDs must differ', undefined, { reason: { kind: 'attachment_request_ids_must_differ' } });
  const journal = new FileJournal(root);
  assertRequestNotReplaced(journal, id, from, opId);
  const files = attachmentFiles(root, id, from).map(file => ({ path: `attachments/${to}/${file.name}`,
    absolutePath: taskFileRoute(id, `attachments/${to}/${file.name}`), size: file.size }));
  const outcome = journal.moveAttachmentFolder({ task: id, from, to, opId, result: files, grant });
  requirePublished(outcome);
  return outcome.body;
}
