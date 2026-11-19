import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type { TaskProjectedTimelineDTO } from '@alpacawork/contract/control';
import { subscribeReads } from './read-model';
import { assessRead } from './resources';

/** Acquired coverage of this list. Cache entries own the pages and their qualification; a
 * pending/partial viewport must not withdraw records acquired for an overlapping viewport. */
export function useTimelinePages(root: string) {
  const client = useQueryClient();
  const subscribe = useCallback((changed: () => void) => subscribeReads(client, changed), [client]);
  const snapshot = useMemo(() => {
    let previous: InfiniteData<TaskProjectedTimelineDTO>[] = [], pages: TaskProjectedTimelineDTO[] = [];
    return () => {
      const next = client.getQueryCache().findAll({ queryKey: ['task-timeline', root, 'root'] })
        .filter(query => query.queryKey.length === 7
          && (query.state.data as InfiniteData<TaskProjectedTimelineDTO> | undefined)?.pages.at(-1)?.nextAfter === null
          && assessRead(client, query).display)
        .sort((a, b) => a.state.dataUpdatedAt - b.state.dataUpdatedAt)
        .map(query => query.state.data as InfiniteData<TaskProjectedTimelineDTO>);
      if (next.length !== previous.length || next.some((data, at) => data !== previous[at])) {
        previous = next;
        pages = next.flatMap(data => data.pages);
      }
      return pages;
    };
  }, [client, root]);
  return useSyncExternalStore(subscribe, snapshot);
}
