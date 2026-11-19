import { CLI_CONTRACT, CONTRACT_HEADER } from '@alpacawork/contract/client-contract';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { attemptOf, commandOf, enqueueCommand, StopDeliveryOwner } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { executionFolder } from '@alpacawork/backend/test-dist/runs/execution-files.js';
import { requestStop } from '@alpacawork/backend/test-dist/runs/entry.js';
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { setup, until } from './runs-runtime.fixture.ts';
import { cliRun } from './helpers/http-cli.ts';

async function call(url: string, path: string, body?: unknown, op?: string) {
  const response = await fetch(new URL('/api/'+path,url),{method:body===undefined?'GET':'POST',headers:{
    ...(body===undefined?{}:{'Content-Type':'application/json'}),...(op?{'X-Alpacawork-Client':'cli', [CONTRACT_HEADER]: String(CLI_CONTRACT),'X-Alpacawork-Op-Id':op}:{})},
    body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
}
test('stop HTTP, operation replay and query share the all-target publication gate',async t=>{
  const h=await setup(t),parent=h.create('plain',{gate:h.gate('hold')}),child=h.create('plain',{gate:h.gate('child')},{role:'worker',placementId:h.memberPlacementId,caller:{run:parent.id}});
  await h.tick();await h.ready(parent);await h.ready(child);h.pauseProjection();
  const launch=attemptOf(h.store,child.id)!,path=executionFolder(h.root,child.id,launch.attemptId),commands=join(path,'commands');
  writeFileSync(commands,'blocked',{mode:0o600});
  const app=await startServer(h.root,0),op=randomUUID();
  try{
    const first=await call(app.url,'run/stop',{run:parent.id},op);
    assert.equal(first.status,503);assert.equal(first.body.error.detail.state,'committed_pending_delivery');
    assert.equal(h.store.get(parent.id)!.stop_requested,true);assert.equal(h.store.get(child.id)!.stop_requested,true);
    const rows=h.store.connection.prepare("SELECT c.*,a.run_no,a.launch_json FROM run_commands c JOIN run_attempts a USING(attempt_id) WHERE type='stop' ORDER BY command_id").all().map(row=>({command_id:row.command_id,json:JSON.stringify(commandOf(row))}));assert.equal(rows.length,2);
    const receipt=()=>h.store.connection.prepare('SELECT status,response_json FROM cli_operations WHERE op_id=?').get(op);
    const saved=receipt();assert.equal(saved!.status,200,'the stop intent and immutable receipt are committed');
    const again=await call(app.url,'run/stop',{run:parent.id},op);
    assert.equal(again.status,503);assert.equal(again.body.error.retry,'check');
    assert.equal(again.body.error.detail.state,'committed_pending_delivery');
    const cli=await cliRun(app.url,['run','stop','--run',parent.id,'--op-id',op]);
    assert.equal(cli.code,3,cli.stdout+cli.stderr);assert.match(cli.stdout+cli.stderr,/committed_pending_delivery/);
    const query=await call(app.url,'operation/get?opId='+op);assert.equal(query.status,503,'a saved 200 is not observable before delivery');
    assert.equal(query.body.error.detail.state,'committed_pending_delivery');
    assert.deepEqual(receipt(),saved,'faults and replay never rewrite a committed response');
    const task=(await call(app.url,'task/get?task='+h.taskId)).body.task,taskOp=randomUUID();
    const updated=await call(app.url,'task/update',{task:h.taskId,title:'Saved during stop publication fault',expectedTaskHash:task.hash},taskOp);
    assert.equal(updated.status,200,'Task save success does not promise stop publication');
    const taskQuery=await call(app.url,'operation/get?opId='+taskOp);assert.equal(taskQuery.status,200);
    assert.equal(taskQuery.body.body.task.title,'Saved during stop publication fault');
    rmSync(commands);mkdirSync(commands,{mode:0o700});
    const replay=await call(app.url,'run/stop',{run:parent.id},op);assert.equal(replay.status,200,JSON.stringify(replay.body));
    assert.deepEqual(receipt(),saved);assert.deepEqual(replay.body,JSON.parse(String(saved!.response_json)));
    const recoveredCli=await cliRun(app.url,['run','stop','--run',parent.id,'--op-id',op]);assert.equal(recoveredCli.code,0,recoveredCli.stderr);
    assert.deepEqual(h.store.connection.prepare("SELECT c.*,a.run_no,a.launch_json FROM run_commands c JOIN run_attempts a USING(attempt_id) WHERE type='stop' ORDER BY command_id").all().map(row=>({command_id:row.command_id,json:JSON.stringify(commandOf(row))})),rows,'replay does not allocate new commands');
    for(const run of[parent,child]){const launch=attemptOf(h.store,run.id)!;const path=join(executionFolder(h.root,run.id,launch.attemptId),'commands');assert.ok(readdirSync(path).some(name=>JSON.parse(readFileSync(join(path,name),'utf8')).type==='stop'));}
    const after=await call(app.url,'operation/get?opId='+op);assert.equal(after.status,200);assert.equal(after.body.state,'committed');
    assert.equal((await call(app.url,'runtime/quiesce',{})).status,200);
    assert.equal((await call(app.url,'run/stop',{run:parent.id},randomUUID())).status,503,'new mutations are not admitted after drained');
  }finally{rmSync(commands,{force:true,recursive:true});mkdirSync(commands,{mode:0o700});await app.close();}
});

test('a missing earlier input and its receipt wait do not block a later durable stop',async t=>{
  const h=await setup(t),run=h.create('plain',{gate:h.gate('priority')});await h.tick();await h.ready(run);h.pauseProjection();
  const launch=attemptOf(h.store,run.id)!;
  h.store.write(()=>enqueueCommand(h.store,launch,{type:'input',inputId:randomUUID(),instructionRunId:run.id,text:'unpublished input'}));
  requestStop(h.root,{run:run.id});new StopDeliveryOwner(h.store).gate();
  const path=join(executionFolder(h.root,run.id,launch.attemptId),'commands');
  assert.equal(readdirSync(path).includes('000000000001.json'),false);assert.equal(readdirSync(path).includes('000000000002.json'),true);
  await until(() => { new RunEventImporter(h.store).pass(); return h.store.get(run.id)?.state === 'cancelled'; }, 'priority stop completed');
  assert.ok(h.store.get(run.id)!.ended_at);
});
