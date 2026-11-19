import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { ControlStore } from '@alpacawork/db';
import { Problem } from '@alpacawork/core';
import { FileJournal, requirePublished, fileDigest } from '@alpacawork/backend/test-dist/control/file-journal.js';
import { saveServerSettings, readServerSettings } from '@alpacawork/backend/test-dist/server-settings.js';
import { parseInput } from '@alpacawork/core';
import { configSetInput } from '@alpacawork/contract/inputs';
import { callerWorkspace, call } from './coordinator-caller.fixture.ts';
import { cliRun } from './helpers/http-cli.ts';

for(const state of ['pending','needs_review']as const)test(`requirePublished maps own ${state} to its unique 503/check code`,()=>{
  assert.throws(()=>requirePublished({state}),error=>{
    assert(error instanceof Problem);assert.equal(error.code,state==='pending'?'publication_pending':'publication_needs_review');
    assert.equal(error.status,503);assert.equal(error.retry,'check');assert.equal(error.reason?.kind,error.code);return true;
  });
  const published={state:'published' as const,status:200,body:{saved:true},replayed:true};
  requirePublished(published);assert.deepEqual(published.body,{saved:true});
});

for(const state of ['pending','needs_review']as const)test(`CLI own file ${state}: exit3, bounded writes, no automatic GET and one durable intent`,async t=>{
  const w=callerWorkspace(t);
  const taskId=(await import('@alpacawork/backend/test-dist/control/task-commands.js')).ControlTaskCommands;
  const task=(await new taskId(w.root,{kind:'human'}).create({parentId:w.project,userRequested:null,tasks:[{title:'Publication'}]})).tasks[0];
  const bytes=Buffer.from('reserved bytes'),id=randomUUID(),file=w.file('input.txt',bytes.toString()),name='work/retry.txt';
  assert.throws(()=>new FileJournal(w.root,phase=>{if(phase==='reserved')throw new Error('interrupted');}).putTaskFile({
    task:task.id,name,opId:id,bytes,result:{path:name,bytes:bytes.length,digest:fileDigest(bytes)},grant:()=>({task:task.id,actor:{kind:'human'}}),
  }),/interrupted/);
  if(state==='needs_review'){
    const store=new ControlStore(w.root);try{
      const stage=store.connection.prepare('SELECT stage_path FROM file_operations WHERE op_id=?').get(id)!.stage_path;
      rmSync(join(w.root,String(stage)));
    }finally{store.close();}
    assert.equal(new FileJournal(w.root).recover().needsReview,1);
  }
  const recover=t.mock.method(FileJournal.prototype,'recover',()=>({published:0,needsReview:0}));
  const url=await w.start(),seen:string[]=[];
  // Observe the actual formal file endpoint through the journal owner; no fake FileOutcome is returned.
  const original=FileJournal.prototype.putTaskFile;
  t.mock.method(FileJournal.prototype,'putTaskFile',function(...args:Parameters<typeof original>){seen.push(args[0].opId);return original.apply(this,args);});
  let operationGets=0;const get=FileJournal.prototype.operationGet;
  t.mock.method(FileJournal.prototype,'operationGet',function(...args:Parameters<typeof get>){operationGets++;return get.apply(this,args);});
  const args=['task','file','put','--task',task.id,'--path',name,'--file',file,'--op-id',id];
  const result=await cliRun(url,args);assert.equal(result.code,3,result.stderr);
  const error=JSON.parse(result.stderr).error;assert.equal(error.code,state==='pending'?'publication_pending':'publication_needs_review');
  const count=state==='pending'?3:1;assert.equal(error.detail.operation.attempts,count);assert.deepEqual(seen,Array(count).fill(id));assert.equal(operationGets,0);
  const store=new ControlStore(w.root,{busyTimeoutMs:1000},true);try{
    assert.equal(store.connection.prepare('SELECT count(*) AS n FROM file_operations WHERE op_id=?').get(id)!.n,1);
  }finally{store.close();}
  if(state==='pending'){
    recover.mock.restore();assert.equal(new FileJournal(w.root).recover().published,1);
    const saved=await cliRun(url,args);assert.equal(saved.code,0,saved.stderr);
    assert.equal(JSON.parse(saved.stdout).digest,fileDigest(bytes));
  }
});

test('CLI config own pending has check semantics while other config writes remain ordinary busy',async t=>{
  const w=callerWorkspace(t),before=await readServerSettings(w.root),id=randomUUID();
  const config=`limits: ${JSON.stringify({...before.limits,parallel:before.limits.parallel+1})}`;
  const input=parseInput(configSetInput,{config,agents:before.agentsText,expectedConfigHash:before.hash});
  const put=FileJournal.prototype.putConfig;
  const fail=t.mock.method(FileJournal.prototype,'putConfig',function(...args:Parameters<typeof put>){
    return put.apply(new FileJournal(this.root,phase=>{if(phase==='reserved')throw new Error('interrupted');}),args);
  });
  await assert.rejects(saveServerSettings(w.root,input,id));fail.mock.restore();
  t.mock.method(FileJournal.prototype,'recover',()=>({published:0,needsReview:0}));
  const url=await w.start();
  const args=['config','set','--config',config,'--agents',before.agentsText,'--expected-config-hash',before.hash!];
  const own=await cliRun(url,[...args,'--op-id',id]);assert.equal(own.code,3,own.stderr);
  assert.equal(JSON.parse(own.stderr).error.code,'publication_pending');assert.equal(JSON.parse(own.stderr).error.detail.operation.attempts,3);
  const other=await cliRun(url,[...args,'--op-id',randomUUID()]);assert.equal(other.code,2,other.stderr);
  assert.equal(JSON.parse(other.stderr).error.retry,'later');assert.equal(JSON.parse(other.stderr).error.detail.operation.attempts,1);
});
