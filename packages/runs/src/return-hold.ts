/** Stored refusal facts. The core owns reason validation; no current settings are consulted. */
import { problemReasonSchema, type ProblemReason } from '@alpacawork/core';
export type ReturnHold = { code: string; reason: ProblemReason | null };
export function returnHold(code: string, reason?: ProblemReason | null): ReturnHold {
  if (typeof code !== 'string' || code.trim().length === 0) throw new Error('Return hold requires a nonblank code');
  return { code, reason: reason == null ? null : problemReasonSchema.parse(reason) };
}
/** Current storage only. Old short codes are transformed by stopped SQL migration. */
export function parseReturnHold(text: string): ReturnHold {
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'code,reason') throw new Error('Invalid stored return hold');
  return returnHold(value.code, value.reason);
}
