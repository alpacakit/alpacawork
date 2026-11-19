/** A stopped process can retain its PID/start time until it is reaped. It is not an active updater. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs, { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { platform } from '@alpacawork/core';
import { controllerAlive, observeUpdate, completedUpdate, type UpdateOperation } from '../apps/backend/test-dist/release/update-record.js';
import { saveJournal, type SwitchJournal } from '../apps/backend/test-dist/release/journal.js';
test('a real unreaped controller stops being live even while its recorded incarnation still exists', {skip:process.platform!=='linux'}, async()=>{
 const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});
 const exited=once(child,'exit');await once(child,'spawn');
 const pid=child.pid!,started=platform.run.started(pid);assert(started);
 const execution={controller:{pid,started}} as any;
 try{
  assert.equal(controllerAlive(execution),true);child.kill('SIGKILL');
  let zombie=false;for(const end=Date.now()+2000;Date.now()<end;){
   zombie=readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1]!.startsWith('Z ');if(zombie)break;
   Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
  }
  assert(zombie,'the real child has exited but this event loop has not reaped it');
  assert.equal(platform.run.started(pid),started,'PID/start-time alone is a false live result');
  assert.equal(controllerAlive(execution),false);
 }finally{child.kill('SIGKILL');await exited;}
});

test('stage belongs to the journal, progress requires a live executor, and terminal checks do no liveness I/O', t=>{
 const releases=mkdtempSync(join(tmpdir(),'update-progress-')),workspace=join(releases,'data');
 t.after(()=>rmSync(releases,{recursive:true,force:true}));mkdirSync(join(workspace,'.alpacawork'),{recursive:true});
 const started=platform.run.started(process.pid);assert(started);
 const controller={pid:process.pid,started};
 const op:UpdateOperation={opId:randomUUID(),workspace,
  candidate:{facts:{source:'a'.repeat(40)},edition:'production'} as UpdateOperation['candidate'],
  reviewDigest:'b'.repeat(64),skills:{root:join(releases,'skills'),place:['alpacawork']},
  phase:'failed',controller,failure:{kind:'application_failed',category:'other'}};
 const journal:SwitchJournal={version:4,skillsWriteStarted:false,opId:op.opId,workspace,old:'/old',target:join(releases,'a'.repeat(40)),
  previous:null,phase:'waiting_runs',schema:null};
 assert.equal(observeUpdate(releases,op,null),'fetching','a live retry takes precedence over the old failure');
 for(const [phase,expected] of [['waiting_runs','waiting_runs'],['target_ready','applying'],['restoring_old','recovering'],['recovery_intent','recovering']] as const){
  journal.phase=phase;assert.equal(observeUpdate(releases,op,journal),expected,phase);
  assert.equal(observeUpdate(releases,{...op,controller:null},journal),'stopped',phase);
 }
 assert.equal(observeUpdate(releases,{...op,controller:null},null),'failed');
 assert.equal(observeUpdate(releases,{...op,controller:null,failure:{kind:'unsupported',category:'other'}},null),'unsupported');
 assert.throws(()=>observeUpdate(releases,op,{...journal,target:'/another'}));
 assert.throws(()=>observeUpdate(releases,op,{...journal,workspace:'/another'}));
 journal.phase='committed';saveJournal({releases,workspace},journal);
 const processes=t.mock.method(platform.run,'commandProcesses',()=>assert.fail('terminal checks must not inspect processes'));
 const originalOpen=fs.openSync;
 const open=t.mock.method(fs,'openSync',(...args:Parameters<typeof fs.openSync>)=>{
  assert.notEqual(String(args[0]),join(releases,'.release.lock'),'terminal checks must not observe the execution lock');
  return Reflect.apply(originalOpen,fs,args);
 });syncBuiltinESMExports();
 try{
  assert.equal(completedUpdate(releases,op),'committed');
  assert.equal(observeUpdate(releases,op,journal),'committed');
  const withdrawn={...op,opId:randomUUID(),failure:{kind:'metadata_changed',category:'other' as const}};
  assert.equal(completedUpdate(releases,withdrawn),'withdrawn');
  assert.equal(observeUpdate(releases,withdrawn,journal),'withdrawn');
 }finally{processes.mock.restore();open.mock.restore();syncBuiltinESMExports();}
});
