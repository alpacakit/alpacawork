/** A loopback service adapter for managed-update fixtures. No real service is addressed. */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backendBundleWith, fixturePlatformEntry, fixtureUpdateRuntime, prependBackendInstrumentation } from './backend-bundle.ts';
export function prepareUpdateFixtureRuntime(built:string,root:string):void {
 fixturePlatformEntry(built);
 const config=join(root,'update-runtime.json');
 fixtureUpdateRuntime(built,`const fixture=JSON.parse(__fixtureRead(${JSON.stringify(config)},'utf8')),runtime=fixtureRuntimeOwner(workspace,fixture.installationEnvironment);if(runtime.place.workspace!==fixture.place.workspace||runtime.place.releases!==fixture.place.releases||runtime.place.service!==fixture.place.service||runtime.registry.nodeExecutable!==fixture.registry.nodeExecutable||runtime.writer.root!==fixture.writer.root)throw Error('Synthetic configuration differs from validated installation');return {...runtime,registry:fixture.registry};`);
 const file=backendBundleWith(built,'function fixtureRuntimeOwner(');
 prependBackendInstrumentation(file,"import {readFileSync as __fixtureRead} from 'node:fs';");
}
export function writeUpdateServiceAdapter(root:string):string {
 const file=join(root,'update-service.mjs');
 writeFileSync(file,`import fs,{readFileSync,writeFileSync,appendFileSync,existsSync,openSync,closeSync,realpathSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';import{pathToFileURL}from'node:url';import{spawn}from'node:child_process';import{isDeepStrictEqual}from'node:util';import{syncBuiltinESMExports}from'node:module';
const root=${JSON.stringify(root)},config=join(root,'update-runtime.json'),stateFile=join(root,'service-state.json'),processes=join(root,'processes.jsonl'),calls=join(root,'service-calls.jsonl');
let image=dirname(realpathSync(resolve(process.argv[1]??'.')));while(image!==dirname(image)&&!existsSync(join(image,'SOURCE')))image=dirname(image);
if(existsSync(join(image,'SOURCE'))){
 const {platform}=await import(pathToFileURL(join(image,'apps/backend/dist/fixture-platform.js')).href);
 const started=platform.run.started(process.pid);appendFileSync(processes,JSON.stringify({pid:process.pid,started,argv:process.argv,executable:process.execPath,cwd:process.cwd(),image,deadline:new Date(Date.now()+600000).toISOString()})+'\\n');
 // The synthetic service boundary owns process groups; never contact this PC's systemd manager.
 platform.run.spawnDetached=(command,args,options,unit)=>{const child=spawn(command,args,{...options,detached:true});appendFileSync(join(root,'spawn-requests.jsonl'),JSON.stringify({pid:process.pid,image,command,args,unit,childPid:child.pid,childStarted:child.pid?platform.run.started(child.pid):null,leaseTransferred:Array.isArray(options.stdio)&&typeof options.stdio[4]==='number'})+'\\n');return child;};
 const event=value=>appendFileSync(join(root,'writer-events.jsonl'),JSON.stringify({pid:process.pid,started,argv:process.argv,image,...value})+'\\n');
 const once=kind=>{const runtime=JSON.parse(readFileSync(config,'utf8'));if(!runtime.faults?.[kind]?.includes(image))return false;try{const fd=openSync(join(root,kind+'-'+basename(image)),'wx',0o600);closeSync(fd);return true;}catch(error){if(error.code==='EEXIST')return false;throw error;}};
 const rename=fs.renameSync;fs.renameSync=function(from,to){if(String(from).includes('.stage-')&&/\\/[a-f0-9]{40}$/.test(String(to))&&once('enospc')){event({method:'publish',target:String(to),fault:'ENOSPC'});throw Object.assign(new Error('Synthetic capacity refusal'),{code:'ENOSPC'});}if(String(from).includes('.alpacawork-skill-stage-')&&String(to).endsWith('/alpacawork-betterquality')&&once('partialSkill'))throw Object.assign(new Error('Synthetic partial skill write'),{code:'ENOSPC'});const result=rename(from,to);if(String(to).endsWith('/.alpacawork/installed.json')&&JSON.parse(readFileSync(to,'utf8')).state==='complete'){event({method:'install'});if(once('killInstall'))process.kill(process.pid,'SIGKILL');}return result;};syncBuiltinESMExports();
 const timer=setTimeout(()=>process.kill(process.pid,'SIGTERM'),600000);timer.unref();
 const read=()=>{try{return JSON.parse(readFileSync(stateFile,'utf8'))}catch{return null;}};
 const dead=pid=>{try{const text=readFileSync('/proc/'+pid+'/stat','utf8');return ['Z','X'].includes(text.split(') ')[1].split(' ')[0]);}catch{return true;}};
 const approved=input=>{const runtime=JSON.parse(readFileSync(config,'utf8')),definition=typeof input==='string'?runtime.definition:input;if(!isDeepStrictEqual(definition,runtime.definition)||typeof input==='string'&&input!==definition.name)throw Error('Synthetic service differs from its saved definition');return{runtime,definition};};
 const call=(operation,input)=>{const{definition}=approved(input);appendFileSync(calls,JSON.stringify({operation,name:definition.name,definition,pid:process.pid,started,argv:process.argv,image,at:new Date().toISOString()})+'\\n');};
 const stop=input=>{call('stop',input);const state=read();if(!state||dead(state.pid))return true;if(platform.run.started(state.pid)!==state.started)throw Error('Synthetic service identity differs');process.kill(state.pid,'SIGTERM');for(const until=Date.now()+10000;Date.now()<until;){if(dead(state.pid))return true;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}return false;};
 platform.service={known:name=>{const runtime=JSON.parse(readFileSync(config,'utf8'));return name===runtime.definition.name;},observe:definition=>{approved(definition);call('observe',definition);const state=read();return{state:'matching',running:!!state&&!dead(state.pid),registrationStarts:false};},register:definition=>{approved(definition);call('register',definition);return true;},unregister:()=>{throw Error('Fixture registration removal is outside this test');},stop,restart:input=>{
  call('restart',input);const{runtime,definition}=approved(input),target=realpathSync(join(runtime.place.releases,'current'));
  if(runtime.failRestart?.includes(target))return false;
  const prior=read();if(prior&&!dead(prior.pid)&&!stop(input))return false;
  const fd=openSync(join(root,'service.log'),'a',0o600);
  const launch={executable:definition.executable,args:definition.args,workingDirectory:definition.workingDirectory};appendFileSync(calls,JSON.stringify({operation:'spawn-service',...launch,pid:process.pid,image})+'\\n');
  let child;try{child=spawn(launch.executable,launch.args,{cwd:launch.workingDirectory,env:{...process.env,...definition.environment},detached:true,stdio:['ignore',fd,fd]});}finally{closeSync(fd);}
  const childStarted=platform.run.started(child.pid);if(!childStarted)throw Error('Synthetic service child identity is absent');
  writeFileSync(stateFile,JSON.stringify({pid:child.pid,started:childStarted,restarts:prior?.restarts??0}));
  child.once('exit',()=>{const saved=read();if(saved?.pid===child.pid)writeFileSync(stateFile,JSON.stringify({...saved,restarts:saved.restarts+1}));});
  child.unref();return true;
 },restarts:()=>read()?.restarts??0};
 if(process.argv[1]?.endsWith('/backend.js')&&process.argv.includes('serve')){const prior=read();writeFileSync(stateFile,JSON.stringify({pid:process.pid,started,restarts:prior?.restarts??0}));}
}
`);
 return file;
}

import { platform } from '@alpacawork/core';
import { setTimeout as delay } from 'node:timers/promises';
export async function stopUpdateFixtureProcesses(root:string){
 let records:{pid:number;started:string;argv:string[]}[]=[];
 try{records=readFileSync(join(root,'processes.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const ended=(pid:number)=>{try{return ['Z','X'].includes(readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1]!.split(' ')[0]!);}catch{return true;}};
 const held=records.filter(r=>r.pid!==process.pid&&platform.run.started(r.pid)===r.started&&!ended(r.pid));
 for(const record of held.reverse())if(platform.run.started(record.pid)===record.started&&!ended(record.pid))process.kill(record.pid,'SIGTERM');
 for(const until=Date.now()+10000;Date.now()<until&&held.some(r=>platform.run.started(r.pid)===r.started&&!ended(r.pid));)await delay(25);
 for(const record of held)if(platform.run.started(record.pid)===record.started&&!ended(record.pid))process.kill(record.pid,'SIGKILL');
 for(const until=Date.now()+5000;Date.now()<until&&held.some(r=>platform.run.started(r.pid)===r.started&&!ended(r.pid));)await delay(25);
 const remaining=held.filter(r=>platform.run.started(r.pid)===r.started&&!ended(r.pid));
 writeFileSync(join(root,'process-cleanup.json'),JSON.stringify({records,remaining},null,2));
 if(remaining.length)throw new Error('Synthetic update processes remain alive');
 return {records,remaining};
}
