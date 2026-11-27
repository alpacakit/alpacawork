/** Local immutable write pins survive a lost response and a later invocation with the same op-id. */
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { publishImmutable, readImmutable, Problem, PROBLEM_CODE, hasCode } from '@alpacawork/core';
import { userStateDirectory } from '@alpacawork/cli-kit';
import { request, type PreparedRequest } from './transport.js';
import { RESTORE_HEADER,recoveryIdentitySchema,restoreIdSchema } from '@alpacawork/contract/recovery';
import { z } from 'zod';
import { CONTRACT_HEADER } from '@alpacawork/contract/client-contract';
const pinSchema=z.object({version:z.literal(1),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),restoreId:restoreIdSchema}).strict();
const digest=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
function withRestore(prepared: PreparedRequest, restoreId: string): PreparedRequest {
  const headers = new Headers(prepared.headers as [string, string][]);
  headers.set(RESTORE_HEADER, restoreId);
  return Object.freeze({ ...prepared, headers: Object.freeze([...headers].map(pair => Object.freeze(pair))) });
}

export async function pinRestore(prepared:PreparedRequest,opId:string,server:string,timeoutMs:number):Promise<PreparedRequest> {
  const env=process.env;
  if (env.ALPACAWORK_PROGRAM_TOKEN !== undefined) {
    const restore = restoreIdSchema.safeParse(env.ALPACAWORK_PROGRAM_RESTORE_ID);
    if (!restore.success) throw new Problem(PROBLEM_CODE.forbidden, 'The automation program has no workspace restore identity');
    return withRestore(prepared, restore.data);
  }
  const base=join(userStateDirectory(env),'write-pins',digest(server));
  const name=digest(opId)+'.json';
  // Caller claims and transport compatibility are not the operation's immutable input.
  const callerHeaders=new Set(['authorization','x-alpacawork-provider','x-alpacawork-conversation','x-alpacawork-cwd','x-alpacawork-client',CONTRACT_HEADER.toLowerCase()]);
  const operationHeaders=prepared.headers.filter(([name])=>!callerHeaders.has(name.toLowerCase()));
  const fingerprint=digest(JSON.stringify([prepared.url,prepared.method,operationHeaders,digest(prepared.body??'')]));
  const read=():{fingerprint:string;restoreId:string} => {
    const checked=pinSchema.safeParse(JSON.parse(readImmutable(base,name,4096).toString('utf8')));
    if(!checked.success||checked.data.fingerprint!==fingerprint)
      throw new Problem(PROBLEM_CODE.idempotencyConflict,'Operation ID was already pinned to different input');
    return checked.data;
  };
  let pinned:{fingerprint:string;restoreId:string};
  try {pinned=read();}catch(error) {
    if(!hasCode(error,'ENOENT'))throw error;
    const reply=await request(server,'/api/runtime/recovery','GET',undefined,new Headers(prepared.headers as [string,string][]),timeoutMs);
    const checked=recoveryIdentitySchema.safeParse(reply);
    if(!checked.success)throw new Problem(PROBLEM_CODE.conflict,'Server has no recovery identity protocol; use matching maintenance code');
    // Publication creates the directory and certifies every ancestor itself.
    try {publishImmutable(base,name,Buffer.from(JSON.stringify({version:1,fingerprint,restoreId:checked.data.restoreId})));}
    catch(error){if(!hasCode(error,'EEXIST')&&!(error instanceof Error&&hasCode(error.cause,'EEXIST')))throw error;}
    // A concurrent first caller may have selected the earlier identity. The immutable winner owns this operation.
    pinned=read();
  }
  return withRestore(prepared, pinned.restoreId);
}
