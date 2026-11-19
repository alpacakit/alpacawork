import { readQuery, readIndex, evaluateRead, getReadProof, taskReadState, serverReadFacts, readEntry, readRefused } from './read-model';
import { liveRead } from './resources';
import { type QueryClient, type QueryKey } from '@tanstack/react-query';
import type { ProjectedIndexDTO } from '@alpacawork/contract/control';

import { validIntentConfirmation, type IntentConfirmation } from './write-intent';
import { create } from "zustand";
import { i18n } from "@alpacawork/i18n";
import type { Connection } from "./feed";

/** The feed publishes native/stream reachability together; write access also needs the snapshot. */
export const useConnection = create<Connection & {
  /** No proven stream reachability, with or without a retained index. Native offline revokes it immediately. */
  offline: boolean;
  /** Only resources may publish a live snapshot's write permission. Never restored from disk. */
  fresh: boolean;
  writable: boolean;
  lastReceivedAt?: number;
  /** How many whole indexes have arrived (a first subscription's, or one `refresh` asked for). */
  wholes: number;
  reconnect: () => void;
  /** Subscribes again for the whole index and reads again what is shown; true once both are in. */
  refresh: () => Promise<boolean>;
}>(() => ({
  state: "connecting", message: () => i18n.t("workspace.connecting"), failures: 0,
  offline: typeof navigator !== "undefined" && navigator.onLine === false, fresh: false, writable: false, wholes: 0, reconnect: () => {}, refresh: async () => false,
}));
/** Calls `then` each time serve is back in reach after it was out of it: what was read in vain meanwhile is read again. */
export const onBackInReach = (then: () => void) => useConnection.subscribe((next, before) => { if (before.offline && !next.offline) then(); });

/** Sending needs a snapshot received in this session and a reachable feed. */
let writeClient: WeakRef<QueryClient> | undefined;
export const bindWriteAccess = (client: QueryClient) => { writeClient = new WeakRef(client); };
export type WriteBasis = { root: string; generation: string } & (
  { kind: 'workspace' } | { kind: 'row'; id: string; expectedHash: string } | { kind: 'detail'; id: string; expectedHash: string }
  | { kind: 'read'; key: QueryKey; expectedRevision: string | null }
  | { kind: 'all'; reads: WriteBasis[] } | { kind: 'confirmation'; confirmation: IntentConfirmation });
const revisionOf = (query: import('@tanstack/react-query').Query) => {
  const data = query.state.data;
  if (data && typeof data === 'object' && 'revision' in data) return data.revision as string | null;
  if (data && typeof data === 'object' && 'hash' in data) return data.hash as string | null;
  return getReadProof(query)?.marker ?? null;
};
const scope = () => {
  const client = writeClient?.deref(), index = client ? readIndex(client) : undefined;
  return { root: index?.root ?? '', generation: index?.generation ?? '' };
};
/** The live index is a view of the journal's identity; cached reads never authorize a write. */
export function writeRestoreId(root: string): string | null {
  const client=writeClient?.deref(), index=client ? readIndex(client) : undefined;
  return index?.root === root ? index.restoreId : null;
}
export const workspaceWriteBasis = (): WriteBasis => ({ ...scope(), kind: 'workspace' });
export const rowWriteBasis = (id: string, expectedHash?: string): WriteBasis => {
  const client = writeClient?.deref(), index = client ? readIndex(client) : undefined;
  return { ...scope(), kind: 'row', id, expectedHash: expectedHash ?? (client && index ? serverReadFacts(client)?.tasks.find(row => row.id === id)?.hash : undefined) ?? '' };
};
export const detailWriteBasis = (id: string, expectedHash: string): WriteBasis => ({ ...scope(), kind: 'detail', id, expectedHash });
export const readWriteBasis = (key: QueryKey, expectedRevision: string | null): WriteBasis => ({ ...scope(), kind: 'read', key, expectedRevision });
/** UI adapters capture an actual read hash/revision; the predicate never trusts a supplied snapshot. */
export function basisForRead(target?: string | QueryKey): WriteBasis {
  const client = writeClient?.deref(), index = client ? readIndex(client) : undefined;
  if (!client || !index || target === undefined) return workspaceWriteBasis();
  if (typeof target === 'string') return detailWriteBasis(target, taskReadState(client, index.root, target).view?.task.hash ?? '');
  const key = target.length === 1 && target[0] !== 'index' ? [target[0], index.root] : target;
  const query = readQuery(client, key);
  return readWriteBasis(key, query ? revisionOf(query) : null);
}
type WriteAccess = 'allowed' | 'offline' | 'forbidden' | 'conflict';
/** One assessment retains the reason; UI derives disabled and HTTP translates it to retry guidance. */
export function writeAccess(basis: WriteBasis = workspaceWriteBasis()): WriteAccess {
  const state = useConnection.getState();
  if (state.offline || state.state !== 'live' || !state.fresh) return 'offline';
  const client = writeClient?.deref(), index = client ? readIndex(client) : undefined;
  const live = client && liveRead(client);
  if (!client || !index || !live) return 'offline';
  if (!state.writable || !index.writable) return 'forbidden';
  if (live.root !== index.root || live.generation !== index.generation || basis.root !== index.root || basis.generation !== index.generation) return 'conflict';
  if (basis.kind === 'workspace') return 'allowed';
  if (basis.kind === 'confirmation') return validIntentConfirmation(basis.confirmation, index.root) ? 'allowed' : 'conflict';
  if (basis.kind === 'all') {
    for (const read of basis.reads) { const access = writeAccess(read); if (access !== 'allowed') return access; }
    return 'allowed';
  }
  if (basis.kind === 'row') {
    const task = readQuery(client, ['task', index.root, basis.id]);
    if (task && readRefused(task)) return 'forbidden';
    return !index.staleIds.includes(basis.id) && serverReadFacts(client)?.tasks.find(row => row.id === basis.id)?.hash === basis.expectedHash ? 'allowed' : 'conflict';
  }
  if (basis.kind === 'detail') {
    const read = taskReadState(client, index.root, basis.id);
    if (read.assessment.state === 'refused') return 'forbidden';
    return read.assessment.project && read.view?.task.hash === basis.expectedHash ? 'allowed' : 'conflict';
  }
  const query = readQuery(client, basis.key);
  if (query && readRefused(query)) return 'forbidden';
  return query && evaluateRead(index, readEntry(query)).project && revisionOf(query) === basis.expectedRevision ? 'allowed' : 'conflict';
}
export const canSendWrites = (basis?: WriteBasis) => writeAccess(basis) === 'allowed';
