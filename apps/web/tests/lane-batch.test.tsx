import { createElement, type ReactNode } from 'react';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import type { TaskTimelineLaneDTO, TaskTimelineLanesDTO } from '@alpacawork/contract/control';
import { laneBatches } from '../src/data/lane-batch';
import { ApiError, DeadlinePassed } from '../src/data/client';
import { useConnection } from '../src/data/connection';
import { queryClient } from '../src/data/query-client';
import { api, resources } from '../src/data/resources';
import { useLaneReads } from '../src/data/timeline-lanes';
import { fixtureReceipt } from './read-fixtures';
import { dto, indexOf, timelineLaneAnswer, tree } from './fixtures';

const value = tree({ tasks: [dto({ id: 'T1' }), dto({ id: 'T2', path: 'tasks/T2' }), dto({ id: 'T3', path: 'tasks/T3' })] });
const strip = (lane: string) => timelineLaneAnswer(value, lane) as unknown as TaskTimelineLaneDTO;
const asked = (path: string) => new URL(path, 'http://fixture').searchParams.get('lanes')!.split(',');
afterEach(() => { cleanup(); queryClient.clear(); vi.useRealTimers(); vi.restoreAllMocks(); useConnection.setState({ offline: false }); });

test('rows asked in one turn go as one read; rows left for size are asked again; a row the server lacks is a missing Task', async () => {
  const request = vi.fn(async (path: string): Promise<TaskTimelineLanesDTO> => {
    const lanes = asked(path).filter(id => id !== 'T9');
    // The first answer is full after one row: the rest are asked again.
    return { lanes: (request.mock.calls.length === 1 ? lanes.slice(0, 1) : lanes).map(strip), gone: asked(path).filter(id => id === 'T9') };
  });
  const read = laneBatches(request);
  const reads = ['T1', 'T2', 'T3', 'T9'].map(lane => read(lane, 'from', 'to'));
  const settled = await Promise.allSettled(reads);
  expect(request.mock.calls.map(([path]) => asked(path))).toEqual([['T1', 'T2', 'T3', 'T9'], ['T2', 'T3']]);
  expect(settled.slice(0, 3).map(result => result.status === 'fulfilled' && result.value.lane)).toEqual(['T1', 'T2', 'T3']);
  expect(settled[3]).toMatchObject({ status: 'rejected', reason: { code: 'not_found' } });
});

test('a read goes on while one of its rows waits for it, and is given up when none does', async () => {
  const signals: AbortSignal[] = [];
  let answer!: (value: TaskTimelineLanesDTO) => void;
  const read = laneBatches((_path, signal) => { signals.push(signal); return new Promise(resolve => { answer = resolve; }); });
  const first = new AbortController(), second = new AbortController();
  const kept = read('T1', 'from', 'to', first.signal);
  void read('T2', 'from', 'to', second.signal).catch(() => {});
  await Promise.resolve();
  second.abort();
  expect(signals[0]!.aborted).toBe(false);
  answer({ lanes: [strip('T1')], gone: [] });
  await expect(kept).resolves.toMatchObject({ lane: 'T1' });
  const third = new AbortController();
  void read('T3', 'from', 'to', third.signal).catch(() => {});
  await Promise.resolve();
  third.abort();
  expect(signals[1]!.aborted).toBe(true);
});

test('a read the server stayed silent on is asked again as the same one read', async () => {
  vi.useFakeTimers();
  const request = vi.fn(async (path: string): Promise<TaskTimelineLanesDTO> => {
    if (request.mock.calls.length === 1) throw new DeadlinePassed(new Error('Synthetic timeout'));
    return { lanes: asked(path).map(strip), gone: [] };
  });
  const read = laneBatches(request);
  const reads = Promise.all(['T1', 'T2', 'T3'].map(lane => read(lane, 'from', 'to')));
  await vi.runAllTimersAsync();
  expect((await reads).map(lane => lane.lane)).toEqual(['T1', 'T2', 'T3']);
  expect(request.mock.calls.map(([path]) => asked(path))).toEqual([['T1', 'T2', 'T3'], ['T1', 'T2', 'T3']]);
});

test('offline, the rows in view are drawn from the last range this list read, not the moved clock\'s', () => {
  fixtureReceipt(['index'], indexOf(value));
  fixtureReceipt(resources.timelineLane('/fixture', 'T1', 'earlier', 'then').queryKey, strip('T1'));
  useConnection.setState({ offline: true });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);
  const view = renderHook(() => useLaneReads('/fixture', ['T1'], { from: 'later', to: 'now' }, true, true), { wrapper });
  expect(view.result.current.shown.map(lane => lane.lane)).toEqual(['T1']);
  expect(view.result.current.absent).toBe(false);
});

test('a row\'s failed read is drawn as soon as it fails', async () => {
  fixtureReceipt(['index'], indexOf(value));
  vi.spyOn(api, 'request').mockRejectedValue(new ApiError('Timeline unavailable', 'unavailable', 'later'));
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);
  const view = renderHook(() => useLaneReads('/fixture', ['T1'], { from: 'from', to: 'to' }, false, true), { wrapper });
  await waitFor(() => expect(view.result.current.error).toMatchObject({ code: 'unavailable' }));
});

test('an answer holding none of the rows asked for is asked no further; a shared failure is each row\'s own', async () => {
  const request = vi.fn(async (): Promise<TaskTimelineLanesDTO> => ({ lanes: [strip('T3')], gone: [] }));
  const read = laneBatches(request);
  const settled = await Promise.allSettled(['T1', 'T2'].map(lane => read(lane, 'from', 'to')));
  expect(request).toHaveBeenCalledTimes(1);
  expect(settled.map(result => result.status === 'rejected' && (result.reason as ApiError).code)).toEqual(['invalid_response', 'invalid_response']);
  const shared = new ApiError('Timeline unavailable', 'unavailable', 'later');
  const failing = laneBatches(async () => { throw shared; });
  const failures = await Promise.allSettled(['T1', 'T2'].map(lane => failing(lane, 'from', 'to')));
  const [first, second] = failures.map(result => result.status === 'rejected' ? result.reason as ApiError : undefined);
  expect([first?.code, second?.code, first?.cause, second?.cause]).toEqual(['unavailable', 'unavailable', shared, shared]);
  expect(first).not.toBe(second);
});
