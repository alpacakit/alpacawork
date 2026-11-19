import { CLI_CONTRACT, CONTRACT_HEADER } from '@alpacawork/contract/client-contract';
import { openSync, closeSync, constants } from 'node:fs';
import { tryLock } from '@alpacawork/core';
import { createFixtureRun } from './helpers/run-fixture.ts';
import { issueRunCredential } from '@alpacawork/backend/test-dist/control/credentials.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ControlStore } from '@alpacawork/db';
import { backupStoppedWorkspace, prune } from '@alpacawork/backend/test-dist/release/switch.js';
import { saveJournal, loadJournal, restoreId, assertServeAdmission, releaseAdmission } from '@alpacawork/backend/test-dist/release/journal.js';
import { point } from '@alpacawork/backend/test-dist/release/layout.js';
import { RunStore } from '@alpacawork/runs';
import { setup } from './helpers/release-recovery-fixture.ts';

test('lost-response CLI POST stays pinned across DB restore; old op cannot execute with a fresh header', { skip: process.platform !== 'linux' && 'maintenance runs from a linux-x64-glibc fixture image (Koffi native)' }, async t=>{
 const h=await setup(t);let target=await h.start(),drop=true;const sent:{method:string;restore:string|null;body:string;status?:number}[]=[];
 const proxy=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=Buffer.concat(chunks);
  const headers=new Headers();for(const [key,value]of Object.entries(req.headers))if(value!==undefined&&!['host','connection','content-length'].includes(key))headers.set(key,Array.isArray(value)?value.join(','):value);
  const message={method:req.method!,restore:headers.get('X-Alpacawork-Restore-Id'),body:body.toString(),status:undefined as number|undefined};sent.push(message);
  try{const upstream=await fetch(new URL(req.url!,target),{method:req.method,headers,body:body.length?body:undefined});const bytes=await upstream.arrayBuffer();
   message.status=upstream.status;
   if(req.method==='POST'&&drop){req.socket.destroy();return;}res.writeHead(upstream.status,{'content-type':'application/json'});res.end(Buffer.from(bytes));
  }catch{req.socket.destroy();}
 });
 await new Promise<void>(done=>proxy.listen(0,'127.0.0.1',done));const origin=`http://127.0.0.1:${(proxy.address() as {port:number}).port}`;
 try {
 // T2 receives the seeded Runs' delayed state links; use a task with no Run so that unrelated catch-up cannot stale this command.
 const task='T12',fixture=new ControlStore(h.workspace,{busyTimeoutMs:1000},true);
 let quietRunCount:number;try{quietRunCount=Number(fixture.read(db=>db.prepare('SELECT count(*) n FROM runs WHERE task_id=?').get(task)!.n));assert.equal(quietRunCount,0);}finally{fixture.close();}
 const current=await h.cli(target,['task','get','--task',task]);assert.equal(current.code,0,current.stderr);
 const opId=randomUUID(),args=['task','comment','--task',task,'--title','Lost recovery response','--expected-task-hash',JSON.parse(current.stdout).task.hash,'--op-id',opId];
 const first=await h.cli(origin,args);assert.equal(first.code,3,first.stderr);assert.equal(sent.filter(x=>x.method==='GET').length,1);assert.equal(sent.filter(x=>x.method==='POST').length,3);
 assert(sent.filter(x=>x.method==='POST').every(x=>x.restore==='initial'));assert.equal(new Set(sent.filter(x=>x.method==='POST').map(x=>x.body)).size,1);
 assert(sent.filter(x=>x.method==='POST').every(x=>x.status===200),JSON.stringify(sent));
 const committed=await h.cli(target,['operation','get','--op-id',opId]);assert.equal(committed.code,0,committed.stderr);
 assert.equal(JSON.parse(committed.stdout).state,'committed');assert.equal(JSON.parse(committed.stdout).status,200);
 const recovered=await h.exec([],{cli:true});assert.equal(recovered.code,0,recovered.stderr);target=JSON.parse(readFileSync(join(h.workspace,'.alpacawork/connection.json'),'utf8')).url;drop=false;
 const id=restoreId(h.workspace),same=await h.cli(origin,args);assert.notEqual(same.code,0);assert.equal(JSON.parse(same.stderr).error.code,'restore_changed');
 const prior=await h.cli(origin,['operation','get','--op-id',opId]);assert.equal(prior.code,0,prior.stderr);const diagnosis=JSON.parse(prior.stdout);assert.equal(diagnosis.state,'before_restore');assert.equal(diagnosis.previous.state,'committed');assert.equal(diagnosis.notFoundProvesUnexecuted,false);
 const rewritten=await fetch(new URL('/api/task/comment',target),{method:'POST',headers:{'Content-Type':'application/json','X-Alpacawork-Client':'cli', [CONTRACT_HEADER]: String(CLI_CONTRACT),'X-Alpacawork-Op-Id':opId,'X-Alpacawork-Restore-Id':id},body:sent.find(x=>x.method==='POST')!.body});assert.equal(rewritten.status,409);assert.equal((await rewritten.json()).error.code,'restore_changed');
 const forbidden=await fetch(new URL('/api/task/new',target),{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Alpacawork-Run R999:'+ 'a'.repeat(64),'X-Alpacawork-Restore-Id':id},body:'{}'});assert.equal(forbidden.status,403);
 const absent=await h.cli(origin,['operation','get','--op-id',randomUUID()]);assert.equal(absent.code,0,absent.stderr);assert.equal(JSON.parse(absent.stdout).state,'unknown_after_restore');
 const read=new ControlStore(h.workspace,{busyTimeoutMs:1000},true);try{assert.equal(read.read(db=>db.prepare('SELECT count(*) n FROM task_log WHERE id=?').get(opId)!.n),0);}finally{read.close();}
 const fresh=await h.cli(origin,['task','new','--parent','P1','--title','Fresh after recovery','--internal']);assert.equal(fresh.code,0,fresh.stderr);assert(Number(JSON.parse(fresh.stdout).task.id.slice(1))>=15);
 const repeat=await h.exec([],{cli:true});assert.equal(repeat.code,0,repeat.stderr);assert.equal(restoreId(h.workspace),id);
 // A later switch journal and a second DB restore must not erase the first diagnostic or old-op guard.
 h.stop();const next={...h.journal,opId:randomUUID(),old:h.images.a,target:h.images.c,phase:'old_stopped' as const};
 saveJournal(h.place,next);const secondBackup=await backupStoppedWorkspace(h.place,next.target,next);
 saveJournal(h.place,{...next,phase:'committed'});point(h.releases,'current',next.target);
 const archived=await h.exec([],{cli:true,diagnostic:opId});assert.equal(archived.code,0,archived.stderr);assert.equal(JSON.parse(archived.stdout).state,'before_restore');
 const second=await h.exec([],{cli:true,backup:secondBackup});assert.equal(second.code,0,second.stderr);assert.notEqual(restoreId(h.workspace),id);
 target=JSON.parse(readFileSync(join(h.workspace,'.alpacawork/connection.json'),'utf8')).url;
 const oldest=await h.cli(origin,['operation','get','--op-id',opId]);assert.equal(oldest.code,0,oldest.stderr);assert.equal(JSON.parse(oldest.stdout).state,'before_restore');
 const disguised=await fetch(new URL('/api/task/comment',target),{method:'POST',headers:{'Content-Type':'application/json','X-Alpacawork-Client':'cli', [CONTRACT_HEADER]: String(CLI_CONTRACT),'X-Alpacawork-Op-Id':opId,'X-Alpacawork-Restore-Id':restoreId(h.workspace)},body:sent.find(x=>x.method==='POST')!.body});assert.equal(disguised.status,409);
 const oldestLimited=await h.exec([],{cli:true,diagnostic:opId});assert.equal(oldestLimited.code,0,oldestLimited.stderr);

 eventsRecord();function eventsRecord(){h.evidence.push({case:'lost response restore',first,same,prior,absent,fresh,posts:sent.filter(x=>x.method==='POST').map(x=>({...x})),committed,quietTask:{task,runCount:quietRunCount},restoreId:id});}
 } finally {proxy.closeAllConnections();await new Promise<void>((done,failed)=>proxy.close(error=>error?failed(error):done()));h.evidence.push({case:'lost response proxy close',closed:true,listening:proxy.listening});}
});

test('waiting restart continues an existing Run report and import while fresh Run reservations stay paused', { skip: process.platform !== 'linux' && 'maintenance runs from a linux-x64-glibc fixture image (Koffi native)' }, async t=>{
 const h=await setup(t),control=new ControlStore(h.workspace);control.write(db=>db.prepare("UPDATE placements SET ended_at=NULL WHERE id='fixture-placement-2'").run());control.close();
 const store=new RunStore(h.workspace,{busyTimeoutMs:1000});
 const running=store.write(tx=>{
  const run=createFixtureRun(store,tx,{task:'T2',placementId:'fixture-placement-2',requestId:randomUUID(),agent:'fixture',role:'owner',resumes:null,continues:false,session:null,caller:null,cwd:h.workspace,
   launch:{ adapter: 'codex', env: [],argv:['/usr/bin/false'],path:'/usr/bin:/bin',values:{}}},'Existing synthetic Run');
  tx.update({...run,state:'running',started_at:new Date().toISOString()});return tx.runtimeGet(run.id)!;
 });store.close();
 const folder=join(h.workspace,'.alpacawork/runs',running.id);mkdirSync(folder,{recursive:true,mode:0o700});const fd=openSync(join(folder,'manager.lock'),constants.O_CREAT|constants.O_RDWR,0o600);assert(tryLock(fd));
 try {
  saveJournal(h.place,{...h.journal,phase:'waiting_runs',old:h.images.b,target:h.images.c});
  const url=await h.start(),state=await(await fetch(new URL('/api/runtime/readiness',url))).json();assert.equal(state.state,'accepting');assert.equal(state.newRunLaunches,'paused');
  const credentials={ALPACAWORK_RUN:running.id,ALPACAWORK_RUN_TOKEN:issueRunCredential(h.workspace,running.id)};
  const current=await h.cli(url,['task','get','--task','T2']);assert.equal(current.code,0,current.stderr);
  const report=await h.cli(url,['task','comment','--task','T2','--title','Existing Run reports during waiting','--expected-task-hash',JSON.parse(current.stdout).task.hash],credentials);assert.equal(report.code,0,report.stderr);
  h.stop();const restarted=await h.start();const currentAgain=await h.cli(restarted,['task','get','--task','T2']);assert.equal(currentAgain.code,0,currentAgain.stderr);
  const requestId=randomUUID();const blocked=await fetch(new URL('/api/task/request',restarted),{method:'POST',headers:{'Content-Type':'application/json','X-Alpacawork-Op-Id':requestId,'X-Alpacawork-Restore-Id':'initial'},body:JSON.stringify({task:'T2',body:'New work while waiting',expectedTaskHash:JSON.parse(currentAgain.stdout).task.hash,expectedPlacementRevision:1,opId:requestId})});
  // Header/body operation IDs must agree before the domain reservation is reached.
  if(blocked.status!==409)throw Error(await blocked.text());
  assert.equal((await blocked.json()).error.code,'busy');
  const checked=new ControlStore(h.workspace,{busyTimeoutMs:1000},true);try{assert.equal(checked.read(db=>db.prepare('SELECT count(*) n FROM runs').get()!.n),8);}finally{checked.close();}
 }finally{h.stop();closeSync(fd);}
});

test('prune keeps the backup code/CLI/skill and the failed-side diagnostic reader after another switch', { skip: process.platform !== 'linux' && 'maintenance runs from a linux-x64-glibc fixture image (Koffi native)' }, async t=>{
 const h=await setup(t,false,undefined,(built,name)=>{if(['a','c'].includes(name)){writeFileSync(join(built,'skills/SKILL.md'),'synthetic immutable skill');writeFileSync(join(built,'apps/launcher/cli'),'synthetic immutable CLI');}});point(h.releases,'current',h.images.c);
 const recovered=await h.exec([],{cli:true});assert.equal(recovered.code,0,recovered.stderr);h.stop();
 point(h.releases,'current',h.images.b);point(h.releases,'previous',h.images.a);
 saveJournal(h.place,{...h.journal,phase:'committed'});assert.deepEqual(prune(h.releases,0,()=>{}),[]);
 for(const name of ['a','c'])assert.equal(readFileSync(join(h.images[name as 'a'|'c'],'skills/SKILL.md'),'utf8'),'synthetic immutable skill');
});
