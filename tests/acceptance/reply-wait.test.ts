/** Reply-wait acceptance at the real CLI/HTTP boundary, with inert agents and a bounded server lifetime. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { automaticIndex } from '@alpacawork/runs';
import { taskFlow, type Seat } from '../task-flow.fixture.ts';
import { call, post } from '../coordinator-caller.fixture.ts';
import { issueRunCredential } from '@alpacawork/backend/test-dist/control/credentials.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { POLL_INTERVAL_MS } from '@alpacawork/backend/test-dist/poll-interval.js';
async function fixture(t: Parameters<typeof taskFlow>[0]) {
  const f=await taskFlow(t), interval=globalThis.setInterval;
  globalThis.setInterval=((cb,ms,...args)=>interval(cb,ms===POLL_INTERVAL_MS?3_600_000:ms,...args)) as typeof setInterval;
  let server: Awaited<ReturnType<typeof startServer>>;
  try {server=await startServer(f.root,0);} finally {globalThis.setInterval=interval;}
  const timer=setTimeout(()=>void server.close(),90_000);timer.unref();
  console.log('reply-wait server lease',JSON.stringify({pid:process.pid,url:server.url,deadline:new Date(Date.now()+90_000).toISOString()}));
  t.after(async()=>{clearTimeout(timer);await server.close();});
  const env=(seat:Seat)=>({ALPACAWORK_RUN:seat.runId,ALPACAWORK_RUN_TOKEN:issueRunCredential(f.root,seat.runId)});
  const get=(id:string)=>call(server.url,['task','get','--task',id,'--log','100']);
  const ask=async(seat:Seat,to:string,hash?:string)=>{
    const op=randomUUID();await call(server.url,['task','report','--task',seat.id,'--state','waiting','--ask-to',to,
      '--title','Choose','--description-file','-','--op-id',op,'--expected-task-hash',hash??(await get(seat.id)).task.hash],env(seat),'Choose the next work');return op;};
  const answer=(task:string,q:string,seat?:Seat)=>call(server.url,['task','request','--task',task,'--answers',q,'--instruction-file','-'],seat?env(seat):{},'The fixed answer');
  return {...f,server,env,get,ask,answer};
}
test('CLI/HTTP: recipient changes, both question/answer commit orders, late ancestor authority, stopped expiry and one reply wait',async t=>{
  const h=await fixture(t), top=await h.task('Top'), parent=await h.work(top), child=await h.task('Child',{parentId:top.id}), owner=await h.work(child,parent), leaf=await h.task('Leaf',{parentId:child.id}), worker=await h.work(leaf,owner);
  const ids:string[]=[];
  for(const to of ['user',top.id,child.id,'user']) {
    ids.push(await h.ask(worker,to));
    assert.equal((await h.get(leaf.id)).questions.filter(q=>q.state==='open').length,1);
  }
  const late=await h.answer(leaf.id,ids[1]!,parent);
  assert.deepEqual([late.outcome.kind,late.outcome.answers],['request_accepted',ids[1]]);
  assert.equal((await h.get(leaf.id)).questions.find(q=>q.id===ids.at(-1))?.state,'withdrawn');
  const current=await h.ask(worker,'user');
  const old=(await h.get(leaf.id)).task.hash;
  assert.equal((await h.answer(leaf.id,current)).outcome.kind,'answered');
  await assert.rejects(h.ask(worker,'user',old),{code:'conflict'},'answer first rejects an obsolete new question');
  const newer=await h.ask(worker,'user'), newest=await h.ask(worker,'user');
  assert.equal((await h.answer(leaf.id,newer)).outcome.kind,'request_accepted','question first preserves the late words');
  assert.equal((await h.get(leaf.id)).questions.find(q=>q.id===newest)?.state,'withdrawn');
  const expiring=await h.ask(worker,'user');
  await call(h.server.url,['task','report','--task',leaf.id,'--state','stopped','--expected-task-hash',(await h.get(leaf.id)).task.hash]);
  await assert.rejects(h.answer(leaf.id,expiring),{code:'question_expired'});
});
test('HTTP: a done report withdraws the outgoing question; owner admission invalidates review before its queued Run starts or is cancelled',async t=>{
  const h=await fixture(t), task=await h.task('Review',{userRequested:true}), owner=await h.work(task);
  const q=await h.ask(owner,'user');
  await h.report(owner,'done');h.end(owner);
  assert.equal((await h.get(task.id)).questions.find(q0=>q0.id===q)?.state,'withdrawn');
  await h.person(task.id,'held');
  const input={task:task.id,answers:q,body:'Additional evidence',opId:randomUUID()};
  const response=await post(h.server.url,'/api/task/request',input,{'X-Alpacawork-Op-Id':input.opId});
  assert.equal(response.status,200,JSON.stringify(response.body));
  assert.deepEqual([response.body.task.baseState,response.body.task.hold,response.body.outcome.answers],['doing',true,q]);
  const queued={...task,runId:response.body.outcome.request.runId};h.end(queued,'cancelled');
  await h.person(task.id,'doing');
  assert.equal((await h.get(task.id)).task.baseState,'doing');
  await assert.rejects(h.confirm(task.id,owner.runId),{code:'conflict'});
  const next=await h.work(task);await h.report(next,'done');h.end(next);
  await h.confirm(task.id,next.runId);assert.equal((await h.get(task.id)).task.state,'done');
});

test('CLI: a late AI answer counts toward the limit, open human answers do not reset it, and a late human answer resets it',async t=>{
 const h=await fixture(t), top=await h.task('Parent'), parent=await h.work(top);
 writeFileSync(join(h.root,'config.yaml'),'limits:\n  automatic_per_placement: 2\n'+readFileSync(join(h.root,'config.yaml'),'utf8'));
 const child=await h.task('Child',{parentId:top.id}), owner=await h.work(child,parent);
 const oldAI=await h.ask(owner,top.id),oldUser=await h.ask(owner,'user'),current=await h.ask(owner,'user');
 const count=()=>automaticIndex(h.store(s=>s.snapshot(h.project).requests)).count(child.placementId,[child.id,top.id]);
 assert.equal(count(),1);
 await h.answer(child.id,oldAI,parent);assert.equal(count(),2);
 assert.equal((await h.get(child.id)).questions.find(q=>q.id===current)?.state,'withdrawn');
 const fresh=await h.ask(owner,'user');
 await assert.rejects(h.answer(child.id,oldAI,parent),{code:'automatic_limit'});assert.equal(count(),2);
 assert.equal((await h.get(child.id)).questions.find(q=>q.id===fresh)?.state,'open','refused admission leaves the current wait intact');
 await h.answer(child.id,fresh);assert.equal(count(),2);
 const late=await h.answer(child.id,oldUser);assert.equal(late.outcome.kind,'request_accepted');assert.equal(count(),0);
});
test('CLI: a child values change and a normal human instruction each invalidate the review at their real entry',async t=>{
 const h=await fixture(t), top=await h.task('Parent review',{userRequested:true}), owner=await h.work(top);
 const child=await h.task('Child',{parentId:top.id}), worker=await h.work(child,owner);
 await h.report(worker,'done');h.end(worker);
 const received=await h.receive(owner);await h.report(received,'done');h.end(received);
 await call(h.server.url,['task','update','--task',child.id,'--values-file','-','--expected-task-hash',(await h.get(child.id)).task.hash],{},JSON.stringify({conclusion:'Revised child result'}));
 const parent=(await h.get(top.id)).task;
 assert.equal(parent.baseState,'doing');assert.equal(parent.log.at(-1).stage.ruleId,'RW02');
 const direct=await h.task('Direct review',{userRequested:true}), responsible=await h.work(direct);
 await h.report(responsible,'done');h.end(responsible);
 const sent=await call(h.server.url,['task','request','--task',direct.id,'--instruction-file','-',
   '--expected-task-hash',(await h.get(direct.id)).task.hash,'--expected-placement-revision','1'],{},'Please revise the result');
 assert.equal(sent.task.baseState,'doing');assert.equal(sent.outcome.kind,'request_accepted');
});

test('CLI/HTTP: resumption and doing close the original wait while fixed question text survives values updates', async t => {
  const h = await fixture(t), task = await h.task('Resume fixed text'), owner = await h.work(task);
  const q = await h.ask(owner, 'user');
  const original = await call(h.server.url, ['task', 'get', '--task', task.id, '--question', q]);
  const inputHash = (await h.get(task.id)).task.hash, op = randomUUID();
  const command = ['task', 'request', '--task', task.id, '--instruction-file', '-', '--expected-task-hash', inputHash,
    '--expected-placement-revision', '1', '--op-id', op];
  const accepted = await call(h.server.url, command, {}, 'Work with new evidence');
  assert.equal((await h.get(task.id)).questions.find(q0 => q0.id === q)?.state, 'withdrawn');
  await call(h.server.url, ['task', 'update', '--task', task.id, '--values-file', '-',
    '--expected-task-hash', (await h.get(task.id)).task.hash], {},
    JSON.stringify({ decide: [{ decide_question: 'A newer question', decide_note: 'New evidence' }] }));
  const fixed = await call(h.server.url, ['task', 'get', '--task', task.id, '--question', q]);
  assert.equal(fixed.question.text, original.question.text);
  const newer = await h.ask(owner, 'user');
  assert.deepEqual((await call(h.server.url, command, {}, 'Work with new evidence')).outcome, accepted.outcome);
  assert.equal((await h.get(task.id)).questions.find(q0 => q0.id === newer)?.state, 'open');
  await call(h.server.url, ['task', 'report', '--task', task.id, '--state', 'doing', '--title', 'Resume now',
    '--expected-task-hash', (await h.get(task.id)).task.hash], h.env(owner));
  assert.equal((await h.get(task.id)).questions.find(q0 => q0.id === newer)?.state, 'withdrawn');
});

test('CLI/HTTP: an answer return resumes the owner and supplies the withdrawn newer original', async t => {
  const h = await fixture(t), task = await h.task('Automatic answer'), owner = await h.work(task);
  const q = await h.ask(owner, 'user');
  await h.answer(task.id, q);
  const newer = await h.ask(owner, 'user');
  const resumed = await h.receive(owner);
  const view = await h.get(task.id);
  assert.equal(view.questions.find(q0 => q0.id === q)?.state, 'answered');
  assert.equal(view.questions.find(q0 => q0.id === newer)?.state, 'withdrawn');
  const text = h.store(s => s.getText(resumed.runId))!.prompt!;
  assert.match(text, new RegExp(`--question ${newer}`));
  const fixed = await call(h.server.url, ['task', 'get', '--task', task.id, '--question', newer]);
  assert.equal(fixed.question.state, 'withdrawn');
  assert.match(fixed.question.text, /Which way/);
});
