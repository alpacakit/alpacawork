/** Stream-json's actual manager path: provider processing markers, durable reservations, and late receipt/cancel races. */
import{test}from'node:test';import assert from'node:assert/strict';import{readFileSync,readdirSync,writeFileSync}from'node:fs';import{join,resolve}from'node:path';
import{setup,until}from'./runs-runtime.fixture.ts';
import type { RunRecord } from '@alpacawork/contract/run';
function subjects(root:string){try{return readdirSync(join(root,'subjects')).map(n=>JSON.parse(readFileSync(join(root,'subjects',n),'utf8')))}catch{return[]}}
function stream(h: Awaited<ReturnType<typeof setup>>, adapter: 'claude' | 'codex' = 'claude'): RunRecord['launch'] { return { adapter, env: [], argv: [process.execPath, resolve('tests/fixtures/protocol-agent.mjs'), '--root', h.root, '--session', adapter === 'claude' ? '{session}' : 'synthetic-delayed', ...(adapter === 'codex' ? ['--bridge', '--result', '{result}'] : [])], values: {}, path: h.path }; }
for(const initial of[true,false])for(const behavior of['NO_RECEIPT','LEGACY_REFUSAL'])test(`${initial?'initial':'continuation'} ${behavior}: a result alone leaves uncertainty, holds its reservation and never starts another subject`,async t=>{
 const h=await setup(t),first=h.create('claude',{text:initial?behavior:'normal'},{launch:stream(h)});await h.tick();await until(()=>subjects(h.root).some(s=>s.run===first.id&&s.inputs.length===1),'first actual processing');
 let inputRun=first;
 if(!initial){await until(()=>h.store.connection.prepare("SELECT 1 FROM run_inputs WHERE state='taken'").get(),'initial receipt');inputRun=h.create('claude',{text:behavior},{resumes:first.id,session:first.session,launch:stream(h)});await h.tick();await until(()=>subjects(h.root).some(s=>s.run===first.id&&s.inputs.length===2),'continued actual processing')}
 const later=h.create('claude',{text:'must wait'},{resumes:first.id,session:first.session,launch:stream(h)});h.release(`gate-${first.id}`);await h.waitState(first,'succeeded');
 await h.tick();await h.tick();const rows=h.store.connection.prepare('SELECT input_id,state FROM run_inputs WHERE instruction_run_no=?').all(Number(inputRun.id.slice(1)));assert.equal(rows.length,1);assert.equal(rows[0]!.state,'uncertain');assert.equal(h.store.get(later.id)!.state,'queued');if(!initial)assert.equal(h.store.get(inputRun.id)!.state,'queued');
 const observed=subjects(h.root).filter(s=>s.run===first.id);assert.equal(observed.length,1);assert.equal(observed[0].inputs.length,initial?1:2);assert.equal(subjects(h.root).some(s=>s.run===later.id),false);
 console.log(JSON.stringify({proof:'stream-uncertain',initial,behavior,rows,subject:observed[0],later:h.store.get(later.id)!.state}));
});
test('delayed same-uuid taken resolves uncertainty after cancellation without reviving or redelivering the instruction',async t=>{
 const h=await setup(t),first=h.create('codex',{text:'normal'},{launch:stream(h, 'codex')});await h.tick();await until(()=>h.store.connection.prepare("SELECT 1 FROM run_inputs WHERE state='taken'").get(),'initial processing receipt');
 const next=h.create('codex',{text:'LATE_TAKEN'},{resumes:first.id,session:h.store.get(first.id)!.session,launch:stream(h, 'codex')});await h.tick();
 const input=await until(()=>h.store.connection.prepare("SELECT input_id FROM run_inputs WHERE instruction_run_no=? AND state='uncertain'").get(Number(next.id.slice(1))),'durable uncertain continued input');
 h.store.write(tx=>tx.update({...tx.get(next.id)!,state:'cancelled',reason:'stopped',stop_requested:true,ended_at:new Date().toISOString()}));
 writeFileSync(join(h.root,'late-'+input.input_id),'');await until(()=>h.store.connection.prepare('SELECT state FROM run_inputs WHERE input_id=?').get(input.input_id)!.state==='taken','delayed processing receipt');
 assert.equal(h.store.get(next.id)!.state,'cancelled');h.release(`gate-${first.id}`);await h.waitState(first,'succeeded');const observed=subjects(h.root).filter(s=>s.run===first.id);assert.equal(observed.length,1);assert.equal(observed[0].inputs.filter((i:any)=>i.id===input.input_id).length,1);
 console.log(JSON.stringify({proof:'late-taken-cancel',input,subject:observed[0],instruction:h.store.get(next.id)!.state}));
});
