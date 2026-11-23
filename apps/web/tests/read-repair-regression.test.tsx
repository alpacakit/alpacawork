import { sendDirectIntent, checkDirectIntent } from '../src/data/direct-write';
import { intentKey, useWriteIntentStore, checkWriteIntent } from '../src/data/write-intent';
import { rememberWriteIdentity } from '../src/data/write-identity';
import { createApi } from '../src/data/client';
import { rowWriteBasis, detailWriteBasis } from '../src/data/connection';
/** The original read-repair symptoms: assert the required behaviour through existing product boundaries. */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { dehydrate, hydrate, QueryObserver, type InfiniteData } from '@tanstack/react-query';
import { defaultSettings } from '@alpacawork/contract';
import { projectedIndexSchema, taskProjectedPageSchema, taskWriteResultSchema, type ProjectedIndexDTO, type TaskProjectedPageDTO } from '@alpacawork/contract/control';
import { queryClient } from '../src/data/query-client';
import { usePersonalSettings } from '../src/data/personal-settings';
import { canSendWrites, useConnection } from '../src/data/connection';
import { assessRead, indexKey, onReadEvent, receiveFullIndex, receivePatch, recoverReads, resources, showWrittenTask, startRequiredReadSession } from '../src/data/resources';
import { taskReadState } from '../src/data/read-model';
import { captureReadProof, configureReadRetention, READ_DAY, READ_MAX_BYTES, READ_TASK_AGE, recordReadProof } from '../src/data/read-model';
import { startReadPersistence, restoreReadPersistence } from '../src/data/read-persistence';
import { readSize } from '../src/data/read-retention';
import { selectRetainedReads } from './retained-reads';
import { displayReadFacts, readerPresentation } from '../src/data/read-model';
import { readIndex, serverReadFacts } from '../src/data/read-model';
import { historyWindowAnswer, serverPage, serverPatch } from './receipt-fixture';
import { writeTask } from '../src/data/task-write';
import { headOf, dto, historyFixture, indexOf, searchAnswer, tree, viewsOf } from './fixtures';

function seedRequired(index: ProjectedIndexDTO) {
  queryClient.setQueryData(indexKey, index);
  queryClient.setQueryData(resources.personalSettings(index.root).queryKey, { values: defaultSettings(), revision: index.person.settings ?? 'settings' });
  queryClient.setQueryData(resources.notices(index.root).queryKey, { state: null, revision: index.person.notices });
}
const response = (value: unknown) => new Response(JSON.stringify(value));
const cleanups: (() => void)[] = [];
beforeEach(() => {
  queryClient.clear();
  usePersonalSettings.setState(usePersonalSettings.getInitialState(), true);
  useConnection.setState({ state: 'live', fresh: true, writable: true, offline: false });
});
afterEach(() => { cleanups.splice(0).reverse().forEach(stop => stop()); queryClient.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test('K1 hydrate → ordinary load → new live marker → recover → forced load installs the actual new settings once', async () => {
  const index = indexOf(tree()); index.person.settings = 'old'; receiveFullIndex(queryClient, index);
  const key = resources.personalSettings(index.root).queryKey;
  queryClient.setQueryData(key, { values: { ...defaultSettings(), theme: 'dark' }, revision: 'old' });
  const saved = dehydrate(queryClient);
  queryClient.removeQueries({ queryKey: key, exact: true });
  hydrate(queryClient, { mutations: [], queries: saved.queries.filter(read => read.queryKey[0] === 'person-settings') });
  const query = queryClient.getQueryCache().find({ queryKey: key, exact: true })!;
  recordReadProof(query, captureReadProof(index, key));
  await usePersonalSettings.getState().load(index.root);
  expect(usePersonalSettings.getState().values.theme).toBe('dark');
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response({ values: { ...defaultSettings(), theme: 'light' }, revision: 'new' }));
  receiveFullIndex(queryClient, { ...index, rev: index.rev + 1, person: { ...index.person, settings: 'new' } });
  recoverReads(queryClient);
  await usePersonalSettings.getState().load(index.root, true);
  expect.soft(usePersonalSettings.getState().values.theme).toBe('light');
  expect.soft(usePersonalSettings.getState().revision).toBe('new');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

for (const kind of ['finished', 'shelved'] as const) test(`P1/P7 first ${kind} GET overtaken by a receipt cannot project its old row as current`, async () => {
  const old = dto({ id: 'T9', title: 'OLD', state: 'done', lifecycle: kind === 'shelved' ? 'archived' : 'active' });
  const index = indexOf(tree({ tasks: [] })); receiveFullIndex(queryClient, index);
  const options = kind === 'finished' ? resources.finished(index.root, null) : resources.shelved(index.root, null);
  const oldRow = { ...searchAnswer(['T9']).rows[0]!, title: old.title, state: old.state, lifecycle: old.lifecycle, hash: old.hash, version: old.version };
  const page = taskProjectedPageSchema.parse(serverPage([oldRow]));
  let release!: (value: Response) => void;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const pending = (kind === 'finished' ? queryClient.fetchInfiniteQuery(resources.finished(index.root, null))
    : queryClient.fetchInfiniteQuery(resources.shelved(index.root, null))).catch(() => undefined);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(queryClient.getQueryData(options.queryKey)).toBeUndefined();
  showWrittenTask(queryClient, headOf({ ...old, title: 'NEW', version: 2, hash: 'b'.repeat(64) }));
  release(response(page)); await pending;
  const query = queryClient.getQueryCache().find({ queryKey: options.queryKey, exact: true })!;
  const current = serverReadFacts(queryClient)!.tasks;
  expect.soft(current.find(row => row.id === 'T9')?.title).not.toBe('OLD');
  // A dated response may remain readable, but its old value must not be certified current.
  if ((query.state.data as InfiniteData<TaskProjectedPageDTO> | undefined)?.pages[0]?.rows[0]?.title === 'OLD') expect(assessRead(queryClient, query).project).toBe(false);
});

test('M1 control: an unrelated Task GET still enters the current cache and projection', async () => {
  const task = dto({ id: 'T10', title: 'UNRELATED' });
  const value = tree({ tasks: [task] }), index = indexOf(value); receiveFullIndex(queryClient, index);
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(viewsOf(value).find(view => view.task.id === task.id)!));
  await queryClient.fetchQuery(resources.taskView(index.root, task.id));
  const query = queryClient.getQueryCache().find({ queryKey: resources.taskView(index.root, task.id).queryKey, exact: true })!;
  expect(fetcher).toHaveBeenCalledTimes(1); expect(assessRead(queryClient, query).project).toBe(true);
  expect(serverReadFacts(queryClient)!.tasks.find(row => row.id === task.id)?.title).toBe('UNRELATED');
});

test('M1 same Task hint/detail consumers share one actual GET', async () => {
  const value = tree({ tasks: [dto({ id: 'T9' })] }), index = indexOf(value); receiveFullIndex(queryClient, index);
  let release!: (value: Response) => void;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const first = queryClient.fetchQuery(resources.taskView(index.root, 'T9'));
  const second = queryClient.fetchQuery(resources.taskView(index.root, 'T9'));
  expect(fetcher).toHaveBeenCalledTimes(1);
  release(response(viewsOf(value).find(view => view.task.id === 'T9')!));
  const [hint, detail] = await Promise.all([first, second]); expect(hint).toEqual(detail);
  expect(queryClient.getQueryCache().findAll({ queryKey: resources.taskView(index.root, 'T9').queryKey, exact: true })).toHaveLength(1);
});

test('M1 a GET begun after the row POST but before publication cannot certify a version below that receipt', async () => {
  const old = dto({ id: 'T9', title: 'OLD' }), value = tree({ tasks: [old] }), index = indexOf(value); receiveFullIndex(queryClient, index);
  const committed = { ...old, lifecycle: 'archived' as const, version: 2, title: 'NEW', hash: 'b'.repeat(64) };
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, input) => response(input?.method === 'POST'
    ? { task: headOf(committed) } : viewsOf(value).find(view => view.task.id === 'T9')!));
  await writeTask(queryClient, 'task/archive', { task: old.id, expectedTaskHash: old.hash }, taskWriteResultSchema, 'receipt-before-publication', rowWriteBasis(old.id, old.hash));
  // The old full view is genuinely fetched after the write, with no cached view to provide a version floor.
  await queryClient.fetchQuery(resources.taskView(index.root, old.id)).catch(() => undefined);
  expect(fetcher).toHaveBeenCalledTimes(2);
  const query = queryClient.getQueryCache().find({ queryKey: resources.taskView(index.root, old.id).queryKey, exact: true })!;
  expect.soft(assessRead(queryClient, query).project).toBe(false);
  expect(serverReadFacts(queryClient)!.tasks.find(row => row.id === old.id)?.title).not.toBe('OLD');
});

for (const kind of ['empty Task ID', 'empty search'] as const) test(`M4 recovery does not send a disabled ${kind} GET`, async () => {
  const index = indexOf(tree()); receiveFullIndex(queryClient, index);
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 400 }));
  // Same disabled options used by useTaskDetail/useSearch, not a mock of recovery or cancellation.
  const observer = kind === 'empty Task ID'
    ? new QueryObserver(queryClient, { ...resources.taskView(index.root, ''), enabled: false })
    : new QueryObserver(queryClient, { ...resources.taskSearch(index.root, '', null), enabled: false });
  const stop = observer.subscribe(() => {}); cleanups.push(() => { stop(); observer.destroy(); });
  recoverReads(queryClient);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(fetcher).not.toHaveBeenCalled();
});

for (const dbUnavailable of [false, true]) test(`M2 active view protects inactive History; release expires the complete group (DB unavailable=${dbUnavailable})`, async () => {
  vi.useFakeTimers();
  if (dbUnavailable) {
    vi.stubGlobal('indexedDB', { open() { throw new DOMException('Unavailable storage', 'UnknownError'); } });
    await restoreReadPersistence(queryClient);
  } else configureReadRetention(queryClient);
  const value = tree({ tasks: [dto({ id: 'T9' })] }), index = indexOf(value); receiveFullIndex(queryClient, index);
  const history = { events: historyFixture([{ id: 'L9', taskId: 'T9', kind: 'comment', title: 'Kept History', summary: 'Keep this actual report with the active body.' }]), nextBefore: null };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => response(String(url).includes('/history')
    ? historyWindowAnswer(history.events) : viewsOf(value).find(view => view.task.id === 'T9')!));
  await queryClient.fetchQuery(resources.taskView(index.root, 'T9'));
  await queryClient.fetchQuery(resources.history(index.root, 'T9'));
  cleanups.push(startReadPersistence(queryClient, changed => onReadEvent(queryClient, changed)));
  const observer = new QueryObserver(queryClient, resources.taskView(index.root, 'T9'));
  const stop = observer.subscribe(() => {}); cleanups.push(() => { stop(); observer.destroy(); });
  const historyKey = resources.history(index.root, 'T9').queryKey;
  await vi.advanceTimersByTimeAsync(READ_TASK_AGE + READ_DAY);
  expect.soft(queryClient.getQueryData(historyKey), 'active group must retain its inactive History through the native GC deadline').toEqual({ pages: [history], pageParams: [null] });
  stop(); observer.destroy();
  await vi.advanceTimersByTimeAsync(READ_TASK_AGE - 1);
  expect.soft(queryClient.getQueryData(resources.taskView(index.root, 'T9').queryKey), 'group gets its full lifetime after last use').toBeDefined();
  await vi.advanceTimersByTimeAsync(2);
  expect(queryClient.getQueryData(historyKey)).toBeUndefined();
  expect(queryClient.getQueryData(resources.taskView(index.root, 'T9').queryKey)).toBeUndefined();
});

test('M5 disk retains a mandatory index of more rows than the Task budget, and settings, within 8MiB', () => {
  const count = 101; // One past READ_MAX_TASKS: an index's rows are not Tasks retained.
  const index = projectedIndexSchema.parse(indexOf(tree({ tasks: Array.from({ length: count - 1 }, (_, at) => dto({ id: `T${at + 2000}` })) })));
  expect(index.tasks).toHaveLength(count); // tree includes its project; count is the real DTO's count.
  seedRequired(index);
  const reads = dehydrate(queryClient).queries;
  const record = (queries: typeof reads) => ({ snapshot: { mutations: [], queries } });
  expect(readSize(record(reads))).toBeLessThan(READ_MAX_BYTES);
  const selected = selectRetainedReads(reads, Date.now(), readSize(record([])));
  expect.soft(selected.unavailable).toBe(false);
  expect(selected.queries.map(read => read.queryKey[0])).toEqual(['index', 'person-settings', 'person-notices']);
});

test('M5 valid required DTO around 8MiB: exact record bytes determine disk availability', () => {
  const index = indexOf(tree());
  const error = { code: 'fault', path: 'root', message: '' };
  seedRequired(projectedIndexSchema.parse({ ...index, errors: [error] }));
  const [read, ...basis] = dehydrate(queryClient).queries;
  if (!read) throw new Error('index is required');
  const record = (queries: typeof read[]) => ({ token: '0'.repeat(36), snapshot: { mutations: [], queries } });
  const base = readSize(record([read, ...basis]));
  for (const delta of [-1, 0, 1]) {
    const data = projectedIndexSchema.parse({ ...index, errors: [{ ...error, message: 'x'.repeat(READ_MAX_BYTES - base + delta) }] });
    const valid = { ...read, state: { ...read.state, data } };
    expect(readSize(record([valid, ...basis]))).toBe(READ_MAX_BYTES + delta);
    expect(selectRetainedReads([valid, ...basis], Date.now(), readSize(record([]))).unavailable).toBe(delta > 0);
  }
});

test('M5 the 100 unique optional Tasks do not include mandatory index rows or count History twice', () => {
  const value = tree({ tasks: Array.from({ length: 101 }, (_, at) => dto({ id: `T${at + 2000}` })) });
  seedRequired(indexOf(tree()));
  for (const view of viewsOf(value).filter(view => view.task.kind !== 'project')) {
    queryClient.setQueryData(resources.taskView(value.root, view.task.id).queryKey, view);
    queryClient.setQueryData(resources.history(value.root, view.task.id).queryKey, { pages: [{ events: [], nextBefore: null }], pageParams: [null] });
  }
  const reads = dehydrate(queryClient).queries.map((read, at) => ({ ...read, meta: { readUsedAt: Date.now() + at } }));
  const selection = selectRetainedReads(reads, Date.now(), readSize({ snapshot: { mutations: [], queries: [] } }));
  expect(selection.queries.filter(read => read.queryKey[0] === 'task')).toHaveLength(100);
  expect(selection.queries.filter(read => read.queryKey[0] === 'task-history')).toHaveLength(100);
});

test('M5 valid base over 8MiB and unavailable DB preserve online settings and write access in the real composition', async () => {
  vi.stubGlobal('indexedDB', { open() { throw new DOMException('Unavailable storage', 'UnknownError'); } });
  await restoreReadPersistence(queryClient);
  const index = indexOf(tree()); index.person.settings = 's1'; receiveFullIndex(queryClient, index);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ values: { ...defaultSettings(), theme: 'light' }, revision: 's1' }));
  await usePersonalSettings.getState().load(index.root);
  cleanups.push(startReadPersistence(queryClient, changed => onReadEvent(queryClient, changed)));
  const giant = projectedIndexSchema.parse({ ...index, rev: index.rev + 1, errors: [{ code: 'fault', path: 'root', message: 'x'.repeat(READ_MAX_BYTES) }] });
  receiveFullIndex(queryClient, giant);
  window.dispatchEvent(new Event('pagehide'));
  expect.soft(queryClient.getQueryData(resources.personalSettings(index.root).queryKey)).toBeDefined();
  expect.soft(usePersonalSettings.getState().values.theme).toBe('light');
  expect(canSendWrites()).toBe(true);
});

for (const active of [true, false]) test(`N1 503 retry overtaken by receipt owes exactly one successor (active=${active})`, async () => {
  const old = dto({ id: 'T9', title: 'OLD', state: 'done' }), index = indexOf(tree({ tasks: [] })); receiveFullIndex(queryClient, index);
  const options = resources.finished(index.root, null);
  const row = { ...searchAnswer(['T9']).rows[0]!, title: 'OLD', state: 'done' as const, hash: old.hash, version: 1 };
  const page = taskProjectedPageSchema.parse(serverPage([row]));
  const newer = { ...old, title: 'NEW', version: 2, hash: 'b'.repeat(64) };
  let release!: (response: Response) => void, calls = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    calls++;
    if (calls === 1) return new Response('{}', { status: 503 });
    if (calls === 2) return new Promise(resolve => { release = resolve; });
    return response({ ...page, sourcePv: 1, rows: [{ ...row, title: 'NEW', hash: newer.hash, version: 2 }] });
  });
  await queryClient.fetchInfiniteQuery(options).catch(() => {});
  // This is the real retry after an error, while the Query still has no data.
  const retry = queryClient.fetchInfiniteQuery(options);
  let stop = () => {};
  if (active) { const observer = new QueryObserver(queryClient, options); stop = observer.subscribe(() => {}); cleanups.push(() => { stop(); observer.destroy(); }); }
  showWrittenTask(queryClient, headOf(newer));
  release(response(page)); await retry;
  // The write's patch: the finished page now requires its version.
  receivePatch(queryClient, serverPatch(readIndex(queryClient)!, [], { page: ['finished:root'] }));
  const query = queryClient.getQueryCache().find({ queryKey: options.queryKey, exact: true })!;
  if (!active) {
    expect(assessRead(queryClient, query).project).toBe(false);
    const observer = new QueryObserver(queryClient, options); stop = observer.subscribe(() => {}); cleanups.push(() => { stop(); observer.destroy(); });
  }
  await vi.waitFor(() => expect(calls).toBe(3));
  await vi.waitFor(() => expect(assessRead(queryClient, query).project).toBe(true));
  expect(serverReadFacts(queryClient)!.tasks.find(row => row.id === 'T9')?.title).toBe('NEW');
  await new Promise(resolve => setTimeout(resolve, 30)); expect(calls).toBe(3);
});

test('N1 repeated same-marker SSE does not multiply demand, and a failed successor never loops', async () => {
  const old = dto({ id: 'T9' }), value = tree({ tasks: [old] }), index = indexOf(value); receiveFullIndex(queryClient, index);
  let release!: (response: Response) => void, calls = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { calls++; return calls === 1 ? new Promise(resolve => { release = resolve; }) : new Response('{}', { status: 503 }); });
  const observer = new QueryObserver(queryClient, resources.taskView(index.root, old.id));
  const stop = observer.subscribe(() => {}); cleanups.push(() => { stop(); observer.destroy(); });
  for (let at = 1; at < 5; at++) receiveFullIndex(queryClient, { ...index, rev: index.rev + at });
  release(response(viewsOf(value).find(view => view.task.id === old.id)!));
  await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true)); expect(calls).toBe(1);
  const changed = { ...index, rev: index.rev + 5, sourcePv: 1 as never, requiredPv: { ...index.requiredPv, view: { [old.id]: 1 as never } } };
  receiveFullIndex(queryClient, changed);
  await vi.waitFor(() => expect(calls).toBe(2));
  await new Promise(resolve => setTimeout(resolve, 40)); expect(calls).toBe(2);
  for (let at = 0; at < 8; at++) observer.setOptions({ ...resources.taskView(index.root, old.id), meta: { rerender: at } });
  await new Promise(resolve => setTimeout(resolve, 40)); expect(calls).toBe(2);
});

test('N2 the written document survives a below-floor GET without new authority and recovers on publication', async () => {
  const old = dto({ id: 'T9', title: 'OLD' }), value = tree({ tasks: [old] }), index = indexOf(value); receiveFullIndex(queryClient, index);
  const newer = { ...old, title: 'NEW', hash: 'b'.repeat(64), version: 3 };
  showWrittenTask(queryClient, headOf(newer));
  showWrittenTask(queryClient, headOf({ ...old, title: 'OLDER RECEIPT', version: 2 }));
  let calls = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { calls++; return response(viewsOf(tree({ tasks: [calls === 1 ? old : newer] }), calls === 1 ? 0 : 1).find(view => view.task.id === old.id)!); });
  const observer = new QueryObserver(queryClient, resources.taskView(index.root, old.id));
  const stop = observer.subscribe(() => {}); cleanups.push(() => { stop(); observer.destroy(); });
  await vi.waitFor(() => expect(queryClient.getQueryState(resources.taskView(index.root, old.id).queryKey)?.fetchStatus).toBe('idle'));
  const query = queryClient.getQueryCache().find({ queryKey: resources.taskView(index.root, old.id).queryKey, exact: true })!;
  expect(query.state.error).toBeNull(); expect(calls).toBe(1);
  expect(readerPresentation(queryClient, index.root, old.id)).toMatchObject({ kind: 'written', document: { title: 'NEW', version: 3 } });
  expect(assessRead(queryClient, query).project).toBe(false);
  expect(displayReadFacts(queryClient)!.tasks.find(row => row.id === old.id)?.title).toBe('NEW');
  expect(queryClient.getQueryData<ProjectedIndexDTO>(indexKey)!.tasks.find(row => row.id === old.id)?.title).toBe('OLD');
  // Its publication: the written view now requires the version that holds the write.
  receiveFullIndex(queryClient, indexOf(tree({ tasks: [newer] }), index.rev + 1, { view: { [old.id]: 1 } } as never));
  await vi.waitFor(() => expect(assessRead(queryClient, query).project).toBe(true)); expect(calls).toBe(2);
  receiveFullIndex(queryClient, indexOf(tree({ tasks: [newer] }), index.rev + 1, { view: { [old.id]: 1 } } as never));
  await new Promise(resolve => setTimeout(resolve, 30)); expect(calls).toBe(2);
});

test('N3 own receipt survives its first publication and failed full read as a savable dated view; later external change is obsolete', async () => {
  const old = dto({ id: 'T9' }), value = tree({ tasks: [old] }), index = indexOf(value); receiveFullIndex(queryClient, index);
  const options = resources.taskView(index.root, old.id);
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(viewsOf(value).find(view => view.task.id === old.id)!));
  await queryClient.fetchQuery(options);
  const query = queryClient.getQueryCache().find({ queryKey: options.queryKey, exact: true })!;
  const acquiredAt = assessRead(queryClient, query).acquiredAt;
  const newer = { ...old, values: { notes: 'SAVED BODY' }, version: 2, hash: 'b'.repeat(64) };
  showWrittenTask(queryClient, headOf(newer));
  expect(assessRead(queryClient, query)).toMatchObject({ state: 'unverified', display: true, persist: true, project: false, acquiredAt });
  fetcher.mockResolvedValue(new Response('{}', { status: 503 })); await queryClient.fetchQuery(options).catch(() => {});
  const published = indexOf(tree({ tasks: [newer] }), index.rev + 1, { view: { [old.id]: 1 } } as never); receiveFullIndex(queryClient, published);
  expect(assessRead(queryClient, query)).toMatchObject({ state: 'unverified', display: true, persist: true, project: false, acquiredAt });
  expect(taskReadState(queryClient, index.root, old.id).view?.task.values?.notes).toBe('SAVED BODY');
  // Someone else's change to it: its view requires a later version than the receipt's publication.
  receiveFullIndex(queryClient, { ...published, rev: published.rev + 1, sourcePv: 2 as never, requiredPv: { ...published.requiredPv, view: { [old.id]: 2 as never } } });
  expect(assessRead(queryClient, query)).toMatchObject({ state: 'obsolete', persist: false, project: false });
});

test('N5 required session rebinds root, same-root generation and clear with actual observers and one GET each', async () => {
  const counts = new Map<string, number>();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    const path = String(url); counts.set(path, (counts.get(path) ?? 0) + 1);
    return response(path.endsWith('/settings/get') ? { values: defaultSettings(), revision: 's1' } : { state: null, revision: null });
  });
  cleanups.push(startRequiredReadSession(queryClient));
  const initial = indexOf(tree()); initial.person.settings = 's1'; initial.person.notices = null;
  receiveFullIndex(queryClient, initial); recoverReads(queryClient);
  await vi.waitFor(() => expect(queryClient.getQueryData(resources.personalSettings(initial.root).queryKey)).toBeDefined());
  expect([...counts.values()]).toEqual([1, 1]);
  for (const query of queryClient.getQueryCache().getAll().filter(query => String(query.queryKey[0]).startsWith('person-'))) expect(query.isActive()).toBe(true);
  receiveFullIndex(queryClient, { ...initial, generation: 'new-gen' }); recoverReads(queryClient);
  await vi.waitFor(() => expect(counts.get('/api/commands/settings/get')).toBe(2));
  expect(counts.get('/api/person/notices')).toBe(2);
  queryClient.clear(); receiveFullIndex(queryClient, { ...initial, generation: 'new-gen' }); recoverReads(queryClient);
  await vi.waitFor(() => expect(counts.get('/api/commands/settings/get')).toBe(3));
  expect(counts.get('/api/person/notices')).toBe(3);
  receiveFullIndex(queryClient, { ...initial, root: '/other-root' }); recoverReads(queryClient);
  await vi.waitFor(() => expect(counts.get('/api/commands/settings/get')).toBe(4));
  expect(counts.get('/api/person/notices')).toBe(4);
});

test('N5 standard hydrate receives resource options and active observers before new live evidence', async () => {
  const index = indexOf(tree()); seedRequired(index);
  const saved = dehydrate(queryClient); queryClient.clear(); hydrate(queryClient, saved);
  for (const read of saved.queries) {
    const query = queryClient.getQueryCache().get(read.queryHash)!; recordReadProof(query, captureReadProof(index, read.queryKey));
  }
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => response(String(url).endsWith('/settings/get') ? { values: defaultSettings(), revision: 'new' } : { state: null, revision: null }));
  cleanups.push(startRequiredReadSession(queryClient));
  const query = queryClient.getQueryCache().find({ queryKey: resources.personalSettings(index.root).queryKey, exact: true })!;
  expect(query.isActive()).toBe(true); expect(typeof query.options.queryFn).toBe('function'); expect(fetcher).not.toHaveBeenCalled();
  receiveFullIndex(queryClient, { ...index, rev: index.rev + 1, person: { ...index.person, settings: 'new' } }); recoverReads(queryClient);
  await vi.waitFor(() => expect((query.state.data as { revision: string }).revision).toBe('new'));
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/settings/get'))).toHaveLength(1);
});

test('N6 response loss keeps the fixed intent; manual Check alone can resend its original body and opId after the read becomes obsolete', async () => {
  useWriteIntentStore.setState({ entries: {}, unavailable: false });
  const old = dto({ id: 'T9' }), value = tree({ tasks: [old] }), index = indexOf(value); receiveFullIndex(queryClient, index);
  let posts = 0;
  const newer = { ...old, values: { notes: 'COMMITTED BODY' }, hash: 'b'.repeat(64), version: 2 };
  const inputs: { body: unknown; opId: string | null }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if (init?.method === 'POST') {
      posts++; inputs.push({ body: JSON.parse(String(init.body)), opId: new Headers(init.headers).get('X-Alpacawork-Op-Id') });
      if (posts === 1) throw new TypeError('committed but reply lost');
      return response({ task: headOf(newer) });
    }
    return response(viewsOf(value).find(view => view.task.id === old.id)!);
  });
  await queryClient.fetchQuery(resources.taskView(index.root, old.id));
  const key = intentKey(index.root, 'body', old.id);
  const payload = { task: old.id, values: newer.values, expectedTaskHash: old.hash };
  await expect(sendDirectIntent(queryClient, key, { path: 'task/update', response: 'task', label: old.id }, () => payload, detailWriteBasis(old.id, old.hash))).rejects.toMatchObject({ retry: 'check' });
  receiveFullIndex(queryClient, indexOf(tree({ tasks: [newer] }), index.rev + 1, { view: { [old.id]: 1 } } as never));
  expect(useWriteIntentStore.getState().entries[key]?.status).toBe('unconfirmed');
  await expect(createApi().request('commands/task/update', taskWriteResultSchema, undefined, payload, 'new-op', detailWriteBasis(old.id, old.hash))).rejects.toMatchObject({ code: 'conflict', retry: 'reread' });
  expect(posts).toBe(1);
  await expect(checkDirectIntent(queryClient, key)).resolves.toMatchObject({ task: { values: newer.values } });
  expect(posts).toBe(2); expect(inputs[1]).toEqual(inputs[0]); expect(useWriteIntentStore.getState().entries[key]?.status).toBe('confirmed');
});

for (const change of ['payload', 'opId', 'root', 'offline', 'unknown', 'writable'] as const) test(`N6 manual capability refuses changed ${change} before HTTP`, async () => {
  useWriteIntentStore.setState({ entries: {}, unavailable: false });
  const index = indexOf(tree()); receiveFullIndex(queryClient, index);
  const root = change === 'root' ? '/other-root' : index.root, key = intentKey(root, 'body', 'T9');
  const input = { task: 'T9', values: { notes: 'fixed' }, expectedTaskHash: 'a'.repeat(64) };
  rememberWriteIdentity(root, 'fixed-op', index.restoreId);
  useWriteIntentStore.setState({ entries: { [key]: { status: 'unconfirmed', operationId: 'fixed-op', transport: 'receipt', payload: input, attempt: 'first', at: new Date().toISOString() } } });
  if (change === 'offline') useConnection.setState({ offline: true });
  if (change === 'unknown') useConnection.setState({ state: 'connecting', fresh: false });
  if (change === 'writable') useConnection.setState({ writable: false });
  const fetcher = vi.spyOn(globalThis, 'fetch');
  const checked = checkWriteIntent<typeof input, unknown>(key, (payload, opId, basis) => createApi().request('commands/task/update', taskWriteResultSchema, undefined,
    change === 'payload' ? { ...payload, values: { notes: 'changed' } } : payload, change === 'opId' ? 'changed-op' : opId, basis));
  await expect(checked).rejects.toMatchObject({ code: change === 'root' ? 'conflict' : change === 'writable' ? 'forbidden' : 'write_unavailable' }); expect(fetcher).not.toHaveBeenCalled();
});

test('restoring native cache after clear never inherits the previous index identity’s live write authority', () => {
  const index = indexOf(tree()); receiveFullIndex(queryClient, index); expect(canSendWrites()).toBe(true);
  const saved = dehydrate(queryClient); queryClient.clear(); hydrate(queryClient, saved);
  // Even a stale connection flag cannot turn restored data into a received live index.
  useConnection.setState({ state: 'live', fresh: true, writable: true, offline: false });
  expect(canSendWrites()).toBe(false);
  receiveFullIndex(queryClient, index); expect(canSendWrites()).toBe(true);
});
