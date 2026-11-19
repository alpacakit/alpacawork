import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { queryClient } from '../src/data/query-client';
import { receiveFullIndex, resources } from '../src/data/resources';
import { useConnection } from '../src/data/connection';
import { useSkills } from '../src/features/coordinator/editor/skills';
import { TestWorkspace, indexOf, tree } from './fixtures';

const ready = (profile = 'codex') => ({ status: 'ready', profile, skills: [] });
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => { cleanup(); queryClient.clear(); useConnection.setState({ offline: false }); vi.restoreAllMocks(); });
const wrapper = ({ children }: { children: React.ReactNode }) => <TestWorkspace>{children}</TestWorkspace>;

test('engagement gates transport and two consumers share one catalog flight', async () => {
  const get = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => reply(ready()));
  const view = renderHook(({ conversation }) => [useSkills('codex', conversation), useSkills('codex', conversation)],
    { wrapper, initialProps: { conversation: null as string | null } });
  expect(get).not.toHaveBeenCalled(); expect(view.result.current[0]!.status).toBe('loading');
  view.rerender({ conversation: 'conversation' });
  await waitFor(() => expect(view.result.current.map(value => value.status)).toEqual(['ready', 'ready']));
  expect(get).toHaveBeenCalledTimes(1);
  view.rerender({ conversation: null });
  expect(view.result.current.map(value => [value.status, value.skills])).toEqual([['loading', []], ['loading', []]]);
  expect(get).toHaveBeenCalledTimes(1);
});

test('conversation and profile changes hide the former catalog before a delayed response arrives', async () => {
  let finish!: (response: Response) => void;
  const get = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(reply(ready())).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = renderHook(({ conversation, profile }) => useSkills(profile, conversation),
    { wrapper, initialProps: { conversation: 'old', profile: 'codex' } });
  await waitFor(() => expect(view.result.current.status).toBe('ready'));
  view.rerender({ conversation: 'new', profile: 'codex' });
  expect(view.result.current.status).toBe('loading'); expect(view.result.current.skills).toEqual([]);
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  await act(async () => { finish(reply(ready())); });
  await waitFor(() => expect(view.result.current.status).toBe('ready'));
  view.rerender({ conversation: 'new', profile: 'claude' });
  expect(view.result.current.status).toBe('loading'); expect(view.result.current.profile).toBe('claude');
});

for (const failure of ['unavailable', 'http', 'schema'] as const) test(`${failure} recovers once for shared consumers on back-in-reach`, async () => {
  const get = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(failure === 'unavailable'
    ? reply({ status: 'unavailable', profile: 'codex', skills: [], reason: 'launch' })
    : failure === 'http' ? reply({}, 500) : reply({ status: 'ready' })).mockImplementation(async () => reply(ready()));
  const view = renderHook(() => [useSkills('codex', 'same'), useSkills('codex', 'same')], { wrapper });
  await waitFor(() => expect(view.result.current.map(value => value.status)).toEqual(['unavailable', 'unavailable']));
  if (failure === 'unavailable') expect(view.result.current.map(value => value.reason)).toEqual(['launch', 'launch']);
  expect(get).toHaveBeenCalledTimes(1);
  act(() => { useConnection.setState({ offline: true }); useConnection.setState({ offline: false }); });
  await waitFor(() => expect(view.result.current.map(value => value.status)).toEqual(['ready', 'ready']));
  expect(get).toHaveBeenCalledTimes(2);
});

for (const boundary of ['root', 'generation', 'session'] as const) test(`a delayed catalog cannot commit across ${boundary}`, async () => {
  const index = indexOf(tree()); receiveFullIndex(queryClient, index);
  let finish!: (response: Response) => void;
  const get = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const options = resources.skills(index.root, 'codex', 'conversation');
  const pending = queryClient.fetchQuery(options).catch(() => undefined);
  await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
  if (boundary === 'session') { queryClient.removeQueries({ queryKey: ['index'] }); receiveFullIndex(queryClient, index); }
  else receiveFullIndex(queryClient, { ...index, ...(boundary === 'root' ? { root: '/other' } : { generation: 'other' }) });
  await act(async () => { finish(reply(ready())); await pending; });
  expect(queryClient.getQueryData(options.queryKey)).toBeUndefined();
});

test('an unmounted last consumer cancels its flight; a retained ready catalog still refetches on a new mount', async () => {
  let signal: AbortSignal | undefined;
  const get = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => { signal = init?.signal ?? undefined; return new Promise(() => {}); });
  const view = renderHook(() => useSkills('codex', 'one'), { wrapper });
  await waitFor(() => expect(get).toHaveBeenCalledTimes(1)); view.unmount(); expect(signal?.aborted).toBe(true);
  get.mockImplementation(async () => reply(ready()));
  const one = renderHook(() => useSkills('codex', 'one'), { wrapper });
  await waitFor(() => expect(one.result.current.status).toBe('ready')); one.unmount();
  const before = get.mock.calls.length;
  const two = renderHook(() => useSkills('codex', 'one'), { wrapper });
  await waitFor(() => expect(get.mock.calls.length).toBe(before + 1)); two.unmount();
});
