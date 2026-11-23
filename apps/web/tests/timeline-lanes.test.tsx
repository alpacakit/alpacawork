import { createElement, type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import type { TaskTimelineLaneDTO } from '@alpacawork/contract/control';
import { queryClient } from '../src/data/query-client';
import { resources } from '../src/data/resources';
import { refuseRead } from '../src/data/read-model';
import { useTimelineLanes } from '../src/data/timeline-lanes';
import { fixtureReceipt } from './read-fixtures';
import { dto, indexOf, timelineLaneAnswer, tree } from './fixtures';

const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);
const value = tree({ tasks: [dto({ id: 'T1' }), dto({ id: 'T2', path: 'tasks/T2' })] });
const key = (lane: string, from = 'from') => resources.timelineLane('/fixture', lane, from, 'to').queryKey;
const named = (lanes: readonly TaskTimelineLaneDTO[]) => lanes.map(lane => `${lane.lane}@${lane.sourcePv}`);
const strip = (lane: string, sourcePv: number) => ({ ...timelineLaneAnswer(value, lane), sourcePv }) as unknown as TaskTimelineLaneDTO;
afterEach(() => { cleanup(); queryClient.clear(); });

test('coverage survives a row not read yet for another range; removal and refusal withdraw only their own strip', async () => {
  const index = indexOf(value); fixtureReceipt(['index'], index);
  fixtureReceipt(key('T1'), strip('T1', 1));
  const view = renderHook(() => useTimelineLanes('/fixture'), { wrapper });
  expect(named(view.result.current)).toEqual(['T1@1']);
  const identity = view.result.current;
  act(() => { queryClient.getQueryCache().build(queryClient, { queryKey: key('T2') }); });
  await waitFor(() => expect(view.result.current).toBe(identity));
  act(() => { fixtureReceipt(key('T2'), strip('T2', 2)); fixtureReceipt(key('T1', 'earlier'), strip('T1', 3)); });
  await waitFor(() => expect(named(view.result.current)).toEqual(['T1@1', 'T2@2', 'T1@3']));
  act(() => {
    const query = queryClient.getQueryCache().find({ queryKey: key('T2'), exact: true })!;
    refuseRead(query, index); query.setState({});
  });
  await waitFor(() => expect(named(view.result.current)).toEqual(['T1@1', 'T1@3']));
  act(() => { queryClient.removeQueries({ queryKey: key('T1'), exact: true }); });
  await waitFor(() => expect(named(view.result.current)).toEqual(['T1@3']));
});

test('a row\'s strip over a range the clock moved on replaces those before it; a range zoomed to stays', async () => {
  fixtureReceipt(['index'], indexOf(value));
  const range = (from: string, to: string) => resources.timelineLane('/fixture', 'T1', from, to).queryKey;
  const view = renderHook(() => useTimelineLanes('/fixture'), { wrapper });
  act(() => { fixtureReceipt(range('2026-01-01T00:00', '2026-01-02T00:00'), strip('T1', 1)); });
  act(() => { fixtureReceipt(range('2026-01-01T23:00', '2026-01-02T00:00'), strip('T1', 2)); });
  await waitFor(() => expect(named(view.result.current)).toEqual(['T1@1', 'T1@2']));
  act(() => { fixtureReceipt(range('2026-01-01T00:05', '2026-01-02T00:05'), strip('T1', 3)); });
  await waitFor(() => expect(named(view.result.current)).toEqual(['T1@3']));
});

test('root and generation qualify every cached strip', async () => {
  const index = indexOf(value); fixtureReceipt(['index'], index);
  fixtureReceipt(key('T1'), strip('T1', 1));
  const view = renderHook(({ root }) => useTimelineLanes(root), { wrapper, initialProps: { root: '/fixture' } });
  expect(named(view.result.current)).toEqual(['T1@1']);
  view.rerender({ root: '/another' }); expect(view.result.current).toEqual([]);
  view.rerender({ root: '/fixture' });
  act(() => { fixtureReceipt(['index'], { ...index, generation: 'another-boot' }); });
  await waitFor(() => expect(view.result.current).toEqual([]));
});
