import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setup } from './runs-runtime.fixture.ts';
import { settleTransaction, closeLaunches } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { attemptOf } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { EventJournal, executionFolder, identityOf } from '@alpacawork/backend/test-dist/runs/execution-files.js';
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import { recoverExecution } from '@alpacawork/backend/test-dist/runs/recovery.js';
import { bootIdentity, digestBytes, publishImmutable } from '@alpacawork/core';

const outcomes = [
  ...['exit','timeout','launch','output','conversation_busy'].map(reason => ({state:'failed',reason})),
  {state:'succeeded',reason:null}, {state:'cancelled',reason:'stopped'},
  {state:'needs_review',reason:'conversation_busy'},
] as const;
for (const outcome of outcomes) test(`repair importer storage fault then import ${outcome.state}/${outcome.reason}`, async t => {
  const h = await setup(t); h.pauseProjection();
  const run = h.create();
  const decision = await settleTransaction(h.store, readAgentsSettings(h.root)); closeLaunches(decision.launches);
  const launch = attemptOf(h.store, run.id)!;
  const folder=executionFolder(h.root,run.id,launch.attemptId), journal = new EventJournal(folder, identityOf(launch));
  journal.append('claimed', { managerPid: process.pid, managerStarted: 'review', bootId: bootIdentity() });
  journal.append('spawn_intent', { initialInputId: launch.initialInputId });
  journal.append('input_attempt', { inputId: launch.initialInputId, instructionRunId: run.id, contentDigest: digestBytes(launch.prompt) });
  journal.append('input_taken', { inputId: launch.initialInputId, receipt: { evidence: 'provider_started' } });
  const text='original result '+outcome.state+'/'+outcome.reason, digest=digestBytes(text);
  publishImmutable(join(folder,'results'),digest+'.bin',text);
  const measuredUsage={scope:'run',counters:{input:71,cacheRead:5,cacheWrite:3,output:29}} as const;
  const completed=journal.append('completed', { outcome, session:'original-session', measuredUsage,
    exit: { code: 1, signal: null }, result: { state: 'present', digest, size: Buffer.byteLength(text) } } as any);
  h.store.connection.exec(`CREATE TRIGGER review_fault BEFORE UPDATE ON runs WHEN json_extract(NEW.record,'$.state')='${outcome.state}' AND coalesce(json_extract(NEW.record,'$.reason'),'none')='${outcome.reason??'none'}' BEGIN SELECT RAISE(ABORT,'review-transient-io'); END`);
  new RunEventImporter(h.store).pass();
  assert.equal(h.store.get(run.id)!.state, 'needs_review');assert.equal(h.store.get(run.id)!.reason,null);
  // Even without a manager, a durable completion behind a fault belongs to the Importer.
  h.store.write(tx=>tx.update({...tx.get(run.id)!,stop_requested:true}));
  await recoverExecution(h.store);assert.equal(h.store.get(run.id)!.state,'needs_review');
  h.store.connection.exec('DROP TRIGGER review_fault');
  new RunEventImporter(h.store).pass();
  const row=()=>h.store.connection.prepare('SELECT next_seq,completed_digest,diagnostic FROM run_attempts').get()!;
  assert.equal(h.store.get(run.id)!.state,outcome.state,'repair must import the same durable completion');
  assert.equal(h.store.get(run.id)!.reason,outcome.reason);
  assert.equal(h.store.get(run.id)!.ended_at,completed.occurredAt);
  if(outcome.state!=='needs_review')assert.equal(h.store.getText(run.id)!.result,text);
  assert.deepEqual(h.store.get(run.id)!.usage?.run,measuredUsage.counters);
  assert.equal(row().completed_digest,digestBytes(JSON.stringify(completed)));
  assert.equal(row().next_seq,completed.seq+1);assert.equal(row().diagnostic,null);
  const before=JSON.stringify({run:h.store.get(run.id),row:row()});
  new RunEventImporter(h.store).pass();await recoverExecution(h.store);
  assert.equal(JSON.stringify({run:h.store.get(run.id),row:row()}),before);
  console.log(JSON.stringify({proof:'repaired-original-completion',outcome,occurredAt:completed.occurredAt,attempt:row()}));
});
for (const reason of ['manager_lost', null] as const) test(`lost invocation timeout from needs_review/${reason}`, async t => {
  const h = await setup(t, { run_minutes: 1 }); h.pauseProjection(); const run = h.create();
  const decision = await settleTransaction(h.store, readAgentsSettings(h.root)); closeLaunches(decision.launches);
  const launch = attemptOf(h.store, run.id)!;
  h.store.connection.prepare('UPDATE run_attempts SET started_json=? WHERE attempt_id=?').run(JSON.stringify({pid:2147483647,started:'nonexistent',bootId:bootIdentity(),group:2147483647,scope:null}),launch.attemptId);
  h.store.write(tx => tx.update({ ...tx.get(run.id)!, started_at:'2020-01-01T00:00:00.000Z', state:'needs_review', reason,
    pids: { manager:null, agent:2147483647 } }));
  let caught: unknown;
  try { await recoverExecution(h.store); } catch (e) { caught=e; }
  console.log(JSON.stringify({scenario:'lost-timeout',reason,error:String(caught),run:h.store.get(run.id)}));
  assert.equal(caught, undefined, 'an expired lost invocation must not throw an illegal transition');
  assert.equal(h.store.get(run.id)!.state, 'failed');
  const next=h.createIndependent('plain',{output:'after timeout'});await h.tick();
  await (await import('./runs-runtime.fixture.ts')).until(()=>{new RunEventImporter(h.store).pass();return h.store.get(next.id)!.state==='succeeded'},'workspace still settles after timeout');
  await new ReturnRouter(h.root).pass();
  assert.equal(h.store.connection.prepare('SELECT dirty FROM run_attempts WHERE attempt_id=?').get(launch.attemptId)!.dirty,0,'routing consumes a recovered terminal observation as well as a manager completion');
});

for (const state of ['needs_review','failed'] as const) test(`a late manager completion may resolve provisional manager_lost to ${state}/conversation_busy`, async t=>{
  const h=await setup(t);h.pauseProjection();const run=h.create();
  const decision=await settleTransaction(h.store,readAgentsSettings(h.root));closeLaunches(decision.launches);
  const launch=attemptOf(h.store,run.id)!,journal=new EventJournal(executionFolder(h.root,run.id,launch.attemptId),identityOf(launch));
  journal.append('claimed',{managerPid:process.pid,managerStarted:'review',bootId:bootIdentity()});
  journal.append('spawn_intent',{initialInputId:launch.initialInputId});
  h.store.write(tx=>tx.update({...tx.get(run.id)!,state:'needs_review',reason:'manager_lost'}));
  const completed=journal.append('completed',{outcome:{state,reason:'conversation_busy'},session:null,measuredUsage:null,exit:{code:1,signal:null},result:{state:'missing',digest:null,size:0}});
  new RunEventImporter(h.store).pass();
  assert.equal(h.store.get(run.id)!.state,state);assert.equal(h.store.get(run.id)!.reason,'conversation_busy','a provisional loss must yield to the durable observation');
  assert.equal(h.store.connection.prepare('SELECT completed_digest FROM run_attempts WHERE attempt_id=?').get(launch.attemptId)!.completed_digest,digestBytes(JSON.stringify(completed)));
});
