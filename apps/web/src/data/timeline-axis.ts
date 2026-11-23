import { useMemo, useRef } from 'react';
import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import { joinBusy, type Busy } from '@alpacawork/contract';
import type { TaskProjectedTimelineAxisDTO } from '@alpacawork/contract/control';
import { newestHeldRead, resources } from './resources';
import { queryClient } from './query-client';
import { useConnection } from './connection';

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
  const offline = useConnection(state => state.offline);
  // A complete previous set is a reading snapshot while a changed set loads, never a partial union of the new set.
  const last = useRef<{ root: string; busy: Busy; earliest: number | null } | null>(null);
  if (!enabled || last.current?.root !== root) last.current = null;
  if (enabled && result.busy !== undefined) last.current = { root, busy: result.busy, earliest: result.earliest };
  // Out of reach with none on this screen (a restart whose rows are not the set last read), the strips' rule stands in:
  // the newest held read of the rows in view (an axis holding one of them), never a part of this set's own.
  const standIn = enabled && offline && !last.current ? (() => {
    const own = new Set(queries.map(query => JSON.stringify(query.queryKey))), rows = new Set(lanes);
    return newestHeldRead(queryClient, ['task-timeline', root, 'axis'], query => !own.has(JSON.stringify(query.queryKey))
      && String(query.queryKey[3]).split(',').some(id => rows.has(id)))?.state.data as TaskProjectedTimelineAxisDTO | undefined;
  })() : undefined;
  const shown = last.current ?? standIn;
  return { busy: shown?.busy, earliest: shown?.earliest ?? null, standIn: !last.current && !!standIn, error: result.error,
    retry: () => { for (const query of queries) void queryClient.refetchQueries({ queryKey: query.queryKey, exact: true }); } };
}
