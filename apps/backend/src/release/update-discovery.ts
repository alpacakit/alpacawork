/** Periodic npm observation. Only the update Owner publishes offered candidates. */
import { randomUUID } from 'node:crypto';
import { loadJournal, terminal } from './journal.js';
import { observeNpmCandidate } from './npm-candidate.js';
import { readUpdateRecord, completedUpdate } from './update-record.js';
import { offerUpdateLocked, updateDecision } from './update-operation.js';
import { CandidateRejection } from './npm-records.js';
import { readManifest } from './package-closure.js';
import { updateRuntime, type UpdateRuntime } from './update-runtime.js';
/** Canonical npm versions have already passed the metadata Owner's syntax validation. */
export function newerNpmVersion(candidate:string,current:string):boolean {
 const split=(v:string)=>{const value=v.split('+')[0]!,dash=value.indexOf('-');return{
  core:(dash<0?value:value.slice(0,dash)).split('.').map(BigInt),pre:dash<0?undefined:value.slice(dash+1).split('.')};};
 const a=split(candidate),b=split(current);
 for(let i=0;i<3;i++){if(a.core[i]!==b.core[i])return a.core[i]!>b.core[i]!;}
 if(!a.pre||!b.pre)return !a.pre&&!!b.pre;
 for(let i=0;i<Math.max(a.pre.length,b.pre.length);i++){
  const x=a.pre[i],y=b.pre[i];if(x===y)continue;if(x===undefined||y===undefined)return y===undefined;
  const xn=/^\d+$/.test(x),yn=/^\d+$/.test(y);if(xn&&yn)return BigInt(x)>BigInt(y);if(xn!==yn)return yn;return x>y;
 }return false;
}
export async function discoverUpdate(runtime:UpdateRuntime,signal?:AbortSignal):Promise<'deferred'|void>{
 const {releases}=runtime.place,journal=loadJournal(runtime.place),state=readUpdateRecord(releases);
 if(journal&&!terminal(journal)||state.operation&&!completedUpdate(releases,state.operation))return 'deferred';
 const current=journal?.phase==='committed'?journal.target:journal?.old;
 if(!current)return;
 const result=await observeNpmCandidate({releases,candidateId:randomUUID(),expectedActive:current,registry:{...runtime.registry,signal},environment:runtime.environment});
 try{return updateDecision(releases,()=>{
  const after=loadJournal(runtime.place);if(after&&!terminal(after)||after?.opId!==journal?.opId)return 'deferred' as const;
  if(result.ok)offerUpdateLocked(releases,newerNpmVersion(result.value.exactVersion,readManifest(current).version)?result.value:null);
 });}catch(error){
  if(error instanceof CandidateRejection&&error.kind==='operation_busy')return 'deferred';
  throw error;
 }
}
/** Caller owns and awaits this lifetime on serve shutdown. Failures are diagnostics, never GET repairs. */
export function monitorUpdates(workspace:string,report:(error:unknown)=>void){
 const cancellation=new AbortController();
 let closed=false,active:Promise<void>|null=null,timer:ReturnType<typeof setTimeout>|undefined;
 const tick=()=>{
  if(closed||active)return;
  let next=60*60*1000;
  active=Promise.resolve().then(()=>{const runtime=updateRuntime(workspace);return runtime?discoverUpdate(runtime,cancellation.signal):undefined;})
   .then(outcome=>{if(outcome==='deferred')next=60*1000;}).catch(report).finally(()=>{
    active=null;
    if(!closed){timer=setTimeout(tick,next);timer.unref();}
   });
 };
 tick();
 return async()=>{closed=true;clearTimeout(timer);cancellation.abort();await active;};
}
