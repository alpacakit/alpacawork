/** Actual manager/process markers and durable input rows at every fatal observation boundary. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setup, until } from './runs-runtime.fixture.ts';
import { readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { settleTransaction, launch, settle } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
const markers=(root:string)=>{try{return readdirSync(join(root,'subjects')).map(n=>JSON.parse(readFileSync(join(root,'subjects',n),'utf8')))}catch{return[]}};
for(const stage of ['claimed','spawn_intent','input_attempt','stdin-write','input_taken','result-blob','completed'])test(`manager SIGKILL at ${stage} keeps one invocation and durable reservation`,async t=>{
 const h=await setup(t);
 const run=h.create('claude',{}, {launch:{argv:[process.execPath,resolve('tests/fixtures/protocol-agent.mjs'),'--root',h.root,'--session','{session}'],adapter:'claude',env:[],values:{},path:h.path}});
 const next=h.create('claude',{output:'next'},{resumes:run.id,session:run.session});
 writeFileSync(join(h.root,'manager-fault-stage'),stage);
 // Result-producing stages need a completed provider round; others leave the actual subject gated.
 await launch(h.store,await settleTransaction(h.store,readAgentsSettings(h.root)),{script:resolve('tests/fixtures/fault-manager.ts')});
 if(['result-blob','completed'].includes(stage)){await until(()=>markers(h.root).some(s=>s.run===run.id&&s.inputs.length===1),'actual initial processing');h.release(`gate-${run.id}`);}
 await until(()=>existsSync(join(h.root,'manager-fault.json')),'manager fatal boundary');
 await until(()=>{try{process.kill(JSON.parse(readFileSync(join(h.root,'manager-fault.json'),'utf8')).pid,0);return false}catch{return true}},'manager gone');
 new RunEventImporter(h.store).pass();await settle(h.store);await settle(h.store);
 const row=h.store.connection.prepare('SELECT completed_digest,next_seq,dirty FROM run_attempts WHERE run_no=?').get(Number(run.id.slice(1)))!;
 const inputs=h.store.connection.prepare('SELECT input_id,state,receipt_json FROM run_inputs WHERE instruction_run_no=?').all(Number(run.id.slice(1)));
 const subjects=markers(h.root).filter(s=>s.run===run.id);
 assert.equal(h.store.connection.prepare('SELECT count(*) AS n FROM run_attempts WHERE run_no=?').get(Number(run.id.slice(1)))!.n,1);
 assert.ok(subjects.length<=1,'the actual process marker must never show a second initial invocation');
 if(stage==='completed'){assert.equal(h.store.get(run.id)!.state,'succeeded');assert.ok(row.completed_digest)}
 else if(stage==='result-blob'){
  assert.equal(h.store.get(run.id)!.state,'failed');assert.equal(h.store.get(run.id)!.reason,'exit');assert.equal(h.store.get(run.id)!.exit,null);
  assert.match(h.store.getText(run.id)!.result!,new RegExp(`^RESULT:${run.id}:`));assert.ok(row.completed_digest,'a stable exited invocation publishes its recovered observation');
 }
 else{assert.equal(h.store.get(run.id)!.state,'needs_review');assert.equal(h.store.get(run.id)!.exit,null);assert.equal(h.store.get(next.id)!.state,'queued');assert.equal(row.completed_digest,null)}
 if(['stdin-write','input_taken','result-blob','completed'].includes(stage))assert.ok(inputs.every(i=>i.state!=='not_sent'),'transfer must not be released as unsent');
 console.log(JSON.stringify({proof:'manager-kill',stage,manager:JSON.parse(readFileSync(join(h.root,'manager-fault.json'),'utf8')),run:{id:run.id,state:h.store.get(run.id)!.state,exit:h.store.get(run.id)!.exit},inputs,cursor:row,subjects}));
});
