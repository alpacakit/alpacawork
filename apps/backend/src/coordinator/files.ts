import { syncFile } from '@alpacawork/db';
/**
 * The coordinator conversations' files, at `.alpacawork/coordinator/<conversation>/attachments/<request>/<name>` (what a
 * message attached) and `.../answers/<request>/<name>` (what its answer linked to).
 * Where a file is says whose it is: a message's own folder, in its conversation's. They use FileJournal's existing
 * durable publication protocol.
 */
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { hasCode, Problem, PROBLEM_CODE } from '@alpacawork/core';
import { requirePublished, FileJournal, fileDigest } from '../control/file-journal.js';
import { attachmentFileName } from '../control/task-files.js';
import { attachmentLimit, fileTooLarge } from '../agents-settings.js';
import { FileWriter, type OpenedFile } from '../raw/storage.js';

const FOLDER = '.alpacawork/coordinator';
export const coordinatorRequestId = (id: string) => {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Problem(PROBLEM_CODE.invalidInput, 'Invalid coordinator request ID', undefined, { reason: { kind: 'invalid_coordinator_request_id' } });
  return id;
};
/** A message's own files: those the person attached, and the snapshots of local files its answer links to. */
type Area = 'attachments' | 'answers';
const base = (conversation: string, id: string, area: Area = 'attachments') =>
  `${FOLDER}/${conversation}/${area}/${coordinatorRequestId(id)}`;
export const coordinatorFilePath = (conversation: string, id: string, name: string, area: Area = 'attachments') => {
  if (attachmentFileName(name) !== name || name.includes('/')) throw new Problem(PROBLEM_CODE.invalidInput, 'Invalid attachment name', undefined, { reason: { kind: 'invalid_attachment_name' } });
  return `${base(conversation, id, area)}/${name}`;
};
const path = (conversation: string, id: string, name: string) => coordinatorFilePath(conversation, id, name);
const url = (id: string, name: string) => `/api/coordinator/file?requestId=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`;
const result = (id: string, name: string, size: number) => ({ path: `attachments/${id}/${name}`, absolutePath: url(id, name), size });

/** Where an attached file is on disk, for the agent to read; refused when it is not there. */
export function coordinatorAttachmentFile(root: string, conversation: string, id: string, name: string) {
  const file = path(conversation, id, name);
  new FileJournal(root).readManagedFile(file);
  return join(root, file);
}
export function withCoordinatorFile<T>(root: string, conversation: string, id: string, name: string, area: Area, read: (file: OpenedFile) => T): T {
  return new FileJournal(root).withManagedFile(coordinatorFilePath(conversation, id, name, area), read);
}
/** Names and sizes only: bytes are read where a caller compares them, and only for files of the same size. */
function files(root: string, conversation: string, id: string) {
  const folder = join(root, base(conversation, id));
  let names: string[];
  try { names = readdirSync(folder); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return names.map(name => ({ name, size: lstatSync(join(root, path(conversation, id, name))).size }));
}
function collision(name: string, number: number) {
  const dot = name.lastIndexOf('.'), extension = dot > 0 ? name.slice(dot) : '';
  return attachmentFileName(`${name.slice(0, dot > 0 ? dot : undefined)}-${number}${extension}`);
}
export function saveCoordinatorAttachment(root: string, conversation: string, id: string, rawName: string, bytes: Buffer, opId: string) {
  const limit = attachmentLimit(root);
  if (bytes.length > limit) throw fileTooLarge(limit);
  const name = attachmentFileName(rawName), journal = new FileJournal(root);
  const replay = journal.replayManagedPut<ReturnType<typeof result>>({ path: path(conversation, id, name), opId, bytes,
    fingerprintKey: ['attachment', id, name] });
  if (replay) { requirePublished(replay); return replay.body; }
  if (journal.managedRequestWasMoved(base(conversation, id))) throw new Problem(PROBLEM_CODE.attachmentRequestReplaced, 'Attachment request ID was replaced');
  const existing = files(root, conversation, id).map(file => ({ ...file,
    same: file.size === bytes.length && journal.readManagedFile(path(conversation, id, file.name)).equals(bytes) }));
  let chosen = existing.find(file => file.same)?.name ?? name, number = 2;
  while (existing.some(file => file.name === chosen && !file.same)) chosen = collision(name, number++);
  const old = existing.find(file => file.name === chosen);
  const outcome = journal.putManagedFile({ path: path(conversation, id, chosen), opId, bytes,
    expectedDigest: old ? fileDigest(bytes) : null, result: result(id, chosen, bytes.length),
    fingerprintKey: ['attachment', id, name] });
  requirePublished(outcome);
  return outcome.body;
}
export function removeCoordinatorAttachment(root: string, conversation: string, id: string, name: string, opId: string) {
  const journal = new FileJournal(root), target = path(conversation, id, name);
  const replay = journal.replayManagedDelete<{ removed: true }>({ path: target, opId,
    fingerprintKey: ['attachment', id, name] });
  if (replay) { requirePublished(replay); return replay.body; }
  if (journal.managedRequestWasMoved(base(conversation, id))) throw new Problem(PROBLEM_CODE.attachmentRequestReplaced, 'Attachment request ID was replaced');
  let bytes: Buffer;
  try { bytes = journal.readManagedFile(target); }
  catch (error) { if (error instanceof Problem && error.code === PROBLEM_CODE.notFound) return { removed: true as const }; throw error; }
  const outcome = journal.deleteManagedFile({ path: target, opId, digest: fileDigest(bytes),
    result: { removed: true as const }, fingerprintKey: ['attachment', id, name] });
  requirePublished(outcome);
  return outcome.body;
}
export function moveCoordinatorAttachments(root: string, conversation: string, from: string, to: string, opId: string) {
  if (from === to) throw new Problem(PROBLEM_CODE.invalidInput, 'Attachment request IDs must differ', undefined, { reason: { kind: 'attachment_request_ids_must_differ' } });
  const journal = new FileJournal(root);
  const replay = journal.replayManagedMove<ReturnType<typeof result>[]>({ source: base(conversation, from), destination: base(conversation, to), opId });
  if (replay) { requirePublished(replay); return replay.body; }
  if (journal.managedRequestWasMoved(base(conversation, from))) throw new Problem(PROBLEM_CODE.attachmentRequestReplaced, 'Attachment request ID was replaced');
  const moved = files(root, conversation, from).map(file => result(to, file.name, file.size));
  const outcome = journal.moveManagedFolder({ source: base(conversation, from), destination: base(conversation, to), opId, result: moved });
  requirePublished(outcome);
  return outcome.body;
}

/**
 * The folders directly below the coordinator's (with `conversation`, its messages' attachment folders), for a sweep to
 * judge by the records whose they are.
 */
export function coordinatorFolders(root: string, conversation?: string, area: Area = 'attachments'): string[] {
  const writer = new FileWriter(root);
  try {
    let folder: string;
    try { folder = writer.directory(conversation === undefined ? FOLDER : `${FOLDER}/${conversation}/${area}`); }
    catch (error) { if (hasCode(error, 'ENOENT')) return []; throw error; }
    return writer.entries(folder).map(entry => entry.name);
  } finally { writer.close(); }
}
/**
 * Removes a cleared conversation's or an expired message's files. What is
 * already gone is skipped, so a sweep that stopped part way is simply run again. Refused while a file publication there
 * is pending.
 */
export function discardCoordinatorFiles(root: string, conversation: string, id?: string) {
  for (const target of id === undefined ? [`${FOLDER}/${conversation}`] : (['attachments', 'answers'] as const).map(area => base(conversation, id, area)))
    discardFolder(root, target);
}
function discardFolder(root: string, target: string) {
  new FileJournal(root).assertAvailable(target);
  const writer = new FileWriter(root);
  try {
    const at = target.lastIndexOf('/');
    let parent: string;
    try { parent = writer.directory(target.slice(0, at)); }
    catch (error) { if (hasCode(error, 'ENOENT')) return; throw error; }
    rmSync(join(parent, target.slice(at + 1)), { recursive: true, force: true });
    syncFile(parent);
  } finally { writer.close(); }
}
