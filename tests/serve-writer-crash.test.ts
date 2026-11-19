import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setup, until, receipts } from './runs-runtime.fixture.ts';
import { RunStore } from '@alpacawork/runs';
import { launch, settleTransaction } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { cleanCliEnv } from './helpers/http-cli.ts';
const read=(root:string,fn:(store:RunStore)=>any)=>{const store=RunStore.openReadable(root,{busyTimeoutMs:1000})!;try{return fn(store)}finally{store.close()}};
function faultServe(root:string,mode:string,marker:string){const child=spawn(process.execPath,[resolve('tests/fixtures/serve-writer-fault.ts'),root,mode,marker],{env:cleanCliEnv(),stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',bytes=>stderr+=bytes);const expiry=setTimeout(()=>child.kill('SIGKILL'),25000);const exited=once(child,'exit').finally(()=>clearTimeout(expiry));return{child,exited,stderr:()=>stderr}}
for(const phase of ['import-before-commit','import-after-commit'])test(`serve SIGKILL ${phase}: result/cursor/time commit together and the next subject starts once`,async t=>{
 const h=await setup(t),run=h.create('claude',{gate:h.gate('release'),output:'durable-proof',usage:{inputTokens:9,cacheReadInputTokens:2,cacheCreationInputTokens:1,outputTokens:4}}),next=h.create('claude',{output:'next-proof'},{resumes:run.id,session:run.session});
 await h.tick();await h.ready(run);h.pauseProjection();const before=h.store.connection.prepare('SELECT next_seq,last_digest FROM run_attempts WHERE run_no=?').get(Number(run.id.slice(1)));h.store.close();h.release('release');
 const marker=join(h.root,'serve-fault.json');await until(()=>{try{return readdirSync(join(h.root,'.alpacawork/runs',run.id,'protocol')).some(a=>readdirSync(join(h.root,'.alpacawork/runs',run.id,'protocol',a,'events')).some(n=>JSON.parse(readFileSync(join(h.root,'.alpacawork/runs',run.id,'protocol',a,'events',n),'utf8')).type==='completed'))}catch{return false}},'manager persisted completion');
 const subject=faultServe(h.root,phase,marker);await subject.exited;assert.ok(existsSync(marker),subject.stderr());
 const crash=read(h.root,s=>({run:s.getText(run.id),cursor:s.connection.prepare('SELECT next_seq,last_digest,dirty FROM run_attempts WHERE run_no=?').get(Number(run.id.slice(1)))}));
 if(phase==='import-before-commit'){assert.equal(crash.run.record.state,'running');const attempt=readdirSync(join(h.root,'.alpacawork/runs',run.id,'protocol'))[0]!;const events=readdirSync(join(h.root,'.alpacawork/runs',run.id,'protocol',attempt,'events')).map(n=>JSON.parse(readFileSync(join(h.root,'.alpacawork/runs',run.id,'protocol',attempt,'events',n),'utf8')));const completed=events.find(e=>e.type==='completed');assert.equal(crash.cursor.next_seq,completed.seq);assert.equal(crash.cursor.last_digest,completed.previousDigest);assert.equal(crash.run.resultState,'pending')}else{assert.equal(crash.run.record.state,'succeeded');assert.equal(crash.cursor.dirty,1)}
 const app=await startServer(h.root,0);try{await until(()=>read(h.root,s=>s.get(next.id)?.state)==='succeeded','next completes');const after=read(h.root,s=>s.getText(run.id));assert.equal(after.result,'durable-proof');assert.deepEqual(after.record.usage.run,{input:9,cacheRead:2,cacheWrite:1,output:4});assert.equal(receipts(h.root).filter((r:any)=>r.env.ALPACAWORK_RUN===run.id).length,1);assert.equal(receipts(h.root).filter((r:any)=>r.env.ALPACAWORK_RUN===next.id).length,1);console.log(JSON.stringify({proof:phase,subjectPid:subject.child.pid,before,crash:{state:crash.run.record.state,cursor:crash.cursor},after:{state:after.record.state,endedAt:after.record.ended_at,usage:after.record.usage},processes:receipts(h.root).map((r:any)=>({pid:r.pid,run:r.env.ALPACAWORK_RUN}))}));}finally{await app.close()}
});
