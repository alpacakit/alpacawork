import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,writeFileSync,mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setup,until,receipts} from './runs-runtime.fixture.ts';
import {launch,settleTransaction,closeLaunches,settle} from '@alpacawork/backend/test-dist/runs/scheduler.js';
import {readAgentsSettings} from '@alpacawork/backend/test-dist/agents-settings.js';
import {attemptOf,StopDeliveryOwner} from '@alpacawork/backend/test-dist/runs/execution-control.js';
import {RunEventImporter} from '@alpacawork/backend/test-dist/runs/event-importer.js';
import {requestStop} from '@alpacawork/backend/test-dist/runs/entry.js';
import {recoverExecution} from '@alpacawork/backend/test-dist/runs/recovery.js';
import {platform,processIdentity,sameProcess} from '@alpacawork/core';
const artifact=join(import.meta.dirname,'fixtures');
const alive=(pid:number)=>{try{process.kill(pid,0);return true}catch{return false}};
async function stopRecorded(group:number){platform.run.signalGroup(group,'SIGKILL');await until(()=>!platform.run.signalGroup(group,0),'recorded group gone');}

test('bounded agent readiness never exposes a partially written PID receipt', async t => {
 const root=realpathSync(mkdtempSync(join(tmpdir(),'bounded-receipt-')));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 // Stop the real fixture between creating its output inode and writing the JSON bytes.
 const source=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
 const [root]=process.argv.slice(1),write=fs.writeFileSync;
 fs.writeFileSync=(path,data,...args)=>{
   if(String(path).includes('-pid.json')){
     write(path,'');write(root+'/write-entered','');
     const deadline=Date.now()+5000;
     while(!fs.existsSync(root+'/write-release')){
       if(Date.now()>deadline)throw new Error('receipt write was not released');
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
     }
   }
   return write(path,data,...args);
 };syncBuiltinESMExports();
 process.argv=[process.execPath,${JSON.stringify(join(artifact,'bounded-agent.mjs'))},root,'hold'];
 await import(${JSON.stringify(new URL('./fixtures/bounded-agent.mjs',import.meta.url).href)});`;
 const child=spawn(process.execPath,['--input-type=module','-e',source,root],{stdio:'ignore'}),exited=once(child,'exit');
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited});
 try{
   await until(()=>existsSync(join(root,'write-entered')),'receipt write paused');
   assert.equal(existsSync(join(root,'hold-pid.json')),false,'readiness must wait for every JSON byte');
 }finally{writeFileSync(join(root,'write-release'),'')}
 await until(()=>existsSync(join(root,'hold-pid.json')),'completed receipt published');
 assert.equal(JSON.parse(readFileSync(join(root,'hold-pid.json'),'utf8')).pid,child.pid);
});

test('stop during the actual spawn-before-started window must retain unknown execution',async t=>{
 const h=await setup(t);h.pauseProjection();let recorded:any;
 t.after(async()=>{if(recorded)await stopRecorded(recorded.agentPid)});
 const run=h.create('plain',{}, {launch:{ adapter: 'codex', env: [],argv:[process.execPath,join(artifact,'bounded-agent.mjs'),h.root,'hold'],path:h.path,values:{}}});
 await launch(h.store,await settleTransaction(h.store,readAgentsSettings(h.root)),{script:join(artifact,'kill-before-started.mjs')});
 await until(()=>existsSync(join(h.root,'spawn-window.json'))&&existsSync(join(h.root,'hold-pid.json')),'actual child survived manager kill');
 recorded=JSON.parse(readFileSync(join(h.root,'spawn-window.json'),'utf8'));
 await until(()=>!alive(recorded.managerPid),'killed manager gone');
 new RunEventImporter(h.store).pass();await settle(h.store);
 assert.equal(h.store.get(run.id)!.reason,'manager_lost');assert.equal(h.store.get(run.id)!.pids.agent,null);
 const stopped=requestStop(h.root,{run:run.id});new StopDeliveryOwner(h.store).gate();
 await settle(h.store);assert.equal(h.store.connection.prepare('SELECT count(*) AS n FROM run_attempts WHERE run_no=1').get()!.n,1);
 assert.equal(h.store.get(run.id)!.stop_requested,true);
 const actual={scenario:'unknown-started-stop',recorded,childAlive:alive(recorded.agentPid),response:stopped.result,run:h.store.get(run.id)};
 console.log(JSON.stringify(actual));writeFileSync(join(h.root,'unknown-started-stop.json'),JSON.stringify(actual,null,2));
 assert.equal(h.store.get(run.id)!.state,'needs_review','unknown spawned process must not be displayed as cancelled');
});

test('recorded leader exiting does not prove its surviving process group stopped',async t=>{
 const h=await setup(t);h.pauseProjection();
 const leader=spawn(process.execPath,[join(artifact,'bounded-agent.mjs'),h.root,'leader'],{detached:true,stdio:'ignore'});let group:number|undefined;const exited=once(leader,'exit');
 await once(leader,'spawn');group=leader.pid!;t.after(async()=>{await stopRecorded(group!);await exited});
 const identity=processIdentity(group);
 await until(()=>existsSync(join(h.root,'descendant-pid.json')),'actual descendant ready');
 const descendant=JSON.parse(readFileSync(join(h.root,'descendant-pid.json'),'utf8'));
 const run=h.create();const decision=await settleTransaction(h.store,readAgentsSettings(h.root));closeLaunches(decision.launches);const launchSnapshot=attemptOf(h.store,run.id)!;
 h.store.connection.prepare('UPDATE run_attempts SET started_json=? WHERE attempt_id=?').run(JSON.stringify(identity),launchSnapshot.attemptId);
 h.store.write(tx=>tx.update({...tx.get(run.id)!,state:'needs_review',reason:'manager_lost',stop_requested:true,pids:{manager:null,agent:group!}}));
 writeFileSync(join(h.root,'leader-exit'),'');await exited;assert.equal(sameProcess(identity),false);assert.equal(alive(descendant.pid),true);assert.equal(platform.run.signalGroup(group,0),true);
 await recoverExecution(h.store);
 const actual={scenario:'leader-gone-child-live',leader:identity,descendant,childAlive:alive(descendant.pid),groupAlive:platform.run.signalGroup(group,0),run:h.store.get(run.id)};
 console.log(JSON.stringify(actual));writeFileSync(join(h.root,'leader-gone-child-live.json'),JSON.stringify(actual,null,2));
 assert.equal(h.store.get(run.id)!.state,'needs_review','leader loss with live children cannot release the Run');
 assert.equal(h.store.get(run.id)!.stop_requested,true);
 assert.equal(platform.run.signalGroup(group,0),true,'an unproven group must not be signalled');
 await stopRecorded(group!); await recoverExecution(h.store);
 assert.equal(h.store.get(run.id)!.state,'cancelled','only confirmed group absence permits terminal stop');
});

for(const reused of [false,true])test(`lost manager ${reused?'rejects a different leader incarnation':'stops a proven live leader before finishing'}`,async t=>{
 const h=await setup(t);h.pauseProjection();
 const leader=spawn(process.execPath,[join(artifact,'bounded-agent.mjs'),h.root,'hold'],{detached:true,stdio:'ignore'}),exited=once(leader,'exit');
 await once(leader,'spawn');const group=leader.pid!;t.after(async()=>{await stopRecorded(group);await exited});
 const identity=processIdentity(group);if(reused)identity.started='different-incarnation';
 const run=h.create();const decision=await settleTransaction(h.store,readAgentsSettings(h.root));closeLaunches(decision.launches);
 const snapshot=attemptOf(h.store,run.id)!;
 h.store.connection.prepare('UPDATE run_attempts SET started_json=? WHERE attempt_id=?').run(JSON.stringify(identity),snapshot.attemptId);
 h.store.write(tx=>tx.update({...tx.get(run.id)!,state:'needs_review',reason:'manager_lost',stop_requested:true,pids:{manager:null,agent:group}}));
 await recoverExecution(h.store);
 assert.equal(h.store.get(run.id)!.state,reused?'needs_review':'cancelled');
 assert.equal(platform.run.signalGroup(group,0),reused,'a reused PID never authorizes a signal');
});

test('recovery keeps proven child witnesses after TERM kills the leader and KILLs its stubborn grandchild',async t=>{
 const h=await setup(t);h.pauseProjection();const run=h.create('plain',{group:true,stubborn:true});await h.tick();
 await until(()=>{new RunEventImporter(h.store).pass();const r=h.store.get(run.id)!;return r.pids.agent&&receipts(h.root).filter(p=>p.pgid===r.pids.agent).length===3},'actual three generation group ready');
 const running=h.store.get(run.id)!;process.kill(running.pids.manager!,'SIGKILL');await until(()=>!alive(running.pids.manager!),'manager gone');
 await settle(h.store);requestStop(h.root,{run:run.id});new StopDeliveryOwner(h.store).gate();
 await recoverExecution(h.store);
 await until(()=>!platform.run.signalGroup(running.pids.agent!,0),'whole group gone after TERM then KILL');
 assert.equal(h.store.get(run.id)!.state,'cancelled');assert.equal(h.store.get(run.id)!.reason,'stopped');
 console.log(JSON.stringify({proof:'recorded-group-witness',run:run.id,pids:running.pids,subjects:receipts(h.root).map(s=>({pid:s.pid,group:s.pgid,branch:s.branch}))}));
});

test('recovery uses a stop committed after its unfinished scan', async t => {
 const h=await setup(t);h.pauseProjection();
 const leader=spawn(process.execPath,['-e',''],{detached:true,stdio:'ignore'});
 const exited=once(leader,'exit');await once(leader,'spawn');
 const identity=processIdentity(leader.pid!);await exited;
 const run=h.create();const decision=await settleTransaction(h.store,readAgentsSettings(h.root));closeLaunches(decision.launches);
 const snapshot=attemptOf(h.store,run.id)!;
 h.store.connection.prepare('UPDATE run_attempts SET started_json=? WHERE attempt_id=?').run(JSON.stringify(identity),snapshot.attemptId);
 h.store.write(tx=>tx.update({...tx.get(run.id)!,state:'needs_review',reason:'manager_lost',pids:{manager:null,agent:leader.pid!}}));
 const read=h.store.readUnfinished.bind(h.store);let injected=false;
 h.store.readUnfinished=()=>{const rows=read();if(!injected){injected=true;h.store.write(tx=>tx.update({...tx.get(run.id)!,stop_requested:true}));}return rows;};
 try{await recoverExecution(h.store);}finally{h.store.readUnfinished=read;}
 assert.equal(injected,true);assert.equal(h.store.get(run.id)!.state,'cancelled');assert.equal(h.store.get(run.id)!.reason,'stopped');
});
