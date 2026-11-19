import { afterEach, expect, test, vi } from 'vitest';
import { useLayoutEffect } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { dehydrate, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { taskProjectedViewSchema } from '@alpacawork/contract/control';
import { captureReadProof, serverReadFacts, readEntry, evaluateRead, recordReadProof } from '../src/data/read-model';
import { requestRead } from '../src/data/read-demand';
import { receiveFullIndex, observeReadRefusals, resources } from '../src/data/resources';
import { useServerReadFacts } from '../src/data/use-read-facts';
import { readSize } from '../src/data/read-retention';
import { selectRetainedReads } from './retained-reads';
import { dto, indexOf, run, tree, viewsOf } from './fixtures';

const clients: QueryClient[] = [];
const flushReads = () => new Promise<void>(resolve => setTimeout(resolve, 20));
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients.length = 0; vi.restoreAllMocks(); });
/** A Run as a view carries it: what activity files say comes with the list alone. */
function asViewRun({ activity: _activity, errorCause: _cause, ...rest }: ReturnType<typeof run>) { return rest; }
/** The Run only T1's view knows of: the facts hold it while that view is a current read. */
const viewRun = asViewRun(run('R7', { taskId: 'T1' }));
const holdsViewRun = (facts: ReturnType<typeof serverReadFacts>) => !!facts?.runs.some(each => each.id === viewRun.id);
function fixture(n = 1) {
  const value = tree({ tasks: Array.from({ length: n }, (_, i) => dto({ id: `T${i + 1}` })) });
  const index = indexOf(value);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client); receiveFullIndex(client, index);
  for (const view of viewsOf(value)) {
    const key = ['task', index.root, view.task.id]; client.setQueryData(key, view.task.id === 'T1' ? { ...view, runs: [viewRun] } : view);
    recordReadProof(client.getQueryCache().find({ queryKey: key, exact: true })!, captureReadProof(index, key));
  }
  const query = client.getQueryCache().find({ queryKey: ['task', index.root, 'T1'], exact: true })!;
  return { client, index, query };
}
function mounted(client: QueryClient, committed = () => {}) {
  return renderHook(() => { const facts = useServerReadFacts(); useLayoutEffect(committed); return facts; },
    { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
}

test('a read of a task that only repeats the list\'s Runs keeps the facts; one that adds a Run puts it after them', async () => {
  const listed = [run('R1', { taskId: 'T1' }), run('R2', { taskId: 'T2' }), run('R3', { taskId: 'T1' })];
  const value = tree({ tasks: [dto({ id: 'T1' }), dto({ id: 'T2' })], runs: listed });
  const index = indexOf(value);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client); receiveFullIndex(client, index);
  const read = (id: string, runs: typeof listed) => {
    const key = ['task', index.root, id], view = viewsOf(value).find(each => each.task.id === id)!;
    client.setQueryData(key, { ...view, runs: runs.map(asViewRun) });
    recordReadProof(client.getQueryCache().find({ queryKey: key, exact: true })!, captureReadProof(index, key));
  };
  const before = serverReadFacts(client)!;
  expect(before.runs.map(each => each.id)).toEqual(['R1', 'R2', 'R3']);
  // A view lists its own Runs first; the screen is not told anything changed.
  read('T2', [listed[1]!]);
  read('T1', [listed[2]!, listed[0]!]);
  expect(serverReadFacts(client)).toBe(before);
  const older = run('R9', { taskId: 'T1' });
  read('T1', [older, ...listed.filter(each => each.taskId === 'T1')]);
  const after = serverReadFacts(client)!;
  expect(after).not.toBe(before);
  expect(after.runs.map(each => each.id)).toEqual(['R1', 'R2', 'R3', 'R9']);
});

test('80 reads share a fold: equal events do no work; body-only change parses/folds once and keeps the projected reference', async () => {
  const { client, index, query } = fixture(80);
  const first = serverReadFacts(client)!;
  const committed = vi.fn(), hooks = Array.from({ length: 4 }, () => mounted(client, committed));
  committed.mockClear();
  const parse = vi.spyOn(taskProjectedViewSchema.shape.task._zod, 'run');
  const offered = new Set(first.tasks), nativeSet = Map.prototype.set; let rowOffers = 0;
  const insert = vi.spyOn(Map.prototype, 'set').mockImplementation(function (this: Map<any, any>, key: any, value: any) {
    if (offered.has(value)) rowOffers++;
    return nativeSet.call(this, key, value);
  });
  await act(async () => { for (let n = 0; n < 5; n++) for (const q of client.getQueryCache().getAll()) q.setState({}); await flushReads(); });
  expect(parse).toHaveBeenCalledTimes(0); expect(rowOffers).toBe(0);
  expect(committed).toHaveBeenCalledTimes(0);
  for (const hook of hooks) expect(hook.result.current).toBe(first);
  const before = query.state.data as any;
  await act(async () => {
    client.setQueryData(query.queryKey, { ...before, task: { ...before.task, values: { notes: 'one immutable change' } } });
    recordReadProof(query, captureReadProof(index, query.queryKey));
    await flushReads();
  });
  expect(parse).toHaveBeenCalledTimes(1);
  const after = serverReadFacts(client)!; expect(after).toBe(first);
  expect((query.state.data as typeof before).task.values.notes).toBe('one immutable change');
  expect(rowOffers).toBe(offered.size); // Includes the fixture's project row: one actual fold.
  expect(committed).toHaveBeenCalledTimes(0);
  for (const hook of hooks) expect(hook.result.current).toBe(after);
  expect(after.tasks.find(row => row.id === 'T1')).toBeDefined();
  // An index revision is a changed fold input even when its rows stay the same.
  rowOffers = 0;
  await act(async () => { receiveFullIndex(client, { ...index, rev: index.rev + 1 }); await flushReads(); });
  expect(rowOffers).toBe(offered.size); expect(parse).toHaveBeenCalledTimes(1);
  expect(committed).toHaveBeenCalledTimes(4);
  for (const hook of hooks) expect(hook.result.current!.rev).toBe(index.rev + 1);
  insert.mockRestore();
});

test('already-invalidated proof-only demand and receipt completion notify every mounted current projection', async () => {
  const { client, index, query } = fixture(), hook = mounted(client);
  await act(async () => { query.invalidate(); await flushReads(); }); expect(holdsViewRun(hook.result.current)).toBe(true);
  await act(async () => { requestRead(query); await flushReads(); }); expect(holdsViewRun(hook.result.current)).toBe(false);
  expect(evaluateRead(index, readEntry(query)).display).toBe(true);
  await act(async () => { recordReadProof(query, captureReadProof(index, query.queryKey)); await flushReads(); });
  expect(holdsViewRun(hook.result.current)).toBe(false);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(query.state.data));
  await act(async () => { await client.fetchQuery({ ...resources.taskView(index.root, 'T1'), staleTime: 0 }); await flushReads(); });
  expect(holdsViewRun(hook.result.current)).toBe(true);
});

test.each(['generation', 'remove', 'clear', 'error', 'cancel'] as const)('mounted projection follows actual QueryCache lifecycle: %s', async kind => {
  const { client, index, query } = fixture(), hook = mounted(client), first = hook.result.current;
  if (kind === 'generation') act(() => receiveFullIndex(client, { ...index, generation: 'replacement' }));
  if (kind === 'remove') act(() => client.removeQueries({ queryKey: query.queryKey, exact: true }));
  if (kind === 'clear') act(() => client.clear());
  if (kind === 'error') act(() => query.setState({ status: 'error', error: new Error('temporary failure') }));
  if (kind === 'cancel') {
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    const flight = client.fetchQuery({ queryKey: query.queryKey, queryFn: ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); started();
    }) }).catch(() => undefined);
    await ready; await act(async () => { await client.cancelQueries({ queryKey: query.queryKey, exact: true }, { revert: true }); await flight; });
  }
  await act(flushReads);
  expect(hook.result.current).toBe(serverReadFacts(client));
  if (kind === 'error' || kind === 'cancel') expect(hook.result.current).toBe(first);
  else expect(holdsViewRun(hook.result.current)).toBe(false);
});

test('mounted true refusal excludes data while a second client using the same references stays independent', async () => {
  const a = fixture(), b = fixture(), mountedA = mounted(a.client), mountedB = mounted(b.client), beforeB = mountedB.result.current;
  observeReadRefusals(a.client);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 403 }));
  await act(async () => { await a.client.fetchQuery({ ...resources.taskView(a.index.root, 'T1'), staleTime: 0 }).catch(() => {}); await flushReads(); });
  expect(mountedA.result.current!.tasks.some(row => row.id === 'T1')).toBe(false);
  expect(mountedB.result.current).toBe(beforeB);
});

test('disk selection and repeated memory sweeps reuse only immutable data byte counts, measuring metadata anew', async () => {
  const { client, query } = fixture(80); serverReadFacts(client);
  const data = query.state.data;
  const json = JSON.stringify;
  let traversals = 0;
  const contains = (value: any): boolean => value === data || !!value && typeof value === 'object' && Object.values(value).some(contains);
  vi.spyOn(JSON, 'stringify').mockImplementation((value: any, ...args: any[]) => {
    if (contains(value)) traversals++;
    return (json as any)(value, ...args);
  });
  // Include all required basis reads, then warm their immutable data byte evidence.
  const index = client.getQueryData<any>(['index'])!;
  client.setQueryData(['person-settings', index.root], { values: {}, revision: index.person.settings });
  client.setQueryData(['person-notices', index.root], { state: null, revision: index.person.notices });
  const reads = dehydrate(client).queries;
  const envelopeBytes = readSize({ queries: [] });
  expect(selectRetainedReads(reads, Date.now(), envelopeBytes).absent).toEqual([]);
  await Promise.resolve(); traversals = 0;
  for (let n = 0; n < 3; n++) {
    const current = reads.map(read => ({ ...read, meta: { readUsedAt: Date.now() + n } }));
    expect(selectRetainedReads(current, Date.now(), envelopeBytes).queries.length).toBe(reads.length);
    query.setState({}); await Promise.resolve();
  }
  expect(traversals).toBe(0);
});

test('actual single-read callers use the native Query map without scanning unrelated reads or resolving defaults again', async () => {
  const { client, index, query } = fixture(80);
  const { readState } = await import('../src/data/resources'), { taskReadState } = await import('../src/data/read-model');
  const { readIndex, readQuery } = await import('../src/data/read-model');
  serverReadFacts(client);
  const scans = vi.spyOn(client.getQueryCache(), 'getAll');
  const defaults = vi.spyOn(client, 'defaultQueryOptions');
  for (let n = 0; n < 10; n++) {
    expect(readIndex(client)).toBe(index);
    expect(readQuery(client, query.queryKey)).toBe(query);
    expect(readState(client, query.queryKey).assessment.state).toBe('current');
    expect(taskReadState(client, index.root, 'T1').view?.task.id).toBe('T1');
  }
  expect(scans).toHaveBeenCalledTimes(0); expect(defaults).toHaveBeenCalledTimes(0);
  requestRead(query);
  expect(readState(client, query.queryKey).assessment).toMatchObject({ state: 'unverified', display: true, project: false });
});

test('same folded index facts stay stable across demand while the mounted Task read still changes qualification', async () => {
  const value = tree({ tasks: [dto()] }), index = indexOf(value);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });clients.push(client);
  receiveFullIndex(client, index);const key=['task',index.root,'T1'];client.setQueryData(key,viewsOf(value)[0]);
  const query=client.getQueryCache().find({queryKey:key,exact:true})!;recordReadProof(query,captureReadProof(index,key));
  const facts=mounted(client), first=facts.result.current;
  const {useTaskReadState}=await import('../src/data/queries');
  const detail=renderHook(()=>useTaskReadState(index.root,'T1',false),{wrapper:({children})=><QueryClientProvider client={client}>{children}</QueryClientProvider>});
  expect(detail.result.current.assessment.state).toBe('current');
  await act(async () => { requestRead(query); await flushReads(); });
  expect(facts.result.current).toBe(first);
  expect(detail.result.current.assessment).toMatchObject({state:'unverified',display:true,project:false});
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(query.state.data));
  await act(async () => { await client.fetchQuery({ ...resources.taskView(index.root, 'T1'), staleTime: 0 }); await flushReads(); });
  expect(facts.result.current).toBe(first);expect(detail.result.current.assessment.state).toBe('current');
});
