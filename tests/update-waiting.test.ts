/** Same FORMAT/DB updates keep a real synthetic Run alive and import its natural completion. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parse, stringify } from 'yaml';
import { fixtureAgentSetting, installAgentStub } from './helpers/agent-stub.ts';
import { managedUpdateFixture } from './helpers/managed-update.ts';
import { simpleUpdateCandidate } from './helpers/simple-update-candidate.ts';
const ok=(r:any)=>{assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
async function until(read:()=>Promise<any>,accept:(value:any)=>boolean):Promise<any>{let last:unknown;for(const end=Date.now()+120000;Date.now()<end;){try{last=await read();if(accept(last))return last;}catch(error){last=String(error);}await delay(50);}throw new Error('Timed out: '+JSON.stringify(last));}
test('formal HTTP switches the same FORMAT and DB while an existing Run keeps working', { skip: process.platform !== 'linux' && 'GNU tar --transform and a linux-x64-glibc fixture image', timeout:240000}, async t=>{
 const f=await managedUpdateFixture(t);await simpleUpdateCandidate(t,f);
 const gate=join(f.root,'run-finished'),started=join(f.root,'run-started'),agent=join(f.root,'synthetic-agent.mjs');
 writeFileSync(agent,`import{existsSync,writeFileSync}from'node:fs';import{setTimeout as delay}from'node:timers/promises';writeFileSync(${JSON.stringify(started)},String(process.pid));for(const end=Date.now()+120000;Date.now()<end&&!existsSync(${JSON.stringify(gate)});)await delay(25);console.log('Synthetic Run finished');`);
 const file=join(f.workspace,'config.yaml'),config=parse(readFileSync(file,'utf8'));config.agents.synthetic=fixtureAgentSetting('claude');writeFileSync(file,stringify(config));
 const preload=join(f.root,'agent-path.mjs');writeFileSync(preload,'process.env.PATH='+JSON.stringify(installAgentStub(f.root,'claude',[process.execPath,agent]))+';');
 await f.start(f.workspace,[preload]);
 const act=(path:string,body:any)=>f.call(path,body,{'X-Alpacawork-Op-Id':randomUUID(),'X-Alpacawork-Restore-Id':'initial'});
 const task=ok(await act('/api/commands/task/new',{parent:'P1',title:'Synthetic update wait',fromUser:false})).task;
 const assigned=ok(await act('/api/commands/agent/assign',{task:task.id,role:'responsible',profile:'synthetic',expectedTaskHash:task.hash}));
 ok(await act('/api/commands/task/request',{task:task.id,instruction:'Wait for the local fixture gate',expectedTaskHash:assigned.task.hash,expectedPlacementRevision:assigned.agent.placement.revision}));
 await until(async()=>existsSync(started),Boolean);
 const status=async()=>ok(await f.call('/api/update/status')),available=await until(status,s=>s.kind==='available');
 const review=ok(await f.call('/api/update/review?candidateId='+available.candidateId)),input={opId:randomUUID(),candidateId:available.candidateId,reviewDigest:review.reviewDigest};
 ok(await f.call('/api/update/confirm',input));
 await until(status,s=>s.kind==='done');
 assert.equal(existsSync(gate),false,'update commits before the running Run is allowed to finish');
 assert.equal(JSON.parse(readFileSync(join(f.releases,'switch.json'),'utf8')).phase,'committed');
 assert.equal((await f.call('/api/runtime/readiness')).status,200);
 writeFileSync(gate,'done');await until(async()=>ok(await f.call('/api/runtime/preflight')),s=>s.unfinishedRuns.length===0);
 await f.stop();
});
