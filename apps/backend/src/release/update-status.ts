/** Read-only projection. A durable phase does not prove an executor is alive. */
import { openControlDatabase } from '@alpacawork/db';
import { inspectExecution } from '../runs/execution-control.js';
import type { UpdateStatus } from '@alpacawork/contract';
import { connectionPath, readConnection } from '@alpacawork/contract/connection';
import { join, basename } from 'node:path';
import { managedScope } from './update-operation.js';
import { observeUpdate } from './update-record.js';
import { updateRuntime } from './update-runtime.js';
import { switchNeedsNoRuns } from './switch.js';
export function updateStatus(workspace:string):UpdateStatus {
 let opId:string|null=null,version:string|null=null;
 const attention=(reason:string):UpdateStatus=>{console.error('Update needs attention',{opId,version,reason});return{kind:'attention',opId,version};};
 try{
  if(!updateRuntime(workspace))return{kind:'none'};
  const scope=managedScope(workspace);
  const {state,journal}=scope,op=state.operation;
  const progress=op?observeUpdate(scope.releases,op,journal):state.lastResult?.result;
  opId=op?.opId??state.lastResult?.opId??null;version=op?.candidate.exactVersion??state.lastResult?.version??null;
  if(op){
   opId=op.opId;version=op.candidate.exactVersion;
   switch(progress){
    case 'fetching': case 'applying': case 'recovering': return{kind:progress,opId,version};
    case 'waiting_runs': {
     const runs=unfinishedRuns(inspectWorkspace(scope.workspace));
     return runs>0?{kind:'waiting',opId,version,runs}:{kind:'applying',opId,version};
    }
    case 'failed': return{kind:'failed',candidateId:op.candidate.candidateId,version,category:op.failure?.category??'other',...op.failure?.runConflict?{runConflict:op.failure.runConflict}:{}};
    case 'unsupported': return attention('unsupported');
    case 'stopped': return attention('application_required');
   }
  }
  const candidate=state.offer;
  if(candidate&&candidate.expectedActive===scope.current){
   const live=inspectWorkspace(scope.workspace);
   return{kind:'available',candidateId:candidate.candidateId,version:candidate.exactVersion,
   runs:unfinishedRuns(live),requiresNoRuns:needsNoRuns(live,candidate.facts,scope.current),changes:null,note:state.lastResult?.result==='cancelled'?{kind:'deferred'}:
    state.lastResult?.result==='withdrawn'?{kind:'withdrawn',version:state.lastResult.version}:null};
  }
  if(progress==='committed'){
   const j=journal,id=op?.opId??state.lastResult?.opId;
   version=op?.candidate.exactVersion??state.lastResult?.version??null;
   if(j&&j.opId===id&&j.phase==='committed'&&j.target===scope.current&&j.ready){
    const connection=readConnection(connectionPath(scope.workspace));
    if(j.ready.release===basename(scope.current)&&connection.runManager===join(scope.current,'apps/backend/dist/run-manager.js'))return{kind:'done',version:version!};
    return attention('unconfirmed');
   }
  }
  if(progress==='recovered')return attention('recovered_update_failed');
  if(progress==='withdrawn')return{kind:'withdrawn',version:op?.candidate.exactVersion??state.lastResult!.version};
  return{kind:'none'};
 }catch(error){
  console.error('Update status unavailable',error);
  const reason=error&&typeof error==='object'&&'detail'in error?(error.detail as {reason?:string}|undefined)?.reason:undefined;
  if(reason==='not_managed')return error&&typeof error==='object'&&'cause'in error&&error.cause?attention('unconfirmed'):{kind:'none'};
  return attention(reason?.startsWith('installation_')||error instanceof SyntaxError?'unconfirmed':'unsupported');
 }
}
function inspectWorkspace(root:string){
 const connection=openControlDatabase(root,{busyTimeoutMs:1000},true);
 try{return inspectExecution({root,connection});}finally{connection.close();}
}
const unfinishedRuns=(state:ReturnType<typeof inspectWorkspace>)=>Math.max(state.unfinishedRuns.length,state.contractUsers.length,state.unpublishedStops);
/** The switch's own rule, read now; facts it cannot read count as needing no Runs (said too often, never too seldom). */
function needsNoRuns(state:ReturnType<typeof inspectWorkspace>,facts:{format:string;schema:unknown},current:string):boolean{
 try{return switchNeedsNoRuns(state,facts,current)!==null;}catch{return true;}
}
