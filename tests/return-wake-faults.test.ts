/** Real serve kill at a wake's commit. Durable wake rows and actual manager/agent markers must both be singular. */
import{test}from'node:test';import assert from'node:assert/strict';import{spawn}from'node:child_process';import{once}from'node:events';import{existsSync,readFileSync,readdirSync}from'node:fs';import{join,resolve}from'node:path';
import{RunStore}from'@alpacawork/runs';import{startServer}from'@alpacawork/backend/test-dist/receiver/server.js';import{setup,until,receipts}from'./runs-runtime.fixture.ts';import{cleanCliEnv}from'./helpers/http-cli.ts';
import { preserveTestFailure } from './helpers/failure-workspace.ts';
const snapshot=(root:string)=>{const store=RunStore.openReadable(root,{busyTimeoutMs:1000})!;try{return{runs:store.read(),requests:store.readRequests(),returns:store.readReturns(),attempts:store.connection.prepare('SELECT run_no,dirty FROM run_attempts').all()}}finally{store.close()}};
for(const phase of['wake-before-commit','wake-after-commit'])test(`SIGKILL ${phase} keeps the reply's delivery and its wake atomic; recovery starts its subject once`,async t=>{
 const h=await setup(t),parent=h.create('claude',{gate:h.gate('parent')}),worker=h.create('claude',{gate:h.gate('worker')},{role:'worker',placementId:h.memberPlacementId,caller:{run:parent.id}});await h.tick();await h.ready(parent);await h.ready(worker);
 h.pauseProjection();h.store.close();h.release('parent');h.release('worker');
 await until(()=>[parent,worker].every(run=>{try{const base=join(h.root,'.alpacawork/runs',run.id,'protocol');return readdirSync(base).some(a=>readdirSync(join(base,a,'events')).some(n=>JSON.parse(readFileSync(join(base,a,'events',n),'utf8')).type==='completed'))}catch{return false}}),'both real managers persist completion');
 const marker=join(h.root,'wake-kill.json'),subject=spawn(process.execPath,[resolve('tests/fixtures/serve-writer-fault.ts'),h.root,phase,marker],{env:cleanCliEnv(),stdio:['ignore','ignore','pipe']});let stderr='';subject.stderr.on('data',b=>stderr+=b);const expiry=setTimeout(()=>subject.kill('SIGKILL'),25000);try{await once(subject,'exit')}finally{clearTimeout(expiry)}assert.ok(existsSync(marker),stderr);
 const before=snapshot(h.root),wakeBefore=before.requests.filter(r=>r.purpose === 'return_continuation');assert.equal(wakeBefore.length,phase==='wake-before-commit'?0:1);assert.equal(before.returns.filter(r=>r.requestId===worker.requestId&&r.deliveries.length>0).length,phase==='wake-before-commit'?0:1);
 const app=await startServer(h.root,0);try{
  const after=await until(()=>{const state=snapshot(h.root),wake=state.requests.filter(r=>r.purpose === 'return_continuation');return wake.length===1&&state.runs.find(r=>r.requestId===wake[0]!.id)?.state==='succeeded'&&state},'the one wake actually executes');
  const wake=after.requests.find(r=>r.purpose === 'return_continuation')!,run=after.runs.find(r=>r.requestId===wake.id)!;assert.equal(receipts(h.root).filter(r=>r.env.ALPACAWORK_RUN===run.id).length,1);assert.equal(after.returns.find(r=>r.requestId===worker.requestId)!.deliveries.at(-1)!.wakeRequestId,wake.id);
  // Finishing the wake publishes new seat work; its dirty receipt is cleared by that later routing pass.
  const acknowledged=await until(()=>{const state=snapshot(h.root);return state.attempts.every(a=>a.dirty===0)&&state},'the finished wake seat is routed and acknowledged');
  assert.equal(acknowledged.requests.filter(r=>r.purpose==='return_continuation').length,1);
  assert.equal(receipts(h.root).filter(r=>r.env.ALPACAWORK_RUN===run.id).length,1,'acknowledging the completion never starts its wake again');
  console.log(JSON.stringify({proof:'return-wake-kill',phase,subjectPid:subject.pid,requestsBefore:wakeBefore.map(r=>r.id),wake:{request:wake.id,run:run.id,pids:run.pids},returns:after.returns.filter(r=>r.requestId===worker.requestId),actualSubjects:receipts(h.root).map(r=>({pid:r.pid,run:r.env.ALPACAWORK_RUN}))}));
 }catch(error){await preserveTestFailure(t,h.root,{failure:{error},origin:app.url,diagnostics:()=>({phase,state:snapshot(h.root),processes:receipts(h.root)})});throw error;}finally{await app.close()}
});
