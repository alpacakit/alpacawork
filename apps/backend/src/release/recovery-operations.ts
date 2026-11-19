/** Frozen, version-matched diagnostic receipts never authorize or execute an operation. */
import { Problem,PROBLEM_CODE } from '@alpacawork/core';
import { recoveryLineage,assertMutationIdentity } from './journal.js';
import { readGroup,type DatabaseGroup } from './recovery-data.js';
const receipts=new Map<string,Map<string,DatabaseGroup['evidence']['operations'][number]>>();
export function priorRecoveryOperation(root:string,opId:string) {
  for(const identity of recoveryLineage(root)) {
    let operations=receipts.get(identity.id);
    if(!operations) {
      operations=new Map(readGroup(identity.failure,root).evidence.operations.map(op=>[op.opId,op]));
      receipts.set(identity.id,operations);
    }
    const operation=operations.get(opId);if(operation)return operation;
  }
  return null;
}
export function assertRestoredMutation(root:string,sent:string|null,opId:string|null,currentHas:(id:string)=>boolean):void {
  assertMutationIdentity(root,sent);
  if(opId&&priorRecoveryOperation(root,opId)&&!currentHas(opId))throw new Problem(PROBLEM_CODE.restoreChanged,
    'This operation existed before restore; do not execute it again. Check its earlier result',
    {opId,notFoundProvesUnexecuted:false,priorResult:'operation get'});
}
