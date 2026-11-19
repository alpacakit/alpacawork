/** Process lifetime ownership. Every writable connection borrows this one exclusive workspace writer. */
import { closeSync, constants, openSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Problem, PROBLEM_CODE, tryLock, unlock, hasCode } from '@alpacawork/core';
import { DatabaseSync } from 'node:sqlite';
import { controlDatabasePath, controlWriterPath } from './control-files.js';
import { reuseStatements } from './statements.js';
const owners = new Map<string, { fd: number; references: number; lifetime: boolean }>();
function lockWriter(fd: number): void {
  if (!tryLock(fd)) throw new Problem(PROBLEM_CODE.conflict, 'Another serve writer owns this workspace', undefined,
    { reason: { kind: 'another_serve_writer_owns_workspace' } });
}
/** Read-only observation. A later writer race is resolved by the actual lifetime acquisition. */
export function assertControlWriterAvailable(root: string): void {
  statSync(join(root, '.alpacawork'));
  let fd: number;
  try { fd = openSync(controlWriterPath(root), constants.O_RDONLY); }
  catch (error) { if (hasCode(error, 'ENOENT')) return; throw error; }
  try { lockWriter(fd); unlock(fd); } finally { closeSync(fd); }
}
export function holdControlWriter(root: string, lifetime = true): () => void {
  const key = resolve(root), current = owners.get(key);
  if (current) {
    if (lifetime && current.lifetime) throw new Problem(PROBLEM_CODE.conflict, 'Workspace already has a serve writer in this process', undefined,
      { reason: { kind: 'workspace_already_has_serve_writer_process' } });
    if (lifetime) current.lifetime = true;
    current.references++;
  } else {
    statSync(join(key, '.alpacawork'));
    const fd = openSync(controlWriterPath(key), constants.O_RDWR | constants.O_CREAT, 0o600);
    try {
      lockWriter(fd);
    } catch (error) { closeSync(fd); throw error; }
    owners.set(key, { fd, references: 1, lifetime });
  }
  let held = true;
  return () => {
    if (!held) return; held = false;
    const owner = owners.get(key)!;
    if (lifetime) owner.lifetime = false;
    if (--owner.references === 0) { owners.delete(key); try { unlock(owner.fd); } finally { closeSync(owner.fd); } }
  };
}
/** Connections also take ownership in maintenance/library composition, before SQLite opens any file. */
export function controlConnectionLease(root: string): () => void { return holdControlWriter(root, false); }

/** The connection owns its borrowed writer until close, and releases it on every failed open. */
export function connectControlDatabase(root: string, options: { busyTimeoutMs: number }, readOnly = false): DatabaseSync {
  const releaseWriter = readOnly ? undefined : controlConnectionLease(root);
  let db: DatabaseSync;
  try {
    const filename = controlDatabasePath(root);
    if (!readOnly && !existsSync(filename)) closeSync(openSync(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600));
    db = new DatabaseSync(filename, { readOnly, timeout: options.busyTimeoutMs });
  }
  catch (error) { releaseWriter?.(); throw error; }
  const sqliteClose = db.close.bind(db);
  db.close = () => { try { sqliteClose(); } finally { releaseWriter?.(); } };
  reuseStatements(db);
  return db;
}
/** Stopped maintenance must not borrow a still-open managed connection in its own process. */
export function assertControlQuiescent(root:string):void {
  const owner=owners.get(resolve(root));
  if(!owner?.lifetime||owner.references!==1)throw new Error('Managed SQLite connections must close before group maintenance');
}
