import { createElement, type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '../src/data/query-client';
import { api } from '../src/data/resources';
import { useTimelineAxis } from '../src/data/timeline-axis';
import type { TaskProjectedTimelineAxisDTO as TaskTimelineAxisDTO } from '@alpacawork/contract/control';
import { served0 } from './fixtures';

const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);
afterEach(() => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); });

test('201 lanes wait for every chunk; a failed chunk stays unknown, retry completes it, and workspace changes discard snapshots', async () => {
  const defaults = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  try {
    const pending: { resolve: (value: TaskTimelineAxisDTO) => void; reject: (error: Error) => void }[] = [];
    const reads: string[] = [];
    const request = vi.spyOn(api, 'request').mockImplementation(((path: string) => {
      reads.push(path);
      return new Promise<TaskTimelineAxisDTO>((resolve, reject) => pending.push({ resolve, reject }));
    }) as typeof api.request);
    const lanes = Array.from({ length: 201 }, (_, at) => `T${at + 1}`);
    const view = renderHook(({ root, enabled }: { root: string; enabled: boolean }) => useTimelineAxis(root, lanes, enabled),
      { initialProps: { root: 'root', enabled: false }, wrapper });
    expect(pending).toHaveLength(0);
    expect(view.result.current.busy).toBeUndefined();
    view.rerender({ root: 'root', enabled: true });
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(reads.map(path => new URL(path, 'http://fixture/').searchParams.get('lanes')!.split(',').length)).toEqual([200, 1]);
    await act(async () => { pending[0]!.resolve({ busy: [[100, 200]], earliest: 0, ...served0 }); });
    expect(view.result.current.busy).toBeUndefined();
    await act(async () => { pending[1]!.reject(new Error('axis unavailable')); });
    await waitFor(() => expect(view.result.current.error?.message).toBe('axis unavailable'));
    expect(view.result.current.busy).toBeUndefined();
    request.mockResolvedValue({ busy: [[100, 200]], earliest: 0, ...served0 });
    act(() => view.result.current.retry());
    await waitFor(() => expect(view.result.current.busy).toEqual([[100, 200]]));
    request.mockImplementation((() => new Promise(() => {})) as typeof api.request);
    view.rerender({ root: 'another', enabled: true });
    expect(view.result.current.busy).toBeUndefined();
  } finally { queryClient.setDefaultOptions(defaults); }
});
