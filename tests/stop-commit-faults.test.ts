import { CLI_CONTRACT, CONTRACT_HEADER } from '@alpacawork/contract/client-contract';
/** Faults at actual HTTP commit/publication boundaries, with separate serve and manager processes. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {existsSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {RunStore} from '@alpacawork/runs';
import {commandOf} from '@alpacawork/backend/test-dist/runs/execution-control.js';
import {startServer} from '@alpacawork/backend/test-dist/receiver/server.js';
import {setup,until} from './runs-runtime.fixture.ts';
import {cleanCliEnv} from './helpers/http-cli.ts';
const body=async(response:Response)=>({status:response.status,body:await response.json()});
const call=(url:string,path:string,data?:unknown,op?:string)=>fetch(new URL('/api/'+path,url),{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(op?{'X-Alpacawork-Client':'cli', [CONTRACT_HEADER]: String(CLI_CONTRACT),'X-Alpacawork-Op-Id':op}:{})},body:data===undefined?undefined:JSON.stringify(data)}).then(body);
async function subject(root:string,mode:string,marker:string,gate:string){
 const child=spawn(process.execPath,[resolve('tests/fixtures/serve-writer-fault.ts'),root,mode,marker,gate],{env:cleanCliEnv(),stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',b=>stderr+=b);const expiry=setTimeout(()=>child.kill('SIGKILL'),25000),exited=once(child,'exit').finally(()=>clearTimeout(expiry));
 const lines=createInterface({input:child.stdout});const info=JSON.parse(await Promise.race([once(lines,'line').then(([line])=>line),exited.then(()=>{throw Error(stderr)})]));
 return{child,exited,info};
}
for(const mode of ['stop-pause','stop-before-publication'])test(`${mode}: no stop success or drained token escapes before durable publication`,async t=>{
 const h=await setup(t),parent=h.create('plain',{gate:h.gate('parent')}),child=h.create('plain',{gate:h.gate('child')},{role:'worker',placementId:h.memberPlacementId,caller:{run:parent.id}});
 await h.tick();await h.ready(parent);await h.ready(child);h.pauseProjection();h.store.close();
 const marker=join(h.root,'stop-boundary.json'),gate=join(h.root,'publish-release'),server=await subject(h.root,mode,marker,gate),op=randomUUID();
 const stop=call(server.info.url,'run/stop',{run:parent.id},op);void stop.catch(()=>undefined);
 try{
  await until(()=>existsSync(marker),'stop transaction committed');
  const stored=RunStore.openReadable(h.root,{busyTimeoutMs:1000})!;let commands:any[];
  try{assert.equal(stored.get(parent.id)!.stop_requested,true);assert.equal(stored.get(child.id)!.stop_requested,true);commands=stored.connection.prepare("SELECT c.*,a.run_no,a.launch_json FROM run_commands c JOIN run_attempts a USING(attempt_id) WHERE type='stop'").all().map(row=>({attempt_id:row.attempt_id,seq:row.seq,json:JSON.stringify(commandOf(row))}));assert.equal(commands.length,2);assert.equal(stored.connection.prepare("SELECT count(*) AS n FROM run_commands WHERE type='stop' AND published=1").get()!.n,0)}finally{stored.close()}
  if(mode==='stop-pause'){
   let stopReturned=false,drained=false;void stop.then(()=>{stopReturned=true});const draining=call(server.info.url,'runtime/quiesce',{}).then(r=>{drained=true;return r});
   await delay(100);assert.equal(stopReturned,false);assert.equal(drained,false,'in-flight committed stop must block drained');
   assert.equal((await call(server.info.url,'task/new',{title:'not admitted',parent:'P1'},randomUUID())).status,503);
   writeFileSync(gate,'');assert.equal((await stop).status,200);assert.equal((await draining).status,200);
   for(const row of commands!){const value=JSON.parse(row.json),path=join(h.root,'.alpacawork/runs',value.runId,'protocol',row.attempt_id,'commands',String(row.seq).padStart(12,'0')+'.json');assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),value)}
  }else{
   await server.exited;await assert.rejects(stop);let observedListening=false;
   const app=await startServer(h.root,0);try{for(const row of commands!){const c=JSON.parse(row.json);assert.ok(existsSync(join(h.root,'.alpacawork/runs',c.runId,'protocol',row.attempt_id,'commands',String(row.seq).padStart(12,'0')+'.json')))}observedListening=true;assert.equal((await call(app.url,'operation/get?opId='+op)).status,200);assert.equal((await call(app.url,'run/stop',{run:parent.id},op)).status,200)}finally{await app.close()}
   assert.equal(observedListening,true);
  }
  console.log(JSON.stringify({proof:'stop-commit-gate',mode,servePid:server.child.pid,marker:JSON.parse(readFileSync(marker,'utf8')),targets:commands!.map(row=>({attempt:row.attempt_id,seq:row.seq,command:JSON.parse(row.json)}))}));
 }finally{writeFileSync(gate,'');if(server.child.exitCode===null&&server.child.signalCode===null)server.child.kill('SIGTERM');await server.exited}
});
