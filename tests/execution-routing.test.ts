/** Compose import dirtiness with the per-project routing cache. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './runs-runtime.fixture.ts';
import { settleTransaction, closeLaunches } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { attemptOf } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { EventJournal, executionFolder, identityOf } from '@alpacawork/backend/test-dist/runs/execution-files.js';
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { bootIdentity } from '@alpacawork/core';

async function pending(t: Parameters<typeof setup>[0]) {
 const h=await setup(t);h.pauseProjection();const run=h.create();
 const decision=await settleTransaction(h.store,readAgentsSettings(h.root));closeLaunches(decision.launches);
 const launch=attemptOf(h.store,run.id)!;
 const journal=new EventJournal(executionFolder(h.root,run.id,launch.attemptId),identityOf(launch));
 journal.append('claimed',{managerPid:process.pid,managerStarted:'test',bootId:bootIdentity()});
 journal.append('spawn_intent',{initialInputId:launch.initialInputId});new RunEventImporter(h.store).pass();
 h.store.write(tx=>tx.update({...tx.get(run.id)!,state:'needs_review',reason:null}));
 const complete=()=>{journal.append('completed',{outcome:{state:'needs_review',reason:'conversation_busy'},session:null,
  measuredUsage:null,exit:{code:1,signal:null},result:{state:'missing',digest:null,size:0}});new RunEventImporter(h.store).pass();};
 const dirty=()=>h.store.connection.prepare('SELECT dirty FROM run_attempts WHERE attempt_id=?').get(launch.attemptId)!.dirty;
 return {h,run,complete,dirty};
}
test('an imported completion routes even when state/result counts do not move',async t=>{
 const {h,run,complete,dirty}=await pending(t),router=new ReturnRouter(h.root),passProject=router.passProject;
 let visits=0;
 t.mock.method(router,'passProject',function(...args:unknown[]){visits++;return passProject.apply(router,args);});
 for(let n=0;n<5;n++){visits=0;await router.pass(undefined,'changed');if(!visits)break;}
 assert.equal(visits,0,'routing is cached before the new completion');
 complete();assert.equal(h.store.get(run.id)!.state,'needs_review');assert.equal(dirty(),1);
 await router.pass(undefined,'changed');assert.equal(visits,1,'completion dirtiness invalidates the routing mark');assert.equal(dirty(),0);
});
test('routing one project does not consume another project completion',async t=>{
 const {h,complete,dirty}=await pending(t);complete();
 const mobile=(await new ControlTaskCommands(h.root,{kind:'human'}).create({kind:'project', color: '#39659b',parentId:null,userRequested:null,tasks:[{title:'Mobile'}]})).tasks[0];
 await new ReturnRouter(h.root).pass(undefined,{project:mobile.id});
 assert.equal(dirty(),1,'unvisited completion stays dirty');
 await new ReturnRouter(h.root).pass(undefined,'changed');assert.equal(dirty(),0);
});
