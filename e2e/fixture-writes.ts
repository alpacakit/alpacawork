/** Test-only composition: fixture changes run inside the serve process that owns the DB. */
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ControlStore } from '@alpacawork/db';
import { RunStore } from '@alpacawork/runs';
import { TaskTransition } from '@alpacawork/backend/test-dist/control/task-transition.js';
import { launchSnapshot, readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { seedTask } from './fixture/tasks.ts';
import { patchTask } from './fixture/task-state.ts';
import { inertFixtureLaunch } from '../tests/helpers/agent-stub.ts';
import { builtinAdapterIdSchema } from '@alpacawork/contract/agent-adapters';
const writers=new Set<string>(),held=new Map<string,ControlStore>();
const descriptor=(root:string)=>join(root,'.alpacawork','e2e-fixture.json');
export function remoteFixture(root:string,operation:unknown):{handled:boolean;value?:any}{
 if(writers.has(root)||!existsSync(descriptor(root)))return{handled:false};
 const request=JSON.stringify({connection:JSON.parse(readFileSync(descriptor(root),'utf8')),operation});
 const result=spawnSync(process.execPath,[new URL('./fixture-client.mjs',import.meta.url).pathname],{input:request,encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024});
 if(result.status!==0)throw new Error('Serve fixture mutation failed: '+result.stderr);
 const answer=JSON.parse(result.stdout);if(answer.error)throw new Error(answer.error);return{handled:true,value:answer.value};
}
/** A served fixture's config is written and published by its owner; cold setup writes before serve starts. */
export function writeFixtureConfig(root:string,text:string):void{
 if(remoteFixture(root,{kind:'config',text}).handled)return;
 writeFileSync(join(root,'config.yaml'),text);
}
/** Finish external file preparation before a case reads the served fixture's file index. */
export function publishFixtureFiles(root:string):void{
 if(!remoteFixture(root,{kind:'filesChanged'}).handled)throw Error('File publication requires a served fixture');
}
export function seedReviewRun(root:string,task:string,placementId:string,hash:string):string{
 const remote=remoteFixture(root,{kind:'reviewRun',task,placementId,hash});if(remote.handled)return remote.value;
 const store=new RunStore(root,{busyTimeoutMs:1000});try{return store.write(tx=>{
  const placement=tx.getPlacement(placementId);if(!placement)throw Error(`Fixture placement ${placementId} is absent`);
  const settings=readAgentsSettings(root);if(!settings.ok)throw settings.error;
  const profile=placement.profileKey, prepared=launchSnapshot(settings.config,profile,'start',`${join(root,'agent-bin')}:/usr/bin:/bin`);
  if(!prepared.ok)throw Error(`Fixture profile ${profile} is absent`);
  const requestId=randomUUID(),prompt='Please review revenue recognition.';tx.insertRequest({id:requestId,taskId:task,placementId,placementRevision:placement.revision,taskHash:hash,waitCycleId:null,headRunId:null,mode:'new',body:prompt,purpose: 'instruction',author:{kind:'human'},submittedAt:new Date().toISOString(),deliveryState:'queued'});
  // A completed synthetic Run has an explicitly known fake session, including for adapters that discover it on start.
  const created=tx.create({task,agent:profile,role:'owner',placementId,requestId,resumes:null,continues:false,session:{provider:profile,id:randomUUID()},caller:null,cwd:root,launch:inertFixtureLaunch(builtinAdapterIdSchema.parse(prepared.launch.adapter),prepared.launch.values)},prompt);
  new TaskTransition().captureStartGrant({store,runs:tx},task,requestId,{kind:'human'});
  const running={...created,state:'running' as const,started_at:created.created_at};tx.update(running);tx.finish({...running,state:'succeeded',exit:{code:0,signal:null},ended_at:created.created_at},{state:'present',text:'fixture reply'});return created.id;
 })}finally{store.close()}
}
/** Puts a project away as archiving would, whatever runs its Tasks hold: a scene that starts from no project of the sample's. */
export function archiveFixtureProject(root:string,id:string):void{if(!remoteFixture(root,{kind:'archiveProject',id}).handled)throw Error('Archiving requires a served fixture')}
export function holdFixtureControl(root:string):()=>Promise<void>{const id=randomUUID();const remote=remoteFixture(root,{kind:'hold',id});if(!remote.handled)throw Error('DB contention requires a served fixture');return async()=>{remoteFixture(root,{kind:'release',id})}}
export async function fixtureWriter(root:string,changed:()=>void){
 if(!/^alpacawork-e2e-/.test(root.split('/').at(-1)!))throw Error('Fixture writer requires an isolated E2E workspace');
 writers.add(root);const token=randomUUID(),sockets=new Set<import('node:net').Socket>();
 const server=createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let input='';socket.on('data',bytes=>{input+=bytes;if(input.length>1024*1024){socket.destroy();return}if(!input.endsWith('\n'))return;try{const request=JSON.parse(input);if(request.token!==token)throw Error('Fixture token mismatch');const op=request.operation;let value;
  if(op.kind==='task')value=seedTask(root,op.parentId,op.title,op.values);
  else if(op.kind==='patchTask')value=patchTask(root,op.id,op.patch);
  else if(op.kind==='config')writeFixtureConfig(root,op.text);
  else if(op.kind==='filesChanged')value=undefined;
  else if(op.kind==='reviewRun')value=seedReviewRun(root,op.task,op.placementId,op.hash);
  else if(op.kind==='failReviewWrite'){const control=new ControlStore(root,{busyTimeoutMs:1000});try{control.write(db=>db.exec("CREATE TRIGGER simulated_review_write_fault BEFORE INSERT ON task_log WHEN json_extract(NEW.entry,'$.kind') = 'review_approved' BEGIN SELECT RAISE(ABORT, 'simulated-review-write-fault'); END"))}finally{control.close()}}
  else if(op.kind==='archiveProject'){const control=new ControlStore(root,{busyTimeoutMs:1000});try{control.write(db=>db.prepare("UPDATE tasks SET lifecycle='archived',revision=revision+1 WHERE external_id=? AND kind='project'").run(op.id))}finally{control.close()}}
  else if(op.kind==='hold'){const control=new ControlStore(root,{busyTimeoutMs:0});control.connection.exec('BEGIN IMMEDIATE');held.set(op.id,control)}
  else if(op.kind==='release'){const control=held.get(op.id);if(control){control.connection.exec('ROLLBACK');control.close();held.delete(op.id)}}
  else throw Error('Unknown fixture operation');
  // A fixture writes records and files without naming them: the served side reads all of them again.
  if(op.kind!=='hold'&&op.kind!=='release')changed();
  socket.end(JSON.stringify({value:value??null})+'\n');
 }catch(error){socket.end(JSON.stringify({error:String(error)})+'\n')}})});
 await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done)});const address=server.address()as{port:number};writeFileSync(descriptor(root),JSON.stringify({port:address.port,token,pid:process.pid}),{mode:0o600});
 return async()=>{for(const control of held.values()){if(control.connection.isTransaction)control.connection.exec('ROLLBACK');control.close()}held.clear();for(const socket of sockets)socket.destroy();await new Promise<void>(done=>server.close(()=>done()));writers.delete(root);rmSync(descriptor(root),{force:true})};
}
