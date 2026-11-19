import { createElement, type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import type { TaskProjectedTimelineDTO } from '@alpacawork/contract/control';
import { queryClient } from '../src/data/query-client';
import { resources } from '../src/data/resources';
import { refuseRead } from '../src/data/read-model';
import { useTimelinePages } from '../src/data/timeline-pages';
import { fixtureReceipt } from './read-fixtures';
import { indexOf, served0, tree } from './fixtures';

const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);
/** Each page is told apart by the version it names. */
const labels = ['first', 'partial', 'last', 'home', 'branch'];
const page = (name: string, nextAfter: string | null = null): TaskProjectedTimelineDTO => ({ rows: [], runs: [], belowRuns: {}, events: [], anchors: {}, placements: [], nextAfter,
  ...served0, sourcePv: (labels.indexOf(name) + 1) as TaskProjectedTimelineDTO['sourcePv'] });
const named = (pages: readonly TaskProjectedTimelineDTO[]) => pages.map(p => labels[p.sourcePv - 1]);
const key = (visible: string[], scope: string | null = null) => resources.timeline('/fixture', scope, visible, [], 'from', 'to').queryKey;
afterEach(() => { cleanup(); queryClient.clear(); });

test('complete coverage survives pending and partial overlapping windows; removal and refusal withdraw only their actual source', async () => {
  const index = indexOf(tree()); fixtureReceipt(['index'], index);
  const first = key(['T1']), second = key(['T2']);
  fixtureReceipt(first, { pages: [page('first')], pageParams: [null] });
  const view = renderHook(() => useTimelinePages('/fixture'), { wrapper });
  expect(named(view.result.current)).toEqual(['first']);
  const identity = view.result.current;
  act(() => { queryClient.getQueryCache().build(queryClient, { queryKey: second }); });
  await waitFor(() => expect(view.result.current).toBe(identity));
  act(() => { fixtureReceipt(second, { pages: [page('partial', 'next')], pageParams: [null] }); });
  await waitFor(() => expect(view.result.current).toBe(identity));
  act(() => { fixtureReceipt(second, { pages: [page('partial', 'next'), page('last')], pageParams: [null, 'next'] }); });
  await waitFor(() => expect(named(view.result.current)).toEqual(['first', 'partial', 'last']));
  act(() => {
    const query = queryClient.getQueryCache().find({ queryKey: second, exact: true })!;
    refuseRead(query, index); query.setState({});
  });
  await waitFor(() => expect(named(view.result.current)).toEqual(['first']));
  act(() => { queryClient.removeQueries({ queryKey: first, exact: true }); });
  await waitFor(() => expect(view.result.current).toEqual([]));
});

test('root and generation qualify every cached source; a different list cannot reuse the old coverage', async () => {
  const index = indexOf(tree()); fixtureReceipt(['index'], index);
  fixtureReceipt(key(['T1']), { pages: [page('home')], pageParams: [null] });
  fixtureReceipt(key(['T1'], 'T1'), { pages: [page('branch')], pageParams: [null] });
  const view = renderHook(({ root }) => useTimelinePages(root),
    { wrapper, initialProps: { root: '/fixture',  } });
  expect(named(view.result.current)).toEqual(['home']);
  view.rerender({ root: '/another' }); expect(view.result.current).toEqual([]);
  view.rerender({ root: '/fixture' });
  act(() => { fixtureReceipt(['index'], { ...index, generation: 'another-boot' }); });
  await waitFor(() => expect(view.result.current).toEqual([]));
});
