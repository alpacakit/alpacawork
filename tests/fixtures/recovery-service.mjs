/** Local service for the unbundled controller. Target maintenance and serve use the shipped bundles. */
import { platform } from '@alpacawork/core';
import { isDeepStrictEqual } from 'node:util';
import { readInstallationService } from '@alpacawork/backend/test-dist/installation/setup.js';
import { spawn,spawnSync } from 'node:child_process';
import { existsSync,readFileSync,writeFileSync,openSync,closeSync,appendFileSync,realpathSync,readdirSync,watchFile,unwatchFile } from 'node:fs';
import { join } from 'node:path';
const base=process.env.ALPACAWORK_RECOVERY_FIXTURE;
if(!base)throw Error('Missing test service root');
const cfg=JSON.parse(readFileSync(join(base,'service.json'),'utf8'));
const record=event=>appendFileSync(join(base,'service-events.jsonl'),JSON.stringify({...event,at:new Date().toISOString()})+'\n');
const ticks=pid=>{try{return readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1].split(' ')[19];}catch{return null;}};
const stop=()=>{
 if(!existsSync(join(base,'serve.identity.json')))return true;
 const identity=JSON.parse(readFileSync(join(base,'serve.identity.json'),'utf8'));
 // One existing 5-second stop budget includes helper startup, drain and real process exit.
 const started=performance.now(),deadline=process.hrtime.bigint()+5_000_000_000n;
 const wait=spawnSync(process.execPath,['--input-type=module','-e',`
 import {readFileSync,readdirSync,readlinkSync}from'node:fs';
 import {request}from'node:http';
 const identity=${JSON.stringify(identity)},pid=identity.pid,deadline=${deadline}n;
 const remaining=()=>Math.max(0,Number((deadline-process.hrtime.bigint())/1_000_000n));
 const phase=(name)=>console.log(JSON.stringify({phase:name,remainingMs:remaining()}));
 const observe=()=>{try{const fields=readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1].split(' ');return{starttick:fields[19],state:fields[0]};}catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')return null;throw error;}};
 const live=()=>{const value=observe();if(value===null)return false;if(value.starttick!==identity.starttick)throw Error('Fixture PID/starttick mismatch');return !['Z','X'].includes(value.state);};
 if(!live())process.exit(0);
 const connection=JSON.parse(readFileSync(${JSON.stringify(join(cfg.workspace,'.alpacawork/connection.json'))},'utf8'));
 let drainError=null;try {
  const url=new URL(connection.url);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw Error('Fixture connection is not local');
  const response=await new Promise((done,fail)=>{
   let result,error;
   const req=request(new URL('/api/runtime/quiesce',url),{method:'POST',agent:false,headers:{Connection:'close'},signal:AbortSignal.timeout(Math.max(1,Math.min(2500,remaining())))},res=>{
    const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.once('error',cause=>{error=cause;req.destroy();});
    res.once('end',()=>{try{result={status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))};}catch(cause){error=cause;}req.destroy();});
   });
   req.once('error',cause=>{error=cause;});req.once('close',()=>{if(error)fail(error);else if(!result)fail(Error('Fixture drain response closed early'));else done(result);});req.end();
  });
  console.log(JSON.stringify({phase:'quiesce',status:response.status,result:response.body,remainingMs:remaining()}));
  if(response.status!==200||response.body.state!=='drained'||response.body.generation!==connection.generation||response.body.workspace!==${JSON.stringify(cfg.workspace)})throw Error('Fixture quiesce was not confirmed');
 }catch(error){drainError=String(error);console.error(drainError);}
 if(!live())process.exit(drainError?1:0);
 try {
  const cwd=readlinkSync('/proc/'+pid+'/cwd'),fd=readdirSync('/proc/'+pid+'/fd').flatMap(n=>{try{return[[n,readlinkSync('/proc/'+pid+'/fd/'+n)]];}catch{return[];}}),maps=readFileSync('/proc/'+pid+'/maps','utf8');
  if(cwd.replace(/ \\(deleted\\)$/,'')!==identity.cwd)throw Error('Fixture cwd mismatch');
  if(!fd.some(([,path])=>path===${JSON.stringify(join(base,'serve.log'))}))throw Error('Fixture log fd mismatch');
  console.log(JSON.stringify({identity,cwd,fd,maps,signal:'SIGTERM'}));
  if(!live())process.exit(drainError?1:0);phase('signal');process.kill(pid,'SIGTERM');
 }catch(error){if((error.code==='ENOENT'||error.code==='ESRCH')&&!live())process.exit(drainError?1:0);throw error;}
 const sleeper=new Int32Array(new SharedArrayBuffer(4));
 while(remaining()>0){if(!live()){phase('exited');process.exit(drainError?1:0);}Atomics.wait(sleeper,0,0,Math.min(10,remaining()));}
 console.error(JSON.stringify({phase:'exit deadline',identity,observation:observe(),remainingMs:remaining()}));process.exit(1);`],{encoding:'utf8',timeout:5000});
 const result={operation:'stop',...identity,status:wait.status,signal:wait.signal,error:wait.error?.message,elapsedMs:performance.now()-started,audit:wait.stdout,stderr:wait.stderr};
 record(result);
 if(wait.status!==0)console.error('Fixture service stop failed: '+JSON.stringify({...result,audit:undefined}));
 return wait.status===0;
};
const service={known:()=>true,observe:definition=>{
 const saved=readInstallationService({workspace:cfg.workspace,releases:cfg.releases}).definition;
 if(!isDeepStrictEqual(definition,saved))throw Error('Fixture service definition differs from the saved installation');
 const identity=existsSync(join(base,'serve.identity.json'))?JSON.parse(readFileSync(join(base,'serve.identity.json'),'utf8')):null;
 const starttick=identity?ticks(identity.pid):null;
 if(starttick!==null&&starttick!==identity.starttick)throw Error('Fixture service PID/starttick mismatch');
 const state=starttick===null?null:readFileSync('/proc/'+identity.pid+'/stat','utf8').split(') ')[1].split(' ')[0];
 return{state:'matching',running:state!==null&&!['Z','X'].includes(state),registrationStarts:false};
},register:definition=>{service.observe(definition);record({operation:'register',definition});return true;},restarts:()=>existsSync(join(base,'restart-failed'))?1:0,stop,restart:()=>{
 if(!stop())return false;
 if(existsSync(join(base,'fail-ready'))){writeFileSync(join(base,'restart-failed'),'');return false;}
 const release=realpathSync(join(cfg.releases,'current')),fd=openSync(join(base,'serve.log'),'a');
 try{
 const child=spawn(process.execPath,['--import',import.meta.filename,join(release,'apps/backend/dist/backend.js'),'--workspace',cfg.workspace,'workspace','serve','--port','0'],
 {detached:true,stdio:['ignore',fd,fd],env:{...process.env,ALPACAWORK_RUN:undefined,ALPACAWORK_RUN_TOKEN:undefined}});
 const identity={pid:child.pid,starttick:ticks(child.pid),cwd:process.cwd()};if(!identity.starttick)throw Error('Fixture child has no startup identity');
 writeFileSync(join(base,'serve.identity.json'),JSON.stringify(identity));record({operation:'restart',...identity,release});child.unref();return true;
 }finally{closeSync(fd);}
}};
platform.service=service;
/** Fixture preparation owns the real startup notification within its caller's existing watchdog.
 * restart alone only means spawn succeeded; readiness must not race module loading.
 */
async function startReady(){
 const log=join(base,'serve.log'),offset=existsSync(log)?readFileSync(log).length:0;
 if(!service.restart())return false;
 const identity=JSON.parse(readFileSync(join(base,'serve.identity.json'),'utf8'));
 await new Promise((done,fail)=>{
  const check=()=>{
   try{
    const stat=readFileSync('/proc/'+identity.pid+'/stat','utf8').split(') ')[1].split(' ');
    if(stat[19]!==identity.starttick||['Z','X'].includes(stat[0]))throw Error('Fixture serve exited before startup notification');
    const text=readFileSync(log).subarray(offset).toString('utf8');
    const started=text.split('\n').some(line=>{try{const value=JSON.parse(line);return value.root===cfg.workspace&&typeof value.url==='string';}catch{return false;}});
    if(!started)return;
    unwatchFile(log,check);record({operation:'startup',...identity});done();
   }catch(error){unwatchFile(log,check);fail(error);}
  };
  watchFile(log,{interval:30},check);check();
 });
 return true;
}
export { stop, startReady };
