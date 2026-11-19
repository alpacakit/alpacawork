/** The one writer settles old waits atomically; answers preserve their original identity. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openQuestions } from '@alpacawork/raw';
import { evaluate, TASK_POLICY } from '@alpacawork/contract/task-policy';
import { controlDatabasePath } from '@alpacawork/db';
import { taskFlow } from './task-flow.fixture.ts';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { TaskTransition } from '@alpacawork/backend/test-dist/control/task-transition.js';
const human = { kind: 'human' } as const;

test('RW01–RW03 are one table for both kinds of wait', () => {
  for (const input of ['question','done','request','doing','below'] as const) {
    assert.equal(evaluate(TASK_POLICY.replyWait,{wait:'question',input}).rule,input==='below'?'RW03':'RW01');
    assert.equal(evaluate(TASK_POLICY.replyWait,{wait:'review',input}).rule,input==='done'?'RW03':'RW02');
  }
});
test('question replacement crosses recipients; a late and duplicate answer resume work through ordinary instructions; replay preserves a later question', async t => {
  const f = await taskFlow(t), top = await f.task('Top'), parent = await f.work(top);
  const child = await f.task('Child',{parentId:top.id}), owner = await f.work(child,parent);
  const q1 = await f.ask(owner,top.id), q2 = await f.ask(owner,'user');
  assert.deepEqual(openQuestions((await f.get(child.id)).meta.log).map(q=>q.id),[q2]);
  const service = new TaskRequestService(f.root);
  const input = {task:child.id,answers:q1,body:'Late ancestor answer',opId:randomUUID()};
  const actor = {kind:'placement',placementId:parent.placementId} as const;
  const caller = {kind:'run',runId:parent.runId,placementId:parent.placementId,taskId:parent.id,role:'owner',responsible:true} as const;
  const accepted = await service.request(input,actor,caller);
  assert.equal(accepted.outcome.kind,'request_accepted');
  if(accepted.outcome.kind!=='request_accepted')throw new Error('instruction expected');
  assert.equal(accepted.outcome.answers,q1);
  assert.equal(f.store(s=>s.getRequest(input.opId))!.answersQuestion,q1);
  assert.match(f.store(s=>s.getText(accepted.outcome.kind==='request_accepted'?accepted.outcome.request.runId:'R0'))!.prompt!,/reply to the withdrawn question/);
  assert.equal(openQuestions((await f.get(child.id)).meta.log).length,0);
  const q3 = await f.ask(owner,'user');
  assert.deepEqual((await service.request(input,actor,caller)).outcome,accepted.outcome);
  assert.deepEqual(openQuestions((await f.get(child.id)).meta.log).map(q=>q.id),[q3]);
  const first = await f.answer(child.id,q3);
  assert.equal(first.outcome.kind,'answered');
  assert.equal((await f.answer(child.id,q3)).outcome.kind,'request_accepted');
});
test('done withdraws only outgoing questions; a replacement or done save fault leaves the original wait intact', async t => {
  const f=await taskFlow(t), task=await f.task('Work',{userRequested:true}), owner=await f.work(task);
  const question=await f.ask(owner,'user'), before=await f.get(task.id);
  const db=new DatabaseSync(controlDatabasePath(f.root));
  try {
    db.exec("CREATE TRIGGER fail_wait BEFORE INSERT ON task_log WHEN NEW.kind='reported' BEGIN SELECT RAISE(ABORT,'wait fault'); END");
    await assert.rejects(f.report(owner,'done'));
    assert.deepEqual(await f.get(task.id),before);
    db.exec('DROP TRIGGER fail_wait');
  } finally {db.close();}
  await f.report(owner,'done');
  const after=await f.get(task.id);
  assert.equal(after.meta.baseState,'waiting');
  assert.equal(openQuestions(after.meta.log).length,0);
  assert.equal(after.meta.log.find(l=>l.questionId===question)?.kind,'question_withdrawn');
});
test('review question and owner admission return to doing immediately; hold persists and cancelling queued work never revives the old review', async t => {
  const f=await taskFlow(t), task=await f.task('Review',{userRequested:true}), owner=await f.work(task);
  await f.report(owner,'done');
  await f.person(task.id,'held');
  const q=await f.ask(owner,'user');
  assert.deepEqual([(await f.get(task.id)).meta.baseState,(await f.get(task.id)).meta.hold],['doing',true]);
  await f.withdraw(owner,q);await f.person(task.id,'doing');
  await f.report(owner,'done');f.end(owner);
  const queued=await f.request(task);
  assert.equal((await f.get(task.id)).meta.baseState,'doing');
  f.end(queued,'cancelled');
  assert.equal((await f.get(task.id)).meta.baseState,'doing');
  await assert.rejects(f.confirm(task.id,owner.runId),{code:'conflict'});
});
test('a values change below a review uses RW02 in the existing climb', async t => {
  const f=await taskFlow(t), top=await f.task('Top',{userRequested:true}), owner=await f.work(top);
  const child=await f.task('Child',{parentId:top.id}), worker=await f.work(child,owner);
  await f.report(worker,'done');f.end(worker);await f.receive(owner);
  // A finished child edit still invalidates the parent's submission.
  const head=f.store(s=>s.conversationHead(top.placementId))!;
  const seat={...owner,runId:head.id};
  await f.report(seat,'done');
  await f.commands.update({id:child.id,expectedTaskHash:(await f.get(child.id)).hash,values:{notes:'Changed result'}});
  const parent=await f.get(top.id);
  assert.equal(parent.meta.baseState,'doing');assert.equal(parent.meta.log.at(-1)?.stage?.ruleId,'RW02');
});
test('the final write invariant rolls back a bypassed second question with the entire transaction',async t=>{
  const f=await taskFlow(t), task=await f.task('Guard'), owner=await f.work(task), q=await f.ask(owner,'user');
  const before=await f.get(task.id);
  assert.throws(()=>f.store(store=>store.write(runs=>{
    const db=store.connection, uuid=String(db.prepare('SELECT id FROM tasks WHERE external_id=?').get(task.id)!.id);
    const bypass={...before.meta.log.find(l=>l.id===q)!,id:'bypassed-question'};
    db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry) SELECT ?,?,count(*),? FROM task_log WHERE task_id=?')
      .run(bypass.id,uuid,JSON.stringify(bypass),uuid);
    new TaskTransition().appendRecord({store,runs},task.id,{id:randomUUID(),kind:'reported',at:new Date().toISOString(),
      title:'Check',description:null,actor:human,fromState:null,toState:null});
  })),/Reply-wait invariant/);
  assert.deepEqual(await f.get(task.id),before);
});
test('an owner request withdraws its own question, and done still refuses a question addressed to the finishing Task',async t=>{
  const f=await taskFlow(t), parent=await f.task('Parent'), owner=await f.work(parent), q=await f.ask(owner,'user');
  await f.request(parent);
  assert.equal(openQuestions((await f.get(parent.id)).meta.log).length,0);
  assert.equal((await f.get(parent.id)).meta.log.find(l=>l.questionId===q)?.kind,'question_withdrawn');
  const child=await f.task('Child',{parentId:parent.id}), worker=await f.work(child,owner), incoming=await f.ask(worker,parent.id);
  await assert.rejects(f.report(owner,'done'),error=>error instanceof Error && 'detail' in error && JSON.stringify(error.detail).includes(incoming));
});
test('a late answer refused by ordinary admission returns the current question IDs and preserves its words for retry',async t=>{
 const f=await taskFlow(t),task=await f.task('Archive'),owner=await f.work(task);
 const old=await f.ask(owner,'user'),current=await f.ask(owner,'user');f.end(owner);
 await f.commands.lifecycle({id:task.id,action:'archive',expectedTaskHash:(await f.get(task.id)).hash});
 await assert.rejects(new TaskRequestService(f.root).request({task:task.id,answers:old,body:'Late words',opId:randomUUID()},human,human),
   error=>error instanceof Error && 'detail' in error && (error.detail as {questions:string[]}).questions.includes(current));
});
