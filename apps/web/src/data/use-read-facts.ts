import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { serverReadFacts, displayReadFacts, readScope, subscribeReads } from './read-model';
import { useReadPersistence } from './read-persistence';

/** QueryCache owns notifications; the resolver owns stable snapshots and all eligibility decisions. */
export function useServerReadFacts() {
  const client = useQueryClient();
  const subscribe = useCallback((changed: () => void) => subscribeReads(client, changed), [client]);
  const snapshot = useCallback(() => serverReadFacts(client), [client]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function useDisplayReadFacts() {
  const client = useQueryClient();
  const subscribe = useCallback((changed: () => void) => {
    const reads = subscribeReads(client, changed);
    const persistence = useReadPersistence.subscribe((state, before) => {
      if (state.restoredAt !== before.restoredAt) changed();
    });
    return () => { reads(); persistence(); };
  }, [client]);
  // Capture both in the external-store snapshot. In particular, an equal first live index changes
  // the source alone; a delayed effect must not assign that live source to an earlier saved frame.
  const snapshot = useMemo(() => {
    let held: { index: ReturnType<typeof displayReadFacts>; restoredAt: number | null } | undefined;
    return () => {
      const index = displayReadFacts(client);
      const restoredAt = readScope(client)?.restored ? useReadPersistence.getState().restoredAt : null;
      if (!held || held.index !== index || held.restoredAt !== restoredAt) held = { index, restoredAt };
      return held;
    };
  }, [client]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
