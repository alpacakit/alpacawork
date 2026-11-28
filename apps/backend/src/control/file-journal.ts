import { dirname, join } from 'node:path';
import { syncFile } from '@alpacawork/db';
/** Durable publication of files outside the control database. The database owns intent and receipts. */
import { randomUUID, createHash } from 'node:crypto';
import { closeSync, constants, fsyncSync, readFileSync, writeSync, openSync, statSync, mkdirSync, linkSync, unlinkSync, renameSync, copyFileSync } from 'node:fs';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { ControlStore, touch } from '@alpacawork/db';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { thisRelease } from '../release/location.js';
import { assertServeAdmission } from '../release/journal.js';
import { reportMediaReferences, reportEmbed } from '@alpacawork/contract/report-media';
import { Problem, PROBLEM_CODE, hasCode } from '@alpacawork/core';
import { MAX_FILE_BYTES, problemSchema, valuesText } from '@alpacawork/contract';
import { validTaskFileName } from '@alpacawork/contract/inputs';
import { CONFIG_FILE, MAX_DOCUMENT, type FieldValue, type TaskActor } from '@alpacawork/raw';
import { FileWriter, readOpenedFile, type OpenedFile } from '../raw/storage.js';
import type { AuthorizedWriter } from './authorize.js';
import { taskFolder } from './task-store.js';

export const fileDigest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Kind = 'put' | 'delete' | 'move';
type State = 'prepared' | 'published' | 'needs_review';
type Row = { id: string; op_id: string; kind: Kind; task_uuid: string | null;
  source_path: string | null; destination_path: string | null; old_digest: string | null;
  new_digest: string | null; stage_path: string | null; tombstone_path: string | null;
  fingerprint: string; state: State; result_json: string };
type Receipt<T> = { status: number; body: T; operation?: string; audit?: { actor: TaskActor; at: string } };
type FileOutcome<T> = { state: 'published'; status: number; body: T; replayed: boolean } |
  { state: 'pending' | 'needs_review' };
/** The single conversion for an identified operation's own durable publication outcome. */
export function requirePublished<T>(outcome: FileOutcome<T>): asserts outcome is Extract<FileOutcome<T>, { state: 'published' }> {
  if (outcome.state === 'published') {
    if (outcome.status >= 400) {
      const { error } = problemSchema.parse(outcome.body);
      throw new Problem(error.code, error.message, error.detail, { reason: error.reason, issues: error.issues });
    }
    return;
  }
  if (outcome.state === 'needs_review')
    throw new Problem(PROBLEM_CODE.publicationNeedsReview, 'File publication needs review', undefined,
      { reason: { kind: 'publication_needs_review' } });
  throw new Problem(PROBLEM_CODE.publicationPending, 'File publication is pending', undefined,
    { reason: { kind: 'publication_pending' } });
}
/**
 * A file write's grant, asked on the connection of the transaction that reserves the write: authorize('file.write')
 * for its caller identified again there (server.ts), so that a Run that ended or was replaced while its upload came in
 * reserves nothing. A replay of a saved operation is answered without it.
 */
export type WriteGrant = (db: DatabaseSync) => AuthorizedWriter;
/** A Task file's write: the Task's ID, its row as read before the reservation, and the grant it writes by. */
type TaskWrite = { id: string; uuid: string; grant: WriteGrant };
type Prepare = { opId: string; fingerprint: string; kind: Kind; task?: TaskWrite;
  source?: string; destination?: string; oldDigest?: string | null;
  newDigest?: string; stage?: string; tombstone?: string; receipt: Receipt<unknown> };
const safeSegment = (part: string) => !!part && part !== '.' && part !== '..' &&
  !part.includes('\0') && !part.includes('/') && !part.includes('\\');
const pathParts = (path: string) => {
  const parts = path.split('/');
  if (!parts.every(safeSegment)) throw new Problem(PROBLEM_CODE.unsafePath, 'Invalid managed file path', undefined, { reason: { kind: 'invalid_managed_file_path' } });
  return parts;
};
const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
/** The read isReserved takes, prepared once so a loop over many files reuses it. */
export const reservedPaths = (db: DatabaseSync) => db.prepare('SELECT path FROM file_path_reservations');
/** Whether an unpublished operation has reserved `path`, a folder above it, or anything below it. */
export const isReserved = (reservations: StatementSync, path: string) =>
  reservations.all().some(row => overlaps(path, String(row.path)));
const fingerprint = (value: unknown) => fileDigest(Buffer.from(JSON.stringify(value)));
/**
 * What the saved operation of an ID says to its retry: the same input is answered from its row, another is refused. The
 * only conversion of a saved row to an outcome.
 */
function savedOutcome(row: Pick<Row, 'fingerprint' | 'kind' | 'state' | 'result_json'>, wanted: string, kind: Kind): FileOutcome<unknown> {
  if (row.fingerprint !== wanted || row.kind !== kind)
    throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Operation ID belongs to different input', undefined,
      { reason: { kind: 'operation_id_belongs_different_input' } });
  if (row.state !== 'published') return { state: row.state === 'prepared' ? 'pending' : 'needs_review' };
  const receipt = JSON.parse(row.result_json) as Receipt<unknown>;
  return { state: 'published', status: receipt.status, body: receipt.body, replayed: true };
}
const managedPutFingerprint = (path: string, key: unknown, bytes: Buffer) => fingerprint(['file.put', path, key, fileDigest(bytes)]);
const managedDeleteFingerprint = (path: string, key: unknown) => fingerprint(['file.delete', path, key]);
const managedMoveFingerprint = (source: string, destination: string) => fingerprint(['file.move', source, destination]);

/** All paths are data-directory relative. Every filesystem walk is anchored to an open directory. */
export class FileJournal {
  constructor(readonly root: string, readonly checkpoint: (phase: 'staged' | 'reserved' | 'linked' | 'renamed' | 'receipted') => void = () => {}) {}
  private store() { return new ControlStore(this.root, { busyTimeoutMs: 10_000 }); }
  private task(db: DatabaseSync, id: string, write = false) {
    const row = db.prepare(`SELECT id FROM tasks WHERE external_id=? ${write ? "AND lifecycle='active'" : ''}`).get(id);
    if (!row) throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist', undefined, { reason: { kind: 'task_does_not_exist' } });
    return { uuid: String(row.id), folder: taskFolder(id) };
  }
  /**
   * authorize decides who may write, by the grant asked on `db`: this checks only that it is for this Task and that the
   * Task is active.
   */
  private writableTask(db: DatabaseSync, id: string, grant: WriteGrant) {
    const task = this.task(db, id, true);
    if (grant(db).task !== id) throw new Problem(PROBLEM_CODE.forbidden, 'File write is authorized for another Task', undefined, { reason: { kind: 'file_write_authorized_for_another_task' } });
    return task;
  }
  taskLocation(id: string, write = false) {
    const store=this.store();
    try { return store.read(db=>this.task(db,id,write)); }
    finally { store.close(); }
  }
  taskPath(id: string, name: string, write = false) {
    if (!validTaskFileName(name) || name.split('/').some(part => !safeSegment(part)))
      throw new Problem(PROBLEM_CODE.unsafePath, 'Invalid Task file path', undefined, { reason: { kind: 'invalid_task_file_path_2' } });
    const store = this.store();
    try { return store.read(db => `${this.task(db, id, write).folder}/${name}`); }
    finally { store.close(); }
  }
  assertAvailable(path: string) {
    this.withAvailablePath(path, () => undefined);
  }
  withAvailablePath<T>(path: string, read: () => T): T {
    pathParts(path);
    return this.withFileReads(available => available(path, read));
  }
  /** Reuse a connection, never an availability snapshot: each file gets the normal fresh read transaction. */
  withFileReads<T>(read: (available: <Value>(path: string, read: () => Value) => Value) => T): T {
    const store = this.store();
    try {
      const reservations = reservedPaths(store.connection);
      return read((path, operation) => {
        pathParts(path);
        return store.read(() => {
          if (isReserved(reservations, path))
            throw new Problem(PROBLEM_CODE.busy, 'File publication is pending', undefined, { reason: { kind: 'file_publication_pending' } });
          return operation();
        });
      });
    } finally { store.close(); }
  }
  /** A non-Task managed file uses the same reservation, stage and receipt protocol. */
  readManagedFile(path: string): Buffer {
    return this.withManagedFile(path, file => readOpenedFile(file.fd, file.size, MAX_FILE_BYTES));
  }
  withManagedFile<T>(path: string, read: (file: OpenedFile) => T): T {
    return this.withOpenedFile(path, () => new Problem(PROBLEM_CODE.notFound, 'File does not exist', undefined,
      { reason: { kind: 'file_does_not_exist' } }), read);
  }
  private withOpenedFile<T>(path: string, notFound: () => Problem, read: (file: OpenedFile) => T): T {
    return this.withAvailablePath(path, () => {
      const writer = new FileWriter(this.root);
      try {
        let file: OpenedFile | null;
        try {
          const { directory, name } = this.parent(writer, path);
          file = writer.openVersionedAt(directory, name);
        } catch (error) { if (hasCode(error, 'ENOENT')) throw notFound(); throw error; }
        if (file === null) throw notFound();
        try { return read(file); } finally { closeSync(file.fd); }
      } finally { writer.close(); }
    });
  }
  managedRequestWasMoved(path: string): boolean {
    const store = this.store();
    try { return store.read(db => !!db.prepare("SELECT 1 FROM file_operations WHERE kind='move' AND state='published' AND source_path=?").get(path)); }
    finally { store.close(); }
  }
  /** `receipt` adds to what a retry is answered with; `staleDigest` is the caller's refusal of a file that changed. */
  private putPublished<T>(input: { path: string; opId: string; bytes: Buffer;
    expectedDigest: string | null; fingerprint: string; result: T; task?: TaskWrite;
    receipt?: Pick<Receipt<T>, 'operation' | 'audit'>; staleDigest?: () => Problem }): FileOutcome<T> {
    // Callers refuse files over the setting; this keeps any one file within what memory is sized for.
    if (input.bytes.length > MAX_FILE_BYTES) throw new Problem(PROBLEM_CODE.tooLarge, 'File exceeds size limit', undefined, { reason: { kind: 'file_exceeds_size_limit' } });
    const existing = this.existing(input.opId, input.fingerprint, 'put');
    if (existing) return existing as FileOutcome<T>;
    const writer = new FileWriter(this.root);
    let stage: string;
    try {
      if (this.digestAt(writer, input.path) !== input.expectedDigest)
        throw input.staleDigest?.() ?? new Problem(PROBLEM_CODE.conflict, 'Expected file digest differs', undefined, { reason: { kind: 'expected_file_digest_differs' } });
      stage = this.stage(writer, randomUUID(), input.bytes);
      this.checkpoint('staged');
    } finally { writer.close(); }
    try { return this.run({ opId: input.opId, fingerprint: input.fingerprint,
      kind: 'put', task: input.task,
      destination: input.path, oldDigest: input.expectedDigest, newDigest: fileDigest(input.bytes), stage,
      receipt: { status: 200, body: input.result, ...input.receipt } }) as FileOutcome<T>; }
    finally { this.removeUnreferencedStage(input.opId,stage); }
  }
  private deletePublished<T>(input: { path: string; opId: string; digest: string;
    fingerprint: string; result: T; task?: TaskWrite }): FileOutcome<T> {
    const existing = this.existing(input.opId, input.fingerprint, 'delete');
    if (existing) return existing as FileOutcome<T>;
    const writer = new FileWriter(this.root);
    try { if (this.digestAt(writer, input.path) !== input.digest)
      throw new Problem(PROBLEM_CODE.conflict, 'Expected file digest differs', undefined, { reason: { kind: 'expected_file_digest_differs' } }); }
    finally { writer.close(); }
    return this.run({ opId: input.opId, fingerprint: input.fingerprint,
      kind: 'delete', task: input.task,
      source: input.path, oldDigest: input.digest, tombstone: `.alpacawork/file-tomb-${randomUUID()}`,
      receipt: { status: 200, body: input.result } }) as FileOutcome<T>;
  }
  private movePublished<T>(input: { source: string; destination: string; opId: string;
    fingerprint: string; result: T; task?: TaskWrite }): FileOutcome<T> {
    const existing = this.existing(input.opId, input.fingerprint, 'move');
    if (existing) return existing as FileOutcome<T>;
    const writer = new FileWriter(this.root);
    let manifest: string | null;
    try {
      manifest = this.manifest(writer, input.source);
      if (!manifest) throw new Problem(PROBLEM_CODE.notFound, 'Attachment folder does not exist', undefined, { reason: { kind: 'attachment_folder_does_not_exist' } });
      if (this.exists(writer, input.destination)) throw new Problem(PROBLEM_CODE.conflict, 'Destination attachment folder exists', undefined, { reason: { kind: 'destination_attachment_folder_exists' } });
    } finally { writer.close(); }
    return this.run({ opId: input.opId, fingerprint: input.fingerprint,
      kind: 'move', task: input.task,
      source: input.source, destination: input.destination, oldDigest: manifest,
      receipt: { status: 200, body: input.result } }) as FileOutcome<T>;
  }
  putManagedFile<T>(input: { path: string; opId: string; bytes: Buffer; expectedDigest: string | null;
    result: T; fingerprintKey: unknown }): FileOutcome<T> {
    pathParts(input.path);
    return this.putPublished({ ...input, fingerprint: managedPutFingerprint(input.path, input.fingerprintKey, input.bytes) });
  }
  deleteManagedFile<T>(input: { path: string; opId: string; digest: string; result: T; fingerprintKey: unknown }): FileOutcome<T> {
    pathParts(input.path);
    return this.deletePublished({ ...input, fingerprint: managedDeleteFingerprint(input.path, input.fingerprintKey) });
  }
  moveManagedFolder<T>(input: { source: string; destination: string; opId: string; result: T }): FileOutcome<T> {
    pathParts(input.source); pathParts(input.destination);
    return this.movePublished({ ...input, fingerprint: managedMoveFingerprint(input.source, input.destination) });
  }
  /** Restore only the saved destination's leaf, under the requested folder, before matching the complete input.
   * A caller must not read reserved files to repeat its collision-name selection. The fingerprint still binds the
   * requested folder, original name/key and bytes, and existing() alone decides the saved operation's outcome. */
  replayManagedPut<T>(input: { path: string; opId: string; bytes: Buffer; fingerprintKey: unknown }): FileOutcome<T> | null {
    pathParts(input.path);
    const store = this.store();
    let destination: string | null;
    try { destination = store.read(db => {
      const row = db.prepare('SELECT destination_path FROM file_operations WHERE op_id=?').get(input.opId);
      return row?.destination_path == null ? null : String(row.destination_path);
    }); } finally { store.close(); }
    const path = destination === null ? input.path
      : input.path.slice(0, input.path.lastIndexOf('/') + 1) + destination.slice(destination.lastIndexOf('/') + 1);
    return this.existingManaged(input.opId, managedPutFingerprint(path, input.fingerprintKey, input.bytes), 'put') as FileOutcome<T> | null;
  }
  replayManagedDelete<T>(input: { path: string; opId: string; fingerprintKey: unknown }): FileOutcome<T> | null {
    pathParts(input.path);
    return this.existingManaged(input.opId, managedDeleteFingerprint(input.path, input.fingerprintKey), 'delete') as FileOutcome<T> | null;
  }
  replayManagedMove<T>(input: { source: string; destination: string; opId: string }): FileOutcome<T> | null {
    pathParts(input.source); pathParts(input.destination);
    return this.existingManaged(input.opId, managedMoveFingerprint(input.source, input.destination), 'move') as FileOutcome<T> | null;
  }
  /** A non-file receipt also occupies its ID; do not let callers inspect the filesystem before rejecting it. */
  private existingManaged(opId: string, wanted: string, kind: Kind): FileOutcome<unknown> | null {
    const outcome = this.existing(opId, wanted, kind);
    if (outcome) return outcome;
    const store = this.store();
    try { return store.read(db => {
      if (db.prepare('SELECT 1 FROM cli_operations WHERE op_id=?').get(opId))
        throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Operation ID belongs to different input', undefined,
          { reason: { kind: 'operation_id_belongs_different_input' } });
      return null;
    }); } finally { store.close(); }
  }
  private parent(writer: FileWriter, path: string, create = false): { directory: string; name: string } {
    const parts = pathParts(path), name = parts.pop()!;
    const directory = join(writer.root, ...parts);
    if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
    else statSync(directory);
    return { directory, name };
  }
  /** Read through the business size ceiling so lowering settings never blocks a replacement. */
  private bytes(writer: FileWriter, path: string, max = MAX_FILE_BYTES): Buffer | null {
    try {
      const parent = this.parent(writer, path);
      return writer.readAt(parent.directory, parent.name, max);
    } catch (error) { if (hasCode(error, 'ENOENT')) return null; throw error; }
  }
  private digestAt(writer: FileWriter, path: string): string | null {
    const bytes = this.bytes(writer, path);
    return bytes === null ? null : fileDigest(bytes);
  }
  private stage(writer: FileWriter, id: string, bytes: Buffer): string {
    const name = `file-stage-${id}`;
    const fd = openSync(join(writer.meta, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      for (let offset = 0; offset < bytes.length;) {
        const count = writeSync(fd, bytes, offset, bytes.length - offset);
        if (!count) throw new Error('Zero-byte stage write');
        offset += count;
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
    syncFile(writer.meta);
    return `.alpacawork/${name}`;
  }
  private prepared(db: DatabaseSync, p: Prepare): Row | FileOutcome<unknown> {
    const prior = db.prepare('SELECT * FROM file_operations WHERE op_id=?').get(p.opId) as Row | undefined;
    // A new operation is authorized in the transaction that reserves it; a saved one is answered as it was saved.
    if (!prior && p.task) {
      const task = this.writableTask(db, p.task.id, p.task.grant);
      if (task.uuid !== p.task.uuid) throw new Problem(PROBLEM_CODE.conflict, 'Task changed before reservation', undefined, { reason: { kind: 'task_changed_before_reservation' } });
    }
    if (prior) return savedOutcome(prior, p.fingerprint, p.kind);
    const ledger = db.prepare('SELECT fingerprint FROM cli_operations WHERE op_id=?').get(p.opId);
    if (ledger) throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Operation ID is already used', undefined, { reason: { kind: 'operation_id_already_used' } });
    const paths = [p.source, p.destination].filter((path): path is string => !!path);
    if (p.task) for (const path of paths) this.assertUnsentAttachment(db, p.task.id, path);
    const reservations = reservedPaths(db);
    if (paths.some(path => isReserved(reservations, path)))
      throw new Problem(PROBLEM_CODE.conflict, 'File path is reserved by another operation', undefined, { reason: { kind: 'file_path_reserved_by_another_operation' } });
    const writer=new FileWriter(this.root);
    try {
      if (p.kind==='put' && this.digestAt(writer,p.destination!)!==p.oldDigest ||
          p.kind==='delete' && this.digestAt(writer,p.source!)!==p.oldDigest ||
          p.kind==='move' && (this.manifest(writer,p.source!)!==p.oldDigest || this.exists(writer,p.destination!)))
        throw new Problem(PROBLEM_CODE.conflict, 'File changed before reservation', undefined, { reason: { kind: 'file_changed_before_reservation' } });
    } finally { writer.close(); }
    const id = randomUUID();
    db.prepare(`INSERT INTO file_operations(id,op_id,kind,task_uuid,source_path,destination_path,
      old_digest,new_digest,stage_path,tombstone_path,fingerprint,state,result_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,p.opId,p.kind,p.task?.uuid ?? null,p.source ?? null,
      p.destination ?? null,p.oldDigest ?? null,p.newDigest ?? null,p.stage ?? null,p.tombstone ?? null,
      p.fingerprint,'prepared',JSON.stringify(p.receipt));
    for (const path of new Set(paths))
      db.prepare('INSERT INTO file_path_reservations(path,operation_id) VALUES (?,?)').run(path,id);
    return db.prepare('SELECT * FROM file_operations WHERE id=?').get(id) as Row;
  }
  /** A path under `attachments/<request>` belongs to that request's Task, and only until the request is sent. */
  private assertUnsentAttachment(db: DatabaseSync, task: string, path: string) {
    const requestId=/\/attachments\/([^/]+)(?:\/|$)/.exec(path)?.[1];
    const request=requestId && db.prepare('SELECT task_id,delivery_state FROM requests WHERE id=?').get(requestId);
    if (!request) return;
    if (request.task_id!==task) throw new Problem(PROBLEM_CODE.invalidInput, 'Attachment request belongs to another Task', undefined, { reason: { kind: 'attachment_request_belongs_another_task' } });
    if (request.delivery_state!=='aborted') throw new Problem(PROBLEM_CODE.invalidInput, 'Sent attachments cannot be changed', undefined, { reason: { kind: 'sent_attachments_cannot_changed' } });
  }
  private publish(writer: FileWriter, row: Row): void {
    if (row.kind === 'put') {
      const stage = join(writer.root, row.stage_path!);
      const dest = this.parent(writer, row.destination_path!, true);
      if (this.digestAt(writer, row.stage_path!) !== row.new_digest ||
          this.digestAt(writer, row.destination_path!) !== row.old_digest)
        throw new Problem(PROBLEM_CODE.conflict, 'File changed during publication', undefined, { reason: { kind: 'file_changed_during_publication' } });
      const destination = join(dest.directory, dest.name);
      // The journal stage remains the restart source; replacement uses a sibling temporary file.
      if (row.old_digest === null) {
        linkSync(stage, destination);
        this.checkpoint('linked');
        unlinkSync(stage);
      } else {
        const temporary = join(dest.directory, `.file-${row.id}.tmp`);
        try {
          copyFileSync(stage, temporary);
          syncFile(temporary);
          renameSync(temporary, destination);
          unlinkSync(stage);
        } finally { try { unlinkSync(temporary); } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; } }
      }
      syncFile(dest.directory); syncFile(dirname(stage));
    } else if (row.kind === 'delete') {
      const source = join(writer.root, row.source_path!), tombstone = join(writer.root, row.tombstone_path!);
      if (this.digestAt(writer,row.source_path!) !== row.old_digest)
        throw new Problem(PROBLEM_CODE.conflict, 'File changed during deletion', undefined, { reason: { kind: 'file_changed_during_deletion' } });
      linkSync(source, tombstone); this.checkpoint('linked'); unlinkSync(source);
      syncFile(dirname(source)); syncFile(dirname(tombstone));
    } else {
      const source = join(writer.root, row.source_path!), destination = this.parent(writer,row.destination_path!,true);
      if (this.manifest(writer,row.source_path!) !== row.old_digest || this.exists(writer,row.destination_path!))
        throw new Problem(PROBLEM_CODE.conflict, 'Attachment folder changed during move', undefined, { reason: { kind: 'attachment_folder_changed_during_move' } });
      renameSync(source, join(destination.directory, destination.name));
      syncFile(dirname(source)); syncFile(destination.directory);
    }
  }
  private exists(writer: FileWriter, path: string): boolean {
    try { return statSync(join(writer.root, ...pathParts(path))).isDirectory(); }
    catch (error) { if (hasCode(error,'ENOENT')) return false; throw error; }
  }
  private manifest(writer: FileWriter, path: string): string | null {
    const directory = join(writer.root, ...pathParts(path));
    try {
      const files=writer.entries(directory).map(entry => {
        if (!safeSegment(entry.name) || entry.type !== 8) throw new Problem(PROBLEM_CODE.invalidInput, 'Invalid attachment folder', undefined,
          { reason: { kind: 'unsafe_attachment_folder' } });
        return [entry.name,fileDigest(readFileSync(join(directory, entry.name)))] as const;
      }).sort((a,b)=>a[0].localeCompare(b[0]));
      return fingerprint(files);
    } catch (error) { if (hasCode(error,'ENOENT')) return null; throw error; }
  }
  private finish(row: Row): FileOutcome<unknown> {
    const writer=new FileWriter(this.root);
    try {
      // link and unlink are separate system calls. The saved request/digests own a replay
      // that died between them; conflicting contents still retain their reservation.
      if (row.kind === 'put' && this.digestAt(writer,row.destination_path!) === row.new_digest &&
          this.digestAt(writer,row.stage_path!) === row.new_digest) {
        unlinkSync(join(writer.root,row.stage_path!));
        syncFile(dirname(join(writer.root,row.stage_path!)));
        syncFile(dirname(join(writer.root,row.destination_path!)));
      }
      if (row.kind === 'delete' && this.digestAt(writer,row.source_path!) === row.old_digest &&
          this.digestAt(writer,row.tombstone_path!) === row.old_digest) {
        unlinkSync(join(writer.root,row.source_path!));
        syncFile(dirname(join(writer.root,row.source_path!)));
        syncFile(dirname(join(writer.root,row.tombstone_path!)));
      }
      const published = () => row.kind === 'put' ? this.digestAt(writer,row.destination_path!) === row.new_digest &&
          this.digestAt(writer,row.stage_path!) === null
        : row.kind === 'delete' ? this.digestAt(writer,row.source_path!) === null &&
          this.digestAt(writer,row.tombstone_path!) === row.old_digest
        : this.manifest(writer,row.source_path!) === null &&
          this.manifest(writer,row.destination_path!) === row.old_digest;
      if (!published()) {
        const before = row.kind === 'put' ? this.digestAt(writer,row.stage_path!) === row.new_digest &&
            this.digestAt(writer,row.destination_path!) === row.old_digest
          : row.kind === 'delete' ? this.digestAt(writer,row.source_path!) === row.old_digest &&
            this.digestAt(writer,row.tombstone_path!) === null
          : this.manifest(writer,row.source_path!) === row.old_digest &&
            this.manifest(writer,row.destination_path!) === null;
        if (!before) {
          this.markNeedsReview(row.id);
          return { state:'needs_review' };
        }
        this.publish(writer,row);
        this.checkpoint('renamed');
      }
      if (!published()) throw new Problem(PROBLEM_CODE.conflict, 'Published file digest differs', undefined, { reason: { kind: 'published_file_digest_differs' } });
      const store=this.store();
      try { const outcome = store.write(db => {
        const fresh=db.prepare('SELECT * FROM file_operations WHERE id=?').get(row.id) as Row;
        if (fresh.state !== 'prepared' ||
            db.prepare('SELECT count(*) AS n FROM file_path_reservations WHERE operation_id=?').get(row.id)!.n !==
              new Set([row.source_path,row.destination_path].filter(Boolean)).size)
          throw new Problem(PROBLEM_CODE.conflict, 'File reservation changed', undefined, { reason: { kind: 'file_reservation_changed' } });
        const receipt=JSON.parse(row.result_json) as Receipt<unknown>;
        db.prepare("UPDATE file_operations SET state='published' WHERE id=?").run(row.id);
        if (row.destination_path === CONFIG_FILE) touch(db, { kind: 'config', id: CONFIG_FILE });
        db.prepare('DELETE FROM file_path_reservations WHERE operation_id=?').run(row.id);
        db.prepare(`INSERT INTO cli_operations(op_id,operation,fingerprint,status,response_json,committed_at)
          VALUES (?,?,?,?,?,?)`).run(row.op_id,this.operation(row),row.fingerprint,
          receipt.status,JSON.stringify(receipt.body),new Date().toISOString());
        return { state:'published',status:receipt.status,body:receipt.body,replayed:false } as const;
      });
        this.checkpoint('receipted');
        if (row.kind==='delete') {
          try { unlinkSync(join(writer.meta,row.tombstone_path!.split('/').at(-1)!)); syncFile(writer.meta); }
          catch (error) { if (!hasCode(error,'ENOENT')) throw error; }
        }
        return outcome;
      } finally { store.close(); }
    } finally { writer.close(); }
  }
  /** Only a prepared operation can become one a person reviews; a published receipt stays published. */
  private markNeedsReview(id: string): void {
    const store=this.store();
    try { store.write(db=>db.prepare("UPDATE file_operations SET state='needs_review' WHERE id=? AND state='prepared'").run(id)); }
    finally { store.close(); }
  }
  private operation(row: Row) { return (JSON.parse(row.result_json) as Receipt<unknown>).operation ?? (row.destination_path === CONFIG_FILE ? 'config.set'
    : row.kind === 'put' ? 'file.put' : row.kind === 'delete' ? 'file.delete' : 'file.move'); }
  private existing(opId: string, wanted: string, kind: Kind): FileOutcome<unknown> | null {
    const store=this.store();
    try { return store.read(db => {
      const row=db.prepare('SELECT fingerprint,kind,state,result_json FROM file_operations WHERE op_id=?').get(opId) as Row | undefined;
      return row ? savedOutcome(row,wanted,kind) : null;
    }); } finally { store.close(); }
  }
  replayConfig<T>(opId: string, key: unknown, operation = 'config.set'): FileOutcome<T> | null {
    const wanted=fingerprint([operation,key]);
    const existing=this.existing(opId,wanted,'put');
    if (existing) return existing as FileOutcome<T>;
    const store=this.store();
    try { return store.read(db=>{
      const row=db.prepare('SELECT operation,fingerprint,status,response_json FROM cli_operations WHERE op_id=?').get(opId);
      if (!row) return null;
      if (row.operation!==operation || row.fingerprint!==wanted)
        throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Operation ID belongs to different input', undefined,
          { reason: { kind: 'operation_id_belongs_different_input' } });
      return {state:'published',status:Number(row.status),body:JSON.parse(String(row.response_json)) as T,replayed:true};
    }); } finally { store.close(); }
  }
  priorTaskDigest(task: string, name: string, opId: string, kind: 'put' | 'delete'): string | null | undefined {
    const path=this.taskPath(task,name),store=this.store();
    try { return store.read(db=>{
      const row=db.prepare('SELECT kind,source_path,destination_path,old_digest FROM file_operations WHERE op_id=?').get(opId);
      if (!row) return undefined;
      if (row.kind!==kind || (kind==='put' ? row.destination_path : row.source_path)!==path)
        throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Operation ID belongs to different input', undefined,
          { reason: { kind: 'operation_id_belongs_different_input' } });
      return row.old_digest===null ? null : String(row.old_digest);
    }); } finally { store.close(); }
  }
  private run(p: Prepare): FileOutcome<unknown> {
    const store=this.store();
    let prepared: Row | FileOutcome<unknown>;
    try { prepared=store.write(db=>this.prepared(db,p)); } finally { store.close(); }
    if (!('id' in prepared)) return prepared;
    this.checkpoint('reserved');
    return this.finish(prepared);
  }
  putTaskFile<T>(input: { task: string; name: string; opId: string; bytes: Buffer;
    expectedDigest?: string; result: T; fingerprintKey?: unknown; grant: WriteGrant }): FileOutcome<T> {
    const path=this.taskPath(input.task,input.name,true), digest=fileDigest(input.bytes);
    const uuid=this.taskLocation(input.task,true).uuid;
    const fp=fingerprint(['file.put',uuid,input.fingerprintKey ?? input.name,
      input.fingerprintKey === undefined ? input.expectedDigest ?? null : null,digest]);
    return this.putPublished({ path, opId: input.opId, bytes: input.bytes,
      expectedDigest: input.expectedDigest ?? null, fingerprint: fp, result: input.result,
      task: { id: input.task, uuid, grant: input.grant } });
  }
  deleteTaskFile<T>(input: { task: string; name: string; opId: string; expectedDigest: string;
    result: T; fingerprintKey?: unknown; grant: WriteGrant }): FileOutcome<T> {
    const path=this.taskPath(input.task,input.name,true), uuid=this.taskLocation(input.task,true).uuid;
    const fp=fingerprint(['file.delete',uuid,input.fingerprintKey ?? input.name,
      input.fingerprintKey === undefined ? input.expectedDigest : null]);
    return this.deletePublished({ path, opId: input.opId, digest: input.expectedDigest,
      fingerprint: fp, result: input.result, task: { id: input.task, uuid, grant: input.grant } });
  }
  recordMissingAttachmentDelete(task: string, name: string, opId: string, key: unknown,
    grant: WriteGrant) {
    const path=this.taskPath(task,name,true),store=this.store();
    try { const saved=store.writeOperation({opId,operation:'file.delete',
      fingerprint:fingerprint(['file.delete',this.task(store.connection,task,true).uuid,key,null])},db=>{
      this.writableTask(db,task,grant);
      this.assertUnsentAttachment(db,task,path);
      if (isReserved(reservedPaths(db),path))
        throw new Problem(PROBLEM_CODE.conflict, 'File path is reserved', undefined, { reason: { kind: 'file_path_reserved' } });
      return {status:200,body:{removed:true as const}};
    });
      requirePublished({state:'published',...saved});
      return saved.body;
    } finally { store.close(); }
  }
  moveAttachmentFolder<T>(input: { task: string; from: string; to: string; opId: string;
    result: T; grant: WriteGrant }): FileOutcome<T> {
    if (![input.from,input.to].every(part=>/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(part)) || input.from===input.to)
      throw new Problem(PROBLEM_CODE.invalidInput, 'Invalid attachment request IDs', undefined, { reason: { kind: 'invalid_attachment_request_ids' } });
    const {uuid,folder}=this.taskLocation(input.task,true);
    const fp=fingerprint(['file.move',uuid,input.from,input.to]);
    const source=`${folder}/attachments/${input.from}`,destination=`${folder}/attachments/${input.to}`;
    return this.movePublished({ source, destination, opId: input.opId, fingerprint: fp,
      result: input.result, task: { id: input.task, uuid, grant: input.grant } });
  }
  putConfig<T>(input: { opId: string; bytes: Buffer; expectedDigest: string | null;
    result: T; fingerprintKey?: unknown; operation?: string; audit?: Receipt<T>['audit'] }): FileOutcome<T> {
    // The settings reader stops at MAX_DOCUMENT; a larger config.yaml would save and then never load.
    if (input.bytes.length > MAX_DOCUMENT) throw new Problem(PROBLEM_CODE.tooLarge, `${CONFIG_FILE} exceeds ${MAX_DOCUMENT / 1024 / 1024} MiB`, undefined,
      { reason: { kind: 'exceeds_mib', CONFIG_FILE: String(CONFIG_FILE), MAX_DOCUMENT: String(MAX_DOCUMENT / 1024 / 1024) } });
    return this.putPublished({ path:CONFIG_FILE, opId:input.opId, bytes:input.bytes, expectedDigest:input.expectedDigest,
      fingerprint:input.fingerprintKey === undefined
        ? fingerprint(['config.set',input.expectedDigest,fileDigest(input.bytes)])
        : fingerprint([input.operation ?? 'config.set',input.fingerprintKey]),
      result:input.result, receipt:{operation:input.operation,audit:input.audit},
      staleDigest:()=>new Problem(PROBLEM_CODE.conflict, 'Config digest differs', undefined, { reason: { kind: 'config_digest_differs' } }) });
  }
  private removeUnreferencedStage(opId: string,stage: string) {
    const store=this.store();
    let referenced: boolean;
    try { referenced=store.read(db=>!!db.prepare('SELECT 1 FROM file_operations WHERE op_id=? AND stage_path=?').get(opId,stage)); }
    finally { store.close(); }
    if (!referenced) { const writer=new FileWriter(this.root);
      try { try { unlinkSync(join(writer.meta,stage.split('/').at(-1)!)); syncFile(writer.meta); }
        catch (error) { if (!hasCode(error,'ENOENT')) throw error; } }
      finally { writer.close(); } }
  }
  readTaskFile(task: string, name: string, max = MAX_FILE_BYTES): Buffer {
    return this.withTaskFile(task, name, file => readOpenedFile(file.fd, file.size, max));
  }
  withTaskFile<T>(task: string, name: string, read: (file: OpenedFile) => T): T {
    return this.withOpenedFile(this.taskPath(task, name), () => new Problem(PROBLEM_CODE.notFound, 'Task file does not exist', undefined,
      { reason: { kind: 'task_file_does_not_exist' } }), read);
  }
  operationGet(opId: string) {
    const store=this.store();
    try { return store.read(db=>{
      const row=db.prepare('SELECT state,result_json FROM file_operations WHERE op_id=?').get(opId);
      if (!row) {
        const receipt=db.prepare('SELECT status,response_json FROM cli_operations WHERE op_id=?').get(opId);
        return receipt ? {state:'committed',status:Number(receipt.status),body:JSON.parse(String(receipt.response_json))}
          : {state:'not_found'} as const;
      }
      if (row.state!=='published') return {state:String(row.state)==='prepared'?'pending':'needs_review'};
      const receipt=JSON.parse(String(row.result_json)) as Receipt<unknown>;
      return {state:'committed',status:receipt.status,body:receipt.body};
    }); } finally { store.close(); }
  }
  /** A restore has a different time point. Observe first; never finish old intents or clean their evidence. */
  inspectRestored(): { blocked: boolean; issues: { kind: string; path: string; blocking: boolean }[] } {
    const issues: { kind: string; path: string; blocking: boolean }[] = [];
    const add = (kind: string, path: string, blocking = true) => issues.push({kind,path,blocking});
    const store=this.store(), writer=new FileWriter(this.root);
    try { store.read(db => {
      const rows=db.prepare('SELECT * FROM file_operations ORDER BY rowid').all() as Row[];
      for (const row of rows) if (row.state !== 'published') add('old_file_intent',row.id);
      const expected=new Map<string,{digest:string|null;folder:boolean}>();
      for (const row of rows) if (row.state === 'published') {
        if (row.source_path) expected.set(row.source_path,{digest:null,folder:row.kind==='move'});
        if (row.destination_path) expected.set(row.destination_path,{digest:row.kind==='move'?row.old_digest:row.new_digest,folder:row.kind==='move'});
      }
      for (const [path,state] of expected) {
        try {
          const actual=state.folder?this.manifest(writer,path):this.digestAt(writer,path);
          if (actual!==state.digest) add(actual===null?'missing_file':'changed_file',path,actual===null && state.digest!==null);
        } catch { add('unreadable_file',path); }
      }
      for (const entry of writer.entries(writer.meta))
        if (/^file-(stage|tomb)-/.test(entry.name)) add('retained_'+entry.name.split('-')[1],'.alpacawork/'+entry.name);
      const checkText=(task:string,text:string) => {
        const references=new Set(reportMediaReferences(text).map(r=>reportEmbed(r.path)?.path ?? null).filter((p):p is string=>p!==null));
        for(const match of text.matchAll(/\]\((attachments\/[^)\s]+)\)/g)) references.add(match[1]!);
        for (const reference of references) {
          const path=taskFolder(task)+'/'+reference;
          try { if (this.bytes(writer,path)===null) add('missing_reference',path); }
          catch { add('unreadable_reference',path); }
        }
      };
      for (const row of db.prepare(`SELECT t.external_id,v.value FROM task_values v JOIN tasks t ON t.id=v.task_id`).iterate())
        checkText(String(row.external_id),valuesText({value:JSON.parse(String(row.value)) as FieldValue}));
      for (const row of db.prepare(`SELECT t.external_id,l.entry,l.note_description,x.text FROM tasks t
        LEFT JOIN task_log l ON l.task_id=t.id LEFT JOIN log_texts x ON x.log_id=l.id`).iterate()) {
        for (const text of [row.entry,row.note_description,row.text]) if(typeof text==='string') checkText(String(row.external_id),text);
      }
      const spool=join(this.root,'.alpacawork/runs');
      if(existsSync(spool)) {
        if(lstatSync(spool).isSymbolicLink()) throw new Error('Linked execution spool');
        for (const run of readdirSync(spool)) {
          if(!/^R[1-9][0-9]*$/.test(run)) { add('unknown_run_path',run); continue; }
          const base=join(spool,run); if(lstatSync(base).isSymbolicLink()) {add('linked_run_path',run);continue;}
          const known=db.prepare('SELECT attempt_id,next_seq FROM run_attempts WHERE run_no=?').get(Number(run.slice(1)));
          if(!known) {add('orphan_run_output','.alpacawork/runs/'+run,false);continue;}
          const protocol=join(base,'protocol');
          if(!existsSync(protocol)) continue;
          if(lstatSync(protocol).isSymbolicLink()) {add('linked_run_protocol',run);continue;}
          for (const attempt of readdirSync(protocol)) {
            if (attempt!==known.attempt_id) {add('orphan_attempt_output',run+'/'+attempt,false);continue;}
            const events=join(protocol,attempt,'events');
            if(!existsSync(events)) continue;
            if(lstatSync(events).isSymbolicLink()) {add('linked_run_events',run);continue;}
            if(readdirSync(events).some(name=>/^\d+\.json$/.test(name)&&Number(name.slice(0,-5))>=Number(known.next_seq)))
              add('old_run_unimported_output',run+'/'+attempt);
          }
        }
      }
    }); } finally { writer.close(); store.close(); }
    return {blocked:issues.some(issue=>issue.blocking),issues};
  }
  /** Call before accepting HTTP reads or writes. Ambiguous operations keep their reservations. */
  recover(): { published: number; needsReview: number } {
    assertServeAdmission(this.root,thisRelease());
    const store=this.store(); let rows: Row[];
    try { rows=store.read(db=>db.prepare("SELECT * FROM file_operations WHERE state='prepared' ORDER BY rowid").all() as Row[]); }
    finally { store.close(); }
    let published=0,needsReview=0;
    for (const row of rows) {
      try { const result=this.finish(row); if (result.state==='published') published++; else needsReview++; }
      catch { this.markNeedsReview(row.id); needsReview++; }
    }
    const referenced=this.store(); let stages: Set<string>,tombs: Set<string>;
    try { ({stages,tombs}=referenced.read(db=>({
      stages:new Set(db.prepare("SELECT stage_path FROM file_operations WHERE state<>'published' AND stage_path IS NOT NULL").all().map(r=>String(r.stage_path))),
      tombs:new Set(db.prepare("SELECT tombstone_path FROM file_operations WHERE state<>'published' AND tombstone_path IS NOT NULL").all().map(r=>String(r.tombstone_path)))
    }))); } finally { referenced.close(); }
    const writer=new FileWriter(this.root);
    try { for (const entry of writer.entries(writer.meta)) {
      const path=`.alpacawork/${entry.name}`;
      if (/^file-stage-[0-9a-f-]{36}$/.test(entry.name) && !stages.has(path) ||
          /^file-tomb-[0-9a-f-]{36}$/.test(entry.name) && !tombs.has(path)) {
        unlinkSync(join(writer.meta,entry.name)); syncFile(writer.meta);
      }
    } } finally { writer.close(); }
    return {published,needsReview};
  }
}
