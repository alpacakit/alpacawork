import { commandFetch as fetch } from './command-fetch.ts';
/**
 * Shared workspace and drivers for the platform tests.
 *
 * The platform test files run in parallel under `node --test`; they share this
 * one harness so that the workspace, the CLI/HTTP drivers and the teardown stay
 * defined once.
 * `area` and `root` are exported as live bindings: tests read them directly,
 * and the two tests that move the tree to a fresh folder call `useRoot()`.
 */
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { cleanCliEnv } from './http-cli.ts';
import { cliCommand } from './cli-session.ts';
import { openIndexStream } from '../index-stream.ts';
import { fixtureAgentSetting, installAgentStub } from './agent-stub.ts';
import { initializeWorkspace } from '@alpacawork/backend/test-dist/control/initialize.js';
import { stringify } from 'yaml';
import { DEFAULT_LIMITS } from '@alpacawork/contract';

const project=resolve(import.meta.dirname,'../..');
export let area,root,children;
let lifetime: AbortController;
let activeApp:any;
let fixtureEnv: NodeJS.ProcessEnv;
let previousEnvironment: NodeJS.ProcessEnv;
export function useRoot(next:string){root=next;}
const BACKEND='apps/cli/dist/cli.js';
export async function run(args:string[],{input,extraEnv={},entry=BACKEND}:{input?:string;extraEnv?:Record<string,string>;entry?:string}={}):Promise<{code:number|null;stdout:string;stderr:string}>{
  const cliEntry=entry===BACKEND;
  // The CLI's commands share one process (cli-session.ts); what reads stdin, and the backend's own entry, start their own.
  if(cliEntry&&input===undefined)return cliCommand(activeApp.url,args,{...fixtureEnv,...extraEnv},'',project);
  const argv=cliEntry ? ['--server',new URL(activeApp.url).origin,...args] : args;
  return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[entry,...argv],{cwd:project,env:cleanCliEnv({...fixtureEnv,...extraEnv}),signal:lifetime.signal,stdio:['pipe','pipe','pipe']});children.push(child);child.on('error',reject);let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('close',code=>resolve({code,stdout,stderr}));child.stdin.end(input??'');});
}
export async function cli(command,...args){const mutation=['new','update','report','move','set'].includes(args[0]);const argv=mutation&&!args.includes('--op-id')?[command,...args,'--op-id',randomUUID()]:[command,...args];const result=await run(argv);assert.equal(result.code,0,result.stderr+result.stdout);return JSON.parse(result.stdout);}
export async function start(extraEnv={}){
  if(activeApp && (!activeApp.child || activeApp.child.exitCode===null&&activeApp.child.signalCode===null)){
    if(Object.keys(extraEnv).length===0)return activeApp;
    await stop(activeApp);
  }
  if(Object.keys(extraEnv).length===0) { const app=await startServer(root,0); activeApp={...app,base:new URL(app.url).origin}; return activeApp; }
  const child=spawn(process.execPath,['tests/helpers/serve-http.ts',root],{cwd:project,env:cleanCliEnv({...fixtureEnv,...extraEnv}),signal:lifetime.signal,stdio:['ignore','pipe','pipe']});children.push(child);
  let stderr='';child.stderr.on('data',d=>stderr+=d);
  const lines=createInterface({input:child.stdout});
  const line=await Promise.race([once(lines,'line').then(([v])=>v),once(child,'exit').then(()=>{throw new Error(stderr);})]);
  const info=JSON.parse(line);info.base=new URL(info.url).origin;info.child=child;activeApp=info;return info;
}
/** Waits until `child` is gone. `once` alone would hang when the process has
 * already exited: the 'exit' event fired before the listener was attached. */
export async function exited(child:any){if(child.exitCode===null&&child.signalCode===null)await once(child,'exit');}
export async function stop(app){if(!app.child){await app.close();if(activeApp===app)activeApp=null;return;}if(app.child.exitCode===null&&app.child.signalCode===null){app.child.kill('SIGTERM');await once(app.child,'exit');}if(activeApp===app)activeApp=null;}
export async function request(app:any,path:string,data?:unknown,headers:Record<string,string>={}){
  const response=await fetch(app.base+'/api/'+path,{method:data===undefined?'GET':'POST',headers:{...(data===undefined?{}:{'Content-Type':'application/json'}),...headers},body:data===undefined?undefined:JSON.stringify(data)});return {status:response.status,body:await response.json()};
}
export function replaceBody(path,body){const file=join(root,path),text=readFileSync(file,'utf8'),offset=text.indexOf('\n---\n')+5;writeFileSync(file,text.slice(0,offset)+body);}
/** The same bounded reader as the other SSE fixtures: missing data fails and closes instead of hanging the suite. */
export async function sse(app:any,cursor?:string){
  const controller=new AbortController();
  const stream=await openIndexStream(new URL(app.base+'/api/events'),controller.signal,cursor?{'Last-Event-ID':cursor}:{});
  return {async next(){return JSON.parse((await stream.event()).data);},close(){controller.abort();}};
}
beforeEach(async()=>{
  area=realpathSync(mkdtempSync(join(tmpdir(),'alpacawork-backend-')));root=join(area,'tasks');
  const home=join(area,'home');mkdirSync(home,{mode:0o700});
  fixtureEnv={HOME:home,XDG_CONFIG_HOME:join(home,'.config'),PATH:installAgentStub(area,'claude')};
  previousEnvironment=Object.fromEntries(Object.keys(fixtureEnv).map(name=>[name,process.env[name]]));
  Object.assign(process.env,fixtureEnv);
  children=[];lifetime=new AbortController();activeApp=null;
  await initializeWorkspace(root, [], { firstRun: false });
  writeFileSync(join(root,'config.yaml'),stringify({limits:DEFAULT_LIMITS,agents:{claude:fixtureAgentSetting('claude'),codex:fixtureAgentSetting('codex')}}));
  await start();await cli('task','new','--title','Root task','--parent','P1','--op-id',randomUUID());
});
afterEach(async () => {
  // End the whole fixture, including CLI calls abandoned by a timed-out test.
  // Otherwise those calls can continue after the next test changes root.
  if(activeApp)await stop(activeApp);
  lifetime.abort();
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    const closed = new Promise<void>(resolve => child.once('close', resolve));
    child.kill('SIGKILL');
    await closed;
  }
  rmSync(area, { recursive: true, force: true });
  for(const [name,value] of Object.entries(previousEnvironment)){
    if(value===undefined)delete process.env[name];else process.env[name]=value;
  }
});
