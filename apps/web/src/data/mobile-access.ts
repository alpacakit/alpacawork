import { commandRoute } from '@alpacawork/contract/command-path';
import { useCallback, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { createApi } from './client';
import { useConnection } from './connection';
import { readIndex, subscribeReads } from './read-model';

const api = createApi();
const mobileAccessSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('serving'), localUrl: z.url(), publicUrl: z.url().nullable() }),
  z.object({ status: z.literal('unavailable'), localUrl: z.null(), publicUrl: z.null() }),
  z.object({ status: z.literal('unverified'), localUrl: z.null(), publicUrl: z.null() }),
]);

/** Only serve's published publicUrl may become a phone link; this read is never persisted. */
export function useMobileAccess() {
  const client = useQueryClient();
  const subscribe = useCallback((changed: () => void) => subscribeReads(client, changed), [client]);
  const snapshot = useCallback(() => readIndex(client), [client]);
  const index = useSyncExternalStore(subscribe, snapshot, snapshot);
  const reachable = useConnection(state => state.state === 'live' && !state.offline);
  const enabled = !!index && reachable;
  const query = useQuery({
    queryKey: ['mobile-access', index?.root, index?.generation],
    queryFn: ({ signal }) => api.request(commandRoute('workspace/url'), mobileAccessSchema, signal),
    enabled,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  });
  // Query normally retains its last success during refetch/failure. A QR is an action on this serve,
  // so expose only the current successful read, including when a dialog mounts over a cached result.
  return { ...query, data: enabled && query.isSuccess && !query.isFetching ? query.data : undefined };
}
