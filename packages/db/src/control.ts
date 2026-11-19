/** The single durable control database. Only the current version opens; a fresh file gets its whole baseline. */
import { randomUUID, createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { connectControlDatabase } from './control-writer.js';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrateDatabase, databaseMigrationHistory } from './migrate.js';
import { validateControlMigrations } from './control-migrations.js';
import { validateMaintenanceControlSchema } from './control-maintenance-schema.js';
import { checkDatabaseFiles, validBusyTimeout, type DatabaseOptions } from './sqlite.js';
import { ChangeScope, currentChangeScope, guardControlWrites } from './change-scope.js';

import { controlDatabasePath } from './control-files.js';
export { controlDatabasePath } from './control-files.js';
export const taskHash = (uuid: string, revision: number | bigint) =>
  createHash('sha256').update(`task-v1:${uuid}:${revision}`).digest('hex');
const operationConnection = new AsyncLocalStorage<{ root: string; db: DatabaseSync }>();
/** Services participating in one HTTP operation borrow its SQLite connection. */
export function currentControlConnection(root: string): DatabaseSync | undefined {
  const current = operationConnection.getStore();
  return current?.root === root ? current.db : undefined;
}

/**
 * The control database files this process has found sound (`PRAGMA quick_check` and `foreign_key_check`), by the
 * file's identity: a file made or put in its place later (a new inode or birth time) is checked again on its first
 * open. A check reads every page, so it grows with the database; serve opens this file several times for each project
 * on every pass, where repeating it on a file already found sound would cost a full read each time. A file written over
 * in place keeps its identity and is not checked again; on a filesystem without birth times, where a new file can
 * take a freed inode, every open is checked.
 */
const soundFiles = new Set<string>();
function fileIdentity(filename: string): string | null {
  try {
    const stat = lstatSync(filename, { bigint: true });
    return stat.birthtimeNs === 0n ? null : `${filename}\0${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** That this process has checked the control database's current file, for another thread of it to know (`markControlFileSound`). */
export function soundControlFile(root: string): string | null {
  const identity = fileIdentity(controlDatabasePath(root));
  return identity !== null && soundFiles.has(identity) ? identity : null;
}
export function markControlFileSound(identity: string): void { soundFiles.add(identity); }

/**
 * Creation fixes WAL (`openControl`), but a restored backup file comes back in rollback mode and stays there: every
 * reader then holds off the writer, and every commit syncs several times. A serve puts it back; a database already in
 * WAL takes no lock here. Failing to is not fatal: the database works in either mode, and the next serve tries again.
 * Whether it is in WAL now.
 */
export function restoreControlWal(root: string): boolean {
  try {
    const db = openControlDatabase(root, { busyTimeoutMs: 5_000 });
    try {
      if (db.prepare('PRAGMA journal_mode').get()?.journal_mode === 'wal') return true;
      return db.prepare('PRAGMA journal_mode=WAL').get()?.journal_mode === 'wal';
    } finally { db.close(); }
  } catch (error) {
    console.error('The control database could not return to WAL', error);
    return false;
  }
}

/** Maintenance recognizes the closed historical source set; conversion belongs to its single maintenance Owner. */
export function openControlMaintenanceDatabase(root: string, options: DatabaseOptions, readOnly = true): DatabaseSync {
  return openControl(root, options, readOnly, false, true);
}
/** Installation identity is stable across known migration prefixes, unlike a business-data connection.
 * This read never initializes, migrates, repairs, or claims that the database is ready for business writes. */
export function readControlWorkspaceIdentity(root: string, options: DatabaseOptions): unknown {
  if (!validBusyTimeout(options)) throw new Problem(PROBLEM_CODE.invalidInput, 'Invalid busy timeout', undefined,
    { reason: { kind: 'invalid_busy_timeout' } });
  checkDatabaseFiles(controlDatabasePath(root), true);
  const db = connectControlDatabase(root, options, true);
  try {
    db.exec('BEGIN');
    if (!databaseMigrationHistory(db, 'control').length)
      throw new Problem(PROBLEM_CODE.databaseUnavailable, 'Workspace identity requires a known control migration history', undefined,
        { reason: { kind: 'workspace_identity_history_required' } });
    return db.prepare('SELECT id FROM workspace_identity WHERE singleton=1').get()?.id;
  } finally { db.close(); }
}
const readOnlyConnections = new WeakSet<DatabaseSync>();
const workspaceRoots = new WeakMap<DatabaseSync, string>();
const connectionFiles = new WeakMap<DatabaseSync, string | null>();
/** The workspace whose managed connection established this read point. */
export const controlRoot = (db: DatabaseSync): string | undefined => workspaceRoots.get(db);
/**
 * What a long-lived server keeps of a table whose rows are only ever added and whose kept columns never change (its
 * writers refuse the rest): each read then reads only the rows after the last. Rows read on a read-only connection are
 * committed, so they are kept; a write's own may still roll back, so they stay in that read. Other processes keep
 * nothing and read as they always did.
 */
export class KeptTable<Kept> {
  private kept: Kept | null = null;
  private through = 0;
  private lastId: unknown = null;
  private workspace: unknown;
  private file: unknown;
  private readonly identities = new Map<number, unknown>();
  constructor(private readonly table: string, private readonly empty: () => Kept,
    private readonly add: (kept: Kept, rows: readonly Record<string, unknown>[]) => void) {}
  /** A kept row that could not be decoded is read again, from the table, by the next read. */
  forget(): void { this.kept = null; }
  /**
   * What is kept and the rows after it at `db`'s read point (`rowsAfter`, in rowid order, each with its `id`): null when
   * this read cannot use it, being older than what is kept, or a write's before anything is kept. Kept rows that are no
   * longer the table's (a restored database) are dropped.
   */
  at(db: DatabaseSync, rowsAfter: (through: number) => readonly Record<string, unknown>[]):
    { kept: Kept; own: readonly Record<string, unknown>[]; through: number } | null {
    const workspace = db.prepare('SELECT id FROM workspace_identity WHERE singleton=1').get()?.id;
    const file = connectionFiles.get(db) ?? undefined;
    if (workspace !== this.workspace || file !== this.file) { this.forget(); this.workspace = workspace; this.file = file; }
    const tail = db.prepare(`SELECT rowid AS kept_rowid,id FROM ${this.table} ORDER BY rowid DESC LIMIT 1`).get();
    const last = Number(tail?.kept_rowid ?? 0);
    if (this.kept !== null) {
      if (this.through > last) {
        if (last === 0 || this.identities.get(last) === db.prepare(`SELECT id FROM ${this.table} WHERE rowid=?`).get(last)?.id)
          return { kept: this.kept, own: [], through: last };
        this.forget();
      }
      const same = this.kept === null || this.lastId === null ||
        (this.through === last ? tail?.id : db.prepare(`SELECT id FROM ${this.table} WHERE rowid = ?`).get(this.through)?.id) === this.lastId;
      if (!same) this.kept = null;
    }
    const committed = readOnlyConnections.has(db);
    if (this.kept === null) {
      if (!committed) return null;
      this.kept = this.empty();
      this.through = 0; this.lastId = null; this.identities.clear();
    }
    const added = last > this.through ? rowsAfter(this.through) : [];
    if (!committed) return { kept: this.kept, own: added, through: last };
    if (added.length) {
      this.add(this.kept, added);
      for (const row of db.prepare(`SELECT rowid AS kept_rowid,id FROM ${this.table} WHERE rowid>? ORDER BY rowid`).all(this.through))
        this.identities.set(Number(row.kept_rowid), row.id);
      this.through = last; this.lastId = tail!.id;
    }
    return { kept: this.kept, own: [], through: last };
  }
}
const keptByRoot = new Map<string, Map<string, unknown>>();
/** From now until the returned function is called, this process keeps what it reads of `root` (`keptOf`). */
export function keepControlTables(root: string): () => void {
  const entry = new Map<string, unknown>();
  keptByRoot.set(root, entry);
  return () => { if (keptByRoot.get(root) === entry) keptByRoot.delete(root); };
}
/** What this process keeps of `root` under this name, made once, or undefined when it keeps nothing of `root`. */
export function keptOf<Kept>(root: string, name: string, make: () => Kept): Kept | undefined {
  const entry = keptByRoot.get(root);
  if (!entry) return undefined;
  if (!entry.has(name)) entry.set(name, make());
  return entry.get(name) as Kept;
}
export function openControlDatabase(root: string, options: DatabaseOptions, readOnly = false, create = false): DatabaseSync {
  const db = openControl(root, options, readOnly, create);
  workspaceRoots.set(db, root);
  if (readOnly) readOnlyConnections.add(db);
  else guardControlWrites(root, db);
  return db;
}
function openControl(root: string, options: DatabaseOptions, readOnly: boolean, create: boolean, maintenance = false): DatabaseSync {
  if (!validBusyTimeout(options))
    throw new Problem(PROBLEM_CODE.invalidInput, 'Invalid busy timeout', undefined, { reason: { kind: 'invalid_busy_timeout' } });
  const filename = controlDatabasePath(root);
  if (create) mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  else statSync(dirname(filename));
  checkDatabaseFiles(filename, !create);
  const existed = existsSync(filename), before = fileIdentity(filename);
  const db = connectControlDatabase(root, options, readOnly);
  try {
    const creating = !existed && create && !readOnly;
    if (!maintenance && !creating) {
      validateControlMigrations(db);
    }
    const identity = before !== null && fileIdentity(filename) === before ? before : null;
    db.exec('PRAGMA foreign_keys=ON');
    if (!readOnly) db.exec('PRAGMA synchronous=FULL;');
    const sound = identity !== null && soundFiles.has(identity);
    if (!sound && db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('SQLite integrity check failed');
    if (creating) migrateDatabase(drizzle({ client: db }), 'control');
    if (maintenance) validateMaintenanceControlSchema(db);
    else validateControlMigrations(db);
    if (!sound && db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Control database foreign key check failed');
    // Fresh images are DELETE-format. Only a certified current business writer activates WAL, under
    // the existing connection lease and busy timeout. Existing WAL connections avoid a mode-changing pragma.
    if (!readOnly && !maintenance) {
      const mode = db.prepare('PRAGMA journal_mode').get()?.journal_mode;
      if (mode === 'delete') {
        if (db.prepare('PRAGMA journal_mode=WAL').get()?.journal_mode !== 'wal')
          throw new Problem(PROBLEM_CODE.databaseUnavailable, 'Cannot activate control database WAL mode', undefined,
            { reason: { kind: 'control_wal_activation_failed' } });
      } else if (mode !== 'wal') throw new Problem(PROBLEM_CODE.databaseUnavailable, `Unexpected control database journal mode: ${mode}`, undefined,
        { reason: { kind: 'control_journal_mode_unsupported', mode: String(mode) } });
    }
    if (identity !== null) soundFiles.add(identity);
    connectionFiles.set(db, identity);
    return db;
  } catch (error) { db.close(); throw error; }
}

export type TransactionBegin = 'BEGIN' | 'BEGIN IMMEDIATE';
type TransactionBoundary = { root: string; db: DatabaseSync; borrowed: boolean; savepoint: string;
  exec: (sql: string) => void };
type TransactionStore = TransactionBoundary & { notSynchronous: () => Problem };
/** Sync and async stores share exactly this begin/commit/rollback procedure. */
function controlTransaction(store: TransactionBoundary, begin: TransactionBegin) {
  const { root, db, exec } = store, write = begin === 'BEGIN IMMEDIATE';
  const own = !store.borrowed || !db.isTransaction;
  const parent = currentChangeScope(db);
  if (write && !own && !parent) throw new Error('Nested business write requires a managed ChangeScope');
  const savepoint = !own && write ? `${store.savepoint}_${randomUUID().replaceAll('-', '')}` : null;
  if (own) exec(begin);
  else if (savepoint) exec(`SAVEPOINT ${savepoint}`);
  const scope = write ? new ChangeScope(root, db, parent) : undefined;
  let ended = false;
  return {
    run<T>(work: () => T): T { return scope ? scope.run(work) : work(); },
    commit() {
      if (own) exec('COMMIT');
      else if (savepoint) exec(`RELEASE ${savepoint}`);
      // The committed journal is published synchronously, before a callback/response can observe success.
      ended = true;
      scope?.finish(true);
    },
    rollback() {
      if (ended) return;
      try {
        if (own) exec('ROLLBACK');
        else if (savepoint) { exec(`ROLLBACK TO ${savepoint}`); exec(`RELEASE ${savepoint}`); }
      } catch { /* Preserve the original failure. */ }
      finally { scope?.finish(false); ended = true; }
    },
  };
}
/**
 * The one transaction procedure of the control database's stores: who owns the transaction, the savepoint of a write
 * nested in a borrowed one, its committed change keys, and the rollback that never hides the failure behind it.
 * `exec` is how the store runs its own statements (and classifies their failures), never the callback.
 */
export function inTransaction<T>(store: TransactionStore, begin: TransactionBegin, callback: () => T): T {
  const transaction = controlTransaction(store, begin);
  try {
    const result = transaction.run(callback);
    if (result && typeof (result as { then?: unknown }).then === 'function') throw store.notSynchronous();
    transaction.commit();
    return result;
  } catch (error) {
    transaction.rollback();
    throw error;
  }
}

/** Owns the only write boundary for Task, placement, request, Run, return and receipt facts. */
export class ControlStore {
  readonly connection: DatabaseSync;
  private closed = false;
  private active = false;
  private readonly borrowed: boolean;
  constructor(readonly root: string, options: DatabaseOptions = { busyTimeoutMs: 1_000 },
    readonly readOnly = false, create = false) {
    const shared = currentControlConnection(root);
    this.borrowed = shared !== undefined;
    this.connection = shared ?? openControlDatabase(root, options, readOnly, create);
  }
  close(): void {
    if (this.active) throw new Problem(PROBLEM_CODE.conflict, 'Control transaction is active', undefined, { reason: { kind: 'control_transaction_active' } });
    if (!this.closed && !this.borrowed) this.connection.close();
    this.closed = true;
  }
  read<T>(callback: (db: DatabaseSync) => T): T { return this.transaction('BEGIN', callback); }
  /** A projection captures its DB facts on a separate WAL reader, without occupying the command lane. */
  async readAsync<T>(callback: () => Promise<T>): Promise<T> { return this.asyncTransaction('BEGIN', callback); }
  write<T>(callback: (db: DatabaseSync) => T): T {
    if (this.readOnly) throw new Problem(PROBLEM_CODE.forbidden, 'Control database is read-only', undefined, { reason: { kind: 'control_database_read_only' } });
    return this.transaction('BEGIN IMMEDIATE', callback);
  }
  /**
   * A committed response is immutable. Callers authenticate and normalize input before this boundary. The operation ID
   * alone names an operation.
   */
  writeOperation<T>(input: { opId: string; operation: string; fingerprint: string },
    callback: (db: DatabaseSync) => { status: number; body: T }): { status: number; body: T; replayed: boolean } {
    return this.write(db => {
      const prior = this.replayOperation<T>(db, input);
      return prior ?? this.saveOperation(db, input, callback(db));
    });
  }
  async writeOperationAsync<T>(input: { opId: string; operation: string; fingerprint: string },
    callback: () => Promise<{ status: number; body: T }> | { status: number; body: T },
    authorize?: () => void):
    Promise<{ status: number; body: T; replayed: boolean }> {
    if (this.readOnly) throw new Problem(PROBLEM_CODE.conflict, 'Control store is busy or closed', undefined, { reason: { kind: 'control_store_busy_or_closed' } });
    return this.asyncTransaction('BEGIN IMMEDIATE', async () => {
      authorize?.();
      const prior = this.replayOperation<T>(this.connection, input);
      return prior ?? this.saveOperation(this.connection, input, await callback());
    });
  }
  private replayOperation<T>(db: DatabaseSync, input: { opId: string; operation: string; fingerprint: string }):
    { status: number; body: T; replayed: boolean } | null {
    const prior = db.prepare('SELECT operation,fingerprint,status,response_json FROM cli_operations WHERE op_id=?')
      .get(input.opId);
    if (prior) {
      if (prior.operation !== input.operation || prior.fingerprint !== input.fingerprint)
        throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Operation ID belongs to different input', undefined,
          { reason: { kind: 'operation_id_belongs_different_input' } });
      return { status: Number(prior.status), body: JSON.parse(String(prior.response_json)) as T, replayed: true };
    }
    if (db.prepare('SELECT 1 FROM file_operations WHERE op_id=?').get(input.opId))
      throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Operation ID belongs to a file operation', undefined,
        { reason: { kind: 'operation_id_belongs_file_operation' } });
    return null;
  }
  private saveOperation<T>(db: DatabaseSync, input: { opId: string; operation: string; fingerprint: string },
    result: { status: number; body: T }): { status: number; body: T; replayed: boolean } {
    const json = JSON.stringify(result.body);
    if (json === undefined) throw new Problem(PROBLEM_CODE.invalidInput, 'Operation response must be JSON', undefined, { reason: { kind: 'operation_response_must_json' } });
    db.prepare(`INSERT INTO cli_operations(op_id,operation,fingerprint,status,response_json,committed_at)
      VALUES (?,?,?,?,?,?)`).run(input.opId, input.operation, input.fingerprint,
      result.status, json, new Date().toISOString());
    return { ...result, replayed: false };
  }
  operationGet(opId: string): { status: number; body: unknown } | null {
    return this.read(db => {
      const row = db.prepare('SELECT status,response_json FROM cli_operations WHERE op_id=?').get(opId);
      return row ? { status: Number(row.status), body: JSON.parse(String(row.response_json)) } : null;
    });
  }
  private transaction<T>(begin: TransactionBegin, callback: (db: DatabaseSync) => T): T {
    if (this.active || this.closed) throw new Problem(PROBLEM_CODE.conflict, 'Control store is busy or closed', undefined, { reason: { kind: 'control_store_busy_or_closed' } });
    this.active = true;
    try {
      return inTransaction({ root: this.root, db: this.connection, borrowed: this.borrowed, savepoint: 'control',
        exec: sql => this.connection.exec(sql),
        notSynchronous: () => new Problem(PROBLEM_CODE.invalidInput, 'Control transaction callback must be synchronous', undefined,
          { reason: { kind: 'control_transaction_callback_must_synchronous' } }),
      }, begin,
      // Nested Task and Run services must use this transaction's connection.
      // Otherwise a Run read/write opened during a Task write waits on its own lock.
      () => operationConnection.run({ root: this.root, db: this.connection }, () => callback(this.connection)));
    } finally { this.active = false; }
  }
  /** An async transaction holds this store's connection across its awaits, so a borrowed store cannot take one. */
  private async asyncTransaction<T>(begin: TransactionBegin, work: () => Promise<T>): Promise<T> {
    if (this.closed || this.active || this.borrowed)
      throw new Problem(PROBLEM_CODE.conflict, 'Control store is busy or closed', undefined, { reason: { kind: 'control_store_busy_or_closed' } });
    const db = this.connection;
    const transaction = controlTransaction({ root: this.root, db, borrowed: false, savepoint: 'control',
      exec: sql => db.exec(sql) }, begin);
    this.active = true;
    try {
      const result = await transaction.run(() => operationConnection.run({ root: this.root, db }, work));
      transaction.commit();
      return result;
    } catch (error) {
      transaction.rollback();
      throw error;
    } finally { this.active = false; }
  }
}
