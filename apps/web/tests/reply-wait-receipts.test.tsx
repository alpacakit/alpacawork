/** Real backend write kinds pass through the same receipt matcher that settles the outbox. */
import { beforeAll, afterEach, test, expect, vi } from 'vitest';
import { taskProjectedViewSchema } from '@alpacawork/contract/control';
import { receiveFullIndex } from '../src/data/resources';
import { queryClient } from '../src/data/query-client';
import { useConnection } from '../src/data/connection';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readerResult } from '../src/features/reader/submission';
import { coordinatorResultSchema } from '@alpacawork/contract/coordinator';

let data: ReturnType<typeof JSON.parse>;
beforeAll(()=>{
  const run=spawnSync(process.execPath,['tests/fixtures/reply-wait-receipts.mjs'],{
    cwd:resolve(import.meta.dirname,'../../..'),encoding:'utf8',timeout:90_000});
  expect(run.status,run.stderr+'\n'+run.stdout).toBe(0);
  data=JSON.parse(run.stdout.split('\n').find(line=>line.startsWith('REPLY_WAIT_RECEIPTS '))!.slice('REPLY_WAIT_RECEIPTS '.length));
},100_000);
afterEach(()=>{vi.restoreAllMocks();queryClient.clear();});

test('late answers, open answers, send-back and a refusal are matched from real CLI/HTTP effects',()=>{
  expect(data.late.kind).toBe('request_accepted');expect(data.late.answers).toBe(data.q1);
  const answer={kind:'answer' as const,taskId:data.task,expectedWrites:null};
  expect(readerResult(answer,coordinatorResultSchema.parse(data.lateResult)).status).toBe('confirmed');
  expect(readerResult({...answer,expectedWrites:[{kind:'answered',question:data.fresh}]},coordinatorResultSchema.parse(data.answerResult)).status).toBe('confirmed');
  expect(data.sendback.kind).toBe('request_accepted');
  expect(data.refused.refused).toEqual([expect.objectContaining({code:'question_expired',task:data.task})]);
  expect(readerResult({kind:'intent',taskId:data.reviewTask,expectedWrites:[{kind:'request_accepted'}]},coordinatorResultSchema.parse(data.sendbackResult)).status).toBe('confirmed');
  expect(readerResult(answer,coordinatorResultSchema.parse(data.refused)).status).toBe('confirmed');
  // Choices identify context; only an explicit operation needs an effect record.
  expect(readerResult(answer,{writes:[],refused:[]}).status).toBe('confirmed');
  expect(readerResult({kind:'intent',taskId:data.reviewTask,expectedWrites:[{kind:'request_accepted'}]},{writes:[],refused:[]}).status).toBe('refused');
},100_000);

// The payloads below come from the actual HTTP task/view route above. Only transport is stubbed
// after the fixture process closes; no TaskView is constructed in this test.
test('HTTP detail keeps what each question fixed across replacement, answering and expiry',async()=>{
  queryClient.clear();
  receiveFullIndex(queryClient,data.index);
  useConnection.setState({state:'live',offline:false});
  const replaced=taskProjectedViewSchema.parse(data.replacedView), answered=taskProjectedViewSchema.parse(data.answeredView), expired=taskProjectedViewSchema.parse(data.expiredView);
  expect(replaced.questions?.map(q=>[q.id,q.state])).toEqual([[data.q1,'withdrawn'],[data.q2,'open']]);
  expect(answered.questions?.map(q=>[q.id,q.state])).toEqual([[data.q1,'withdrawn'],[data.q2,'withdrawn'],[data.fresh,'answered']]);
  expect(expired.questions?.map(q=>[q.id,q.state])).toEqual([[data.q1,'withdrawn'],[data.q2,'withdrawn'],[data.fresh,'answered'],[data.q3,'expired']]);
  for(const view of [replaced,answered,expired]) {
    expect(view.questions).not.toBeNull();
    for(const question of view.questions!) expect(question.decide).toEqual([{decide_kind:'choose',decide_question:'Choose',decide_choices:[{decide_choice:'A'},{decide_choice:'B'}]}]);
  }
});
