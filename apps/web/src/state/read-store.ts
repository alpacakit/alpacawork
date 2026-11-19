import { rowWriteBasis } from '@/data/connection';
import { useSyncExternalStore } from "react";
import { i18n } from "@alpacawork/i18n";
import { notify } from "../lib/notify";
import { createNoticeStore, type NoticeReadResult } from "../data/notice-store";
import { taskEvents } from "../data/notice-model";
import { queryClient } from "../data/query-client";
import type { ProjectedIndexDTO } from "@alpacawork/contract/control";
import { indexKey } from "../data/resources";
import { serverReadFacts, subscribeReads } from "../data/read-model";
import { canSendWrites, useConnection } from "../data/connection";
import { isAgentView } from "../lib/agent-view";

const store = createNoticeStore();
const failedReads = new Set<string>();
const scopeKey = (index: ProjectedIndexDTO | undefined) => index && JSON.stringify([index.root, index.generation]);
let failureScope: string | undefined;
/** As with explicit submissions, only a confirmed missing effect is a recoverable screen failure.
 * Keep the notification tied to its unread rows; later confirmed reads retire it. */
function reconcileReadFailure() {
  if (!failedReads.size) return;
  if (failureScope !== scopeKey(queryClient.getQueryData<ProjectedIndexDTO>(indexKey))) {
    failedReads.clear(); notify.dismiss('read-failed'); return;
  }
  const state = store.getState(), facts = serverReadFacts(queryClient);
  if (!state.fresh || !state.checkpoint || !facts) return;
  const unread = new Set(taskEvents(facts.tasks, { ...state.checkpoint.tasks, ...state.reads }).map(event => event.task.id));
  for (const id of failedReads) if (!unread.has(id)) failedReads.delete(id);
  if (!failedReads.size) notify.dismiss('read-failed');
}
store.subscribe(reconcileReadFailure);
export function reportReadResult(ids: readonly string[], result: NoticeReadResult, source: ProjectedIndexDTO | undefined) {
  reconcileReadFailure();
  if (scopeKey(source) !== scopeKey(queryClient.getQueryData<ProjectedIndexDTO>(indexKey))) return;
  if (result === false) {
    failureScope = scopeKey(source);
    for (const id of ids) failedReads.add(id);
  }
  reconcileReadFailure();
  if (result === false && failedReads.size) showReadFailure();
}
function showReadFailure() {
  notify.error(i18n.t("ui:allRead.failed"), { id: "read-failed" });
}
/** Retained rows of an unreadable scan are shown, never acknowledged as read: what the checkpoint receives leaves them out. */
export function receiveServerFacts(server: ProjectedIndexDTO) {
  const stale = new Set(server.staleIds);
  store.getState().receive(server.root, server.tasks.filter(row => !stale.has(row.id)), server.person.notices);
}
export function useReadStore<T>(selector: (state: ReturnType<typeof store.getState>) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}
useReadStore.getState = store.getState;
useReadStore.setState = store.setState;
useReadStore.getInitialState = store.getInitialState;

/** One ready boundary for current visible reading: neither restored notices nor a hidden page acknowledge news. */
function readReady() {
  const notices = store.getState(), index = queryClient.getQueryData<ProjectedIndexDTO>(indexKey);
  // The first baseline is not a saved checkpoint until initialization returns its revision.
  return !!serverReadFacts(queryClient) && canSendWrites() && notices.status === 'ready' && notices.revision !== null && notices.fresh && notices.root === index?.root
    && notices.serverRevision === index?.person.notices
    && document.visibilityState === 'visible';
}
const subscribeReady = (changed: () => void) => {
  const connection = useConnection.subscribe(changed), notices = store.subscribe(changed), reads = subscribeReads(queryClient, changed);
  document.addEventListener('visibilitychange', changed);
  return () => { connection(); notices(); reads(); document.removeEventListener('visibilitychange', changed); };
};
export const useReadReady = () => useSyncExternalStore(subscribeReady, readReady);

/**
 * Navigation acknowledges current facts, never an unreadable retained task.
 * A page opened with `?agent=1` (an agent checking the screen) reads without taking the reader's news.
 * Nothing is acknowledged while writes cannot be sent (out of reach, or a list read back from this device before a
 * fresh index): what was seen then is not queued, and stays news until it is seen again.
 */
function readableTask(id: string) {
  if (isAgentView() || !readReady()) return;
  const index = queryClient.getQueryData<ProjectedIndexDTO>(indexKey);
  if (!index) return;
  const task = (serverReadFacts(queryClient)?.tasks ?? []).find((task) => task.id === id);
  if (!task || index.staleIds.includes(id) || !canSendWrites(rowWriteBasis(id, task.hash))) return;
  return task;
}

export async function markRead(id: string) {
  store.getState().release([id]);
  const task = readableTask(id);
  if (!task) return;
  const source = queryClient.getQueryData<ProjectedIndexDTO>(indexKey);
  const saved = await store.getState().read(task);
  reportReadResult([id], saved, source);
}

const visiblePending = new Map<string, NonNullable<ReturnType<typeof serverReadFacts>>['tasks'][number]>();
let visibleTimer: ReturnType<typeof setTimeout> | undefined;
/** Intersection deliveries in one scroll movement save one revision, even if many rows enter view. */
export function markVisibleRead(id: string) {
  store.getState().hold([id]);
  const task = readableTask(id);
  if (!task) return;
  visiblePending.set(id, task);
  if (visibleTimer) return;
  visibleTimer = setTimeout(() => {
    visibleTimer = undefined;
    const tasks = [...visiblePending.keys()].flatMap(id => { const task = readableTask(id); return task ? [task] : []; });
    visiblePending.clear();
    // The connection may have gone in the meantime: the same rule decides at the send.
    if (!tasks.length) return;
    const source = queryClient.getQueryData<ProjectedIndexDTO>(indexKey);
    void store.getState().readMany(tasks).then(saved => reportReadResult(tasks.map(task => task.id), saved, source));
  }, 50);
}
