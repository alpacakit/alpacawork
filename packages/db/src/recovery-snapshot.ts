/** Stopped SQLite mechanics. Release owns the group, time point, phase and resumption policy. */
import { DatabaseSync, backup } from 'node:sqlite';
import { constants, closeSync, existsSync, fsyncSync, openSync, readSync, writeSync, renameSync, rmSync } from 'node:fs';

import { databaseState } from './database-evidence.js';
import { dirname } from 'node:path';
import { checkDatabaseFiles } from './database-family.js';
import { syncFile, openMaintenanceStage } from './maintenance-files.js';
import { fileHash } from './maintenance-files.js';
import { validateMaintenanceControlSchema } from './control-maintenance-schema.js';
import { databaseMigrationHistory } from './migrate.js';
export const DATABASES = [{name:'control',path:'.alpacawork/alpacawork.sqlite'},{name:'host',path:'.alpacawork/host.sqlite'}] as const;
export type SnapshotIdentity = { version: number; history: { name: string; hash: string }[]; workspace?: string };
export function certifySnapshot(db: DatabaseSync, kind: 'control' | 'host'): SnapshotIdentity {
  if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get())
    throw new Error('Recovery SQLite integrity/FK check failed');
  if (kind === 'control') validateMaintenanceControlSchema(db);
  const history = databaseMigrationHistory(db, kind);
  if (kind === 'host' && !history.length) throw new Error('Host migration history is absent');
  return { version: Number(db.prepare('PRAGMA user_version').get()!.user_version), history,
    ...(kind === 'control' ? { workspace: String(db.prepare('SELECT id FROM workspace_identity WHERE singleton=1').get()!.id) } : {}) };
}
/** Observe committed SQLite facts, including WAL pages, without checkpointing or deleting sidecars. */
export function inspectDatabaseFacts(path: string, kind: 'control' | 'host') {
  checkDatabaseFiles(path, kind === 'control');
  if (!existsSync(path)) return null;

  const db=new DatabaseSync(path,{readOnly:true,timeout:1000});
  try {
    db.exec('BEGIN');
    const snapshot={identity:certifySnapshot(db,kind),state:databaseState(db)};
    db.exec('COMMIT');return snapshot;
  } finally {db.close();}
}
export async function snapshotDatabase(path: string, destination: string, kind: 'control' | 'host') {
  checkDatabaseFiles(path, true);
  const db = new DatabaseSync(path, { timeout: 1000 });
  try {
    const identity = certifySnapshot(db, kind);
    // The caller holds the workspace writer for the whole set. Backup includes committed WAL pages.
    // SQLite may fail before the post-backup chmod. Its partial stage must already be private so a safe retry can inspect it.
    closeSync(openMaintenanceStage(destination));
    await backup(db, destination); syncFile(destination);
    const copy = new DatabaseSync(destination, { readOnly: true });
    try { if (JSON.stringify(certifySnapshot(copy, kind)) !== JSON.stringify(identity)) throw new Error('Snapshot identity changed'); }
    finally { copy.close(); }
    return { digest: fileHash(destination), identity };
  } finally { db.close(); }
}
/** No live reader/writer may keep the old database inode or its WAL. Do not unlink SQLite sidecars. */
export function closeDatabaseFamily(path: string): void {
  checkDatabaseFiles(path);
  if (!existsSync(path)) {
    return;
  }
  const db = new DatabaseSync(path, { timeout: 1000 });
  try {
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (checkpoint && Number(checkpoint.busy) !== 0) throw new Error('Live SQLite connection blocks replacement checkpoint');
    db.exec('PRAGMA locking_mode=EXCLUSIVE');
    if (db.prepare('PRAGMA journal_mode=DELETE').get()?.journal_mode !== 'delete') throw new Error('SQLite family is not exclusive');
    db.exec('BEGIN EXCLUSIVE; COMMIT;');
  } finally { db.close(); }
  if (['-wal','-shm','-journal'].some(suffix => existsSync(path + suffix))) throw new Error('Live SQLite sidecar prevents replacement');
  syncFile(path);
}
export function replaceDatabase(path: string, backupPath: string | null, digest: string | null): void {
  closeDatabaseFamily(path);
  if (backupPath === null) { rmSync(path, { force: true }); syncFile(dirname(path)); return; }

  if (fileHash(backupPath) !== digest) throw new Error('Backup digest differs');
  const temporary = path + '.release-restore';
  const source=openSync(backupPath,constants.O_RDONLY),buffer=Buffer.alloc(1024*1024);
  let fd=-1;
  try {
    fd=openMaintenanceStage(temporary);
    for(;;){const size=readSync(source,buffer,0,buffer.length,null);if(!size)break;
      let offset=0;while(offset<size){const written=writeSync(fd,buffer,offset,size-offset);if(!written)throw new Error('Restore copy made no progress');offset+=written;}}
    fsyncSync(fd);
  } finally {closeSync(source);if(fd>=0)closeSync(fd);}

  if (fileHash(temporary) !== digest) throw new Error('Restoration staging differs');
  renameSync(temporary, path); syncFile(dirname(path));
}
