/** Detached acquisition/application controller. Switch journal alone advances application and recovery. */
import { join } from 'node:path';
import { recordUpdateTelemetry } from '../telemetry/update.js';
import { openSync, closeSync, mkdirSync } from 'node:fs';
import { platform } from '@alpacawork/core';
import { randomUUID } from 'node:crypto';
import { currentRelease, updateDecision, awaitUpdateDecision } from './update-operation.js';
import { CandidateRejection } from './npm-records.js';
import { stageConfirmedNpmCandidate } from './npm-candidate.js';
import { loadJournal, saveJournal, recovering, stoppedContinuationTarget } from './journal.js';
import { switchTo, continueStoppedSwitch, prune, SwitchRunsActive } from './switch.js';
import { readUpdateRecord, saveUpdateRecord, updateJournal, updateTarget, completedUpdate, compactUpdateRecord, controllerAlive, isNpmCandidate, type UpdateOperation } from './update-record.js';
import { resolveUpdateRuntime, updateRuntime, type UpdateRuntime } from './update-runtime.js';
import { thisRelease } from './location.js';
import { backendEntry } from '../app-paths.js';
import { runMaintenance } from './maintenance-process.js';
import { assertUpdateHandoff, UpdateCompatibilityError } from './update-capabilities.js';
export { controllerAlive } from './update-record.js';
function operation(runtime: UpdateRuntime, opId: string): UpdateOperation | null {
 const saved=readUpdateRecord(runtime.place.releases).operation;
 if(!saved||saved.opId!==opId)return null;
 if(saved.workspace!==runtime.place.workspace||saved.skills.root!==runtime.writer.root)throw new Error('Update installation differs from original authorization');
 return saved;
}
function change(runtime:UpdateRuntime,opId:string,work:(op:UpdateOperation)=>void):void {
 updateDecision(runtime.place.releases,()=>{
  const state=readUpdateRecord(runtime.place.releases),op=state.operation;
  if(!op||op.opId!==opId)return;
  work(op);compactUpdateRecord(runtime.place.releases,state);saveUpdateRecord(runtime.place.releases,state);
 });
}
/** Parent saves PID+started while holding L. The child claims under the same L. */
export async function launchUpdateController(workspace:string,opId:string):Promise<void> {
 const runtime=resolveUpdateRuntime(workspace),{releases}=runtime.place;
 let launched;
 try { launched=updateDecision(releases,()=>{
  const saved=operation(runtime,opId);
  if(!saved)return null;
  const application=updateJournal(releases,saved);
  if(completedUpdate(releases,saved,application)||controllerAlive(saved))return null;
  if(application&&recovering(application))return null;
  const target=stoppedContinuationTarget(application);
  if(target&&target!==updateTarget(releases,saved))throw new Error('Handoff target differs from original authorization');
  mkdirSync(join(releases,'.updates'),{recursive:true});
  const log=openSync(join(releases,'.updates','controller.log'),'a',0o600);
  try{
   const child=platform.run.spawnDetached(process.execPath,
    [backendEntry('release/update-controller',target??undefined),target?'continue':'run',workspace,opId],
    {env:{...process.env},stdio:['ignore','ignore',log]},'alpacawork-update-'+opId+'-'+randomUUID());
   const spawned=new Promise<void>((done,reject)=>{child.once('error',reject);child.once('spawn',done);});
   try{
    const started=child.pid&&platform.run.started(child.pid);
    if(!child.pid||!started)throw new Error('Spawned controller identity is unavailable');
    const state=readUpdateRecord(releases);state.operation!.controller={pid:child.pid,started};saveUpdateRecord(releases,state);
   }catch(error){void spawned.catch(()=>{});child.kill();throw error;}
   return{child,spawned};
  }finally{closeSync(log);}
 }); } catch(error) {
  // Acceptance is already durable. A competing release decision must not fail its replay.
  if(error instanceof CandidateRejection&&error.kind==='operation_busy')return;
  throw error;
 }
 if(launched){await launched.spawned;launched.child.unref();}
}
export async function runUpdateController(runtime:UpdateRuntime,opId:string,mode:'run'|'continue'='run'):Promise<import('./switch.js').Serving|null>{
 const {releases,workspace}=runtime.place;
 let handedOff=false;
 const claim=await awaitUpdateDecision(releases,()=>{
  const saved=operation(runtime,opId);
  if(!saved)return null;
  const j=updateJournal(releases,saved);if(completedUpdate(releases,saved,j)||j&&recovering(j))return null;
  const started=platform.run.started(process.pid);if(!started)throw new Error('Controller identity is unavailable');
  if(controllerAlive(saved)&&(saved.controller!.pid!==process.pid||saved.controller!.started!==started))return null;
  const state=readUpdateRecord(releases);state.operation!.failure=null;state.operation!.controller={pid:process.pid,started};saveUpdateRecord(releases,state);
  return state.operation!;
 });
 if(!claim)return null;
 try{
  const target=updateTarget(releases,claim),journal=updateJournal(releases,claim);
  if(mode==='continue'||journal&&!['waiting_runs','prepared','aborted'].includes(journal.phase)){
   const j=journal;
   if(!j||j.opId!==opId||j.target!==thisRelease()||j.target!==target||j.phase==='waiting_runs'||j.phase==='prepared')throw new Error('Target continuation identity/phase differs');
   const ready=await continueStoppedSwitch(runtime.place,j);
   await recordUpdateTelemetry(workspace,loadJournal(runtime.place)?.phase==='committed');
   // Cleanup uses the target's code and the same release lock as CLI prune/reservations.
   // The update is already committed: a cleanup fault is diagnostic, never an application failure.
   try{await awaitUpdateDecision(releases,()=>prune(releases,0,runtime.place.say,workspace));}
   catch(error){console.error('Post-update prune failed; update remains committed:',error);}
   return ready;
  }
  if(currentRelease(releases)!==claim.candidate.expectedActive)throw new Error('Update active release changed');
  if(isNpmCandidate(claim.candidate)&&(claim.phase==='fetching'||claim.phase==='failed')){
   change(runtime,opId,op=>{op.phase='fetching';op.failure=null;});
   const c=claim.candidate,result=await stageConfirmedNpmCandidate({releases,confirmation:{opId,candidateId:c.candidateId,metadataDigest:c.metadataDigest,expectedActive:c.expectedActive},registry:runtime.registry});
   if(result.ok===false)throw new AcquisitionFailure(result.error.kind,result.error.cause,result.error.httpStatus);
   change(runtime,opId,op=>{op.phase='staged';});
  }
  assertUpdateHandoff(target,runtime.place);
  return await switchTo(runtime.place,target,undefined,{opId,reservePrepared:async j=>updateDecision(releases,()=>{
   if(!operation(runtime,opId))throw new Error('Update was cancelled');saveJournal(runtime.place,j);
  }),afterStopped:async()=>{
   change(runtime,opId,op=>{op.controller=null;});handedOff=true;
   const ready=JSON.parse(await runMaintenance(process.execPath,[backendEntry('release/update-controller',target),'continue',workspace,opId],
    {...process.env},runtime.place.say,'Update target continuation'));
   if(!ready||typeof ready.generation!=='string')throw new Error('Target continuation did not return readiness');return ready;
  }});
 }catch(error){
  runtime.place.say('Update controller failed: '+String(error));console.error('Update controller failed',error);
  if(!handedOff){await recordUpdateTelemetry(workspace,false);change(runtime,opId,op=>{
   op.controller=null;const j=updateJournal(releases,op);
   if(!j||['waiting_runs','aborted'].includes(j.phase))op.phase='failed';
   op.failure={kind:error instanceof AcquisitionFailure?error.kind:error instanceof UpdateCompatibilityError?'unsupported':'application_failed',
    category:error instanceof AcquisitionFailure?error.category:'other',cause:error instanceof AcquisitionFailure?error.detail??error.message:error instanceof Error?error.message:'unknown',
    ...(error instanceof SwitchRunsActive?{runConflict:error.runConflict}:{})};
  });}
  throw error;
 }finally{
  if(!handedOff)change(runtime,opId,op=>{if(op.controller?.pid===process.pid)op.controller=null;});
 }
}
class AcquisitionFailure extends Error {
 readonly category:'network'|'disk'|'other';
 constructor(readonly kind:string,readonly detail?:string,status?:number){super(kind);this.category=detail==='ENOSPC'?'disk':
 ['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH'].includes(detail??'')||status!==undefined&&(status>=500||status===429)?'network':'other';}
}
/** Startup resumes only already accepted work; failures require the existing explicit retry. */
export async function resumeKnownUpdates(workspace:string):Promise<void>{
 const runtime=updateRuntime(workspace);if(!runtime)return;
 const op=readUpdateRecord(runtime.place.releases).operation;
 if(op&&op.phase!=='failed')await launchUpdateController(workspace,op.opId);
}
