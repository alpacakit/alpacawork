import { useRef } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { i18n, startI18n } from '@alpacawork/i18n';
import { ReadFailure, ReadRetryContext } from '../src/components/ui/loadable';
import { useTaskDetail } from '../src/data/queries';
import { receiveFullIndex, resources } from '../src/data/resources';
import { getReadProof, readQuery, restoreReadScope, taskReadState } from '../src/data/read-model';
import { readDemandPending, requestRead } from '../src/data/read-demand';
import { useConnection } from '../src/data/connection';
import { mapWorkspace } from '../src/data/map';
import { indexPeople } from '../src/domain/people';
import { createWorkspaceStore, WorkspaceContext } from '../src/data/workspace-store';
import { useReaderRestoration } from '../src/features/reader/reading-restoration';
import { noteReaderPosition, noteReaderScroll, readerHistoryPosition } from '../src/state/reader-position';
import { useViewStore, type ReaderPane } from '../src/state/view-store';
import { dto, indexOf, tree, viewsOf } from './fixtures';

// Position capture is an input from reader-position, exactly as in reading-restoration.test.tsx. No read-model,
// query, resource, retry or restoration result is mocked. jsdom is not evidence of PWA/layout/180px repair.
vi.mock('../src/state/reader-position', () => ({
  noteReaderPlace: vi.fn(), noteReaderPosition: vi.fn(), noteReaderScroll: vi.fn(), readerHistoryPosition: vi.fn(), showingNavigation: vi.fn(() => false),
}));
const original = { task: 'T1', pane: 'task' as const, path: null, scroll: 500, referenceId: 'T2', occurrence: 1 };
const reset = vi.fn(), start = vi.fn();
const clients: QueryClient[] = [];
const flush = async (ms = 25) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const response = (data: unknown) => new Response(JSON.stringify(data));
beforeAll(() => startI18n());
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  useConnection.setState({ offline: false, state: "live" });
  vi.mocked(readerHistoryPosition).mockReturnValue({ ...original });
  useViewStore.setState({ ...useViewStore.getInitialState(), selected: 'T1', event: 'request:original',
    reader: { ...useViewStore.getInitialState().reader, open: true, pane: 'task' } });
});
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients.length = 0; vi.useRealTimers(); });

async function fixture() {
  const value = tree({ tasks: [dto({ id: 'T1' }), dto({ id: 'T2' })] });
  const index = indexOf(value), view = viewsOf(value).find(view => view.task.id === 'T1')!;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, networkMode: 'always' } } });
  clients.push(client); receiveFullIndex(client, index);
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(view));
  const options = resources.taskView(index.root, 'T1');
  await client.fetchQuery(options); // The held value and its proof came through the real resource GET.
  const query = readQuery(client, options.queryKey)!;
  const mapped = mapWorkspace(index, { checkpoint: { at: new Date(0).toISOString(), tasks: {} }, reads: {}, firstSeen: new Map() });
  const store = createWorkspaceStore({ ...mapped, people: indexPeople(index), drawing: { root: index.root, restoredAt: null }, info: {
    root: index.root, rev: index.rev, checkpointAt: new Date(0).toISOString(), automationsVersion: index.automationsVersion, writable: index.writable,
    errors: index.errors, staleIds: index.staleIds, runs: index.runs, profiles: index.profiles,
    attachmentBytes: value.attachmentBytes, projects: index.projects, presence: index.presence, host: index.host, coordinatorWork: index.coordinatorWork,
    counts: index.counts, home: index.home,
  } });
  const task = mapped.tasks.find(task => task.id === 'T1')!;
  function Reading({ historyReady = true, missing = false, pane = 'task' }: { historyReady?: boolean; missing?: boolean; pane?: ReaderPane }) {
    const read = useTaskDetail(task);
    const area = useRef<HTMLDivElement>(null), placing = useRef<string | null>(null);
    const { retry, noteScroll } = useReaderRestoration(area, true, task.id, pane, pane === 'files' ? '/old.md' : null,
      read.detail?.id, read.viewSettled, reset, start, placing);
    return <ReadRetryContext value={retry}><div data-reader-content ref={area} onScroll={event => noteScroll(event.currentTarget.scrollTop)}>
      <div data-report-feed data-history-ready={historyReady} data-history-exhausted={historyReady}>
        {!missing && <li data-report-key="request:original"><button aria-expanded="true">Original instruction</button>
          <span data-task-reference="T2" /><span data-task-reference="T2" /></li>}
        <p>{String(read.detail?.values.values.notes ?? "")}</p>
      </div>
    </div><ReadFailure retry={() => { void read.query.refetch(); }} /></ReadRetryContext>;
  }
  const mount = (props: Parameters<typeof Reading>[0] = {}) => {
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>
      <WorkspaceContext value={store}><I18nextProvider i18n={i18n}>{children}</I18nextProvider></WorkspaceContext>
    </QueryClientProvider>;
    const result = render(<Reading {...props} />, { wrapper });
    return { ...result, area: result.container.querySelector<HTMLElement>('[data-reader-content]')!,
      show: (next: Parameters<typeof Reading>[0]) => result.rerender(<Reading {...next} />),
      retry: () => fireEvent.click(result.getByRole('button', { name: 'Retry' })) };
  };
  function pending(demand = true) {
    const next = deferred<Response>(); fetch.mockImplementation(() => next.promise);
    if (demand) requestRead(query);
    const done = query.fetch().then(() => undefined, error => error);
    return { ...next, done };
  }
  return { client, index, view, query, fetch, mount, pending };
}
const move = (area: HTMLElement) => { fireEvent.wheel(area, { deltaY: -180 }); area.scrollTop = 100; };

// The source defect was early retirement on an already drawn History floor, while detail.id and old success survived.
test('held detail with pending then failed demand keeps the whole original for header Retry and retires after success', async () => {
  const f = await fixture(), loading = f.pending();
  const mounted = f.mount(); await flush();
  expect(f.query.state).toMatchObject({ status: 'success', fetchStatus: 'fetching' });
  expect(getReadProof(f.query)?.demandPending).toBe(true);
  expect(mounted.area.scrollTop).toBe(500); // Held content can be placed before network completion.
  move(mounted.area); await flush();
  await act(async () => { loading.resolve(new Response('temporary', { status: 503 })); await loading.done; }); await flush();
  expect(f.query.state).toMatchObject({ status: 'error', fetchStatus: 'idle' });
  expect(readDemandPending(f.query)).toBe(true);
  const recovered = deferred<Response>(); f.fetch.mockImplementation(() => recovered.promise);
  mounted.retry();
  expect(noteReaderPosition).toHaveBeenLastCalledWith(original);
  await act(async () => { recovered.resolve(response(f.view)); }); await flush();
  expect(mounted.area.scrollTop).toBe(500);
  expect(taskReadState(f.client, f.index.root, 'T1').viewSettled).toBe(true);
  vi.mocked(noteReaderPosition).mockClear();
  const later = f.pending(); await flush();
  await act(async () => { later.resolve(new Response('temporary', { status: 503 })); await later.done; }); await flush();
  mounted.retry();
  expect(noteReaderPosition).not.toHaveBeenCalled(); // A later failure cannot revive a finished request.
});

test('human movement is not corrected by late adopted success, which retires the old Retry request', async () => {
  const f = await fixture(), loading = f.pending(), mounted = f.mount(); await flush();
  move(mounted.area); await flush();
  expect(noteReaderScroll).toHaveBeenLastCalledWith('T1', 'task', null, 500);
  await act(async () => { loading.resolve(response(f.view)); await loading.done; }); await flush();
  expect(mounted.area.scrollTop).toBe(100);
  vi.mocked(noteReaderPosition).mockClear();
  const later = f.pending(); await flush();
  await act(async () => { later.resolve(new Response('temporary', { status: 503 })); await later.done; }); await flush();
  mounted.retry(); await flush();
  expect(noteReaderPosition).not.toHaveBeenCalled(); expect(mounted.area.scrollTop).toBe(100);
});

test('an older successful GET cannot retire a newer same-Task demand', async () => {
  const f = await fixture(), loading = f.pending(), mounted = f.mount(); await flush();
  move(mounted.area); await flush();
  act(() => requestRead(f.query));
  const next = deferred<Response>(); f.fetch.mockImplementation(() => next.promise);
  await act(async () => { loading.resolve(response(f.view)); await loading.done; }); await flush();
  expect(readDemandPending(f.query)).toBe(true);
  expect(taskReadState(f.client, f.index.root, 'T1').viewSettled).toBe(false);
  expect(mounted.area.scrollTop).toBe(100);
  mounted.retry();
  expect(noteReaderPosition).toHaveBeenLastCalledWith(original);
  await act(async () => { next.resolve(response(f.view)); }); await flush();
  expect(mounted.area.scrollTop).toBe(500);
});

test('retained offline contents place without requiring unrelated successful reads or server write qualification', async () => {
  const f = await fixture(); restoreReadScope(f.client, false);
  useConnection.setState({ offline: true }); f.fetch.mockClear();
  const mounted = f.mount(); await flush();
  expect(taskReadState(f.client, f.index.root, 'T1').assessment).toMatchObject({ display: true, project: false });
  expect(mounted.area.scrollTop).toBe(500); expect(f.fetch).not.toHaveBeenCalled();
  move(mounted.area); vi.mocked(noteReaderPosition).mockClear(); mounted.retry();
  expect(noteReaderPosition).not.toHaveBeenCalled();
});

for (const destination of ['task', 'pane', 'path', 'event', 'close'] as const)
  test(`leaving ${destination} synchronously discards the original before return and late success`, async () => {
    const f = await fixture(), loading = f.pending();
    const pane = destination === 'path' ? 'files' : 'task';
    if (pane === 'files') {
      vi.mocked(readerHistoryPosition).mockReturnValue({ ...original, pane, path: '/old.md' });
      useViewStore.setState({ reader: { ...useViewStore.getState().reader, pane }, filePath: { taskId: 'T1', path: '/old.md' } });
    }
    const mounted = f.mount({ pane }); await flush(); move(mounted.area); await flush();
    act(() => {
      const before = useViewStore.getState();
      if (destination === 'task') useViewStore.setState({ selected: 'T2' });
      else if (destination === 'event') useViewStore.setState({ event: 'request:other' });
      else if (destination === 'path') useViewStore.setState({ filePath: { taskId: 'T1', path: '/new.md' } });
      else useViewStore.setState({ reader: { ...before.reader, ...(destination === 'close' ? { open: false } : { pane: 'files' }) } });
      useViewStore.setState(before);
    });
    mounted.retry(); expect(noteReaderPosition).not.toHaveBeenCalled();
    await act(async () => { loading.resolve(response(f.view)); await loading.done; }); await flush();
    expect(mounted.area.scrollTop).toBe(100);
  });

test('read-result changes do not restart the 30-second attempt cap; Retry can still select unfinished History', async () => {
  const f = await fixture(), loading = f.pending(), mounted = f.mount({ historyReady: false }); await flush(29_000);
  await act(async () => { loading.resolve(response(f.view)); await loading.done; }); await flush();
  expect(taskReadState(f.client, f.index.root, 'T1').viewSettled).toBe(true);
  await flush(1_100);
  const resets = reset.mock.calls.length;
  fireEvent.wheel(mounted.area, { deltaY: -180 });
  expect(reset).toHaveBeenCalledTimes(resets); // Cap already ended automatic placement.
  expect(noteReaderScroll).toHaveBeenLastCalledWith('T1', 'task', null, 0); // The real vertical intent still chooses the boundary.
  mounted.retry(); expect(noteReaderPosition).toHaveBeenLastCalledWith(original);
  mounted.show({ historyReady: true }); await flush(); expect(mounted.area.scrollTop).toBe(500);
});

test('exhausted History without the target cannot retire a still failed detail request', async () => {
  const f = await fixture(), loading = f.pending(), mounted = f.mount({ missing: true }); await flush();
  await act(async () => { loading.resolve(new Response('temporary', { status: 503 })); await loading.done; }); await flush();
  mounted.retry(); expect(noteReaderPosition).toHaveBeenLastCalledWith(original);
});
