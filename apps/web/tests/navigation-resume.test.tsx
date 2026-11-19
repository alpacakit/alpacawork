import { beforeAll, beforeEach, afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { dehydrate, hydrate, QueryClientProvider, isCancelledError } from '@tanstack/react-query';
import { startI18n } from '@alpacawork/i18n';
import { queryClient } from '../src/data/query-client';
import { useConnection } from '../src/data/connection';
import { receiveFullIndex } from '../src/data/resources';
import * as resources from '../src/data/resources';
import { useEveryTaskIndex } from '../src/data/queries';
import { useUrlBootstrap } from '../src/state/bootstrap';
import { useViewStore } from '../src/state/view-store';
import { createWorkspaceStore, WorkspaceContext } from '../src/data/workspace-store';
import { screenData, tree, dto, viewsOf, indexOf } from './fixtures';
import { fakeNavigation, sessionHistory } from './navigation-fake';
import { jsonAnswer } from './receipt-fixture';
import { deferred, refusal } from './forms-fixture';

const storage = 'alpacawork.navigation.v2';
const hint = { root: '/fixture', search: 'task=T111&tab=files' };
const source = () => tree({ tasks: [dto({id:'T111'}), dto({id:'T113'})] });
const saved = () => JSON.parse(localStorage.getItem(storage)!);
function Bootstrap() { useUrlBootstrap(useEveryTaskIndex()); return null; }
beforeAll(() => startI18n());
beforeEach(() => {
  queryClient.clear(); localStorage.clear(); history.replaceState(null, '', '/');
  useViewStore.setState(useViewStore.getInitialState());
  useConnection.setState({state:'live', offline:false, fresh:true, writable:true});
  sessionHistory(); fakeNavigation();
});
afterEach(() => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mountCheckpoint() {
  const data = screenData(source()), checkpoint = dehydrate(queryClient);
  // As a new page: hydrated Queries have new identities and no live reception in this session.
  queryClient.clear(); hydrate(queryClient, checkpoint);
  localStorage.setItem(storage, JSON.stringify(hint));
  useConnection.setState({state:'connecting', offline:true, fresh:false});
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async url =>
    jsonAnswer(viewsOf(source()).find(view => String(url).includes(view.task.id))));
  const accepted = vi.spyOn(resources, 'fetchAcceptedResource');
  const view = render(<QueryClientProvider client={queryClient}><WorkspaceContext value={createWorkspaceStore(data)}><Bootstrap /></WorkspaceContext></QueryClientProvider>);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return { ...view, fetcher, accepted };
}
async function connect() {
  await act(async () => {
    receiveFullIndex(queryClient, indexOf(source()));
    useConnection.setState({state:'live', offline:false, fresh:true});
  });
}

test('a checkpoint mounted while connecting retains the restart hint until an accepted GET after reachability returns', async () => {
  const f = await mountCheckpoint();
  const outcomes = await Promise.all(f.accepted.mock.results.map(async result => {
    try { await result.value; return 'fulfilled'; } catch(error) { return isCancelledError(error) ? 'cancelled' : String(error); }
  }));
  console.info('resume-before-live', JSON.stringify({connection:useConnection.getState().state, offline:useConnection.getState().offline,
    getCount:f.fetcher.mock.calls.length, outcomes, url:location.href, saved:saved()}));
  expect(saved()).toEqual(hint);
  expect(new URL(location.href).searchParams.get('task')).toBeNull();
  expect(f.fetcher).not.toHaveBeenCalled();
  await connect();
  await waitFor(() => expect(new URL(location.href).searchParams.get('task')).toBe('T111'));
  expect(new URL(location.href).searchParams.get('tab')).toBe('files');
  expect(f.fetcher.mock.calls.some(([url]) => String(url).includes('/task/view?task=T111'))).toBe(true);
  expect(saved()).toEqual(hint);
});

test('real offline does not validate or revive a cached task and preserves the unverified hint', async () => {
  const f = await mountCheckpoint();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  act(() => useConnection.setState({state:'reconnecting',offline:true}));
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(saved()).toEqual(hint);
  expect(useViewStore.getState().reader.open).toBe(false);
});

test('cancelling a real in-flight GET preserves the hint and its late cached response cannot restore it offline', async () => {
  const f = await mountCheckpoint(), old = deferred();
  f.fetcher.mockImplementationOnce(() => old.promise);
  await connect();
  await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
  await act(async () => {
    useConnection.setState({state:'reconnecting',offline:true});
    await queryClient.cancelQueries({queryKey:['task','/fixture','T111'],exact:true}, {revert:true});
  });
  expect(saved()).toEqual(hint);
  await act(async () => { old.answer(jsonAnswer(viewsOf(source())[0])); });
  expect(new URL(location.href).searchParams.get('task')).toBeNull();
  expect(saved()).toEqual(hint);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  await connect();
  await waitFor(() => expect(new URL(location.href).searchParams.get('task')).toBe('T111'));
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});

test.each([404, 400] as const)('an actual HTTP %s refusal after reconnect clears an invalid hint without using its checkpoint', async status => {
  const f = await mountCheckpoint();
  f.fetcher.mockResolvedValue(refusal(status));
  await connect();
  await waitFor(() => expect(saved().search).toBe(''));
  expect(new URL(location.href).searchParams.get('task')).toBeNull();
  expect(useViewStore.getState().reader.open).toBe(false);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});

test('a late accepted GET cannot overwrite the person’s navigation during validation', async () => {
  const f = await mountCheckpoint(), slow = deferred();
  f.fetcher.mockImplementationOnce(() => slow.promise);
  await connect();
  await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
  act(() => useViewStore.getState().openTask('T113', {reader:true}));
  await act(async () => { slow.answer(jsonAnswer(viewsOf(source())[0])); });
  await waitFor(() => expect(new URL(location.href).searchParams.get('task')).toBe('T113'));
  expect(saved().search).toContain('task=T113');
});

test('a late GET from the retired read session cannot validate a restored checkpoint', async () => {
  const f = await mountCheckpoint(), slow = deferred();
  f.fetcher.mockImplementationOnce(() => slow.promise);
  await connect();
  await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
  await act(async () => {
    receiveFullIndex(queryClient, {...indexOf(source()),generation:'next-session'});
    slow.answer(jsonAnswer(viewsOf(source())[0]));
  });
  expect(new URL(location.href).searchParams.get('task')).toBeNull();
  expect(saved()).toEqual(hint);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});

test('a person’s explicit move while connecting wins over the deferred restart hint', async () => {
  await mountCheckpoint();
  act(() => useViewStore.getState().openTask('T113', {reader:true}));
  await connect();
  await waitFor(() => expect(new URL(location.href).searchParams.get('task')).toBe('T113'));
  expect(saved().search).toContain('task=T113');
});

test('a real fetch rejection during resume keeps the checkpoint hint until a new accepted GET after reachability returns', async () => {
  const f = await mountCheckpoint();
  let reject!: (error: Error) => void;
  f.fetcher.mockImplementationOnce(() => new Promise<Response>((_, fail) => { reject = fail; }));
  await connect();
  await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
  await act(async () => {
    useConnection.setState({state:'reconnecting',offline:true});
    reject(new TypeError('Failed to fetch'));
    await Promise.all(f.accepted.mock.results.map(result => result.value.catch(() => undefined)));
  });
  expect(queryClient.getQueryState(['task','/fixture','T111'])?.error).toMatchObject({code:'network_error',retry:'later'});
  expect(saved()).toEqual(hint);
  expect(new URL(location.href).searchParams.get('task')).toBeNull();
  expect(useViewStore.getState().reader.open).toBe(false);
  await connect();
  await waitFor(() => expect(new URL(location.href).searchParams.get('task')).toBe('T111'));
  expect(new URL(location.href).searchParams.get('tab')).toBe('files');
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});
