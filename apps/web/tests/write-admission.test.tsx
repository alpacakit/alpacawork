import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '../src/data/query-client';
import { canSendWrites, useConnection } from '../src/data/connection';
import { coordinatorWriteBasis } from '../src/data/coordinator';
import { useWriteDisabled } from '../src/data/queries';
import { receiveFullIndex, resources } from '../src/data/resources';
import { dto, indexOf, tree, viewsOf } from './fixtures';
const flushReads = () => new Promise<void>(resolve => setTimeout(resolve, 20));

afterEach(() => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); });
test('a Query recovery updates coordinator eligibility without a connection event or an unrelated render', async () => {
  queryClient.clear();
  const value = tree({ tasks: [dto({ id: 'T9' })] }), index = indexOf(value);
  useConnection.setState({ state: 'live', offline: false });
  receiveFullIndex(queryClient, index);
  const target = { intent: { task: 'T9' }, answers: [{ task: 'T9' }] };
  const hook = renderHook(() => useWriteDisabled(() => coordinatorWriteBasis(target)), { wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider> });
  expect(hook.result.current).toBe(true);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(viewsOf(value).find(view => view.task.id === 'T9'))));
  await act(async () => { await queryClient.fetchQuery(resources.taskView(index.root, 'T9')); await flushReads(); });
  expect(canSendWrites(coordinatorWriteBasis(target))).toBe(true);
  expect(hook.result.current).toBe(false);
});

test('a caller’s explicit draft hash stays fixed while a derived coordinator basis follows the current read', async () => {
  queryClient.clear(); const value = tree({ tasks: [dto({ id: 'T9' })] }), index = indexOf(value);
  useConnection.setState({ state: 'live', offline: false }); receiveFullIndex(queryClient, index);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(viewsOf(value).find(view => view.task.id === 'T9'))));
  await queryClient.fetchQuery(resources.taskView(index.root, 'T9'));
  const basis = coordinatorWriteBasis({ intent: { task: 'T9' } });
  const hook = renderHook(() => useWriteDisabled(basis), { wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider> });
  expect(hook.result.current).toBe(false);
  await act(async () => { useConnection.setState({ offline: true }); }); expect(hook.result.current).toBe(true);
  await act(async () => { useConnection.setState({ offline: false }); }); expect(hook.result.current).toBe(false);
  const row = value.tasks.find(task => task.id === 'T9')!;
  await act(async () => { receiveFullIndex(queryClient, { ...index, rev: index.rev + 1, sourcePv: 1 as never, requiredPv: { ...index.requiredPv, view: { T9: 1 as never } }, tasks: index.tasks.map(task => task.id === 'T9' ? { ...task, hash: 'b'.repeat(64) } : task) }); await flushReads(); });
  expect(hook.result.current).toBe(true);
  expect((basis.kind === 'all' && basis.reads[0]?.kind === 'detail') && basis.reads[0].expectedHash).toBe(row.hash);
});
