/** serve imports local stop intentions before any queued launch. */
import { join } from 'node:path';
import { publishImmutable, readImmutable, strictJson } from '@alpacawork/core';
import { localStopSchema, PROTOCOL_LIMITS } from '@alpacawork/contract/run-protocol';
import { names } from './execution-files.js';
import { requestStop } from './entry.js';
import type { RunStore } from '@alpacawork/runs';
export function publishWorkspaceIdentity(store: RunStore): void {
  const workspaceId = String(store.connection.prepare('SELECT id FROM workspace_identity WHERE singleton=1').get()!.id);
  publishImmutable(join(store.root, '.alpacawork'), 'execution-identity.json', JSON.stringify({ protocol: 1, workspaceId }));
}
export function importLocalStops(store: RunStore): void {
  const path = join(store.root, '.alpacawork', 'local-stops');
  const workspaceId = String(store.connection.prepare('SELECT id FROM workspace_identity WHERE singleton=1').get()!.id);
  for (const name of names(path)) {
    const stop = localStopSchema.parse(strictJson(readImmutable(path, name, PROTOCOL_LIMITS.command)));
    if (name !== `${stop.operationId}.json` || stop.workspaceId !== workspaceId) throw new Error('Local stop identity mismatch');
    if (!store.runtimeGet(stop.targetRunId)) throw new Error('Local stop target missing');
    // Already stopped is idempotent. A coordinator's Run is no Task's: run stop does not find it, its manager stops it.
    try { requestStop(store.root, { run: stop.targetRunId }, stop.operationId); }
    catch (error) { if ((error as { code?: string }).code !== 'not_found') throw error; }
  }
}
