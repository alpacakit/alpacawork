import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { useQueries, useQueryClient, type Query } from '@tanstack/react-query';
import type { TaskTimelineLaneDTO } from '@alpacawork/contract/control';
import { isDatedRead, subscribeReads } from './read-model';
import { assessRead, recoverReads, resources } from './resources';

const sameItems = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((item, at) => item === b[at]);
const isLane = (query: Query) => query.queryKey.length === 6 && query.queryKey[2] === 'lane';

/** Acquired coverage of this list: every row's strip held for any range. Cache entries own the strips and their
 * qualification; a row not read yet for the range in view must not withdraw what was read for another one. */
export function useTimelineLanes(root: string) {
  const client = useQueryClient();
  const subscribe = useCallback((changed: () => void) => subscribeReads(client, changed), [client]);
  const snapshot = useMemo(() => {
    let previous: TaskTimelineLaneDTO[] = [];
    return () => {
      const next = client.getQueryCache().findAll({ queryKey: ['task-timeline', root, 'lane'] })
        .filter(query => isLane(query) && query.state.data !== undefined && assessRead(client, query).display)
        .sort((a, b) => a.state.dataUpdatedAt - b.state.dataUpdatedAt)
        .map(query => query.state.data as TaskTimelineLaneDTO);
      if (!sameItems(next, previous)) previous = next;
      return previous;
    };
  }, [client, root]);
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * The rows in view read over one range: what each row holds for it, and one failure to show for the reads that failed
 * (a read kept from an earlier time says its time only through the offline mark). On an offline restart the clock has
 * moved: the range is the last one this list read, so its saved strips are drawn.
 */
export function useLaneReads(root: string, lanes: readonly string[], range: { from: string; to: string }, offline: boolean, enabled: boolean) {
  const client = useQueryClient();
  const retained = offline ? client.getQueryCache().findAll({ queryKey: ['task-timeline', root, 'lane'] })
    .filter(query => isLane(query) && lanes.includes(String(query.queryKey[3])) && assessRead(client, query).display)
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)[0] : undefined;
  const from = retained ? String(retained.queryKey[4]) : range.from, to = retained ? String(retained.queryKey[5]) : range.to;
  // Rows not read while the strips are off: leaving their reads gives up what is still being read.
  const queries = useMemo(() => enabled ? lanes.map(lane => resources.timelineLane(root, lane, from, to)) : [], [root, lanes, from, to, enabled]);
  const held = useRef<TaskTimelineLaneDTO[]>([]);
  const results = useQueries({ queries });
  const shown = results.flatMap(result => result.data ? [result.data] : []);
  if (!sameItems(shown, held.current)) held.current = shown;
  const failed = queries.flatMap(({ queryKey }) => {
    const query = client.getQueryCache().find({ queryKey, exact: true });
    return query?.state.status === 'error' && !isDatedRead(assessRead(client, query)) ? [query] : [];
  });
  return { shown: held.current, error: failed[0]?.state.error ?? null,
    absent: offline && enabled && !results.some(result => result.data !== undefined || result.isFetching),
    retry: () => void recoverReads(client, failed.map(query => query.queryKey)) };
}
