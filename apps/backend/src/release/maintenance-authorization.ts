import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { Problem,PROBLEM_CODE } from '@alpacawork/core';
import { verifyRunCredential } from '../control/credentials.js';
import { workspaceJournal,recoveryLineage,recoveryGrantSchema,type SwitchJournal,type RecoveryGrant } from './journal.js';
import { operationReadActions } from '@alpacawork/contract/access-boundaries';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { certifySnapshot, checkDatabaseFiles } from '@alpacawork/db';
import { RunStore } from '@alpacawork/runs';
import { authorize } from '../control/authorize.js';
import { resolveCaller, type CallerClaim } from '../control/credentials.js';
import { readGroup } from './recovery-data.js';
type FrozenRecovery=Pick<NonNullable<SwitchJournal['recovery']>,'id'|'failure'|'reader'|'backup'|'authorization'>;
/** Only references published by the recovery Owner may select an archived maintenance reader. */
export function frozenRecovery(root:string,backup:string):FrozenRecovery|null {
  const pending=workspaceJournal(root)?.recovery;
  if(pending?.backup===backup)return pending;
  for(const reference of recoveryLineage(root)) {
    const path=join(reference.failure,'recovery.json');
    const value=z.object({version:z.literal(1),id:z.string().uuid(),reader:z.string(),backup:z.string(),authorization:recoveryGrantSchema.optional()})
      .passthrough().parse(JSON.parse(readFileSync(path,'utf8')));
    if(value.id!==reference.id||value.reader!==reference.reader)throw new Error('Archived recovery identity differs');
    if(value.backup===backup)return {...value,failure:reference.failure};
  }
  return null;
}
/** The stopped failure snapshot is opened only by its own release's bounded maintenance command. */
export function authorizeFailureRecovery(root:string,folder:string,claim:CallerClaim):void {
  readGroup(folder,root);const path=join(folder,'control.sqlite');checkDatabaseFiles(path,true);
  const db=new DatabaseSync(path,{readOnly:true});
  try {
    certifySnapshot(db,'control');db.exec('BEGIN');
    const store=new RunStore(root,{busyTimeoutMs:1000},true,db);
    try {const caller=resolveCaller(root,claim,store);authorize(db,caller,{name:'release'},{task:caller.kind==='run'?caller.taskId:null,quote:null});}
    finally {store.close();db.exec('ROLLBACK');}
  } finally {db.close();}
}

/** An accepted recovery's authorization is scoped to that journal; rollback must not manufacture fresh Run authority. */
export function verifyRecoveryGrant(root:string,grant:RecoveryGrant,env:Readonly<Record<string,string|undefined>>) {
  const token=env.ALPACAWORK_RUN_TOKEN;
  if(env.ALPACAWORK_RUN!==grant.caller.runId||!token||!verifyRunCredential(root,grant.caller.runId,token)||
    createHash('sha256').update(token).digest('hex')!==grant.tokenDigest)
    throw new Problem(PROBLEM_CODE.forbidden,'Recovery continuation credential does not match its admitted Run',undefined,{reason:{kind:'recovery_continuation_credential_mismatch'}});
  return grant.caller;
}
/** Only this release-matched maintenance reader opens the failed schema for Task scope and old result lookup. */
export function readFailureOperation(root:string,folder:string,opId:string,env:NodeJS.ProcessEnv) {
  const reference=recoveryLineage(root).find(item=>item.failure===folder),pending=workspaceJournal(root)?.recovery;
  let recovery:FrozenRecovery|null=null;
  if(pending?.failure===folder)recovery=pending;
  else if(reference) {
    const path=join(folder,'recovery.json');const record=JSON.parse(readFileSync(path,'utf8'));
    recovery=frozenRecovery(root,String(record.backup));
  }
  if(!recovery||recovery.failure!==folder)throw new Error('Diagnostic group is not an admitted recovery');
  const group=readGroup(folder,root),path=join(folder,'control.sqlite'),db=new DatabaseSync(path,{readOnly:true});
  try {
    certifySnapshot(db,'control');db.exec('BEGIN');
    let caller;
    if(recovery.authorization&&(env.ALPACAWORK_RUN!==undefined||env.ALPACAWORK_RUN_TOKEN!==undefined))caller=verifyRecoveryGrant(root,recovery.authorization,env);
    else {
      const store=new RunStore(root,{busyTimeoutMs:1000},true,db);
      try {caller=resolveCaller(root,env.ALPACAWORK_RUN!==undefined||env.ALPACAWORK_RUN_TOKEN!==undefined?
        {run:{runId:env.ALPACAWORK_RUN??'',token:env.ALPACAWORK_RUN_TOKEN??''}}:{},store);}
      finally {store.close();}
    }
    const prior=group.evidence.operations.find(op=>op.opId===opId);
    for(const {action,task}of operationReadActions(prior?.tasks??[]))authorize(db,caller,action,{task,quote:null});
    // The manifest is only an index. Read one body from the certified, version-matched
    // frozen database after authorization; never aggregate all result bodies again.
    let previous=prior;
    if(prior?.state==='committed') {
      const file=db.prepare('SELECT state,result_json FROM file_operations WHERE op_id=?').get(opId);
      const receipt=file
        ? file.state==='published' ? JSON.parse(String(file.result_json)) : null
        : (()=>{const row=db.prepare('SELECT status,response_json FROM cli_operations WHERE op_id=?').get(opId);
          return row?{status:Number(row.status),body:JSON.parse(String(row.response_json))}:null;})();
      if(!receipt||receipt.status!==prior.status)throw new Error('Frozen operation index differs from its database');
      previous={...prior,body:receipt.body};
    }
    return {state:previous?'before_restore':'unknown_after_restore',restoreId:recovery.id,...previous?{previous}:{},notFoundProvesUnexecuted:false};
  } finally {db.close();}
}

/** Explanation beside the verifier; this text grants no authority and performs no recovery reads. */
export const recoveryAccessHelp = 'Frozen --backup continuation: a Run must present the same admitted Run ID and matching token. The frozen recovery grant is scoped to that recovery; it does not grant ordinary workspace access. Without a frozen grant, release authorization is checked against the retained failure snapshot by its matching maintenance reader.';
