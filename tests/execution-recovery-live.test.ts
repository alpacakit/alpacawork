import {test} from 'node:test';import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';import {join} from 'node:path';
import {setup,until} from './runs-runtime.fixture.ts';
import {RunEventImporter} from '@alpacawork/backend/test-dist/runs/event-importer.js';
import {attemptOf,StopDeliveryOwner} from '@alpacawork/backend/test-dist/runs/execution-control.js';
import {executionFolder,messageName} from '@alpacawork/backend/test-dist/runs/execution-files.js';
import {requestStop} from '@alpacawork/backend/test-dist/runs/entry.js';
import {recoverExecution} from '@alpacawork/backend/test-dist/runs/recovery.js';
import {platform,digestBytes} from '@alpacawork/core';
const artifact=join(import.meta.dirname,'fixtures');

// The manager's stop and timeout never read import health, and the blockage is the importer's alone: each value once.
for(const [blockage,cause] of [['diagnostic','stop'],['pending','timeout']]) test(`importer ${blockage} with live manager, ${cause}, manager exit and repair retains original completion`,async t=>{
 const h=await setup(t,{run_minutes:1});h.pauseProjection();const clock=h.clock();let pids:any;
 t.after(async()=>{for(const pid of [pids?.agent,pids?.manager])if(pid){platform.run.signalGroup(pid,'SIGKILL');await until(()=>!platform.run.signalGroup(pid,0),'recorded review process group gone')}});
 const run=h.create('plain',{}, {launch:{ adapter: 'codex', env: [],argv:[process.execPath,join(artifact,'bounded-agent.mjs'),h.root,'hold'],path:h.path,values:{}}});
 await h.tick();await until(()=>{new RunEventImporter(h.store).pass();return h.store.get(run.id)!.pids.agent&&existsSync(join(h.root,'hold-pid.json'))},'manager and actual agent ready');
 pids=h.store.get(run.id)!.pids;assert.ok(platform.run.signalGroup(pids.manager,0));
 const snapshot=attemptOf(h.store,run.id)!,folder=executionFolder(h.root,run.id,snapshot.attemptId),lastImported=messageName(Number(h.store.connection.prepare('SELECT next_seq FROM run_attempts WHERE attempt_id=?').get(snapshot.attemptId)!.next_seq)-1),first=join(folder,'events',lastImported),saved=readFileSync(first);
 // The importer rechecks only its boundary, the last event it imported; breaking that one blocks the import.
 if(blockage==='diagnostic'){writeFileSync(first,'{broken');new RunEventImporter(h.store).pass();assert.equal(h.store.get(run.id)!.reason,null)}
 else h.store.write(tx=>tx.update({...tx.get(run.id)!,state:'needs_review',reason:'manager_lost'}));
 if(cause==='stop'){requestStop(h.root,{run:run.id});new StopDeliveryOwner(h.store).gate()}
 else h.store.write(tx=>tx.update({...tx.get(run.id)!,started_at:'2020-01-01T00:00:00.000Z'}));
 await recoverExecution(h.store);
 assert.ok(platform.run.signalGroup(pids.agent,0),'live manager retains supervision authority');
 assert.equal(h.store.get(run.id)!.state,'needs_review','Importer retains the completion while manager owns the lock');
 if(cause==='timeout')await clock.advanceTo(60001);
 await until(()=>readdirSync(join(folder,'events')).filter(n=>/^\d{12}\.json$/.test(n)).filter(n=>n!==lastImported).some(n=>JSON.parse(readFileSync(join(folder,'events',n),'utf8')).type==='completed'),'live manager persists its own completion');
 await until(()=>{try{process.kill(pids.manager,0);return false}catch{return true}},'manager exits with pending completion');
 await recoverExecution(h.store);assert.equal(h.store.get(run.id)!.state,'needs_review','manager death does not transfer a pending completion to Recovery');
 writeFileSync(first,saved);new RunEventImporter(h.store).pass();
 const actual={scenario:'generic-fault-live-manager-stop',pids,run:h.store.get(run.id),attempt:h.store.connection.prepare('SELECT next_seq,completed_digest,diagnostic FROM run_attempts').get(),events:readdirSync(join(folder,'events')).filter(n=>/^\d{12}\.json$/.test(n)).map(n=>JSON.parse(readFileSync(join(folder,'events',n),'utf8')).type)};
 console.log(JSON.stringify(actual));writeFileSync(join(h.root,'generic-fault-live-manager-stop.json'),JSON.stringify(actual,null,2));
 assert.ok(actual.attempt!.completed_digest,'repair must import the original manager completion, instead of closing twice');
 const completedName=readdirSync(join(folder,'events')).filter(n=>/^\d{12}\.json$/.test(n)).find(n=>JSON.parse(readFileSync(join(folder,'events',n),'utf8')).type==='completed')!;
 const bytes=readFileSync(join(folder,'events',completedName)),completed=JSON.parse(bytes.toString());
 assert.equal(actual.attempt!.completed_digest,digestBytes(bytes));
 assert.equal(h.store.get(run.id)!.ended_at,completed.occurredAt);
 assert.equal(h.store.get(run.id)!.state,completed.payload.outcome.state);
 const before=JSON.stringify({run:h.store.get(run.id),attempt:actual.attempt,result:h.store.getText(run.id)});
 new RunEventImporter(h.store).pass();await recoverExecution(h.store);
 assert.equal(JSON.stringify({run:h.store.get(run.id),attempt:h.store.connection.prepare('SELECT next_seq,completed_digest,diagnostic FROM run_attempts').get(),result:h.store.getText(run.id)}),before);
});
