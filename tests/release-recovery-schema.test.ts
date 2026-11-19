import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ControlStore, fileHash } from '@alpacawork/db';
import { createOriginal, copyWorkspace, removeWorkspace } from '../scripts/dev-fixtures/fixture.ts';
import { snapshotGroup, readGroup } from '@alpacawork/backend/test-dist/release/recovery-data.js';
import { saveJournal, loadJournal, assertServeAdmission } from '@alpacawork/backend/test-dist/release/journal.js';
import { point } from '@alpacawork/backend/test-dist/release/layout.js';
import { setup } from './helpers/release-recovery-fixture.ts';

test('snapshot manifest indexes operations without duplicating their large frozen bodies',async t=>{
 const base=mkdtempSync(join(tmpdir(),'receipt-index-')),root=join(base,'data'),folder=join(base,'backup');
 const original=createOriginal({tasks:14,logs:19,runs:7,seed:'receipt-index'},join(base,'originals'));copyWorkspace(original.root,root);
 t.after(()=>{removeWorkspace(root);removeWorkspace(original.root);rmSync(base,{recursive:true,force:true});});
 const cli=randomUUID(),file=randomUUID(),pending=randomUUID(),payload='synthetic receipt '.repeat(131072),store=new ControlStore(root);
 try {
  store.writeOperation({opId:cli,operation:'task/comment',fingerprint:'a'.repeat(64)},()=>({status:200,body:{task:{id:'T2'},payload}}));
  store.write(db=>{
   const task=db.prepare("SELECT id FROM tasks WHERE external_id='T2'").get()!.id;
   const insert=db.prepare('INSERT INTO file_operations(id,op_id,kind,task_uuid,fingerprint,state,result_json) VALUES (?,?,?,?,?,?,?)');
   insert.run(randomUUID(),file,'put',task,'b'.repeat(64),'published',JSON.stringify({status:200,body:{payload}}));
   insert.run(randomUUID(),pending,'put',task,'c'.repeat(64),'prepared',null);
  });
 } finally {store.close();}
 const group=await snapshotGroup(root,folder);
 assert.deepEqual(group.evidence.operations.find(op=>op.opId===cli),{opId:cli,state:'committed',status:200,tasks:['T2']});
 assert.deepEqual(group.evidence.operations.find(op=>op.opId===file),{opId:file,state:'committed',status:200,tasks:['T2']});
 assert.deepEqual(group.evidence.operations.find(op=>op.opId===pending),{opId:pending,state:'prepared',tasks:['T2']});
 assert(lstatSync(join(folder,'group.json')).size<16384,'manifest size must be independent of response bodies');
 const frozen=new DatabaseSync(join(folder,'control.sqlite'),{readOnly:true});
 try {assert.equal(JSON.parse(String(frozen.prepare('SELECT response_json FROM cli_operations WHERE op_id=?').get(cli)!.response_json)).payload,payload);}
 finally {frozen.close();}
});

test('a target without the recovery gate protocol cannot reopen a general restore', { skip: process.platform !== 'linux' && 'maintenance runs from a linux-x64-glibc fixture image (Koffi native)' }, async t=>{
 const h=await setup(t,'ungated');
 const before=fileHash(join(h.workspace,'.alpacawork/alpacawork.sqlite')),failed=await h.exec([],{cli:true});
 assert.notEqual(failed.code,0);assert.match(failed.stderr,/no restore gate protocol/);assert.equal(loadJournal(h.place)!.phase,'committed');
 assert.equal(fileHash(join(h.workspace,'.alpacawork/alpacawork.sqlite')),before);
});

test('unprovable failed-side sequence stops before replacing any database', { skip: process.platform !== 'linux' && 'maintenance runs from a linux-x64-glibc fixture image (Koffi native)' }, async t=>{
 const h=await setup(t),db=new DatabaseSync(join(h.workspace,'.alpacawork/alpacawork.sqlite'));db.exec('DROP TABLE task_sequence');db.close();
 const failed=await h.exec([],{cli:true});assert.notEqual(failed.code,0);assert.match(failed.stderr,/snapshot failed/);
 const j=loadJournal(h.place)!;assert.equal(j.phase,'recovery_stopped');assert.deepEqual(j.recovery!.replaced,[]);assert.throws(()=>assertServeAdmission(h.workspace),/incomplete/);
});

test('real Drizzle partial commit uses the candidate reader while current still names the old code', { skip: process.platform !== 'linux' && 'maintenance runs from a linux-x64-glibc fixture image (Koffi native)' }, async t=>{
 const h=await setup(t,true);point(h.releases,'current',h.images.a);saveJournal(h.place,{...h.journal,phase:'old_stopped'});
 const failingData=new DatabaseSync(join(h.workspace,'.alpacawork/host.sqlite'));failingData.exec("INSERT INTO episodes(start_at,last_at,detail) VALUES (1,1,'synthetic migration failure');");failingData.close();
 const migration=spawnSync(process.execPath,[join(h.images.b,'apps/backend/dist/maintenance.js'),'migrate',h.workspace],{env:h.env,encoding:'utf8',timeout:15_000});assert.notEqual(migration.status,0);assert.match(migration.stderr,/CHECK constraint failed/);
 const committed=new DatabaseSync(join(h.workspace,'.alpacawork/alpacawork.sqlite'),{readOnly:true});try{assert.equal(committed.prepare('SELECT x FROM failed_partial_schema').get()!.x,'committed');}finally{committed.close();}
 const oldReader=spawnSync(process.execPath,[join(h.images.a,'apps/backend/dist/maintenance.js'),'inspect',h.workspace],{env:h.env,encoding:'utf8',timeout:15_000});assert.notEqual(oldReader.status,0);
 const restored=await h.exec([],{cli:true});assert.equal(restored.code,0,restored.stderr);
 const journal=loadJournal(h.place)!;assert.equal(journal.recovery!.source,h.images.a);assert.equal(journal.recovery!.reader,h.images.b);
 const read=new DatabaseSync(join(h.workspace,'.alpacawork/alpacawork.sqlite'),{readOnly:true});try{assert.equal(read.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='failed_partial_schema'").get()!.n,0);}finally{read.close();}
 const host=new DatabaseSync(join(h.workspace,'.alpacawork/host.sqlite'),{readOnly:true});try{assert.equal(host.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='rolled_back_host'").get()!.n,0);}finally{host.close();}
 if(process.env.ALPACAWORK_RECOVERY_EVIDENCE) {
  const saved=h.evidenceFile+'.receipts';mkdirSync(saved,{recursive:true});
  cpSync(h.backup,join(saved,'T0'),{recursive:true});cpSync(journal.recovery!.failure,join(saved,'failure'),{recursive:true});
  cpSync(join(h.releases,'switch.json'),join(saved,'switch.json'));cpSync(join(h.workspace,'.alpacawork/restore-identity.json'),join(saved,'restore-identity.json'));
 }
 h.evidence.push({case:'real standard Drizzle partial commit',migrationStatus:migration.status,migrationStderr:migration.stderr,oldReaderStatus:oldReader.status,oldReaderStderr:oldReader.stderr,reader:journal.recovery!.reader,journal});
});

test('a protocol 1 maintenance target is rejected before replacing any database', { skip: process.platform !== 'linux' && 'maintenance runs from a linux-x64-glibc fixture image (Koffi native)' }, async t=>{
 const h=await setup(t,'protocol1');
 const before=fileHash(join(h.workspace,'.alpacawork/alpacawork.sqlite'));
 const refused=await h.exec([],{cli:true});assert.notEqual(refused.code,0);assert.match(refused.stderr,/no restore gate protocol/);
 assert.equal(fileHash(join(h.workspace,'.alpacawork/alpacawork.sqlite')),before);assert.equal(loadJournal(h.place)!.phase,'committed');
});
