import { displayReadFacts, restoreReadScope, cutReadScope, readScope, readerPresentation } from '../src/data/read-model';
import { requestRead } from '../src/data/read-demand';
import { basisForRead } from '../src/data/connection';
import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import { QueryClient, QueryObserver, onlineManager } from '@tanstack/react-query';
import { taskProjectedViewSchema, type ProjectedIndexDTO, type RequiredPvDTO } from '@alpacawork/contract/control';
import { defaultSettings } from '@alpacawork/contract';
import { captureReadProof, configureReadRetention, evaluateRead, getReadProof, observeReadProofs, readCodec, readGroup, recordReadProof } from '../src/data/read-model';
import { api, acceptPersonalRead, captureResourceRead, applyReadEvidence, assessRead, discardReadResources, indexKey, observeReadRefusals, receiveFullIndex, recoverReads, resources, readerTaskRow, showWrittenTask } from '../src/data/resources';
import { readEntry, taskReadState } from '../src/data/read-model';
import { queryClient } from '../src/data/query-client';
import { serverReadFacts } from '../src/data/read-model';
import { usePersonalSettings } from '../src/data/personal-settings';
import { useConnection, canSendWrites } from '../src/data/connection';
import { NOTICE_VERSION } from '../src/data/notice-model';
import { useReadStore } from '../src/state/read-store';
import { headOf, dto, indexOf, served0, tree, viewsOf } from './fixtures';
/** The list of T11 and T12, requiring of its resources the versions given (none: any read of this generation). */
const index = (requiredPv: Partial<RequiredPvDTO> = {}) => { const source = indexOf(tree({ tasks: [dto({ id: 'T11' }), dto({ id: 'T12' })] }), 1, requiredPv); return { ...source, person: { ...source.person, settings: 'initial-settings' } }; };
const windowAnswer = { ...served0, events: [], oldestKey: null, hasOlder: false };
const response = (data: unknown) => new Response(JSON.stringify(data));
const defer = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => { queryClient.clear(); observeReadProofs(queryClient); receiveFullIndex(queryClient, index()); useConnection.setState({ state: 'live', offline: false }); });
afterEach(() => { vi.restoreAllMocks(); onlineManager.setOnline(true); queryClient.clear(); usePersonalSettings.setState(usePersonalSettings.getInitialState(), true); useReadStore.setState(useReadStore.getInitialState(), true); });
function entry(key: readonly unknown[], data: unknown, source: ProjectedIndexDTO = index()) { return { key, data, proof: captureReadProof(source, key) }; }
function viewOf(id = 'T11') { return viewsOf(tree({ tasks: [dto({ id })] })).find(view => view.task.id === id)!; }

describe('one read evaluation for rendering, projection and persistence', () => {
  test('required successful personal/notice values remain dated after marker mismatch and 500', async () => {
    const source = index(), notice = { state: { version: NOTICE_VERSION, checkpoint: { at: new Date().toISOString(), tasks: {} }, reads: {} }, revision: source.person.notices };
    const settings = { values: defaultSettings(), revision: source.person.settings };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async url => response(String(url).endsWith('/notices') ? notice : settings));
    await queryClient.fetchQuery(resources.notices(source.root)); await usePersonalSettings.getState().load(source.root);
    const key = resources.notices(source.root).queryKey, query = queryClient.getQueryCache().find({ queryKey: key, exact: true })!;
    const acquiredAt = getReadProof(query)!.acquiredAt;
    const changed = { ...source, rev: source.rev + 1, person: { ...source.person, settings: 'opaque-z', notices: 'opaque-a' } };
    applyReadEvidence(queryClient, changed);
    vi.mocked(fetch).mockResolvedValue(new Response('failed', { status: 500 }));
    await expect(queryClient.fetchQuery(resources.notices(source.root))).rejects.toThrow();
    await usePersonalSettings.getState().load(source.root, true);
    expect(usePersonalSettings.getState().status).toBe('ready'); expect(usePersonalSettings.getState().fresh).toBe(false);
    expect(assessRead(queryClient, query)).toMatchObject({ state: 'unverified', display: true, project: false, persist: true, acquiredAt });
  });
  test('a closed page older than its required version is old on every page, and shown only while it is on screen', () => {
    const key = resources.finished('/fixture', null).queryKey;
    const page = (nextAfter: string | null, sourcePv: number) => ({ rows: [], total: 0, nextAfter, ...served0, sourcePv });
    const data = { pages: [page('old', 2), page(null, 1)], pageParams: [null, 'old'] };
    const read = entry(key, data), raised = index({ page: { 'finished:root': 1 } as never });
    expect(evaluateRead(raised, read)).toMatchObject({ state: 'obsolete', display: false, project: false, persist: false });
    expect(evaluateRead(raised, { ...read, active: true })).toMatchObject({ state: 'obsolete', display: true, project: false, persist: false });
    expect(evaluateRead(index(), read).state).toBe('current');
    expect(evaluateRead(raised, entry(key, { ...data, pageParams: [null, null] })).state).toBe('invalid');
  });
  test('a new list that does not raise a view keeps it current; one that does makes it old', async () => {
    const source = index(), view = viewOf(), options = resources.taskView(source.root, view.task.id);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(view)); await queryClient.fetchQuery(options);
    const query = queryClient.getQueryCache().find({ queryKey: options.queryKey, exact: true })!;
    receiveFullIndex(queryClient, { ...source, rev: source.rev + 1, requiredPv: { ...source.requiredPv, view: { T12: 1 as never } } });
    expect(assessRead(queryClient, query).state).toBe('current');
    expect(evaluateRead(index({ view: { T11: 1 } as never }), readEntry(query))).toMatchObject({ state: 'obsolete', project: false, needsRead: true });
  });
  test('an old view is shown only while it is on screen, and its History is judged on its own', () => {
    const source = index(), view = entry(['task', source.root, 'T11'], viewOf());
    const history = entry(['task-history', source.root, 'T11'], { pages: [{ events: [], nextBefore: null }], pageParams: [null] });
    expect(readGroup(view.key, 'view')).toBe(readGroup(history.key, 'history'));
    const changed = index({ view: { T11: 1 } as never });
    expect(evaluateRead(changed, { ...view, active: true })).toMatchObject({ state: 'obsolete', display: true, project: false, persist: false, needsRead: true });
    expect(evaluateRead(changed, view).display).toBe(false);
    expect(evaluateRead(changed, { ...view, data: undefined }).display).toBe(false);
    expect(evaluateRead(changed, history)).toMatchObject({ state: 'current', display: true });
  });
  test('codec rejects old request/runs formats and wrong Task ID; no timeline persistence', () => {
    expect(readCodec(['request-body', '/fixture', 'T11', 'Q1'])).toBeUndefined();
    expect(readCodec(['task', '/fixture', 'T12'])!.safeParse(viewOf()).success).toBe(false);
    expect(readCodec(['task-history', '/fixture', 'T11'])!.safeParse({ pages: [{ log: [], requests: [], runs: [], nextBefore: null }], pageParams: [null] }).success).toBe(false);
    const read = entry(['task', '/wrong-root', 'T11'], viewOf()); expect(evaluateRead(index(), read).state).toBe('invalid');
    expect(evaluateRead(index(), { ...read, key: ['task', '/fixture', 'T11'], proof: { ...read.proof, origin: 'https://other' } }).state).toBe('invalid');
  });
});

describe('actual Query fetches, overtaking events, refusal and reconnect', () => {
  test('old fetch success cannot erase a later detail change even though native invalidated becomes false', async () => {
    const source = index(), pending = defer<Response>(), view = viewOf(), options = resources.taskView(source.root, view.task.id);
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => pending.promise);
    const fetch = queryClient.fetchQuery(options);
    const changed = { ...index({ view: { T11: 1 } as never }), rev: source.rev + 1 };
    // Observe it so it remains available to annotate while revalidation is in flight.
    const observer = new QueryObserver(queryClient, { ...options, enabled: false }); const stop = observer.subscribe(() => {});
    applyReadEvidence(queryClient, changed); pending.resolve(response(view)); await fetch;
    const query = queryClient.getQueryCache().find({ queryKey: options.queryKey, exact: true })!;
    expect(query.state.isInvalidated).toBe(false);
    expect(assessRead(queryClient, query)).toMatchObject({ state: 'obsolete', project: false, persist: false }); stop();
  });
  test('manual merge cannot certify a later invalidation; option meta changes cannot erase proof', async () => {
    const source = index(), options = resources.taskView(source.root, 'T11'); vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(viewOf()));
    await queryClient.fetchQuery(options); const query = queryClient.getQueryCache().find({ queryKey: options.queryKey, exact: true })!;
    const time = getReadProof(query)!.acquiredAt;
    const observer = new QueryObserver(queryClient, { ...options, enabled: false }); observer.setOptions({ ...options, enabled: false, meta: {} });
    query.invalidate(); queryClient.setQueryData(options.queryKey, { ...viewOf(), task: { ...viewOf().task, values: { notes: 'manual receipt text' } } });
    expect(assessRead(queryClient, query)).toMatchObject({ state: 'unverified', acquiredAt: time, project: false });
  });
  test('POST-first opaque revision survives in-flight and subsequently started old GETs', async () => {
    const source = index(), key = resources.personalSettings(source.root).queryKey;
    const old = { values: defaultSettings(), revision: source.person.settings };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(old)); await queryClient.fetchQuery(resources.personalSettings(source.root));
    const pending = defer<Response>(); vi.mocked(fetch).mockImplementationOnce(() => pending.promise);
    queryClient.getQueryCache().find({ queryKey: key, exact: true })!.invalidate();
    const inFlight = queryClient.fetchQuery(resources.personalSettings(source.root));
    const newer = { values: { ...old.values, theme: 'dark' }, revision: 'opaque-000-first' };
    acceptPersonalRead(queryClient, key, newer, captureResourceRead(queryClient, key)); pending.resolve(response(old)); await inFlight;
    expect(queryClient.getQueryData(key)).toEqual(newer);
    queryClient.getQueryCache().find({ queryKey: key, exact: true })!.invalidate();
    await queryClient.fetchQuery(resources.personalSettings(source.root)); expect(queryClient.getQueryData(key)).toEqual(newer);
    applyReadEvidence(queryClient, { ...source, rev: source.rev + 1, person: { ...source.person, settings: newer.revision } });
    expect(assessRead(queryClient, queryClient.getQueryCache().find({ queryKey: key, exact: true })!).project).toBe(true);
  });
  test('discarding an old GET after a POST settles only its own recovery demand', async () => {
    const source = index(), options = resources.personalSettings(source.root);
    const old = { values: defaultSettings(), revision: source.person.settings };
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response(old));
    await queryClient.fetchQuery(options);
    const observer = new QueryObserver(queryClient, options); const stop = observer.subscribe(() => {});
    const newer = { values: { ...old.values, theme: 'dark' }, revision: 'post-before-feed' };
    acceptPersonalRead(queryClient, options.queryKey, newer, captureResourceRead(queryClient, options.queryKey));
    queryClient.getQueryCache().find({ queryKey: options.queryKey, exact: true })!.invalidate();
    fetch.mockResolvedValueOnce(response(old)).mockRejectedValue(new TypeError('unexpected repeated recovery'));
    recoverReads(queryClient);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(options.queryKey)).toEqual(newer); stop();
  });
  test.each(['native-first', 'feed-first'] as const)('read fails immediately under native offline and %s recovery retries it once', async order => {
    const source = index(), options = resources.taskView(source.root, 'T11'); onlineManager.setOnline(false);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('offline')).mockImplementation(async () => response(viewOf()));
    const observer = new QueryObserver(queryClient, options); const stop = observer.subscribe(() => {});
    await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true)); expect(fetch).toHaveBeenCalledTimes(1);
    if (order === 'native-first') { onlineManager.setOnline(true); expect(fetch).toHaveBeenCalledTimes(1); recoverReads(queryClient); }
    else { recoverReads(queryClient); await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true)); expect(onlineManager.isOnline()).toBe(false); onlineManager.setOnline(true); }
    await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true)); expect(fetch).toHaveBeenCalledTimes(2); stop();
  });
  test('a refused old Query cannot revoke the same Task identity in a newer scope', async () => {
    const source = index(), options = resources.taskView(source.root, 'T11');
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(viewOf()));
    await queryClient.fetchQuery(options);
    const old = queryClient.getQueryCache().find({ queryKey: options.queryKey, exact: true })!;
    observeReadRefusals(queryClient);
    applyReadEvidence(queryClient, { ...source, generation: 'newer-generation' });
    fetch.mockImplementation(async () => response({ ...viewOf(), generation: 'newer-generation' }));
    await queryClient.fetchQuery(options);
    fetch.mockResolvedValue(new Response('gone', { status: 404 }));
    await expect(old.fetch()).rejects.toThrow();
    expect(queryClient.getQueryData(options.queryKey)).toBeDefined();
    expect(assessRead(queryClient, queryClient.getQueryCache().find({ queryKey: options.queryKey, exact: true })!).project).toBe(true);
  });
  test('a known local 404 removes only its unit; whole 403 clears the read scope', async () => {
    const source = index(), view = viewOf(), key = resources.taskView(source.root, 'T11').queryKey;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(view)); await queryClient.fetchQuery(resources.taskView(source.root, 'T11'));
    observeReadRefusals(queryClient); const query = queryClient.getQueryCache().find({ queryKey: key, exact: true })!;
    query.invalidate(); vi.mocked(fetch).mockResolvedValueOnce(new Response('missing', { status: 404 }));
    await expect(queryClient.fetchQuery({ ...resources.taskView(source.root, 'T11'), staleTime: 0 })).rejects.toThrow();
    expect(queryClient.getQueryData(key)).toBeUndefined(); expect(queryClient.getQueryData(indexKey)).toBeDefined();
    discardReadResources(queryClient); expect(queryClient.getQueryCache().getAll()).toHaveLength(0); expect(useConnection.getState().fresh).toBe(false);
  });
});

test('mutation admission rejects a confirmed offline action before pause and does not send it after reconnect', async () => {
  const send = vi.fn(async () => true); onlineManager.setOnline(false);
  // This cache-only fixture has no feed subscription. Supply the common reachability receipt, as the feed does.
  // workspace-feed exercises native offline -> that receipt -> this same admission, through the actual subscription.
  useConnection.setState({ state: 'reconnecting', offline: true });
  const mutation = queryClient.getMutationCache().build(queryClient, { mutationFn: send });
  await expect(mutation.execute(undefined)).rejects.toMatchObject({ code: 'write_unavailable', retry: 'later' });
  expect(mutation.state.isPaused).toBe(false); expect(send).not.toHaveBeenCalled();
  onlineManager.setOnline(true); useConnection.setState({ state: 'live', offline: false });
  await queryClient.resumePausedMutations(); expect(send).not.toHaveBeenCalled();
});

test('a delayed POST receipt from a former generation cannot populate the new QueryCache', async () => {
  const { showWrittenTask } = await import('../src/data/resources');
  const source = index(), before = queryClient.getQueryData(indexKey);
  receiveFullIndex(queryClient, { ...source, generation: 'new-generation', rev: 1 });
  expect(() => showWrittenTask(queryClient, headOf({ ...viewOf().task, title: 'old response', version: 99 }), source)).toThrow('scope changed');
  expect(queryClient.getQueryData<ProjectedIndexDTO>(indexKey)!.tasks.find(row => row.id === 'T11')!.title).not.toBe('old response');
  expect(queryClient.getQueryData(indexKey)).not.toBe(before);
});

test('a delayed personal-setting POST response is not installed after a generation replacement', async () => {
  const source = index(), pending = defer<Response>();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => init?.method === 'POST' ? pending.promise : response({ values: defaultSettings(), revision: source.person.settings }));
  await usePersonalSettings.getState().load(source.root);
  const saving = usePersonalSettings.getState().save('theme', 'dark');
  receiveFullIndex(queryClient, { ...source, generation: 'new-generation', rev: 1 });
  pending.resolve(response({ values: { ...defaultSettings(), theme: 'dark' }, revision: 'old-generation-receipt' }));
  expect(await saving).toBe(false);
  expect(queryClient.getQueryData(resources.personalSettings(source.root).queryKey)).toBeUndefined();
});

test('closed-list recovery reads the page again at its new version before its outstanding next page', async () => {
  const { InfiniteQueryObserver } = await import('@tanstack/react-query');
  const source = index(); let sourcePv = 0, offline = false;
  const after: (string | null)[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    const cursor = new URL(String(url), location.origin).searchParams.get('after'); after.push(cursor);
    if (offline) throw new TypeError('offline');
    return response({ rows: [], total: 40, nextAfter: cursor ? null : 'older', ...served0, sourcePv });
  });
  const options = resources.finished(source.root, null); await queryClient.fetchInfiniteQuery(options);
  const observer = new InfiniteQueryObserver(queryClient, options); const stop = observer.subscribe(() => {});
  offline = true; await observer.fetchNextPage();
  sourcePv = 1; receiveFullIndex(queryClient, { ...index({ page: { 'finished:root': 1 } as never }), rev: source.rev + 1 });
  offline = false; recoverReads(queryClient);
  await vi.waitFor(() => expect(observer.getCurrentResult().data?.pages).toHaveLength(2));
  expect(observer.getCurrentResult().data!.pages.every(page => page.sourcePv === 1)).toBe(true);
  expect(after.slice(-2)).toEqual([null, 'older']); stop();
});

describe('Reader-only rows share the Task read and write boundary', () => {
  /** A finished T11 the list does not hold, as its opened view answers it. */
  const closedView = (sourcePv = 0) => viewsOf(tree({ tasks: [dto({ id: 'T11', state: 'done' })] }), sourcePv).find(view => view.task.id === 'T11')!;
  test('an old view of a closed task keeps its Reader row and document on screen while it is read again', async () => {
    const source = index(), view = closedView();
    const absent = { ...source, tasks: [] };
    receiveFullIndex(queryClient, absent);
    const options = resources.taskView(source.root, 'T11');
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    vi.mocked(fetch).mockResolvedValueOnce(response(view));
    await queryClient.fetchQuery(options);
    // The Reader observes it while it is open.
    const observer = new QueryObserver(queryClient, options); const stop = observer.subscribe(() => {});
    try {
      receiveFullIndex(queryClient, { ...absent, rev: source.rev + 1, requiredPv: { ...absent.requiredPv, view: { T11: 1 as never } } });
      expect(taskReadState(queryClient, source.root, 'T11').assessment).toMatchObject({ state: 'obsolete', display: true, project: false });
      expect(readerTaskRow(queryClient, source.root, 'T11')?.id).toBe('T11');
      expect(taskReadState(queryClient, source.root, 'T11').view?.task).toEqual(view.task);
      expect(readerPresentation(queryClient, source.root, 'T11')).toMatchObject({ kind: 'view', state: 'unverified', view: { task: view.task } });
    } finally { stop(); }
  });
  test.each(['cut', 'era', 'restored', 'uncertain', 'pending', 'demandPending'] as const)('a current view keeps its Reader row after %s qualification loss', async loss => {
    const source = index(), view = closedView();
    receiveFullIndex(queryClient, { ...source, tasks: source.tasks.filter(row => row.id !== 'T11') });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(view));
    const options = resources.taskView(source.root, 'T11');
    await queryClient.fetchQuery(options);
    expect(readerTaskRow(queryClient, source.root, 'T11')?.id).toBe('T11');
    const query = queryClient.getQueryCache().find({ queryKey: options.queryKey, exact: true })!;
    if (loss === 'cut') cutReadScope(queryClient);
    else if (loss === 'restored') restoreReadScope(queryClient, false);
    else if (loss === 'era') readScope(queryClient)!.era++;
    else if (loss === 'pending') {
      const held = readEntry(query);
      expect(evaluateRead(queryClient.getQueryData(indexKey), { ...held, pending: true }).project).toBe(false);
      // The fold consumes the real outstanding demand from the same read-proof Owner.
      requestRead(query);
    } else recordReadProof(query, { ...getReadProof(query)!, [loss]: true });
    expect(taskReadState(queryClient, source.root, 'T11').assessment.project).toBe(false);
    expect(readerTaskRow(queryClient, source.root, 'T11')?.id).toBe('T11');
  });
  test('a closed view made old cannot be written from until it is read again', async () => {
    const source = index(), absent = { ...source, tasks: source.tasks.filter(row => row.id !== 'T11') };
    receiveFullIndex(queryClient, absent);
    let sourcePv = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(closedView(sourcePv)));
    await queryClient.fetchQuery(resources.taskView(source.root, 'T11'));
    const observer = new QueryObserver(queryClient, resources.taskView(source.root, 'T11')); const stop = observer.subscribe(() => {});
    onTestFinished(stop);
    expect(canSendWrites(basisForRead('T11'))).toBe(true);
    const before = taskReadState(queryClient, source.root, 'T11').assessment.acquiredAt;
    receiveFullIndex(queryClient, { ...absent, rev: source.rev + 1, requiredPv: { ...absent.requiredPv, view: { T11: 1 as never } } });
    expect(readerTaskRow(queryClient, source.root, 'T11')?.id).toBe('T11');
    expect(taskReadState(queryClient, source.root, 'T11').assessment).toMatchObject({ state: 'obsolete', project: false, acquiredAt: before });
    expect(canSendWrites(basisForRead('T11'))).toBe(false);
    expect(canSendWrites()).toBe(true);
    const beforeSend = vi.mocked(fetch).mock.calls.length;
    await expect(api.request('task/set-title', taskProjectedViewSchema, undefined, { task: 'T11', title: 'Must not send' })).rejects.toMatchObject({ code: 'write_unavailable' });
    expect(vi.mocked(fetch).mock.calls).toHaveLength(beforeSend);
    sourcePv = 1;
    await queryClient.refetchQueries({ queryKey: resources.taskView(source.root, 'T11').queryKey, exact: true });
    expect(taskReadState(queryClient, source.root, 'T11').assessment.project).toBe(true);
    expect(canSendWrites(basisForRead('T11'))).toBe(true);
  });
  test('address-only data supplies the same Reader view and cannot resurrect after a task GET refusal', async () => {
    const source = index(), view = closedView();
    receiveFullIndex(queryClient, { ...source, tasks: source.tasks.filter(row => row.id !== 'T11') });
    observeReadRefusals(queryClient);
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(view));
    await queryClient.fetchQuery(resources.taskView(source.root, 'T11'));
    expect(readerTaskRow(queryClient, source.root, 'T11')?.id).toBe('T11');
    expect(taskReadState(queryClient, source.root, 'T11').view).toEqual(view);
    fetcher.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'not_found', message: 'Gone', retry: 'fix' } }), { status: 404 }));
    await expect(queryClient.fetchQuery({ ...resources.taskView(source.root, 'T11'), staleTime: 0 })).rejects.toThrow();
    expect(readerTaskRow(queryClient, source.root, 'T11')).toBeUndefined();
    expect(taskReadState(queryClient, source.root, 'T11').assessment.state).toBe('refused');
    expect(canSendWrites(basisForRead('T11'))).toBe(false);
  });
  test('a refused canonical Query cannot be restored by its earlier in-flight GET', async () => {
    const source = index(), view = closedView(), pending = defer<Response>();
    receiveFullIndex(queryClient, { ...source, tasks: source.tasks.filter(row => row.id !== 'T11') });
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => pending.promise);
    const older = queryClient.fetchQuery(resources.taskView(source.root, 'T11'));
    const query = queryClient.getQueryCache().find({ queryKey: resources.taskView(source.root, 'T11').queryKey, exact: true })!;
    applyReadEvidence(queryClient, { kind: 'refused', query });
    pending.resolve(response(view)); await older.catch(() => {});
    expect(readerTaskRow(queryClient, source.root, 'T11')).toBeUndefined();
    expect(canSendWrites(basisForRead('T11'))).toBe(false);
  });
  test('a local write updates the Reader row with its body and no older address alias can overrule it', async () => {
    const source = index(), view = closedView();
    receiveFullIndex(queryClient, { ...source, tasks: source.tasks.filter(row => row.id !== 'T11') });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(view));
    await queryClient.fetchQuery(resources.taskView(source.root, 'T11'));
    await queryClient.fetchQuery(resources.taskView(source.root, 'T11'));
    const written = { ...view.task, version: view.task.version + 1, hash: 'b'.repeat(64), values: { notes: 'Written body held during refresh' } };
    showWrittenTask(queryClient, headOf(written));
    expect(taskReadState(queryClient, source.root, 'T11').view?.task.values?.notes).toBe(written.values?.notes);
    expect(readerTaskRow(queryClient, source.root, 'T11')?.hash).toBe(written.hash);
    expect(canSendWrites(basisForRead('T11'))).toBe(false);
    expect(serverReadFacts(queryClient)!.tasks.some(row => row.id === 'T11')).toBe(false);
  });
  test('invalid proof, mismatched row identity, root and generation changes never admit a snapshot', async () => {
    const source = index(), view = closedView(), options = resources.taskView(source.root, 'T11');
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(view));
    await queryClient.fetchQuery(options);
    const query = queryClient.getQueryCache().find({ queryKey: options.queryKey, exact: true })!;
    recordReadProof(query, { ...captureReadProof(source, options.queryKey), rev: source.rev + 1 });
    expect(taskReadState(queryClient, source.root, 'T11').view).toBeUndefined();
    fetcher.mockResolvedValue(response({ ...view, row: { ...view.row, id: 'T12' } }));
    await queryClient.refetchQueries({ queryKey: options.queryKey, exact: true });
    expect(taskReadState(queryClient, source.root, 'T11').view).toBeUndefined();
    expect(taskReadState(queryClient, source.root, 'T11').assessment.state).toBe('invalid');
    expect(canSendWrites(basisForRead('T11'))).toBe(false);
    receiveFullIndex(queryClient, { ...source, generation: 'other-generation' });
    expect(taskReadState(queryClient, source.root, 'T11').view).toBeUndefined();
    receiveFullIndex(queryClient, { ...source, root: '/other-root' });
    expect(readerTaskRow(queryClient, source.root, 'T11')).toBeUndefined();
  });
});

// Display classification and server eligibility are separate meanings.
test('restoration alone preserves current display and History classification without server authority', () => {
  const source = queryClient.getQueryData<ProjectedIndexDTO>(['index'])!;
  const view = entry(['task', source.root, 'T11'], viewOf(), source);
  const history = entry(['task-history', source.root, 'T11'], { pages: [{ events: [], nextBefore: null }], pageParams: [null] }, source);
  readScope(queryClient); restoreReadScope(queryClient, false);
  expect(evaluateRead(source, view)).toMatchObject({ state: 'current', display: true, persist: true, project: false, needsRead: true });
  expect(evaluateRead(source, history)).toMatchObject({ state: 'current', project: false, needsRead: true });
  expect(evaluateRead({ ...source, requiredPv: { ...source.requiredPv, view: { T11: 1 as never } } }, view).state).toBe('obsolete');
  cutReadScope(queryClient);
  expect(evaluateRead(source, view)).toMatchObject({ state: 'unverified', display: true, project: false });
});
test('an obsolete active list contributes no current display facts while its own dated rows remain available', () => {
  const source = queryClient.getQueryData<ProjectedIndexDTO>(['index'])!;
  const key = resources.finished(source.root, null).queryKey;
  const row = indexOf(tree({ tasks: [dto({ id: 'T99', state: 'done' })] })).tasks.find(row => row.id === 'T99')!;
  const { stateLog, ball, question, ...fields } = row;
  const data = { pages: [{ rows: [{ ...fields, stateMark: null, latestReport: null, childCounts: { live: 0, finished: 0 } }], total: 1, nextAfter: null, ...served0 }], pageParams: [null] };
  queryClient.setQueryData(key, data);
  const query = queryClient.getQueryCache().find({ queryKey: key, exact: true })!;
  recordReadProof(query, captureReadProof(source, key));
  receiveFullIndex(queryClient, { ...source, rev: source.rev + 1, requiredPv: { ...source.requiredPv, page: { 'finished:root': 1 as never } } });
  const observer = new QueryObserver(queryClient, { queryKey: key, staleTime: Infinity });
  const stop = observer.subscribe(() => {});
  try {
    expect(assessRead(queryClient, query)).toMatchObject({ state: 'obsolete', display: true, project: false });
    expect(displayReadFacts(queryClient)!.tasks.map(row => row.id)).not.toContain('T99');
    expect(query.state.data).toBe(data);
  } finally { stop(); observer.destroy(); }
});

for (const failure of ['refused', 'missing', 'origin', 'root', 'generation', 'task', 'shape'] as const)
  test(`an old view on screen keeps the ${failure} gate`, () => {
    const source = index();
    const changed = index({ view: { T11: 1 } as never });
    const view = { ...entry(['task', source.root, 'T11'], viewOf(), source), active: true };
    let candidate = view;
    if (failure === 'refused') candidate = { ...view, refused: true } as typeof view;
    if (failure === 'missing') candidate = { ...view, data: undefined };
    if (failure === 'origin') candidate = { ...view, proof: { ...view.proof, origin: 'https://foreign.example' } };
    if (failure === 'root') candidate = { ...view, proof: { ...view.proof, root: '/other' } };
    if (failure === 'generation') candidate = { ...view, proof: { ...view.proof, generation: 'other' } };
    if (failure === 'task') candidate = { ...view, data: viewOf('T12') };
    if (failure === 'shape') candidate = { ...view, data: { broken: true } };
    expect(evaluateRead(changed, view)).toMatchObject({ state: 'obsolete', display: true });
    expect(evaluateRead(changed, candidate)).toMatchObject({ display: false, project: false, persist: false, needsRead: true });
  });

test('Task view identity refusal withdraws History; a range 404 preserves the Task and its acquired records', async () => {
  const source = index(), view = viewsOf(tree({ tasks: [dto({ id: 'T11' })] }))[0]!;
  const options = resources.taskView(source.root, 'T11'), history = resources.history(source.root, 'T11');
  let failure = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async path => failure ? new Response('', { status: failure })
    : response(String(path).includes('/history') ? windowAnswer : view));
  await queryClient.fetchQuery(options); await queryClient.fetchQuery(history);
  failure = 404;
  await queryClient.fetchQuery({ ...history, staleTime: 0 }).catch(() => {});
  const past = queryClient.getQueryCache().find({ queryKey: history.queryKey, exact: true })!;
  expect(assessRead(queryClient, past).display).toBe(true);
  expect(taskReadState(queryClient, source.root, 'T11').view).toBeDefined();
  failure = 403;
  await queryClient.fetchQuery({ ...options, staleTime: 0 }).catch(() => {});
  expect(assessRead(queryClient, past)).toMatchObject({ state: 'refused', display: false, persist: false });
  expect(past.state.data).toBeUndefined();
  failure = 0;
  await queryClient.fetchQuery({ ...history, staleTime: 0 }).catch(() => {});
  expect(assessRead(queryClient, past).persist).toBe(false);
  // Reauthorization of the identity precedes explicitly recovering its History.
  await queryClient.fetchQuery({ ...options, staleTime: 0 });
  await queryClient.fetchQuery({ ...history, staleTime: 0 });
  expect(assessRead(queryClient, past).project).toBe(true);
});
