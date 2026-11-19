import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '../src/data/query-client';
import { receiveFullIndex, resources, observeReadRefusals, assessRead } from '../src/data/resources';
import { captureReadProof, recordReadProof } from '../src/data/read-model';
import { serverReadFacts } from '../src/data/read-model';
import { useServerReadFacts } from '../src/data/use-read-facts';
import { dto, indexOf, tree, viewsOf } from './fixtures';
const flushReads = () => new Promise<void>(resolve => setTimeout(resolve, 20));

afterEach(() => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); });

test.each([403, 503])('mounted closed-detail facts follow the real Query after HTTP %i', async status => {
  queryClient.clear();
  const person = { id: 'P1', taskId: 'T1', agentId: 'A1', profileKey: 'codex', responsible: true, active: true,
    revision: 1, startedAt: '2026-09-24T09:00:00Z', endedAt: null, headRunId: null,
    runtime: { displayState: 'idle', reason: null, sourceRunIds: [], runningCount: 0, queuedCount: 0,
      since: null, lastOutputAt: null, activityKind: null, toolName: null } } as any;
  const value = tree({ tasks: [dto({ state: 'done' })], placements: [person] });
  const index = { ...indexOf(value), tasks: [], placements: [] };
  receiveFullIndex(queryClient, index);
  const options = resources.taskView(index.root, 'T1'), key = options.queryKey;
  queryClient.setQueryData(key, viewsOf(value)[0]);
  const query = queryClient.getQueryCache().find({ queryKey: key, exact: true })!;
  recordReadProof(query, captureReadProof(index, key));
  const hook = renderHook(() => useServerReadFacts(), {
    wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
  expect(hook.result.current?.placements).toEqual([person]);
  observeReadRefusals(queryClient);
  const events: string[] = [];
  const unsubscribe = queryClient.getQueryCache().subscribe(event => {
    if (event.query === query) events.push(event.type === 'updated' ? event.action.type : event.type);
  });
  try {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status }));
    await act(async () => { await queryClient.fetchQuery({ ...options, staleTime: 0 }).catch(() => {}); await flushReads(); });
    const direct = serverReadFacts(queryClient)!, mounted = hook.result.current;
    const assessment = assessRead(queryClient, query), dataPresent = query.state.data !== undefined;
    console.log('projection-before-control', JSON.stringify({ status, dataPresent, assessment, direct, mounted, events }));
    expect(queryClient.getQueryCache().find({ queryKey: key, exact: true })).toBe(query);
    expect(dataPresent).toBe(status === 503);
    expect(direct.placements).toEqual(status === 403 ? [] : [person]);
    expect(mounted).toEqual(direct);
    // The same Query's removal is a control after preserving the original mismatch, never its repair.
    await act(async () => { queryClient.removeQueries({ queryKey: key, exact: true }); await flushReads(); });
    expect((hook.result.current?.placements ?? [])).toEqual([]);
  } finally { unsubscribe(); }
});
