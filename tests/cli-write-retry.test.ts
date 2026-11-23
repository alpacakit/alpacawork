/** Real CLI -> lossy HTTP proxy -> real receipt/FileJournal/authorization owners. No operation GET is synthesized. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ControlStore } from '@alpacawork/db';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { FileJournal } from '@alpacawork/backend/test-dist/control/file-journal.js';
import { readServerSettings } from '@alpacawork/backend/test-dist/server-settings.js';
import { callerWorkspace, claudeConversation, call } from './coordinator-caller.fixture.ts';
import { cliRun } from './helpers/http-cli.ts';
import { reconcileLinks } from './return-handling.fixture.ts';

const hash=(bytes: Buffer)=>createHash('sha256').update(bytes).digest('hex');
type Sent={url:string;method:string;headers:IncomingHttpHeaders;body:Buffer};
type Fault='before'|'after'|'malformed'|'none'|'partial'|'redirect';
async function proxy(t:TestContext, target:string, faults:Fault[], onRequest?:(sent:Sent,index:number)=>void|Promise<void>) {
  const sent:Sent[]=[];
  const server=createServer(async(req,res)=>{
    try {
      if(req.url==='/api/runtime/recovery'){
        const headers=new Headers();for(const [key,value] of Object.entries(req.headers))if(value!==undefined&&!['host','connection'].includes(key))headers.set(key,Array.isArray(value)?value.join(','):value);
        const upstream=await fetch(new URL(req.url,target),{headers});res.writeHead(upstream.status,{'content-type':'application/json'});res.end(await upstream.text());return;
      }
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
      const item={url:req.url!,method:req.method!,headers:req.headers,body:Buffer.concat(chunks)};
      const index=sent.push(item)-1;await onRequest?.(item,index);
      const fault=faults[index]??'none';
      if(fault==='before'){req.socket.destroy();return;}
      if(fault==='partial'){res.writeHead(200,{'content-type':'application/json'});res.end('{"errors":[{"code":"read_failed"}]}');return;}
      if(fault==='redirect'){res.writeHead(307,{location:target});res.end();return;}
      const headers=new Headers();for(const [key,value]of Object.entries(req.headers))if(value!==undefined&&!['host','connection','content-length'].includes(key))headers.set(key,Array.isArray(value)?value.join(','):value);
      const upstream=await fetch(new URL(req.url!,target),{method:req.method,headers,body:item.body.length?item.body:undefined});
      const body=Buffer.from(await upstream.arrayBuffer());
      if(fault==='after'){req.socket.destroy();return;}
      res.writeHead(upstream.status,{'content-type':'application/json'});res.end(fault==='malformed'?'{':body);
    } catch(error){if(!res.destroyed){res.writeHead(500);res.end(JSON.stringify({diagnostic:String(error)}));}}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const address=server.address();assert(address&&typeof address==='object');
  return {sent,url:`http://127.0.0.1:${address.port}`};
}
function inspect<T>(root:string, read:(db:ControlStore['connection'])=>T) {
  const store=new ControlStore(root,{busyTimeoutMs:1000},true);try{return store.read(read);}finally{store.close();}
}
const receipts=(root:string)=>inspect(root,db=>db.prepare('SELECT op_id FROM cli_operations').all());
const writes=(sent:Sent[])=>sent.filter(item=>item.method!=='GET');
const assertSame=(sent:Sent[],count:number)=>{
  assert.equal(sent.length,count);assert.equal(sent.filter(item=>item.method==='GET').length,0);
  for(const item of sent.slice(1)){assert.equal(item.url,sent[0].url);assert.equal(item.method,sent[0].method);assert.deepEqual(item.body,sent[0].body);assert.deepEqual(item.headers,sent[0].headers);}
};

for(const fault of ['before','after','malformed'] as const)test(`CLI auto ID recovers ${fault} response with one Task and one receipt`,async t=>{
  const w=callerWorkspace(t),target=await w.start(),p=await proxy(t,target,[fault]);
  const before=receipts(w.root).length;
  const result=await cliRun(p.url,['task','new','--parent',w.project,'--title','Retry task']);
  assert.equal(result.code,0,result.stderr);assert.equal(result.stderr,'');
  assert.match(String(p.sent[0].headers['x-alpacawork-op-id']),/^[0-9a-f-]{36}$/);
  assert.equal(receipts(w.root).length,before+1);
  assert.equal(inspect(w.root,db=>db.prepare("SELECT count(*) AS n FROM tasks WHERE title='Retry task'").get()!.n),1);
  assertSame(p.sent,2);
  const separate=await cliRun(p.url,['task','new','--parent',w.project,'--title','Retry task']);
  assert.equal(separate.code,0,separate.stderr);assert.notEqual(p.sent[2].headers['x-alpacawork-op-id'],p.sent[0].headers['x-alpacawork-op-id']);
  assert.equal(inspect(w.root,db=>db.prepare("SELECT count(*) AS n FROM tasks WHERE title='Retry task'").get()!.n),2);
});

test('two unreachable attempts recover on the third with the same automatically generated ID',async t=>{
  const w=callerWorkspace(t),target=await w.start(),p=await proxy(t,target,['before','before']);
  const result=await cliRun(p.url,['task','new','--parent',w.project,'--title','Third attempt']);
  assert.equal(result.code,0,result.stderr);assertSame(p.sent,3);
  assert.equal(inspect(w.root,db=>db.prepare("SELECT count(*) AS n FROM tasks WHERE title='Third attempt'").get()!.n),1);
});

test('all unreachable attempts fail with the retained ID and three-attempt recovery detail',async t=>{
  const w=callerWorkspace(t),target=await w.start(),p=await proxy(t,target,['before','before','before']);
  const result=await cliRun(p.url,['task','new','--parent',w.project,'--title','Unconfirmed']);
  assert.equal(result.code,3,result.stderr);assert.equal(result.stdout,'');assertSame(p.sent,3);
  const error=JSON.parse(result.stderr).error;
  assert.equal(error.retry,'check');assert.equal(error.detail.operation.opId,p.sent[0].headers['x-alpacawork-op-id']);
  assert.equal(error.detail.operation.attempts,3);assert.equal(error.detail.operation.server,p.url);
  assert.match(error.detail.operation.checkCommand,/operation get --op-id/);
  assert.equal(inspect(w.root,db=>db.prepare("SELECT count(*) AS n FROM tasks WHERE title='Unconfirmed'").get()!.n),0);
});

test('explicit empty operation IDs are refused before HTTP',async t=>{
  const w=callerWorkspace(t),target=await w.start(),p=await proxy(t,target,[]);
  for(const id of ['', '   ']){
    const result=await cliRun(p.url,['task','new','--parent',w.project,'--title','Empty ID','--op-id',id]);
    assert.equal(result.code,2,result.stderr);assert.equal(JSON.parse(result.stderr).error.code,'invalid_input');
  }
  assert.equal(p.sent.length,0);
});

test('stdin and local document bytes/hash are frozen across a lost response',async t=>{
  const w=callerWorkspace(t),target=await w.start();
  const task=(await call(target,['task','new','--parent',w.project,'--title','Input snapshot'])).task;
  for(const source of ['-','file']){
    const path=w.file('values.json','{"notes":"original file"}');
    const p=await proxy(t,target,['after'],()=>{writeFileSync(path,'{"notes":"changed between attempts"}');});
    const current=(await call(target,['task','get','--task',task.id])).task;
    const result=await cliRun(p.url,['task','update','--task',task.id,'--values-file',source==='-'?'-':path,'--expected-task-hash',current.hash],{},'{"notes":"original stdin"}');
    assert.equal(result.code,0,result.stderr);assertSame(p.sent,2);
    const body=JSON.parse(p.sent[0].body.toString());assert.equal(body.expectedTaskHash,current.hash);
    assert.deepEqual(body.values,{notes:source==='-'?'original stdin':'original file'});
    assert.deepEqual(JSON.parse(result.stdout).task.values,body.values);
  }
});

for(const kind of ['file','attachment']as const)test(`${kind} upload keeps exact bytes/digest after source changes and lost response`,async t=>{
  const w=callerWorkspace(t),target=await w.start();
  const task=(await call(target,['task','new','--parent',w.project,'--title','Upload'])).task;
  const path=w.file('upload.bin','original bytes'),original=readFileSync(path);
  const p=await proxy(t,target,['after'],()=>{writeFileSync(path,'new bytes');});
  const args=kind==='file'?['file','put','--path','work/result.bin']:['attachment','put','--request-id','draft','--name','result.bin'];
  const result=await cliRun(p.url,['task',...args,'--task',task.id,'--file',path]);
  assert.equal(result.code,0,result.stderr);assertSame(p.sent,2);assert.deepEqual(p.sent[0].body,original);
  assert.equal(p.sent[0].headers['x-alpacawork-content-digest'],kind==='file'?hash(original):undefined);
  assert.equal(new FileJournal(w.root).operationGet(String(p.sent[0].headers['x-alpacawork-op-id'])).state,'committed');
});

for(const changed of [false,true])test(`config ${changed?'change':'no-op'} lost response replays once`,async t=>{
  const w=callerWorkspace(t),target=await w.start();
  const settings=await readServerSettings(w.root);
  const p=await proxy(t,target,['after']);
  const args=['config','set','--agents',settings.agentsText,'--expected-config-hash',settings.hash!,'--config',`limits: ${JSON.stringify({...settings.limits,parallel:settings.limits.parallel+(changed?1:0)})}`];
  const before=receipts(w.root).length,result=await cliRun(p.url,args);
  assert.equal(result.code,0,result.stderr);assertSame(p.sent,2);assert.equal(receipts(w.root).length,before+1);
  assert.equal((await readServerSettings(w.root)).limits.parallel,settings.limits.parallel+(changed?1:0));
});

test('initial partial success and redirect do not resend',async t=>{
  const w=callerWorkspace(t),target=await w.start();
  for(const [fault,code]of [['partial',4],['redirect',2]]as const){
    const p=await proxy(t,target,[fault]);
    const result=await cliRun(p.url,['task','new','--parent',w.project,'--title','Unsent']);
    assert.equal(result.code,code,result.stderr);assert.equal(p.sent.length,1);
  }
});

test('a real screen authorization refusal makes one request and keeps one Problem snapshot', async t => {
  const w = callerWorkspace(t);
  const task = (await new ControlTaskCommands(w.root, { kind: 'human' }).create({ parentId: w.project,
    userRequested: true, tasks: [{ title: 'Refused report' }] })).tasks[0];
  const screen = w.screenRun({ words: `Report ${task.id}`, session: 'refused-screen' });
  const target = await w.start(); await w.startScreenRun(target, screen);
  const before = inspect(w.root, db => db.prepare('SELECT count(*) AS n FROM coordinator_refusals').get()!.n);
  const p = await proxy(t, target, []);
  const result = await cliRun(p.url, ['task', 'report', '--task', task.id, '--state', 'doing',
    '--expected-task-hash', task.hash], claudeConversation('refused-screen'));
  assert.equal(result.code, 2, result.stderr); assert.equal(JSON.parse(result.stderr).error.retry, 'fix');
  assert.equal(p.sent.length, 1);
  assert.equal(inspect(w.root, db => db.prepare('SELECT count(*) AS n FROM coordinator_refusals').get()!.n), Number(before) + 1);
});

test('explicit ID with different input is 409; CLI never fetches an unrelated old success',async t=>{
  const w=callerWorkspace(t),target=await w.start(),p=await proxy(t,target,[]),id=randomUUID();
  const args=['task','new','--parent',w.project,'--title','First','--op-id',id];
  const first=await cliRun(p.url,args);assert.equal(first.code,0,first.stderr);
  const second=await cliRun(p.url,[...args.slice(0,-3),'Second','--op-id',id]);
  assert.equal(second.code,2,second.stderr);assert.equal(JSON.parse(second.stderr).error.code,'idempotency_conflict');
  assert.equal(p.sent.length,1);assert.equal(writes(p.sent).length,1); // The durable local pin rejects changed input before another HTTP request.
});

test('run stop after lost response records one stop and replays its receipt',async t=>{
  const w=callerWorkspace(t);
  const task=(await new ControlTaskCommands(w.root,{kind:'human'}).create({parentId:w.project,userRequested:null,tasks:[{title:'Stop'}]})).tasks[0];
  const {assignResponsible}=await import('./helpers/control-fixture.ts');
  const placement=await assignResponsible(w.root,task,'codex');
  const held=w.heldRun({task:task.id,placementId:placement.id,attempt:true});
  const target=await w.start(),p=await proxy(t,target,['after']),before=receipts(w.root).length;
  const result=await cliRun(p.url,['run','stop','--run',held.id]);
  assert.equal(result.code,0,result.stderr);assertSame(p.sent,2);assert.equal(receipts(w.root).length,before+1);
  assert.deepEqual(JSON.parse(result.stdout).stop_requested,[held.id]);
  assert.equal(inspect(w.root,db=>db.prepare("SELECT count(*) AS n FROM run_commands WHERE type='stop'").get()!.n),1);
  assert.equal(inspect(w.root,db=>db.prepare("SELECT count(*) AS n FROM task_log WHERE kind='run_stop_requested'").get()!.n),1);
});

test('the same report ID from another active Run conflicts instead of replaying old success',async t=>{
  const w=callerWorkspace(t);
  const task=(await new ControlTaskCommands(w.root,{kind:'human'}).create({parentId:w.project,userRequested:null,tasks:[{title:'Report identity'}]})).tasks[0];
  const {assignResponsible}=await import('./helpers/control-fixture.ts');
  const {PlacementStore}=await import('@alpacawork/backend/test-dist/control/placements.js');
  const owner=await assignResponsible(w.root,task,'codex');
  const people=new PlacementStore(w.root);let member;
  try{member=people.createAndPlace({taskId:task.id,profileKey:'codex',responsible:false}).placement;}finally{people.close();}
  const a=w.heldRun({task:task.id,placementId:owner.id}),b=w.heldRun({task:task.id,placementId:member.id,role:'worker'});
  // Import the fixture Run's start before reading the version the CLI will report against.
  // Otherwise the first periodic pass can change that hash between the GET and this report.
  reconcileLinks(w.root,w.project);
  const target=await w.start(),current=(await call(target,['task','get','--task',task.id])).task;
  assert.equal(current.state,'doing');
  const args=['task','report','--task',task.id,'--state','doing','--title','Working','--expected-task-hash',current.hash,'--op-id',randomUUID()];
  const first=await cliRun(target,args,a.env);assert.equal(first.code,0,first.stderr);
  const p=await proxy(t,target,[]),second=await cliRun(p.url,args,b.env);
  assert.equal(second.code,2,second.stderr);assert.equal(JSON.parse(second.stderr).error.code,'idempotency_conflict');assert.equal(p.sent.length,1);
});

test('a real CLI timeout while the first transaction commits late still creates one Task and receipt', {timeout:60_000}, async t=>{
  const w=callerWorkspace(t),target=await w.start();
  const original=ControlTaskCommands.prototype.create;let entered=0, released=false;
  let release!:()=>void, deadline:ReturnType<typeof setTimeout>;
  const retried=new Promise<void>((resolve,reject)=>{
    deadline=setTimeout(()=>reject(new Error('CLI did not resend while the first transaction waited')),45_000);
    release=()=>{clearTimeout(deadline);resolve();};
  });
  t.after(()=>{clearTimeout(deadline);release();});
  t.mock.method(ControlTaskCommands.prototype,'create',async function(...args:Parameters<typeof original>){
    if(++entered===1)await retried;
    released=true;return original.apply(this,args);
  });
  let backendRequests=0;
  const arrived=(request:import('node:http').IncomingMessage)=>{
    if(request.url==='/api/commands/task/new'&&++backendRequests===2){
      assert.equal(released,false,'the backend receives the retry before the first transaction commits');
      release();
    }
  };
  w.httpServer!.on('request',arrived);t.after(()=>w.httpServer?.off('request',arrived));
  const p=await proxy(t,target,[]),before=receipts(w.root).length;
  // The 30-second budget and its schedule are write-attempt.test.ts's. Only the real first POST gives up sooner here;
  // the recovery identity GET before it keeps its own budget.
  const shorter=w.file('first-attempt-gives-up-sooner.mjs',`const send=globalThis.fetch;let first=true;
globalThis.fetch=(url,init={})=>{if(first&&init.method==='POST'){first=false;init={...init,signal:AbortSignal.any([init.signal,AbortSignal.timeout(1500)].filter(Boolean))};}return send(url,init);};\n`);
  const result=await cliRun(p.url,['task','new','--parent',w.project,'--title','Late commit'],{NODE_OPTIONS:`${process.env.NODE_OPTIONS??''} --import=${shorter}`});
  assert.equal(result.code,0,result.stderr);assertSame(p.sent,2);assert.equal(backendRequests,2);assert.equal(entered,1,'replay does not call create');
  assert.equal(receipts(w.root).length,before+1);
  assert.equal(inspect(w.root,db=>db.prepare("SELECT count(*) AS n FROM tasks WHERE title='Late commit'").get()!.n),1);
});

for(const corruption of ['unsupported','extra','null','broken'] as const)test(`CLI keeps a ${corruption} saved pin and sends nothing`,async t=>{
 const w=callerWorkspace(t),target=await w.start(),p=await proxy(t,target,[]),state=join(w.root,'isolated-state'),op=randomUUID();
 const args=['task','new','--parent',w.project,'--title','Strict saved restore pin','--op-id',op];
 const first=await cliRun(p.url,args,{XDG_STATE_HOME:state});assert.equal(first.code,0,first.stderr);assert.equal(writes(p.sent).length,1);
 const pin=join(state,'alpacawork/write-pins',createHash('sha256').update(p.url).digest('hex'),createHash('sha256').update(op).digest('hex')+'.json');
 const original=JSON.parse(readFileSync(pin,'utf8'));
 const raw=corruption==='broken'?'{bad':JSON.stringify(corruption==='extra'?{...original,extra:true}:{...original,restoreId:corruption==='null'?null:'unsupported'});
 writeFileSync(pin,raw);const beforeReceipts=receipts(w.root).length,beforeSent=p.sent.length;
 const refused=await cliRun(p.url,args,{XDG_STATE_HOME:state});assert.notEqual(refused.code,0);assert.equal(p.sent.length,beforeSent);
 assert.equal(receipts(w.root).length,beforeReceipts);assert.equal(readFileSync(pin,'utf8'),raw);
 const current=await cliRun(p.url,['task','get','--task',w.project],{XDG_STATE_HOME:state});assert.equal(current.code,0,current.stderr);
});

test('a repeated file operation keeps its byte and expected-digest input while caller claims stay server-owned', async t => {
  const w = callerWorkspace(t), target = await w.start(), p = await proxy(t, target, []), op = randomUUID();
  const task = (await new ControlTaskCommands(w.root, { kind: 'human' }).create({ parentId: w.project,
    userRequested: true, tasks: [{ title: 'Pinned file precondition' }] })).tasks[0];
  const source = w.file('same-file-input.txt', 'same bytes');
  const args = ['task', 'file', 'put', '--task', task.id, '--path', 'same.txt', '--file', source, '--op-id', op];
  const first = await cliRun(p.url, args); assert.equal(first.code, 0, first.stderr);
  const changed = await cliRun(p.url, [...args, '--expected-digest', 'a'.repeat(64)]);
  assert.equal(changed.code, 2, changed.stderr);
  assert.equal(JSON.parse(changed.stderr).error.code, 'idempotency_conflict');
  assert.equal(p.sent.length, 1, 'changed operation preconditions are rejected before a second HTTP write');
});
