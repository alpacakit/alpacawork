/** Render delivery through the production adapter and real read/write callers. */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useLayoutEffect, useSyncExternalStore } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { notifyManager, QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { startI18n, i18n } from '@alpacawork/i18n';
import { captureReadProof, serverReadFacts, readQuery, recordReadProof, getReadProof, subscribeReads } from '../src/data/read-model';
import { requestRead } from '../src/data/read-demand';
import { receiveFullIndex, observeReadRefusals, resources, assessRead, showWrittenTask } from '../src/data/resources';
import { useServerReadFacts } from '../src/data/use-read-facts';
import { useTaskReadState, useReaderTask, useWriteDisabled, useReadState } from '../src/data/queries';
import { bindWriteAccess, detailWriteBasis, rowWriteBasis, useConnection } from '../src/data/connection';
import { requireWriteAccess } from '../src/data/client';
import { queryClient } from '../src/data/query-client';
import { usePersonalSettings } from '../src/data/personal-settings';
import { createNoticeStore } from '../src/data/notice-store';
import { taskBaseline, NOTICE_VERSION } from '../src/data/notice-model';
import { createWorkspaceStore, WorkspaceContext } from '../src/data/workspace-store';
import { mapWorkspace } from '../src/data/map';
import { indexPeople } from '../src/domain/people';
import { headOf, dto, indexOf, tree, viewsOf, rowOf } from './fixtures';
import { isReadDataImmutable, readDataSize } from '../src/data/read-json';

const clients: QueryClient[] = [], stops: (() => void)[] = [];
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 20));
const wrapper = (client: QueryClient) => ({ children }: any) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
function fixture(client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }), root = '/review', closed = true) {
  if (client !== queryClient) clients.push(client);
  const value = tree({ root, tasks: [dto({ id: 'T1', state: closed ? 'done' : 'doing' })] });
  const source = indexOf(value);
  const index = { ...source, ...(closed ? { tasks: [] } : {}), person: { ...source.person, settings: 'settings0' } };
  receiveFullIndex(client, index);
  const view = viewsOf(value)[0]!, { stateLog, ...row } = rowOf(view.task, value);
  const key = ['task', root, 'T1'] as const;
  client.setQueryData(key, view);
  const query = readQuery(client, key)!;
  recordReadProof(query, captureReadProof(index, key));
  return { client, index, query, key, row: { ...row, stateLog, movedAt: 0 } };
}
function receipt(key: readonly unknown[], data: unknown, acquiredAt?: number) {
  const query = readQuery(queryClient, key) ?? queryClient.getQueryCache().build(queryClient, { queryKey: key });
  const index = queryClient.getQueryData<any>(['index'])!;
  // As in a real GET, reception evidence precedes the success notification consumed synchronously by effects.
  recordReadProof(query, { ...captureReadProof(index, key), ...(acquiredAt === undefined ? {} : { acquiredAt }) });
  queryClient.setQueryData(key, data);
  return query;
}
beforeEach(() => { bindWriteAccess(queryClient); useConnection.setState({ state: 'live', fresh: true, writable: true, offline: false }); });
afterEach(async () => {
  cleanup(); stops.splice(0).reverse().forEach(stop => stop());
  for (const client of clients.splice(0)) client.clear();
  queryClient.clear(); usePersonalSettings.setState(usePersonalSettings.getInitialState(), true);
  bindWriteAccess(queryClient); await tick(); vi.restoreAllMocks();
});

test('an actual GET retains immutable byte sizing after Query structural sharing', async () => {
  const f = fixture();
  const held = f.query.state.data as any;
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ...held, task: { ...held.task, values: { notes: 'New body' } } }));
  await f.client.fetchQuery({ ...resources.taskView(f.index.root, 'T1'), staleTime: 0 });
  const stored = f.query.state.data;
  expect(stored).not.toBe(held);
  expect(isReadDataImmutable(stored)).toBe(true);
  const stringify = vi.spyOn(JSON, 'stringify');
  const first = readDataSize(stored, data => ({ data }));
  expect(readDataSize(stored, data => ({ data }))).toBe(first);
  expect(stringify.mock.calls.filter(([value]) => value === stored).length).toBeLessThanOrEqual(1);
});

test('D coalesces five events to one while B retains five; raw proof is already final', async () => {
  const f = fixture(), calls = { D: 0, B: 0, raw: 0 };
  stops.push(subscribeReads(f.client, () => calls.D++));
  stops.push(f.client.getQueryCache().subscribe(notifyManager.batchCalls(() => calls.B++)));
  stops.push(f.client.getQueryCache().subscribe(() => calls.raw++));
  notifyManager.batch(() => { for (let n = 0; n < 5; n++) f.query.setState({}); });
  expect(calls).toEqual({ D: 0, B: 0, raw: 5 });
  await tick(); expect(calls).toEqual({ D: 1, B: 5, raw: 5 });
});

test('reentrant publication reaches next flush, with final qualification read anew', async () => {
  const f = fixture(), scheduled: (() => void)[] = [], states: string[] = [];
  notifyManager.setScheduler(callback => scheduled.push(callback));
  try {
    stops.push(subscribeReads(f.client, () => {
      states.push(assessRead(f.client, f.query).state);
      if (states.length === 1) requestRead(f.query);
    }));
    requestRead(f.query);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(f.query.state.data));
    await f.client.fetchQuery({ ...resources.taskView(f.index.root, 'T1'), staleTime: 0 });
    expect(states).toEqual([]); expect(scheduled).toHaveLength(1);
    scheduled.shift()!(); expect(states).toEqual(['current']);
    expect(scheduled).toHaveLength(1); scheduled.shift()!();
    expect(states).toEqual(['current', 'unverified']); expect(scheduled).toHaveLength(0);
  } finally { notifyManager.setScheduler(callback => setTimeout(callback, 0)); }
});

test('unsubscribe/readd and registration during flush cannot deliver an old callback', () => {
  const f = fixture(), scheduled: (() => void)[] = [], seen: string[] = [];
  notifyManager.setScheduler(callback => scheduled.push(callback));
  try {
    let old = subscribeReads(f.client, () => seen.push('old'));
    f.query.setState({}); old(); old();
    stops.push(subscribeReads(f.client, () => seen.push('new')));
    scheduled.shift()!(); expect(seen).toEqual([]);
    let victim: () => void = () => {}, added = false;
    stops.push(subscribeReads(f.client, () => {
      seen.push('first'); victim();
      if (!added) { added = true; stops.push(subscribeReads(f.client, () => seen.push('added'))); }
    }));
    victim = subscribeReads(f.client, () => seen.push('victim')); stops.push(victim);
    notifyManager.batch(() => { f.query.setState({}); f.query.setState({}); });
    scheduled.shift()!(); expect(seen).toEqual(['new', 'first']);
    f.query.setState({}); while (scheduled.length) scheduled.shift()!();
    expect(seen).toEqual(['new', 'first', 'new', 'first', 'added']);
  } finally { notifyManager.setScheduler(callback => setTimeout(callback, 0)); }
});

test('pending belongs to a subscription, independent clients and replaced roots do not share it', async () => {
  const a = fixture(), b = fixture(undefined, '/other'), seen: string[] = [];
  stops.push(subscribeReads(a.client, () => seen.push('a:' + a.client.getQueryData<any>(['index'])?.root)));
  stops.push(subscribeReads(b.client, () => seen.push('b')));
  a.query.setState({}); await tick(); expect(seen).toEqual(['a:/review']); seen.length = 0;
  receiveFullIndex(a.client, { ...a.index, root: '/new-root', generation: 'new' });
  b.query.setState({}); await tick(); expect(seen).toEqual(['a:/new-root', 'b']);
});

test.each(['scope', '403'] as const)('actual requireWriteAccess rejects %s before drawing resumes', async kind => {
  const f = fixture(); bindWriteAccess(f.client);
  const basis = detailWriteBasis('T1', (f.query.state.data as any).task.hash);
  expect(() => requireWriteAccess(basis)).not.toThrow();
  let drawings = 0; stops.push(subscribeReads(f.client, () => drawings++));
  if (kind === 'scope') receiveFullIndex(f.client, { ...f.index, generation: 'changed' });
  else {
    observeReadRefusals(f.client);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 403 }));
    await f.client.fetchQuery({ ...resources.taskView(f.index.root, 'T1'), staleTime: 0 }).catch(() => {});
    expect(assessRead(f.client, f.query).state).toBe('refused');
  }
  expect(drawings).toBe(0); expect(() => requireWriteAccess(basis)).toThrowError(expect.objectContaining({ code: kind === '403' ? 'forbidden' : 'conflict' }));
  await tick(); expect(drawings).toBe(1);
});

test('connection suppresses equal evidence while permission changes still publish synchronously', () => {
  const f = fixture(); bindWriteAccess(f.client); let calls = 0;
  stops.push(useConnection.subscribe(() => calls++));
  receiveFullIndex(f.client, { ...f.index }); expect(calls).toBe(0);
  receiveFullIndex(f.client, { ...f.index, rev: f.index.rev + 1, writable: false });
  expect(calls).toBe(1); expect(() => requireWriteAccess()).toThrow();
  receiveFullIndex(f.client, { ...f.index, rev: f.index.rev + 2 });
  expect(calls).toBe(2); expect(() => requireWriteAccess()).not.toThrow();
});

test('demand, 503, and receipt remain unverified after a flush instead of being hidden', async () => {
  const f = fixture(); bindWriteAccess(f.client);
  const states: string[] = [], held = f.query.state.data;
  stops.push(subscribeReads(f.client, () => states.push(assessRead(f.client, f.query).state)));
  requestRead(f.query); await tick(); expect(states.at(-1)).toBe('unverified');
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
  await f.client.fetchQuery({ ...resources.taskView(f.index.root, 'T1'), staleTime: 0 }).catch(() => {});
  await tick(); expect(states.at(-1)).toBe('unverified'); expect(f.query.state.data).toBe(held);
  // Receipt case starts with a current live row; a failed closed read cannot supply a project relation.
  const r = fixture(undefined, '/receipt', false); bindWriteAccess(r.client);
  const receiptStates: string[] = [];
  stops.push(subscribeReads(r.client, () => receiptStates.push(assessRead(r.client, r.query).state)));
  const task = (r.query.state.data as any).task;
  showWrittenTask(r.client, headOf({ ...task, version: task.version + 1, values: { notes: 'receipt' } }), r.index);
  await tick(); expect(receiptStates.at(-1)).toBe('unverified'); expect(getReadProof(r.query)?.uncertain).toBe(true);
  expect((r.query.state.data as any).task.values.notes).toBe('receipt');
  expect(() => requireWriteAccess(detailWriteBasis('T1', (r.query.state.data as any).task.hash))).toThrow();
});

test('raw language and syncSeen effects stay synchronous while cache drawing is pending', async () => {
  startI18n(); await i18n.changeLanguage('en'); const f = fixture(queryClient); bindWriteAccess(queryClient);
  let draws = 0; stops.push(subscribeReads(queryClient, () => draws++));
  receipt(resources.personalSettings(f.index.root).queryKey, { values: { language: 'ja' }, revision: f.index.person.settings });
  expect(i18n.language).toBe('ja'); expect(draws).toBe(0);
  const store = createNoticeStore(), task = f.row;
  store.setState({ root: f.index.root, tasks: [task], status: 'ready' });
  stops.push(store.subscribe(() => {}));
  receipt(resources.notices(f.index.root).queryKey, { state: { version: NOTICE_VERSION, checkpoint: { at: '2026-10-20T00:00:00.000Z', tasks: {} }, reads: {} }, revision: f.index.person.notices });
  expect(store.getState().firstSeen.has('T1|created')).toBe(true); expect(draws).toBe(0);
  await tick(); expect(draws).toBe(1); await i18n.changeLanguage('en');
});

test('notice initial checkpoint must share its view for equal data and equal acquiredAt', () => {
  const f = fixture(queryClient); useConnection.setState({ offline: true });
  const store = createNoticeStore(); store.setState({ root: f.index.root, status: 'ready' });
  const initialBaselines = { T1: taskBaseline(f.row) };
  const q = receipt(resources.notices(f.index.root).queryKey, { state: null, revision: f.index.person.notices, initialBaselines }, 1000);
  const first = store.getState(); q.setState({}); const after = store.getState();
  expect(after).toEqual(first); expect(after).toBe(first);
  // Deep equality or a matching revision cannot stand in for actual baseline identity.
  const data = q.state.data as any;
  q.setState({ data: { ...data, initialBaselines: { ...data.initialBaselines } } });
  const copied = store.getState();
  expect(copied).toEqual(first); expect(copied).not.toBe(first);
  expect(copied.checkpoint?.tasks).not.toBe(first.checkpoint?.tasks);
});

test('notice checkpoint preserves changed acquisition time, baseline, and saved checkpoint', () => {
  const f = fixture(queryClient); useConnection.setState({ offline: true });
  const store = createNoticeStore(); store.setState({ root: f.index.root, status: 'ready' });
  const key = resources.notices(f.index.root).queryKey;
  const initialBaselines = { T1: taskBaseline(f.row) };
  const q = receipt(key, { state: null, revision: f.index.person.notices, initialBaselines }, 1000), first = store.getState();
  recordReadProof(q, { ...getReadProof(q)!, acquiredAt: 2000 });
  const timed = store.getState(); expect(timed).not.toBe(first); expect(timed.checkpoint?.at).toBe(new Date(2000).toISOString());
  receipt(key, { state: null, revision: f.index.person.notices, initialBaselines: { T1: { ...initialBaselines.T1, body: 'b'.repeat(8) } } }, 2000);
  const changed = store.getState(); expect(changed.checkpoint?.tasks.T1?.body).toBe('b'.repeat(8)); expect(changed).not.toBe(timed);
  receipt(key, { state: { version: NOTICE_VERSION, checkpoint: { at: '2026-10-20T00:00:00.000Z', tasks: initialBaselines }, reads: { T1: initialBaselines.T1 } }, revision: f.index.person.notices });
  const saved = store.getState(); expect(saved.checkpoint?.at).toBe('2026-10-20T00:00:00.000Z'); expect(saved.reads.T1).toEqual(initialBaselines.T1);
  q.setState({}); expect(store.getState()).toBe(saved);
});

test('personal/notice status, error, freshness, and real read acquiredAt still invalidate', async () => {
  const f = fixture(queryClient); usePersonalSettings.setState({ root: f.index.root, status: 'loading' });
  const store = createNoticeStore(); store.setState({ root: f.index.root, status: 'loading' });
  const beforeP = usePersonalSettings.getState(), beforeN = store.getState();
  const p = receipt(resources.personalSettings(f.index.root).queryKey, { values: { theme: 'dark' }, revision: f.index.person.settings });
  const n = receipt(resources.notices(f.index.root).queryKey, { state: { version: NOTICE_VERSION, checkpoint: { at: '2026-10-20T00:00:00.000Z', tasks: {} }, reads: {} }, revision: f.index.person.notices });
  const readyP = usePersonalSettings.getState(), readyN = store.getState();
  expect(readyP.status).toBe('ready'); expect(readyN.status).toBe('ready'); expect(readyP).not.toBe(beforeP); expect(readyN).not.toBe(beforeN);
  p.setState({}); n.setState({}); expect(usePersonalSettings.getState()).toBe(readyP); expect(store.getState()).toBe(readyN);
  const error = new Error('temporary'); p.setState({ error, status: 'error' });
  expect(usePersonalSettings.getState().loadError).toBe(error); expect(usePersonalSettings.getState().values?.notes).toBe(readyP.values?.notes);
  requestRead(p); requestRead(n); expect(usePersonalSettings.getState().fresh).toBe(false); expect(store.getState().fresh).toBe(false);
  const h = renderHook(() => useReadState(p.queryKey), { wrapper: wrapper(queryClient) });
  await act(async () => { recordReadProof(p, { ...captureReadProof(f.index, p.queryKey), acquiredAt: 1234 }); await tick(); });
  expect(h.result.current.assessment.acquiredAt).toBe(1234);
  n.setState({ data: undefined, status: 'error', error }); expect(store.getState().status).toBe('error');
});

test('actual facts, Reader, row gate, detail, personal/notice and useQuery share final state', async () => {
  const f = fixture(queryClient); bindWriteAccess(queryClient);
  usePersonalSettings.setState({ root: f.index.root, status: 'ready' });
  receipt(resources.personalSettings(f.index.root).queryKey, { values: { theme: 'dark' }, revision: f.index.person.settings });
  const store = createNoticeStore(); store.setState({ root: f.index.root, status: 'ready' });
  receipt(resources.notices(f.index.root).queryKey, { state: { version: NOTICE_VERSION, checkpoint: { at: '2026-10-20T00:00:00.000Z', tasks: {} }, reads: {} }, revision: f.index.person.notices });
  const index = f.index, baseline = store.getState();
  const workspace = createWorkspaceStore({ ...mapWorkspace(index, { checkpoint: baseline.checkpoint!, reads: baseline.reads, firstSeen: baseline.firstSeen }), people: indexPeople(index), drawing: { root: index.root, restoredAt: null },
    info: { root: index.root, rev: index.rev, checkpointAt: baseline.checkpoint!.at, writable: index.writable, errors: index.errors, staleIds: index.staleIds, runs: index.runs, profiles: index.profiles,
      attachmentBytes: index.attachmentBytes, projects: index.projects, presence: index.presence, host: index.host, coordinatorWork: index.coordinatorWork, launchMemory: index.launchMemory, counts: index.counts, home: index.home } });
  const withWorkspace = ({ children }: any) => <QueryClientProvider client={queryClient}><WorkspaceContext value={workspace}>{children}</WorkspaceContext></QueryClientProvider>;
  const commits: any[] = [];
  const h = renderHook(() => {
    const facts = useServerReadFacts(), reader = useReaderTask('T1'), detail = useTaskReadState(f.index.root, 'T1', false);
    const disabled = useWriteDisabled(rowWriteBasis('T1', (f.query.state.data as any).task.hash));
    const person = usePersonalSettings(), notices = useSyncExternalStore(store.subscribe, store.getState);
    const standard = useQuery({ queryKey: ['index'], enabled: false });
    const snapshot = { facts, reader, detail, disabled, person, notices, standard: standard.data };
    useLayoutEffect(() => { commits.push(snapshot); }); return snapshot;
  }, { wrapper: withWorkspace });
  const first = h.result.current; await act(tick); commits.length = 0;
  await act(async () => {
    const held = f.query.state.data as any;
    queryClient.setQueryData(f.key, { ...held, task: { ...held.task, values: { notes: 'changed body, equal projected rows' } } });
    recordReadProof(f.query, captureReadProof(f.index, f.key));
    expect(h.result.current).toBe(first); await tick();
  });
  expect(h.result.current.facts).toBe(first.facts); expect(h.result.current.reader).toBe(first.reader);
  expect(h.result.current.detail.view?.task.values?.notes).toBe('changed body, equal projected rows'); expect(h.result.current.disabled).toBe(false);
  expect(h.result.current.person).toBe(first.person); expect(h.result.current.notices).toBe(first.notices);
  expect(commits).toHaveLength(1);
  await act(async () => { requestRead(f.query); await tick(); });
  expect(h.result.current.detail.assessment.state).toBe('unverified'); expect(h.result.current.disabled).toBe(true);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(f.query.state.data));
  await act(async () => { await queryClient.fetchQuery({ ...resources.taskView(f.index.root, 'T1'), staleTime: 0 }); await tick(); });
  expect(h.result.current.disabled).toBe(false);
  const indexQuery = readQuery(queryClient, ['index'])!;
  await act(async () => { requestRead(indexQuery); await tick(); });
  expect(h.result.current.facts).toBeUndefined(); expect(h.result.current.disabled).toBe(true);
  vi.mocked(fetch).mockResolvedValue(Response.json(f.index));
  await act(async () => { await queryClient.fetchQuery({ ...resources.index(), staleTime: 0 }); await tick(); });
  expect(h.result.current.facts).toBeDefined(); expect(h.result.current.disabled).toBe(false);
});

test.each(['generation', 'remove', 'clear', 'error', 'cancel'] as const)('flush-adapted original lifecycle still tests actual invalidation: %s', async kind => {
  const f = fixture(), h = renderHook(useServerReadFacts, { wrapper: wrapper(f.client) }), first = h.result.current;
  await act(async () => {
    if (kind === 'generation') receiveFullIndex(f.client, { ...f.index, generation: 'replacement' });
    if (kind === 'remove') f.client.removeQueries({ queryKey: f.key, exact: true });
    if (kind === 'clear') f.client.clear();
    if (kind === 'error') f.query.setState({ status: 'error', error: new Error('temporary') });
    if (kind === 'cancel') {
      let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
      const flight = f.client.fetchQuery({ queryKey: f.key, queryFn: ({ signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); started();
      }) }).catch(() => {});
      await ready; await f.client.cancelQueries({ queryKey: f.key, exact: true }, { revert: true }); await flight;
    }
    await tick();
  });
  expect(h.result.current).toBe(serverReadFacts(f.client));
  if (kind === 'error' || kind === 'cancel') expect(h.result.current).toBe(first);
  else expect(h.result.current?.tasks.some(row => row.id === 'T1') ?? false).toBe(false);
});

test('a render with new option functions tells no read reader; enabling an observer does', async () => {
  const f = fixture();
  let told = 0;
  stops.push(subscribeReads(f.client, () => told++));
  const observed = (enabled: boolean) => ({ queryKey: f.key, queryFn: () => f.query.state.data, staleTime: Infinity, enabled });
  const { rerender } = renderHook(({ enabled }) => useQuery(observed(enabled)), { wrapper: wrapper(f.client), initialProps: { enabled: true } });
  await tick(); await tick();
  const types: string[] = [];
  stops.push(f.client.getQueryCache().subscribe(event => types.push(event.type)));
  told = 0;
  for (let n = 0; n < 5; n++) rerender({ enabled: true });
  await tick();
  expect(types.every(type => type === 'observerOptionsUpdated')).toBe(true);
  expect(told).toBe(0);
  rerender({ enabled: false });
  await tick();
  expect(told).toBeGreaterThan(0);
});
