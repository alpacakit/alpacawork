import { type WriteBasis } from './connection';
import type { QueryClient } from '@tanstack/react-query';
import { stopResponseSchema, serverSettingsSchema, personalSettingsResponseSchema } from '@alpacawork/contract';
import { taskWriteResultSchema, taskPlacementResultSchema } from '@alpacawork/contract/control';
import { createApi, ApiError, requireWriteAccess } from './client';
import { writeTask } from './task-write';
import { checkWriteIntent, sendWriteIntent, submitWriteIntent, bindIntentTransport, intentKeyParts, reloadedWrites, reloadedWaiting, useWriteIntentStore, type WriteIntent, type WriteOptions } from './write-intent';

const api = createApi();
type DirectRecovery = NonNullable<WriteIntent['recovery']>;
type Results = {
  task: ReturnType<typeof taskWriteResultSchema.parse> & { local: 'applied' | 'scope-changed' | 'failed' };
  placement: ReturnType<typeof taskPlacementResultSchema.parse>;
  settings: ReturnType<typeof serverSettingsSchema.parse>;
  personal: ReturnType<typeof personalSettingsResponseSchema.parse>;
  stop: ReturnType<typeof stopResponseSchema.parse>;
};

/** The fixed route and response contract travel with the fixed input, including after reload. */
async function deliver<K extends keyof Results>(client: QueryClient, recovery: DirectRecovery & { response: K }, input: Record<string, unknown>, opId: string, basis: WriteBasis, keepalive = false): Promise<Results[K]> {
  const original = input; input = recovery.body ?? input;
  basis = bindIntentTransport(basis, original, input, opId);
  const result = recovery.response === 'task'
    ? await writeTask(client, recovery.path, input, taskWriteResultSchema, opId, basis, keepalive)
    : recovery.response === 'placement' ? await writeTask(client, recovery.path, input, taskPlacementResultSchema, opId, basis, keepalive)
    : await api.request(recovery.path, recovery.response === 'settings' ? serverSettingsSchema as import('zod').z.ZodType<unknown> : recovery.response === 'personal' ? personalSettingsResponseSchema as import('zod').z.ZodType<unknown> : stopResponseSchema as import('zod').z.ZodType<unknown>, undefined, input, opId, basis, keepalive);
  return result as Results[K];
}

export function sendDirectIntent<K extends keyof Results>(client: QueryClient, key: string, recovery: DirectRecovery & { response: K }, build: (operationId: string) => Record<string, unknown>, basis: WriteBasis, options?: WriteOptions): Promise<Results[K]> {
  requireWriteAccess(basis);
  return sendWriteIntent(key, build, (input, opId, confirmationBasis, keepalive) => deliver(client, recovery, input, opId, confirmationBasis ?? basis, keepalive), recovery, options);
}

/** Forms close at admission, while delivery continues under the immutable operation ID. */
export function admitDirectIntent<K extends keyof Results>(client: QueryClient, key: string, recovery: DirectRecovery & { response: K }, build: (operationId: string) => Record<string, unknown>, basis: WriteBasis, options?: WriteOptions): import('./write-intent').Submission<Results[K]> {
  requireWriteAccess(basis);
  let id: string | undefined;
  const result = submitWriteIntent(key, build, (input, opId, confirmationBasis, keepalive) => deliver(client, recovery, input, opId, confirmationBasis ?? basis, keepalive), undefined, options?.draft, recovery,
    { ...options, admitted: entry => { id = entry.operationId; options?.admitted?.(entry); } });
  return result && id ? { kind: 'accepted', id, result } : { kind: 'rejected', reason: 'Check the saved operation or browser storage before sending' };
}

/** Resume this page's unresolved attempts once; report whether any deferred checks were consumed. */
export function resumeDirectIntents(client: QueryClient, root: string) {
  let resumed = false;
  for (const [key, entry] of Object.entries(useWriteIntentStore.getState().entries)) {
    if (intentKeyParts(key).root !== root || !entry.recovery || !reloadedWaiting.has(key) && !reloadedWrites.has(key)) continue;
    reloadedWrites.delete(key); reloadedWaiting.delete(key);
    resumed = true;
    const recovery = entry.recovery;
    void checkWriteIntent<Record<string, unknown>, unknown>(key, (input, opId, basis, keepalive) => deliver(client, recovery, input, opId, basis!, keepalive), true)?.catch(() => {});
  }
  return resumed;
}

/** Confirm only the old fixed request. Never consumes, rebases or sends the person's newer input. */
export function checkDirectIntent(client: QueryClient, key: string): Promise<unknown> {
  const held = useWriteIntentStore.getState().entries[key];
  const recovery = held?.recovery;
  if (!recovery) return Promise.reject(new ApiError(
    'The earlier result cannot be checked by this client. Its original input and saved record are retained.', 'unavailable', 'check'));
  const result = checkWriteIntent<Record<string, unknown>, unknown>(key,
    (input, opId, basis) => deliver(client, recovery, input, opId, basis!));
  return result ?? Promise.reject(new ApiError('The saved operation is already being checked or browser storage is unavailable', 'unavailable', 'check'));
}
