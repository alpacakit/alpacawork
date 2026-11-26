/** Spawned by the receipt test: actual CLI/HTTP writes and resultsOf, no invented effect records. */
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { callerWorkspace,call,claudeConversation } from '../coordinator-caller.fixture.ts';
import { controlDatabasePath } from '@alpacawork/db';
// This fixture drives Run lifecycles itself. No real agent owns these Runs, so the production
// interval must not recover or launch them between a version read and a CLI write.
await test('reply-wait-receipts', async t => {
t.mock.timers.enable({apis:['setInterval']});
const deadline=setTimeout(()=>{console.error('receipt fixture deadline');process.exit(1);},80_000);
deadline.unref();
console.error('receipt fixture lease '+JSON.stringify({pid:process.pid,deadline:new Date(Date.now()+80_000).toISOString()}));
t.after(()=>clearTimeout(deadline));
const w=callerWorkspace(t);
const {resultsOf}=await import('@alpacawork/backend/test-dist/coordinator/messages.js');
const {TaskReportService}=await import('@alpacawork/backend/test-dist/control/report.js');
const {TaskRequestService}=await import('@alpacawork/backend/test-dist/control/task-request.js');
const {ControlTaskStore}=await import('@alpacawork/backend/test-dist/control/task-store.js');
const {assignResponsible}=await import('../helpers/control-fixture.ts');
const {ControlTaskCommands}=await import('@alpacawork/backend/test-dist/control/task-commands.js');
const {RunStore}=await import('@alpacawork/runs');
const {RunEventImporter}=await import('@alpacawork/backend/test-dist/runs/event-importer.js');
const {reconcileLinks}=await import('../return-handling.fixture.ts');
const {issueRunCredential}=await import('@alpacawork/backend/test-dist/control/credentials.js');
const human={kind:'human'};
 const head=w.screenRun({words:'Decide the next work',session:'receipt-screen'});
 w.journal(head);const imported=new RunStore(w.root,{busyTimeoutMs:1000});
 try {new RunEventImporter(imported).pass();} finally {imported.close();}
 const url=await w.start();
 const commands=new ControlTaskCommands(w.root,human), task=(await commands.create({parentId:w.project,userRequested:true,tasks:[{title:'Receipt',values:{decide:[{decide_kind:'choose',decide_question:'Choose',decide_choices:[{decide_choice:'A'},{decide_choice:'B'}]}]}}]})).tasks[0];
 const placement=await assignResponsible(w.root,task,'claude'),store=new RunStore(w.root,{busyTimeoutMs:1000}),tasks=new ControlTaskStore(w.root);
 // A manually driven boundary includes its Task transition before a command reads that Task's hash.
 // Freezing the scheduler interval does not freeze ChangeLog-driven routing.
 const runBoundary=write=>{store.write(write);reconcileLinks(w.root,w.project);};
 const initial=await new TaskRequestService(w.root).request({task:task.id,body:'Work',opId:randomUUID(),expectedTaskHash:(await tasks.get(task.id)).hash,expectedPlacementRevision:placement.revision},human,human);
 const owner=initial.outcome.request.runId;
 runBoundary(tx=>tx.update({...tx.get(owner),state:'running',started_at:new Date().toISOString()}));
 const report=new TaskReportService(w.root);
 const ownerEnv={ALPACAWORK_RUN:owner,ALPACAWORK_RUN_TOKEN:issueRunCredential(w.root,owner)};
 const ask=async()=>{const id=randomUUID();await call(url,['task','report','--task',task.id,'--state','waiting','--ask-to','user','--title','Choose','--description-file','-','--op-id',id,'--expected-task-hash',(await tasks.get(task.id)).hash],ownerEnv,'A or B');return id;};
 const detail=async()=>{const response=await fetch(new URL(`/api/task/view?task=${task.id}`,url));if(!response.ok)throw new Error(await response.text());return response.json();};
 const q1=await ask(),q2=await ask();
 const replacedView=await detail();
 const env=claudeConversation('receipt-screen');
 const late=await call(url,['task','request','--task',task.id,'--answers',q1,'--instruction-file','-'],env,'Late words');
 const db=new DatabaseSync(controlDatabasePath(w.root));
 const take=()=>resultsOf(db,[head.requestId]).get(head.requestId);
 const lateResult=take();
 const fresh=await ask();
 await call(url,['task','request','--task',task.id,'--answers',fresh,'--instruction-file','-'],env,'Answer words');
 const answerResult=take();
 const answeredView=await detail();
 const reviewTask=(await commands.create({parentId:w.project,userRequested:true,tasks:[{title:'Review receipt'}]})).tasks[0];
 const reviewPlacement=await assignResponsible(w.root,reviewTask,'claude');
 const reviewStart=await new TaskRequestService(w.root).request({task:reviewTask.id,body:'Work',opId:randomUUID(),expectedTaskHash:(await tasks.get(reviewTask.id)).hash,expectedPlacementRevision:reviewPlacement.revision},human,human);
 const reviewRun=reviewStart.outcome.request.runId;
 runBoundary(tx=>tx.update({...tx.get(reviewRun),state:'running',started_at:new Date().toISOString()}));
 await report.report({task:reviewTask.id,state:'done',title:'Ready', description: 'The result is ready for review.',opId:randomUUID(),expectedTaskHash:(await tasks.get(reviewTask.id)).hash},
   {kind:'placement',placementId:reviewPlacement.id},{kind:'run',runId:reviewRun,placementId:reviewPlacement.id,taskId:reviewTask.id,role:'owner',responsible:true});
 runBoundary(tx=>tx.finish({...tx.get(reviewRun),state:'succeeded',ended_at:new Date().toISOString()},{state:'present',text:'Ready'}));
 const sendback=await call(url,['task','request','--task',reviewTask.id,'--instruction-file','-','--expected-task-hash',(await tasks.get(reviewTask.id)).hash,'--expected-placement-revision',String(reviewPlacement.revision)],env,'Revise this');
 const sendbackResult=take();
 // Actual refusal from an expired question, recorded by the normal CLI operation owner.
 const q3=await ask();await call(url,['task','report','--task',task.id,'--state','stopped','--expected-task-hash',(await tasks.get(task.id)).hash],env);
 try {await call(url,['task','request','--task',task.id,'--answers',q3,'--instruction-file','-'],env,'Expired words');}catch{}
 const refused=take();
 const expiredView=await detail();
 const index=await (await fetch(new URL('/api/workspace/live',url))).json();
 console.log('REPLY_WAIT_RECEIPTS '+JSON.stringify({index,task:task.id,q1,q2,q3,fresh,replacedView,answeredView,expiredView,late:late.outcome,lateResult,answerResult,reviewTask:reviewTask.id,sendback:sendback.outcome,sendbackResult,refused}));
 db.close();store.close();
});
