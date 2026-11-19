import { createElement, type ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMobileAccess } from '../src/data/mobile-access';
import { useConnection } from '../src/data/connection';
import { indexOf, tree } from './fixtures';

let client: QueryClient;
const serving = { status: 'serving', localUrl: 'http://127.0.0.1:5499/', publicUrl: 'https://pc.example-tail.ts.net/' };
const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
const identity = (root = '/fixture', generation = '00000000-0000-4000-8000-000000000001') =>
  client.setQueryData(['index'], { ...indexOf(tree({})), root, generation });

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useConnection.setState({ state: 'live', offline: false });
  identity();
});
afterEach(() => { cleanup(); client.clear(); vi.restoreAllMocks(); useConnection.setState(useConnection.getInitialState()); });

test('a mounted dialog rechecks an existing success before exposing it', async () => {
  client.setQueryData(['mobile-access', '/fixture', '00000000-0000-4000-8000-000000000001'], serving);
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
  const view = renderHook(useMobileAccess, { wrapper });
  expect(view.result.current.data).toBeUndefined();
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(view.result.current.data).toBeUndefined();
});

test('reads the published URL through the API, preserves null and never infers a URL', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(serving)));
  const view = renderHook(useMobileAccess, { wrapper });
  await waitFor(() => expect(view.result.current.data).toEqual(serving));
  expect(fetch.mock.calls[0]![0]).toBe('/api/workspace/url');
  for (const answer of [
    { ...serving, publicUrl: null },
    { status: 'unavailable', localUrl: null, publicUrl: null },
    { status: 'unverified', localUrl: null, publicUrl: null },
  ]) {
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(answer)));
    await act(async () => { await view.result.current.refetch(); });
    await waitFor(() => expect(view.result.current.data).toEqual(answer));
  }
});

test('hides a successful QR while refetching, then keeps it hidden on HTTP or malformed response failure', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(serving)));
  const view = renderHook(useMobileAccess, { wrapper });
  await waitFor(() => expect(view.result.current.data?.publicUrl).toBe(serving.publicUrl));
  let reply!: (response: Response) => void;
  fetch.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
  act(() => { void view.result.current.refetch(); });
  await waitFor(() => expect(view.result.current.isFetching).toBe(true));
  expect(view.result.current.data).toBeUndefined();
  await act(async () => reply(new Response('{}', { status: 503 })));
  await waitFor(() => expect(view.result.current.isError).toBe(true));
  expect(view.result.current.data).toBeUndefined();
  expect(view.result.current.error).toMatchObject({ code: 'http_error' });
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ...serving, publicUrl: 12 })));
  await act(async () => { await view.result.current.refetch(); });
  expect(view.result.current.data).toBeUndefined();
  await waitFor(() => expect(view.result.current.error).toMatchObject({ code: 'invalid_response' }));
});

test('root and serve generation changes hide previous success and in-flight responses', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(serving)));
  const view = renderHook(useMobileAccess, { wrapper });
  await waitFor(() => expect(view.result.current.data).toEqual(serving));
  let oldReply!: (response: Response) => void;
  fetch.mockImplementationOnce(() => new Promise(resolve => { oldReply = resolve; }));
  act(() => identity('/fixture', '00000000-0000-4000-8000-000000000002'));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(view.result.current.data).toBeUndefined();
  const oldSignal = fetch.mock.calls[1]![1]?.signal;
  let newReply!: (response: Response) => void;
  fetch.mockImplementationOnce(() => new Promise(resolve => { newReply = resolve; }));
  act(() => identity('/another-root', '00000000-0000-4000-8000-000000000003'));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => oldReply(new Response(JSON.stringify(serving))));
  expect(view.result.current.data).toBeUndefined();
  const latest = { ...serving, publicUrl: 'https://new.example-tail.ts.net:8443/' };
  await act(async () => newReply(new Response(JSON.stringify(latest))));
  await waitFor(() => expect(view.result.current.data).toEqual(latest));
  act(() => useConnection.setState({ offline: true }));
  expect(view.result.current.data).toBeUndefined();
});
