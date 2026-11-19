/** Import health governs completion, never authority to stop a proven orphan group. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,existsSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {setup,until} from './runs-runtime.fixture.ts';
import {RunEventImporter} from '@alpacawork/backend/test-dist/runs/event-importer.js';
import {recoverExecution} from '@alpacawork/backend/test-dist/runs/recovery.js';
import {attemptOf,StopDeliveryOwner} from '@alpacawork/backend/test-dist/runs/execution-control.js';
import {executionFolder,messageName} from '@alpacawork/backend/test-dist/runs/execution-files.js';
import {requestStop} from '@alpacawork/backend/test-dist/runs/entry.js';
import {platform,sameProcess} from '@alpacawork/core';
const alive=(pid:number)=>{try{process.kill(pid,0);return true}catch{return false}};
const files=(folder:string)=>existsSync(join(folder,'events'))?readdirSync(join(folder,'events')).filter(n=>/^\d{12}\.json$/.test(n)):[];

for(const blockage of ['diagnostic','pending'] as const)
for(const cause of ['stop','timeout'] as const)
for(const known of [true,false]) test(`orphan supervision ${blockage}/${cause}/${known?'proven':'unknown'} preserves completion arbitration`,async t=>{
 const h=await setup(t,{run_minutes:1});h.pauseProjection();let pids:any;
 t.after(async()=>{for(const pid of [pids?.agent,pids?.manager])if(pid){platform.run.signalGroup(pid,'SIGKILL');await until(()=>!platform.run.signalGroup(pid,0),'recorded group gone')}});
 // Both the agent marker and the session event come from real processes. Delay just
 // the publication visible to Importer so started is durable with a pending session.
 const run=h.create('codex',{gate:join(h.root,'agent-release')});await h.tick();
 const launch=attemptOf(h.store,run.id)!,folder=executionFolder(h.root,run.id,launch.attemptId);
 const sessionFile=await until(()=>files(folder).find(n=>JSON.parse(readFileSync(join(folder,'events',n),'utf8')).type==='session'),'real manager session event');
 // The manager confirms its own publication by name until it ends; kill it before hiding that name.
 const claimed=JSON.parse(readFileSync(join(folder,'events',messageName(1)),'utf8'));assert.equal(claimed.type,'claimed');
 const manager=Number(claimed.payload.managerPid);process.kill(manager,'SIGKILL');await until(()=>!alive(manager),'actual manager killed');
 const sessionPath=join(folder,'events',sessionFile),held=join(folder,'held-session');renameSync(sessionPath,held);
 new RunEventImporter(h.store).pass();pids=h.store.get(run.id)!.pids;assert.ok(pids.agent&&pids.manager);
 assert.equal(pids.manager,manager);renameSync(held,sessionPath);
 // The importer rechecks only its boundary, the last event it imported; breaking that one blocks the import.
 const lastImported=Number(h.store.connection.prepare('SELECT next_seq FROM run_attempts WHERE attempt_id=?').get(launch.attemptId)!.next_seq)-1;
 assert.ok(lastImported>=1,'the importer took the events before the held session');
 const first=join(folder,'events',messageName(lastImported)),original=readFileSync(first);
 if(blockage==='diagnostic'){writeFileSync(first,'{broken');new RunEventImporter(h.store).pass()}
 else h.store.write(tx=>tx.update({...tx.get(run.id)!,state:'needs_review',reason:'manager_lost'}));
 if(cause==='stop'){requestStop(h.root,{run:run.id});new StopDeliveryOwner(h.store).gate();
   assert.ok(h.store.connection.prepare("SELECT published FROM run_commands WHERE type='stop'").all().every(r=>r.published===1));}
 else h.store.write(tx=>tx.update({...tx.get(run.id)!,started_at:'2020-01-01T00:00:00.000Z'}));
 const row=()=>h.store.connection.prepare('SELECT started_json,next_seq,completed_digest,diagnostic FROM run_attempts WHERE attempt_id=?').get(launch.attemptId)!;
 const identity=JSON.parse(String(row().started_json));assert.equal(sameProcess(identity),true);
 if(!known){identity.started='different-incarnation';h.store.connection.prepare('UPDATE run_attempts SET started_json=? WHERE attempt_id=?').run(JSON.stringify(identity),launch.attemptId)}
 const before=JSON.stringify({row:row(),text:h.store.getText(run.id),usage:h.store.get(run.id)!.usage,ended:h.store.get(run.id)!.ended_at});
 await recoverExecution(h.store);await recoverExecution(h.store);
 // Signal authority and completion eligibility are deliberately separate assertions.
 assert.equal(platform.run.signalGroup(pids.agent,0),!known,'import blockage cannot prevent proven group termination; unknown group receives no signal');
 assert.equal(h.store.get(run.id)!.state,'needs_review','pending facts retain the slot and prohibit missing-result finish');
 assert.equal(JSON.stringify({row:row(),text:h.store.getText(run.id),usage:h.store.get(run.id)!.usage,ended:h.store.get(run.id)!.ended_at}),before,'supervision changes no cursor/digest/result/usage/time or diagnosis');
 if(blockage==='diagnostic')writeFileSync(first,original);
 new RunEventImporter(h.store).pass();await recoverExecution(h.store);
 assert.equal(h.store.get(run.id)!.state,known?(cause==='stop'?'cancelled':'failed'):'needs_review');
 assert.equal(h.store.get(run.id)!.usage,null);
 const completions=files(folder).map(n=>JSON.parse(readFileSync(join(folder,'events',n),'utf8'))).filter(e=>e.type==='completed');
 assert.equal(completions.length,known?1:0,'only confirmed group absence permits a recovered completion');
 if(known){assert.ok(row().completed_digest);assert.notEqual(completions[0].payload.outcome.state,'succeeded');assert.equal(completions[0].payload.exit,null,'recovery does not invent an exit status');}
 else assert.equal(row().completed_digest,null);
 console.log(JSON.stringify({proof:'orphan-supervision',blockage,cause,known,pids,agentAlive:alive(pids.agent),before:JSON.parse(before),after:row(),run:h.store.get(run.id)}));
});
