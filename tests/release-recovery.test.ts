import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, lstatSync, writeFileSync, readFileSync, readdirSync, existsSync, renameSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ControlStore } from '@alpacawork/db';
import { loadJournal, saveJournal, restoreId, assertServeAdmission, releaseAdmission } from '@alpacawork/backend/test-dist/release/journal.js';
import { point } from '@alpacawork/backend/test-dist/release/layout.js';
import { readGroup } from '@alpacawork/backend/test-dist/release/recovery-data.js';
import { FileJournal } from '@alpacawork/backend/test-dist/control/file-journal.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { RunStore } from '@alpacawork/runs';
import { setup } from './helpers/release-recovery-fixture.ts';
import { backupStoppedWorkspace } from '@alpacawork/backend/test-dist/release/switch.js';

test('two ordinary switches prune the obsolete backup/code and the latest backup still restores through the real CLI', { skip: process.platform !== 'linux' && 'maintenance runs from a linux-x64-glibc fixture image (Koffi native)' }, async t=>{
 const h=await setup(t);
 point(h.releases,'current',h.images.a);point(h.releases,'previous',null);
 saveJournal(h.place,{...h.journal,old:null,target:h.images.a,backup:undefined});
 await h.start();
 const driver=join(h.base,'switch-and-prune.mjs');
 writeFileSync(driver,`import{switchTo,prune}from ${JSON.stringify(new URL('../apps/backend/test-dist/release/switch.js',import.meta.url).href)};
 import{holdReleases}from ${JSON.stringify(new URL('../apps/backend/test-dist/release/layout.js',import.meta.url).href)};
 import{readFileSync}from'node:fs';const p=JSON.parse(readFileSync(${JSON.stringify(join(h.base,'service.json'))},'utf8'));p.say=()=>{};
 const close=holdReleases(p.releases);try{const ready=await switchTo(p,process.argv[2]);console.log(JSON.stringify({...ready,removed:prune(p.releases,0,p.say,p.workspace)}));}finally{close();}`);
 const switchRelease=(target:string)=>{
  const result=spawnSync(process.execPath,['--import',new URL('./fixtures/recovery-service.mjs',import.meta.url).pathname,driver,target],{env:h.env,encoding:'utf8',timeout:120000});
  assert.equal(result.status,0,result.stderr);h.evidence.push({action:'switch and prune',target,status:result.status,stdout:result.stdout,stderr:result.stderr});
  return JSON.parse(result.stdout);
 };
 // Publish the prebuilt second target only when that update begins, as deploy's producer does.
 const next=join(h.base,'next-release');renameSync(h.images.c,next);
 switchRelease(h.images.b);const first=loadJournal(h.place)!.backup!;
 const setTitle=async(title:string)=>{
  const url=JSON.parse(readFileSync(join(h.workspace,'.alpacawork/connection.json'),'utf8')).url;
  const before=await h.cli(url,['task','get','--task','T12']);assert.equal(before.code,0,before.stderr);
  const changed=await h.cli(url,['task','update','--task','T12','--title',title,'--expected-task-hash',JSON.parse(before.stdout).task.hash]);assert.equal(changed.code,0,changed.stderr);
 };
 await setTitle('Synthetic title at the latest backup');
 renameSync(next,h.images.c);
 const metadata=join(h.releases,'.release-metadata');mkdirSync(metadata,{recursive:true});const provenance=join(metadata,h.images.a.split('/').at(-1)!+'.json');writeFileSync(provenance,'{}');
 const switched=switchRelease(h.images.c),latest=loadJournal(h.place)!.backup!;
 assert.notEqual(latest,first);assert.equal(existsSync(first),false);assert.equal(existsSync(h.images.a),false);assert.equal(existsSync(provenance),false);
 assert.deepEqual(switched.removed,[h.images.a.split('/').at(-1)]);assert.deepEqual(readdirSync(join(h.releases,'backups')),[latest.split('/').at(-1)]);
 await setTitle('Synthetic change after the latest backup');
 const recovered=await h.exec([],{cli:true,backup:latest});assert.equal(recovered.code,0,recovered.stderr);
 assert.equal(loadJournal(h.place)!.phase,'recovered');assert.equal(loadJournal(h.place)!.recovery!.target,h.images.b);
 const restored=new ControlStore(h.workspace,{busyTimeoutMs:1000},true);
 try{assert.equal(restored.read(db=>db.prepare("SELECT title FROM tasks WHERE external_id='T12'").get()!.title),'Synthetic title at the latest backup');}finally{restored.close();}
 assert.equal(JSON.parse(readFileSync(join(h.workspace,'.alpacawork/connection.json'),'utf8')).runManager,join(h.images.b,'apps/backend/dist/run-manager.js'));
 const pruned=spawnSync(process.execPath,['--import',new URL('./fixtures/recovery-service.mjs',import.meta.url).pathname,
  new URL('../apps/backend/test-dist/backend-entry.js',import.meta.url).pathname,'--workspace',h.workspace,'release','prune','--releases',h.releases],{env:h.env,encoding:'utf8',timeout:30000});
 assert.equal(pruned.status,0,pruned.stderr);assert.deepEqual(JSON.parse(pruned.stdout).removed,[]);
 assert(existsSync(latest));assert(existsSync(loadJournal(h.place)!.recovery!.failure));
});

// Each resume skips the points already passed, so one recovery is killed at every durable point in order.
test('DB recovery survives SIGKILL at each durable point and a failed readiness with one identity', { skip: process.platform !== 'linux' && 'maintenance runs from a linux-x64-glibc fixture image (Koffi native)' }, async t=>{
 const before='agents: {}\n',h=await setup(t,false,before),config=join(h.workspace,'config.yaml'),writerInode=lstatSync(join(h.workspace,'.alpacawork/writer.lock')).ino;
 assert.deepEqual(readGroup(h.backup,h.workspace).fileState.map(file=>file.path),['config.yaml']);
 const otherBackup=await backupStoppedWorkspace(h.place,h.images.c,{...h.journal,opId:randomUUID(),old:h.images.b,target:h.images.c,phase:'old_stopped'});
 const control=new ControlStore(h.workspace);control.write(db=>{db.prepare('UPDATE task_sequence SET next_number=120 WHERE singleton=1').run();db.prepare('UPDATE run_sequence SET next_number=180 WHERE singleton=1').run();});control.close();
 const host=new DatabaseSync(join(h.workspace,'.alpacawork/host.sqlite'));host.exec('CREATE TABLE recovery_partial_commit(value TEXT);INSERT INTO recovery_partial_commit VALUES (\'failed-side\');');host.close();
 mkdirSync(join(h.workspace,'tasks/T125'),{recursive:true});mkdirSync(join(h.workspace,'.alpacawork/runs/R190'),{recursive:true});
 const changed='agents: {}\n# changed after T0\n',after=Buffer.from(changed).toString('base64');writeFileSync(config,changed);
 let identity:string|undefined;
 const pendingAfterKill=async(checkpoint:string)=>{
  const killed=await h.exec([],{kill:checkpoint});assert.equal(killed.signal,'SIGKILL',checkpoint+': '+killed.stderr);
  const pending=loadJournal(h.place)!;identity??=pending.recovery!.id;assert.equal(pending.recovery!.id,identity,checkpoint);
  assert.equal(releaseAdmission(h.workspace),'maintenance',checkpoint);assert.throws(()=>assertServeAdmission(h.workspace),/incomplete/);
  if(checkpoint!=='before-ready'){
   await assert.rejects(startServer(h.workspace,0),/incomplete/);
   const runStore=RunStore.openReadable(h.workspace,{busyTimeoutMs:1000})!;try{assert.throws(()=>new RunEventImporter(runStore).pass(),/incomplete/);}finally{runStore.close();}
   assert.throws(()=>new FileJournal(h.workspace).recover(),/incomplete/);
  }
  h.evidence.push({case:'kill journal resumption',checkpoint,pending});
  return pending;
 };
 await pendingAfterKill('intent');
 const pendingBytes=readFileSync(join(h.releases,'switch.json'));
 const wrongContinuation=await h.exec([],{cli:true,backup:otherBackup});
 assert.notEqual(wrongContinuation.code,0);assert.match(wrongContinuation.stderr,/Finish the same recovery target\/backup first/);
 assert.deepEqual(readFileSync(join(h.releases,'switch.json')),pendingBytes);
 const replaced=await pendingAfterKill('replaced:control');
 // The failed-side group keeps the files changed after T0; DB replacement has not yet restored them.
 assert.deepEqual(readGroup(replaced.recovery!.failure,h.workspace).fileState,[{path:'config.yaml',bytes:after}]);
 assert.equal(readFileSync(config).toString('base64'),after);
 for(const checkpoint of ['replaced:host','before-floor','before-ready'])await pendingAfterKill(checkpoint);
 // A failed readiness keeps the same DB recovery journal for a later resume.
 writeFileSync(join(h.base,'fail-ready'),'');
 const failed=await h.exec([],{cli:true});assert.notEqual(failed.code,0);assert.match(failed.stderr,/readiness failed/);
 assert.equal(loadJournal(h.place)!.phase,'recovery_ready');assert.equal(loadJournal(h.place)!.recovery!.id,identity);
 assert.equal(releaseAdmission(h.workspace),'maintenance');assert.throws(()=>assertServeAdmission(h.workspace),/incomplete/);
 rmSync(join(h.base,'fail-ready'));rmSync(join(h.base,'restart-failed'),{force:true});
 const restored=await h.exec([],{cli:true});assert.equal(restored.code,0,restored.stderr);
 assert.equal(loadJournal(h.place)!.recovery!.id,identity);assert.equal(loadJournal(h.place)!.phase,'recovered');assert.equal(restoreId(h.workspace),identity);
 assert.equal(readFileSync(config,'utf8'),before);
 const restoredControl=new ControlStore(h.workspace,{busyTimeoutMs:1000},true);try{assert.equal(restoredControl.read(db=>db.prepare('SELECT next_number FROM task_sequence').get()!.next_number),126);assert.equal(restoredControl.read(db=>db.prepare('SELECT next_number FROM run_sequence').get()!.next_number),191);}finally{restoredControl.close();}
 const oldHost=new DatabaseSync(join(h.workspace,'.alpacawork/host.sqlite'),{readOnly:true});try{assert.equal(oldHost.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='recovery_partial_commit'").get()!.n,0);}finally{oldHost.close();}
 assert.equal(lstatSync(join(h.workspace,'.alpacawork/writer.lock')).ino,writerInode);
 h.evidence.push({case:'kill journal resumption completed',completed:loadJournal(h.place),identity,writerInodeBefore:writerInode,writerInodeAfter:lstatSync(join(h.workspace,'.alpacawork/writer.lock')).ino});
});
