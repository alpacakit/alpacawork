import { CLI_CONTRACT, CONTRACT_HEADER } from '@alpacawork/contract/client-contract';
import { atomicJson } from '@alpacawork/backend/test-dist/release/atomic-json.js';
import { cleanCliEnv } from './helpers/http-cli.ts';
import { preserveTestFailure } from './helpers/failure-workspace.ts';
import { reserveAttempt } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { backendEntry } from '@alpacawork/backend/test-dist/app-paths.js';
import { EventJournal,executionFolder,identityOf } from '@alpacawork/backend/test-dist/runs/execution-files.js';
import { bootIdentity } from '@alpacawork/core';
import assert from 'node:assert/strict';
import { test,type TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, lstatSync, rmSync, realpathSync, renameSync } from 'node:fs';
import { basename,dirname,join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ControlStore, openDatabase, fileHash, readControlWorkspaceIdentity } from '@alpacawork/db';
import { createOriginal,copyWorkspace,removeWorkspace } from '../scripts/dev-fixtures/fixture.ts';
import { snapshotGroup,readGroup,restoreGroupMember,restoreGroupFiles,applyRecoveryFloor } from '@alpacawork/backend/test-dist/release/recovery-data.js';
import { FileJournal } from '@alpacawork/backend/test-dist/control/file-journal.js';
import { saveJournal, assertServeAdmission, releaseAdmission, restoreId, assertMutationIdentity } from '@alpacawork/backend/test-dist/release/journal.js';
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { RunStore } from '@alpacawork/runs';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';

const events:unknown[]=[];
const maintenanceEntry=backendEntry('maintenance',resolve('.'));
async function fixture(t:TestContext) {
 const base=realpathSync(mkdtempSync(join(tmpdir(),'recovery-data-'))),root=join(base,'data');
 const original=createOriginal({tasks:14,logs:19,runs:7,seed:'recovery-data-v1'},join(base,'originals'));copyWorkspace(original.root,root);
 t.after(async()=>{await preserveTestFailure(t,base,{databaseRoot:root});removeWorkspace(root);removeWorkspace(original.root);rmSync(base,{recursive:true,force:true});
   if(process.env.ALPACAWORK_RECOVERY_DATA_EVIDENCE)writeFileSync(process.env.ALPACAWORK_RECOVERY_DATA_EVIDENCE,JSON.stringify({node:process.version,pid:process.pid,events},null,2));});
 return {base,root,control:join(root,'.alpacawork/alpacawork.sqlite'),host:join(root,'.alpacawork/host.sqlite')};
}

test('same stopped interval snapshots committed WAL pages and refuses open managed connections',async t=>{
 const h=await fixture(t),managed=new ControlStore(h.root);
 await assert.rejects(snapshotGroup(h.root,join(h.base,'busy')),/connections must close/);managed.close();
 const host=openDatabase(h.host,'host',{busyTimeoutMs:1000});host.$client.close();
 const wal=new DatabaseSync(h.control);wal.exec('PRAGMA journal_mode=WAL;UPDATE task_sequence SET next_number=88;');
 assert(existsSync(h.control+'-wal'));assert(lstatSync(h.control+'-wal').size>0);
 const before=performance.now(),group=await snapshotGroup(h.root,join(h.base,'backup'));
 const copy=new DatabaseSync(join(h.base,'backup/control.sqlite'),{readOnly:true});
 try{assert.equal(copy.prepare('SELECT next_number FROM task_sequence').get()!.next_number,88);}finally{copy.close();}
 events.push({case:'WAL snapshot',elapsedMs:performance.now()-before,walBytes:lstatSync(h.control+'-wal').size,dbBytes:group.databases.map(x=>({name:x.name,bytes:x.digest?lstatSync(join(h.base,'backup',x.name+'.sqlite')).size:0}))});
 // A real lingering WAL reader must prevent inode replacement, even when it ignores writer.lock.
 wal.exec('BEGIN;SELECT * FROM task_sequence;');
 assert.throws(()=>restoreGroupMember(h.root,join(h.base,'backup'),'control'));
 wal.exec('ROLLBACK');wal.close();
 restoreGroupMember(h.root,join(h.base,'backup'),'control');assert.equal(fileHash(h.control),group.databases[0]!.digest);
});

test('capacity-limited real SQLite backup publishes no group and a retry preserves the same sources',async t=>{
 const h=await fixture(t),backup=join(h.base,'limited'),before=fileHash(h.control);
 const result=spawnSync('/bin/bash',['-c','trap "" XFSZ; ulimit -f 32; exec "$@"','capacity-fixture',process.execPath,maintenanceEntry,'recovery-snapshot',h.root,backup],{encoding:'utf8',timeout:15_000,
  // RLIMIT_FSIZE applies to every child write, including a shared guard log already above the quota.
  // Keep the guard loaded; give this deliberately capacity-limited child its own initially empty log.
  env:cleanCliEnv(process.env.ALPACAWORK_E2E_GUARD_LOG?{ALPACAWORK_E2E_GUARD_LOG:join(h.base,'quota-guard.jsonl')}:{})});
 events.push({case:'file quota',limitBytes:32*1024,status:result.status,signal:result.signal,stderr:result.stderr});
 assert.notEqual(result.status,0);assert.equal(existsSync(join(backup,'group.json')),false);
 assert.equal(fileHash(h.control),before);
 if(process.env.ALPACAWORK_RECOVERY_DATA_EVIDENCE) {
  const saved=join(dirname(process.env.ALPACAWORK_RECOVERY_DATA_EVIDENCE),'quota-'+basename(h.base));
  cpSync(backup,saved,{recursive:true});
  const files=readdirSync(backup).map(name=>({name,mode:lstatSync(join(backup,name)).mode&0o777,bytes:lstatSync(join(backup,name)).size,digest:fileHash(join(backup,name))}));
  writeFileSync(join(saved,'observation.json'),JSON.stringify({command:['maintenance','recovery-snapshot',h.root,backup],status:result.status,signal:result.signal,stdout:result.stdout,stderr:result.stderr,source:before,files},null,2));
 }
 assert.equal(lstatSync(join(backup,'control.sqlite')).mode&0o077,0,'a failed backup leaves a private resumable stage');
 const successful=await snapshotGroup(h.root,backup);assert.equal(successful.root,h.root);
 const copy=new DatabaseSync(join(backup,'control.sqlite'),{readOnly:true});try{assert.equal(copy.prepare('SELECT count(*) n FROM tasks').get()!.n,14);}finally{copy.close();}
});

test('partial commit and one replaced database cannot reopen business until floor and file diagnostics finish',async t=>{
 const h=await fixture(t);const host=openDatabase(h.host,'host',{busyTimeoutMs:1000});host.$client.close();
 const old=join(h.base,'old');await snapshotGroup(h.root,old);
 const db=new ControlStore(h.root);db.write(db=>{db.prepare('UPDATE task_sequence SET next_number=99').run();db.prepare('UPDATE run_sequence SET next_number=120').run();});db.close();
 const partial=new DatabaseSync(h.host);partial.exec('CREATE TABLE partial_commit(x TEXT); INSERT INTO partial_commit VALUES (\'committed\')');partial.close();
 const failed=join(h.base,'failed');await snapshotGroup(h.root,failed);
 const releases=join(h.base,'releases');mkdirSync(releases);
 const journal={version:4 as const,skillsWriteStarted:false,opId:randomUUID(),workspace:h.root,old:'old',target:'new',previous:null,schema:16,phase:'recovery_replacing' as const,
   recovery:{id:randomUUID(),backup:old,failure:failed,source:'new',reader:'new',target:'old',replaced:[] as string[]}};
 saveJournal({workspace:h.root,releases},journal);
 const inode=lstatSync(join(h.root,'.alpacawork/writer.lock')).ino;
 restoreGroupMember(h.root,old,'control');
 await assert.rejects(startServer(h.root,0),/incomplete/);assert.throws(()=>new FileJournal(h.root).recover(),/incomplete/);
 const runs=RunStore.openReadable(h.root,{busyTimeoutMs:1000})!;try{assert.throws(()=>new RunEventImporter(runs).pass(),/incomplete/);}finally{runs.close();}
 const check=new DatabaseSync(h.host,{readOnly:true});assert.equal(check.prepare('SELECT x FROM partial_commit').get()!.x,'committed');check.close();
 restoreGroupMember(h.root,old,'host');mkdirSync(join(h.root,'tasks/T150'),{recursive:true});mkdirSync(join(h.root,'.alpacawork/runs/R200'),{recursive:true});
 const floor=applyRecoveryFloor(h.root,old,failed);assert.equal(floor.taskMax,150);assert.equal(floor.runMax,200);
 const after=new ControlStore(h.root);try{assert.equal(after.read(db=>db.prepare('SELECT next_number FROM task_sequence').get()!.next_number),151);assert.equal(after.read(db=>db.prepare('SELECT next_number FROM run_sequence').get()!.next_number),201);}finally{after.close();}
 assert.equal(lstatSync(join(h.root,'.alpacawork/writer.lock')).ino,inode);
 assert.equal(new FileJournal(h.root).inspectRestored().blocked,false);
});

test('FileJournal diagnoses old prepared intent, missing reference, orphan stage/tomb and old Run tail without publish or cleanup',async t=>{
 const h=await fixture(t),task='T2',bytes=Buffer.from('retained');
 const journal=new FileJournal(h.root,phase=>{if(phase==='reserved')throw Error('simulated crash');});
 assert.throws(()=>journal.putTaskFile({task,name:'old.txt',opId:randomUUID(),bytes,result:{},grant:()=>({actor:{kind:'human'},task})}),/crash/);
 const meta=join(h.root,'.alpacawork'),stage=readdirSync(meta).find(name=>name.startsWith('file-stage-'))!;
 writeFileSync(join(meta,'file-stage-'+randomUUID()),'orphan-stage');writeFileSync(join(meta,'file-tomb-'+randomUUID()),'orphan-tomb');
 const control=new ControlStore(h.root);control.write(db=>db.prepare("INSERT OR REPLACE INTO task_values(task_id,field_id,value) SELECT id,'notes',? FROM tasks WHERE external_id=?").run(JSON.stringify('![missing](attachments/request/missing.png)'),task));control.close();
 const runs=new RunStore(h.root,{busyTimeoutMs:1000});
 let launch;try{launch=runs.write(tx=>reserveAttempt(runs,tx,tx.runtimeGet('R1')!,resolve('apps/backend/test-dist/run-manager.js'),{run_minutes:1,coordinator_run_minutes:1}));}finally{runs.close();}
 const spool=executionFolder(h.root,'R1',launch.attemptId),oldOutput=new EventJournal(spool,identityOf(launch));
 oldOutput.append('claimed',{managerPid:process.pid,managerStarted:'synthetic-start',bootId:bootIdentity()});
 const outputPath=join(spool,'events','000000000001.json'),outputDigest=fileHash(outputPath);
 const report=new FileJournal(h.root).inspectRestored();assert(report.blocked);
 assert.equal(fileHash(outputPath),outputDigest);assert(report.issues.some(x=>x.kind==='old_run_unimported_output'));
 for(const kind of ['old_file_intent','missing_reference','retained_stage','retained_tomb'])assert(report.issues.some(x=>x.kind===kind),kind);
 assert(existsSync(join(meta,stage)));assert.equal(existsSync(join(h.root,'tasks',task,'old.txt')),false);
 const count=new ControlStore(h.root);try{assert.equal(count.read(db=>db.prepare("SELECT state FROM file_operations").get()!.state),'prepared');}finally{count.close();}
 events.push({case:'file diagnostics',report});
});

test('waiting phase permits existing import while final maintenance phases fail before ordinary opening',async t=>{
 const h=await fixture(t),releases=join(h.base,'releases');mkdirSync(releases);
 const j={version:4 as const,skillsWriteStarted:false,opId:randomUUID(),workspace:h.root,old:'old',target:'target',previous:null,schema:16,phase:'waiting_runs' as const};
 saveJournal({workspace:h.root,releases},j);assert.equal(releaseAdmission(h.root),'waiting_runs');assert.doesNotThrow(()=>assertServeAdmission(h.root));
 const runs=RunStore.openReadable(h.root,{busyTimeoutMs:1000})!;try{assert.deepEqual(new RunEventImporter(runs).pass(),[]);}finally{runs.close();}
 const prior=restoreId(h.root);assert.equal(prior,'initial');assert.doesNotThrow(()=>assertMutationIdentity(h.root,'initial'));
 const id=randomUUID();atomicJson(join(h.root,'.alpacawork/restore-identity.json'),{version:1,id,failure:join(h.base,'failed'),reader:'source'});
 assert.throws(()=>assertMutationIdentity(h.root,'initial'),{code:'restore_changed'});assert.throws(()=>assertMutationIdentity(h.root,null),{code:'restore_changed'});assert.doesNotThrow(()=>assertMutationIdentity(h.root,id));
 assert.equal(restoreId(h.root),id);assert.equal(restoreId(h.root),id);
});

test('only declared config bytes or nonexistence are restored; ordinary file, skill and repository bytes stay current',async t=>{
 const h=await fixture(t),taskFile=join(h.root,'tasks/T2/current.txt');mkdirSync(join(h.root,'tasks/T2'),{recursive:true});writeFileSync(taskFile,'before');
 const skill=join(h.base,'isolated-skill');writeFileSync(skill,'edited skill');const repository=join(h.base,'repository');mkdirSync(repository);writeFileSync(join(repository,'source.txt'),'repository changes');
 const ordinary=join(h.base,'ordinary');await snapshotGroup(h.root,ordinary);
 writeFileSync(taskFile,'after');writeFileSync(join(h.root,'config.yaml'),'# current configuration\n');
 restoreGroupMember(h.root,ordinary,'control');restoreGroupFiles(h.root,ordinary);
 assert.equal(readFileSync(taskFile,'utf8'),'after');assert.equal(readFileSync(join(h.root,'config.yaml'),'utf8'),'# current configuration\n');
 await assert.rejects(snapshotGroup(h.root,join(h.base,'forbidden-file'),['../isolated-skill']),/Undeclared/);
 const declared=join(h.base,'declared');await snapshotGroup(h.root,declared,['config.yaml']);writeFileSync(join(h.root,'config.yaml'),'# migrated\n');restoreGroupFiles(h.root,declared);assert.equal(readFileSync(join(h.root,'config.yaml'),'utf8'),'# current configuration\n');
 rmSync(join(h.root,'config.yaml'));const absent=join(h.base,'absent');await snapshotGroup(h.root,absent,['config.yaml']);writeFileSync(join(h.root,'config.yaml'),'# newly-created-by-declared-migration\n',{mode:0o600});restoreGroupFiles(h.root,absent);assert.equal(existsSync(join(h.root,'config.yaml')),false);
 assert.equal(readFileSync(skill,'utf8'),'edited skill');assert.equal(readFileSync(join(repository,'source.txt'),'utf8'),'repository changes');assert.equal(readFileSync(taskFile,'utf8'),'after');
});

for(const entry of ['direct','maintenance'] as const)test(`orphan committed WAL family is refused before publishing a ${entry} snapshot`,async t=>{
 const h=await fixture(t),empty=await snapshotGroup(h.root,join(h.base,'truly-absent'));
 assert.equal(empty.databases[1]!.digest,null);
 openDatabase(h.host,'host',{busyTimeoutMs:1000}).$client.close();
 const raw=new DatabaseSync(h.host);raw.exec("PRAGMA journal_mode=WAL;INSERT INTO episodes(start_at,last_at,detail) VALUES(1,1,'real committed WAL');");
 const lost=join(h.base,'lost-main.sqlite');renameSync(h.host,lost);
 const hashes=['-wal','-shm'].map(suffix=>({suffix,bytes:lstatSync(h.host+suffix).size,digest:fileHash(h.host+suffix)}));
 const before=fileHash(lost),backup=join(h.base,'incomplete');
 try {
  if(entry==='direct')await assert.rejects(snapshotGroup(h.root,backup),/Orphan SQLite sidecar/);
  else {const result=spawnSync(process.execPath,[maintenanceEntry,'recovery-snapshot',h.root,backup],{encoding:'utf8',timeout:15_000});assert.notEqual(result.status,0);assert.match(result.stderr,/Orphan SQLite sidecar/);}
  assert.equal(existsSync(join(backup,'group.json')),false);assert.equal(existsSync(h.host),false);assert.equal(fileHash(lost),before);
  for(const each of hashes)assert.equal(fileHash(h.host+each.suffix),each.digest);
  events.push({case:'orphan SQLite family',entry,hashes,main:before,refused:true,published:false,unchanged:true});
 }finally{raw.close();}
});

for (const history of ['missing', 'empty'] as const) for (const entry of ['direct','maintenance'] as const)
test(`existing host with ${history} history is refused by ${entry} snapshot without changing source bytes`, async t => {
 const h=await fixture(t);
 openDatabase(h.host,'host',{busyTimeoutMs:1000}).$client.close();
 const host=new DatabaseSync(h.host);
 host.exec(history==='missing'?'DROP TABLE __drizzle_migrations':'DELETE FROM __drizzle_migrations');host.close();
 const before={control:fileHash(h.control),host:fileHash(h.host)},folder=join(h.base,'uncertified');
 if(entry==='direct')await assert.rejects(snapshotGroup(h.root,folder),/Host migration history is absent/);
 else {
  const result=spawnSync(process.execPath,[maintenanceEntry,'recovery-snapshot',h.root,folder],{encoding:'utf8',timeout:15000});
  assert.notEqual(result.status,0);assert.match(result.stderr,/Host migration history is absent/);
 }
 assert.equal(existsSync(join(folder,'group.json')),false);
 assert.deepEqual({control:fileHash(h.control),host:fileHash(h.host)},before);
 events.push({case:'host history refusal',history,entry,before,unchanged:true});
});

test('maintenance snapshots only explicitly declared config bytes and no-op migration leaves them unchanged',async t=>{
 const h=await fixture(t),config=join(h.root,'config.yaml'),before=Buffer.from('agents: {}\n');writeFileSync(config,before);
 const ordinary=join(h.base,'ordinary-t0'),declared=join(h.base,'declared-t0');
 const run=(mode:string,...args:string[])=>spawnSync(process.execPath,[maintenanceEntry,mode,h.root,...args],
  {encoding:'utf8',timeout:15000,env:cleanCliEnv()});
 let result=run('recovery-snapshot',ordinary);assert.equal(result.status,0,result.stderr);assert.deepEqual(readGroup(ordinary,h.root).fileState,[]);
 result=run('recovery-snapshot',declared,'config.yaml');assert.equal(result.status,0,result.stderr);
 assert.deepEqual(readGroup(declared,h.root).fileState,[{path:'config.yaml',bytes:before.toString('base64')}]);
 result=run('migrate');assert.equal(result.status,0,result.stderr);assert.deepEqual(readFileSync(config),before);
});

test('a warm read thread and kept history end before DB replacement; a new generation reads only restored history',async t=>{
 const h=await fixture(t),control=new ControlStore(h.root);
 control.write(db=>db.prepare("UPDATE placements SET ended_at='2026-10-30T00:00:00.000Z'").run());control.close();
 const backup=join(h.base,'cold-t0');await snapshotGroup(h.root,backup);
 let server=await startServer(h.root,0);let closed=false;
 try {
  const oldGeneration=(await(await fetch(new URL('/api/workspace/live',server.url))).json()).generation;
  const current=await(await fetch(new URL('/api/commands/task/get?task=T2',server.url),{headers:{'X-Alpacawork-Client':'cli', [CONTRACT_HEADER]: String(CLI_CONTRACT)}})).json();
  const op=randomUUID(),saved=await fetch(new URL('/api/commands/task/comment',server.url),{method:'POST',headers:{'Content-Type':'application/json','X-Alpacawork-Client':'cli', [CONTRACT_HEADER]: String(CLI_CONTRACT),'X-Alpacawork-Op-Id':op,'X-Alpacawork-Restore-Id':'initial'},body:JSON.stringify({task:'T2',title:'AFTER_T0_MUST_DISAPPEAR',expectedTaskHash:current.task.hash})});
  assert.equal(saved.status,200,await saved.text());
  for(let n=0;n<3;n++) {
   const warm=await(await fetch(new URL('/api/commands/task/get?task=T2&log=100',server.url),{headers:{'X-Alpacawork-Client':'cli', [CONTRACT_HEADER]: String(CLI_CONTRACT)}})).json();
   assert(JSON.stringify(warm).includes('AFTER_T0_MUST_DISAPPEAR'));
  }
  await server.close();closed=true;
  restoreGroupMember(h.root,backup,'control');restoreGroupMember(h.root,backup,'host');
  server=await startServer(h.root,0);closed=false;
  const restored=await(await fetch(new URL('/api/commands/task/get?task=T2&log=100',server.url),{headers:{'X-Alpacawork-Client':'cli', [CONTRACT_HEADER]: String(CLI_CONTRACT)}})).json();
  assert(!JSON.stringify(restored).includes('AFTER_T0_MUST_DISAPPEAR'));
  const index=await(await fetch(new URL('/api/workspace/live',server.url))).json();assert.notEqual(index.generation,oldGeneration);
  events.push({case:'warm restored read',oldGeneration,newGeneration:index.generation,discardedOldHistory:true});
 }finally{if(!closed)await server.close();}
});

test('recovery groups bind the version-matched snapshot to the approved workspace identity without writes', async t => {
 const h=await fixture(t), folder=join(h.base,'identity-backup');
 const identity=readControlWorkspaceIdentity(h.root,{busyTimeoutMs:1000});
 const group=await snapshotGroup(h.root,folder), before=fileHash(h.control), receipt=fileHash(join(folder,'group.json'));
 assert.throws(()=>readGroup(folder,h.root,randomUUID()),/workspace identity/);
 assert.deepEqual(readGroup(folder,h.root,identity),group);
 assert.equal(fileHash(h.control),before);assert.equal(fileHash(join(folder,'group.json')),receipt);
});
