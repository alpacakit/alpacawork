import { taskHistoryWindowSchema, type HistoryWindowRequest } from "@alpacawork/contract/control";
import { queryOptions, type QueryClient, type QueryKey, type Query as QueryRecord } from "@tanstack/react-query";
import { ApiError, createApi, readWithReason } from "./client";
import { freshHistoryRequest, historyProtection, historyWindow, olderHistoryRequest, replaceHistory, trimHistory, widenHistory, widenedSource, type HistoryData } from './history-window';
import { readDemandPending, readExecution, requestRead } from './read-demand';
import { getReadProof, readQuery, recordHistorySource } from './read-model';

type Query = QueryRecord<any, any, any, any>;

export const historyResource = (api: ReturnType<typeof createApi>, readResource: <T>(client: QueryClient, key: QueryKey, fetch: () => Promise<T>) => Promise<T>) => (root: string, id: string) => queryOptions({
    queryKey: ['task-history', root, id] as const,
    queryFn: ({ client, queryKey, signal }) => readResource(client, queryKey, () => executeHistoryRead(api, client, queryKey, signal)),
    staleTime: query => readDemandPending(query) ? 0 : Infinity,
  });

const historyQueryText = (request: HistoryWindowRequest) => {
  const { mode: _mode, ...fields } = request;
  return new URLSearchParams(Object.entries(fields).map(([name, value]) => [name, String(value)])).toString();
};
/** Windows whose reader asked to move to the latest. */
const toLatest = new WeakSet<Query>();
/** Whether a History read failed because the protected range passed HISTORY_WINDOW_MAX: the held window stays as it was. */
export const historyWindowRefused = (error: unknown) => error instanceof ApiError && error.reason?.kind === 'history_window_too_large';

/**
 * One History execution is one GET: the window's newest part again, or the part below it (read-demand's plan). Its
 * answer replaces or widens the held window; a failure leaves the held window as it was.
 */
async function executeHistoryRead(api: ReturnType<typeof createApi>, client: QueryClient, key: QueryKey, signal: AbortSignal): Promise<HistoryData> {
  const query = readQuery(client, key)!, execution = readExecution(query)!;
  const held = historyWindow(query.state.data as HistoryData | undefined);
  const older = execution.plan.kind === 'older' ? olderHistoryRequest(held) : undefined;
  if (execution.plan.kind === 'older' && !older) return query.state.data as HistoryData;
  const latest = toLatest.has(query);
  const request = older ?? freshHistoryRequest(held, historyProtection(query), latest);
  const read = (asked: HistoryWindowRequest) => readWithReason(() => api.request(`task/history?task=${encodeURIComponent(String(key[2]))}&mode=${asked.mode}`
    + (asked.mode === 'latest' ? '' : `&${historyQueryText(asked)}`), taskHistoryWindowSchema, signal),
    { kind: older ? 'history_past_unavailable' : 'history_revalidation_unavailable' });
  let response = await read(request);
  // Nothing is left from the held oldest event on (it and all after it are gone): the window starts again from the
  // newest events, whether older ones remain or not.
  if (!older && request.mode !== 'latest' && response.events.length === 0) response = await read({ mode: 'latest' });
  if (!older) toLatest.delete(query);
  const heldSource = held && getReadProof(query)?.sourcePv;
  const data = older && held ? widenHistory(held, response) : replaceHistory(response);
  recordHistorySource(data, { generation: response.generation,
    sourcePv: older && heldSource !== undefined ? widenedSource(heldSource, response.sourcePv) : response.sourcePv });
  return data;
}

/** The reader leaves the position it protected: the window is read again as the newest events. */
export function moveHistoryToLatest(client: QueryClient, root: string, id: string) {
  const query = readQuery(client, ['task-history', root, id]);
  if (!query) return;
  toLatest.add(query);
  requestRead(query);
  void query.fetch(undefined, { cancelRefetch: false }).catch(() => {});
}
/** A History no one reads goes back to its newest events, so a large window is neither kept nor read again. */
export function trimClosedHistory(query: Query) {
  const data = query.state.data as HistoryData | undefined;
  if (query.queryKey[0] !== 'task-history' || query.getObserversCount() > 0 || !data) return;
  const trimmed = trimHistory(data);
  if (trimmed !== data) query.setState({ data: trimmed });
  toLatest.delete(query);
}

export const missingHistoryRange = (key: QueryKey, error: unknown) => {
  const failure = error as { code?: string; detail?: { status?: number } };
  return key[0] === 'task-history' && (['not_found', 'task_not_found'].includes(failure.code ?? '') || failure.detail?.status === 404);
};
