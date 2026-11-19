import { recoveryOperationReceiptSchema } from '@alpacawork/contract/recovery';
import { FileWriter } from '../raw/storage.js';
/** Frozen DB groups and evidence. The switch journal owns when each operation is allowed. */
import { closeSync, existsSync, fsyncSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

import { DATABASES, checkDatabaseFiles, certifySnapshot, controlRecoveryEvidence, fileHash, holdControlWriter, assertControlQuiescent, snapshotDatabase, syncFile, openMaintenanceStage, replaceDatabase, raiseRecoverySequences, type RecoveryEvidence } from '@alpacawork/db';
import { atomicJson } from './atomic-json.js';
import { FileJournal } from '../control/file-journal.js';
export { DATABASES } from '@alpacawork/db';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const databaseShape = z.object({ name: z.enum(['control','host']), path: z.string(), digest: digest.nullable(), identity: z.unknown() });
const groupShape = z.object({ version: z.literal(1), root: z.string(), t0: z.string(),
  databases: z.array(databaseShape).length(2), evidence: z.object({ taskNext: z.number().int().positive(), runNext: z.number().int().positive(),
    taskMax: z.number().int().nonnegative(), runMax: z.number().int().nonnegative(), operations: z.array(recoveryOperationReceiptSchema) }),
  pathEvidence: z.array(z.string()), fileState: z.array(z.object({ path: z.literal('config.yaml'), bytes: z.string().nullable() })) });
export type DatabaseGroup = z.infer<typeof groupShape>;
/** Small publication receipt/identity checks, shared by retention and full recovery validation. */
export function readGroupReceipt(folder: string, root: string): DatabaseGroup {
  statSync(folder); const path = join(folder,'group.json');
  const checksum=join(folder,'group.sha256');
  if(fileHash(path)!==JSON.parse(readFileSync(checksum,'utf8')).digest)throw new Error('Backup group receipt digest differs');
  const group = groupShape.parse(JSON.parse(readFileSync(path,'utf8')));
  if (group.root !== root || group.databases.some((db,i) => db.name !== DATABASES[i]!.name || db.path !== DATABASES[i]!.path) ||
    group.databases[0]!.digest === null) throw new Error('Backup group identity/set differs');
  for (const db of group.databases) if (db.digest !== null && !statSync(join(folder,db.name+'.sqlite')).isFile())
    throw new Error('Backup group member is missing');
  return group;
}
export function readGroup(folder: string, root: string, workspaceIdentity?: string): DatabaseGroup {
  const group = readGroupReceipt(folder,root);
  if (workspaceIdentity !== undefined && (group.databases[0]!.identity as { workspace?: unknown } | null)?.workspace !== workspaceIdentity)
    throw new Error('Recovery group workspace identity differs from the approved installation');
  for (const db of group.databases) if (db.digest !== null) {
    const path = join(folder,db.name+'.sqlite');
    if (fileHash(path) !== db.digest) throw new Error('Backup group digest differs');
  }
  return group;
}
function namesIfPresent(path: string): string[] {
  try { statSync(path); return readdirSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
function pathEvidence(root: string, evidence: RecoveryEvidence): string[] {
  const observed: string[] = [];
  // Physical Task directories and all execution/output directories use the same public namespace.
  for (const [base,pattern] of [['tasks',/^[TP]([1-9][0-9]*)$/],['.alpacawork/runs',/^R([1-9][0-9]*)$/]] as const) {
    for (const name of namesIfPresent(join(root,base))) {
      const match = pattern.exec(name);
      if (!match) throw new Error(`Unrecognized managed identity path: ${base}/${name}`);
      const n = Number(match[1]); if (!Number.isSafeInteger(n)) throw new Error('Unsafe managed identity number');
      if (base === 'tasks') evidence.taskMax = Math.max(evidence.taskMax,n); else evidence.runMax = Math.max(evidence.runMax,n);
      observed.push(base+'/'+name);
    }
  }
  return observed.sort();
}
/** Called only by version-matched stopped maintenance. Incomplete groups are never published as usable. */
export async function snapshotGroup(root:string,folder:string,files:readonly string[]=[]):Promise<DatabaseGroup> {
  const writer=new FileWriter(root);
  try{return await writer.exclusive(()=>snapshotLockedGroup(root,folder,files));}finally{writer.close();}
}
async function snapshotLockedGroup(root: string, folder: string, files: readonly string[]): Promise<DatabaseGroup> {
  root = resolve(root); statSync(root);
  if (files.some(path => path !== 'config.yaml') || new Set(files).size !== files.length)
    throw new Error('Undeclared/unsupported recovery file; only config.yaml can be declared');
  const release = holdControlWriter(root);
  const guards:DatabaseSync[]=[];
  try {
    assertControlQuiescent(root);
    if (existsSync(join(folder,'group.json'))) return readGroup(folder,root);
    mkdirSync(dirname(folder), { recursive: true, mode: 0o700 });
    if (!existsSync(folder)) { mkdirSync(folder,{mode:0o700}); syncFile(dirname(folder)); }
    statSync(folder);
    // A killed acquisition has no group receipt; discard only its private snapshot stages, never source evidence.
    const stages=DATABASES.flatMap(({name})=>['.sqlite','.sqlite-wal','.sqlite-shm','.sqlite-journal'].map(suffix=>join(folder,name+suffix)));
    for(const stage of stages)rmSync(stage,{force:true});
    // Reserve every database against even an uncooperative SQLite writer before choosing T0.
    for(const db of DATABASES)if(existsSync(join(root,db.path))) {
      checkDatabaseFiles(join(root,db.path),true);
      const guard=new DatabaseSync(join(root,db.path),{timeout:1000});guards.push(guard);guard.exec('BEGIN IMMEDIATE');
    }
    const t0 = new Date().toISOString(), databases: DatabaseGroup['databases'] = [];
    for (const db of DATABASES) {
      checkDatabaseFiles(join(root,db.path),db.name==='control');
      databases.push({ ...db, ...(existsSync(join(root,db.path)) ? await snapshotDatabase(join(root,db.path),join(folder,db.name+'.sqlite'),db.name)
        : { digest:null, identity:null }) });
    }
    const control = new DatabaseSync(join(folder,'control.sqlite'),{readOnly:true});
    let evidence: RecoveryEvidence;
    try { evidence = controlRecoveryEvidence(control); } finally { control.close(); }
    const paths = pathEvidence(root,evidence);
    const fileState = files.map(path => {
      const file = join(root,path);
      return { path: 'config.yaml' as const, bytes: existsSync(file) ? readFileSync(file).toString('base64') : null };
    });
    const group: DatabaseGroup = {version:1,root,t0,databases,evidence,pathEvidence:paths,fileState};
    const bytes=Buffer.from(JSON.stringify(group));
    const staged=join(folder,'group.json.prepared');
    const fd=openMaintenanceStage(staged);
    try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
    atomicJson(join(folder,'group.sha256'),{digest:fileHash(staged)});
    renameSync(staged,join(folder,'group.json'));syncFile(folder);return readGroup(folder,root);
  } finally { for(const guard of guards) {try {if(guard.isTransaction)guard.exec('ROLLBACK');} finally {guard.close();}} release(); }
}
export function restoreGroupMember(root: string, folder: string, name: string): void {
  const group = readGroup(folder,root), db = group.databases.find(db => db.name===name);
  if (!db) throw new Error('Unknown backup group member');
  replaceDatabase(join(root,db.path),db.digest===null?null:join(folder,db.name+'.sqlite'),db.digest);
}
export function restoreGroupFiles(root: string, folder: string): void {
  for (const {path,bytes} of readGroup(folder,root).fileState) {
    const destination = join(root,path);
    if (bytes===null) { rmSync(destination,{force:true}); syncFile(root); continue; }
    const temporary = destination+'.release-restore',fd=openMaintenanceStage(temporary);
    try { writeFileSync(fd,Buffer.from(bytes,'base64')); fsyncSync(fd); } finally { closeSync(fd); }
     renameSync(temporary,destination); syncFile(root);
  }
}
export function applyRecoveryFloor(root: string, backup: string, failure: string): RecoveryEvidence {
  const before=readGroup(backup,root), failed=readGroup(failure,root), evidence={...failed.evidence};
  for (const key of ['taskNext','runNext','taskMax','runMax'] as const) evidence[key]=Math.max(evidence[key],before.evidence[key]);
  pathEvidence(root,evidence);
  const db=new DatabaseSync(join(root,DATABASES[0].path),{timeout:1000});
  try { certifySnapshot(db,'control'); raiseRecoverySequences(db,evidence); } finally { db.close(); }
  return evidence;
}
export function inspectRecoveryFiles(root: string) { return new FileJournal(root).inspectRestored(); }
