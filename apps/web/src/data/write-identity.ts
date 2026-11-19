import { restoreIdSchema } from '@alpacawork/contract/recovery';
import { z } from 'zod';

const pinSchema=z.object({restoreId:restoreIdSchema.nullable()}).strict();
const pinKey=(root:string,opId:string)=>'alpacawork-write-identity:'+JSON.stringify([root,opId]);
function readPin(root:string,opId:string) {
  const raw=sessionStorage.getItem(pinKey(root,opId));
  return raw===null ? null : pinSchema.parse(JSON.parse(raw));
}
/** Continuing an admitted operation requires its original evidence. Reading never creates or repairs a pin. */
export function readWriteIdentity(root:string,opId:string):string|null {
  return readPin(root,opId)?.restoreId ?? null;
}
/** One tab's immutable epoch for each existing operation identity. Payload/authority stay with their existing owners.
 * Only new admission/first transport may establish evidence; continuation uses readWriteIdentity. */
export function rememberWriteIdentity(root:string,opId:string,restoreId:string|null):string|null {
  const saved=readPin(root,opId);
  if(saved!==null)return saved.restoreId;
  const pin=pinSchema.parse({restoreId});sessionStorage.setItem(pinKey(root,opId),JSON.stringify(pin));return pin.restoreId;
}

/** A presentation/continuation proof; storage or parse faults never authorize a new operation. */
export function provenWriteIdentity(root: string, opId: string): string | null {
  try { return readWriteIdentity(root, opId); } catch { return null; }
}
