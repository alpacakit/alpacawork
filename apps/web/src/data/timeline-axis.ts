import { useMemo, useRef } from 'react';
import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import { joinBusy, type Busy } from '@alpacawork/contract';
import type { TaskProjectedTimelineAxisDTO } from '@alpacawork/contract/control';
import { resources } from './resources';
import { queryClient } from './query-client';

function combine(results: UseQueryResult<TaskProjectedTimelineAxisDTO>[]) {
  const ready = results.every(result => result.data !== undefined);
  let earliest: number | null = null;
  results.forEach(result => {
    const at = result.data?.earliest;
    if (at !== null && at !== undefined) earliest = Math.min(earliest ?? Infinity, at);
  });
  return { busy: ready ? joinBusy(results.flatMap(result => result.data!.busy)) : undefined,
    earliest, error: results.find(result => result.isError)?.error ?? null };
}

/** All rendered lanes, including those below the vertical viewport. Never publish a partly read union. */
export function useTimelineAxis(root: string, lanes: string[], enabled: boolean) {
  const queries = useMemo(() => {
    if (!enabled) return [];
    const ids = [...new Set(lanes)].sort();
    return Array.from({ length: Math.ceil(ids.length / 200) }, (_, at) => {
      const chunk = ids.slice(at * 200, (at + 1) * 200);
      return resources.timelineAxis(root, chunk);
    });
  }, [root, lanes, enabled]);
  const result = useQueries({ queries, combine });
  // A complete previous set is a reading snapshot while a changed set loads, never a partial union of the new set.
  const last = useRef<{ root: string; busy: Busy; earliest: number | null } | null>(null);
  if (!enabled || last.current?.root !== root) last.current = null;
  if (enabled && result.busy !== undefined) last.current = { root, busy: result.busy, earliest: result.earliest };
  return { busy: last.current?.busy, earliest: last.current?.earliest ?? null, error: result.error,
    retry: () => { for (const query of queries) void queryClient.refetchQueries({ queryKey: query.queryKey, exact: true }); } };
}
