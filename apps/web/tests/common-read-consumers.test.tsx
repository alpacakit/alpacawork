import { rememberWriteIdentity } from "../src/data/write-identity";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider, QueryObserver, InfiniteQueryObserver } from '@tanstack/react-query';
import { startI18n, i18n } from '@alpacawork/i18n';
import { queryClient } from '../src/data/query-client';
import { resources, receiveFullIndex, captureResourceRead, admitResourceRead, requestLaterReadDemand, recoverReads, assessRead } from '../src/data/resources';
import { readIndex, readQuery, getReadProof, recordReadProof, refuseRead, cutReadScope, readScope } from '../src/data/read-model';
import { usePersonalSettings } from '../src/data/personal-settings';
import { useConversation } from '../src/features/coordinator/coordinator';
import { readDemandPending, readDemandReady } from '../src/data/read-demand';
import { conversationSnapshot } from './conversation-fixture';
import { createNoticeStore } from '../src/data/notice-store';
import { NOTICE_VERSION } from '../src/data/notice-model';
import { useConnection } from '../src/data/connection';
import { useViewStore } from '../src/state/view-store';
import { TimeTree } from '../src/features/tree/TimeTree';
import { dto, tree, indexOf, viewsOf, screenData, served0, TestWorkspace, homeFixture } from './fixtures';
import type { QueryKey } from '@tanstack/react-query';

const json = (data: unknown) => new Response(JSON.stringify(data));
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { resolve, promise }; };
const notice = { state: { version: NOTICE_VERSION, checkpoint: { at: '2026-10-24T00:00:00Z', tasks: {} }, reads: {} }, revision: 'n1' };
const person = { values: { theme: 'dark' }, revision: 'p1' };
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
beforeAll(async () => { await startI18n(); await i18n.changeLanguage('en'); });
beforeEach(() => {
  queryClient.clear(); usePersonalSettings.setState(usePersonalSettings.getInitialState(), true);
  useViewStore.setState(useViewStore.getInitialState(), true);
  const index = indexOf(tree()); receiveFullIndex(queryClient, { ...index, person: { ...index.person, settings: 'p1', notices: 'n1' } });
  useConnection.setState({ state: 'live', fresh: true, writable: true, offline: false });
});
afterEach(() => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); });
function invalidateProof(key: QueryKey, kind: 'refused' | 'origin' | 'root' | 'generation') {
  const query = readQuery(queryClient, key)!;
  if (kind === 'refused') refuseRead(query, readIndex(queryClient));
  else recordReadProof(query, { ...getReadProof(query)!, [kind]: 'foreign' });
  query.setState({}); // Keep raw payload deliberately: the real selector, not erasure, must enforce display.
}

test.each(['refused', 'origin', 'root', 'generation'] as const)('personal and notice selectors exclude %s raw values after real GETs', async kind => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => json(String(url).endsWith('/settings/get') ? person : notice));
  const root = readIndex(queryClient)!.root, notices = createNoticeStore(); notices.setState({ root });
  usePersonalSettings.setState({ root });
  await queryClient.fetchQuery(resources.personalSettings(root)); await queryClient.fetchQuery(resources.notices(root));
  expect(usePersonalSettings.getState()).toMatchObject({ status: 'ready', values: person.values });
  expect(notices.getState().checkpoint).toEqual(notice.state.checkpoint);
  invalidateProof(resources.personalSettings(root).queryKey, kind); invalidateProof(resources.notices(root).queryKey, kind);
  expect(queryClient.getQueryData(resources.personalSettings(root).queryKey)).toEqual(person);
  expect(usePersonalSettings.getState()).toMatchObject({ status: 'error', values: {}, revision: '', fresh: false });
  expect(notices.getState()).toMatchObject({ status: 'error', reads: {}, revision: null, fresh: false });
  expect(notices.getState().checkpoint).toBeUndefined();
});

test('first missing and valid empty/null reads differ; 503 and revision uncertainty preserve acquired settings/notices', async () => {
  const root = readIndex(queryClient)!.root, notices = createNoticeStore(); notices.setState({ root }); usePersonalSettings.setState({ root });
  expect(usePersonalSettings.getState().status).not.toBe('ready'); expect(notices.getState().status).not.toBe('ready');
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json(null));
  await expect(queryClient.fetchQuery(resources.personalSettings(root))).rejects.toBeDefined();
  await expect(queryClient.fetchQuery(resources.notices(root))).rejects.toBeDefined();
  expect(usePersonalSettings.getState()).toMatchObject({ status: 'error', fresh: false });
  expect(notices.getState()).toMatchObject({ status: 'error', fresh: false, checkpoint: undefined });
  fetcher.mockImplementation(async url => json(String(url).endsWith('/settings/get') ? { values: {}, revision: 'p1' } : { state: null, revision: null }));
  await queryClient.fetchQuery(resources.personalSettings(root)); await queryClient.fetchQuery(resources.notices(root));
  expect(usePersonalSettings.getState()).toMatchObject({ status: 'ready', values: {} });
  expect(notices.getState()).toMatchObject({ status: 'ready', checkpoint: undefined, reads: {} });
  const index = readIndex(queryClient)!;
  receiveFullIndex(queryClient, { ...index, rev: index.rev + 1, person: { ...index.person, settings: 'p2', notices: 'n2' } });
  vi.mocked(fetch).mockResolvedValue(new Response('unavailable', { status: 503 }));
  await expect(queryClient.fetchQuery({ ...resources.personalSettings(root), staleTime: 0 })).rejects.toBeDefined();
  await expect(queryClient.fetchQuery({ ...resources.notices(root), staleTime: 0 })).rejects.toBeDefined();
  expect(usePersonalSettings.getState()).toMatchObject({ status: 'ready', values: {}, fresh: false });
  expect(notices.getState()).toMatchObject({ status: 'ready', checkpoint: undefined, fresh: false });
});

test.each(['scope', 'refused', 'ABA', 'first-query-refused'] as const)('shared reception rejects %s before Query commit and leaves replacement untouched', async kind => {
  const key = resources.personalSettings('/fixture').queryKey;
  if (kind !== 'first-query-refused') await queryClient.fetchQuery({ queryKey: key, queryFn: async () => person });
  const started = captureResourceRead(queryClient, key);
  if (kind === 'scope') cutReadScope(queryClient); // personal reads still enforce the same session; use a Task for era below.
  if (kind === 'refused' || kind === 'first-query-refused') {
    if (!readQuery(queryClient, key)) queryClient.setQueryData(key, person);
    refuseRead(readQuery(queryClient, key)!, readIndex(queryClient));
  }
  if (kind === 'ABA') { queryClient.removeQueries({ queryKey: key }); queryClient.setQueryData(key, person); }
  if (kind === 'scope') {
    const old = readIndex(queryClient)!; receiveFullIndex(queryClient, { ...old, generation: 'other' });
  }
  expect(admitResourceRead(queryClient, started)).toBe(false);
  if (kind === 'ABA' || kind === 'first-query-refused') expect(queryClient.getQueryData(key)).toEqual(person);
});

test('normal GET receipt from a retired generation cannot commit to the same root', async () => {
  const answer = deferred<Response>(); vi.spyOn(globalThis, 'fetch').mockReturnValue(answer.promise);
  const key = resources.personalSettings('/fixture').queryKey;
  const flight = queryClient.fetchQuery(resources.personalSettings('/fixture')).catch(error => error);
  const index = readIndex(queryClient)!; receiveFullIndex(queryClient, { ...index, generation: 'other' });
  answer.resolve(json(person)); await flight;
  expect(queryClient.getQueryData(key)).toBeUndefined(); expect(usePersonalSettings.getState().status).not.toBe('ready');
});

test('later demand never revives a refused Query or starts work through a cut scope', async () => {
  const key = resources.taskView('/fixture', 'T1').queryKey;
  const value = tree(); vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(viewsOf(value)[0]));
  await queryClient.fetchQuery(resources.taskView('/fixture', 'T1'));
  const connect = vi.fn(); refuseRead(readQuery(queryClient, key)!, readIndex(queryClient));
  requestLaterReadDemand(queryClient, key, connect, undefined);
  expect(connect).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
  queryClient.removeQueries({ queryKey: key }); cutReadScope(queryClient);
  requestLaterReadDemand(queryClient, key, connect, undefined);
  expect(connect).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
});


test('nonempty acquired personal and notice contents survive failed reload and offline without save qualification', async () => {
  const root = readIndex(queryClient)!.root, notices = createNoticeStore(); notices.setState({ root }); usePersonalSettings.setState({ root });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => json(String(url).endsWith('/settings/get') ? person : notice));
  await queryClient.fetchQuery(resources.personalSettings(root)); await queryClient.fetchQuery(resources.notices(root));
  const checkpoint = notices.getState().checkpoint;
  vi.mocked(fetch).mockImplementation(async () => new Response('unavailable', { status: 503 }));
  const index = readIndex(queryClient)!; receiveFullIndex(queryClient, { ...index, rev: index.rev + 1, person: { ...index.person, settings: 'p2', notices: 'n2' } });
  await expect(queryClient.fetchQuery({ ...resources.personalSettings(root), staleTime: 0 })).rejects.toBeDefined();
  await expect(queryClient.fetchQuery({ ...resources.notices(root), staleTime: 0 })).rejects.toBeDefined();
  useConnection.setState({ offline: true });
  expect(usePersonalSettings.getState()).toMatchObject({ status: 'ready', values: person.values, fresh: false });
  expect(notices.getState()).toMatchObject({ status: 'ready', checkpoint, fresh: false });
  expect(await usePersonalSettings.getState().save('theme', 'light')).toBe(false);
  expect(vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});


test('rejecting an older receipt does not cancel a newer explicit retry on the same Query', async () => {
  const key = resources.personalSettings('/fixture').queryKey;
  const answer = deferred<Response>(); const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(person)).mockReturnValue(answer.promise);
  await queryClient.fetchQuery(resources.personalSettings('/fixture'));
  const older = captureResourceRead(queryClient, key), query = readQuery(queryClient, key)!;
  refuseRead(query, readIndex(queryClient));
  const retry = queryClient.fetchQuery({ ...resources.personalSettings('/fixture'), staleTime: 0 });
  expect(admitResourceRead(queryClient, older)).toBe(false);
  expect(query.state.fetchStatus).toBe('fetching');
  answer.resolve(json({ ...person, revision: 'p2' }));
  expect(await retry).toMatchObject({ revision: 'p2' }); expect(fetcher).toHaveBeenCalledTimes(2);
});


test('explicit conversation refresh waits for the common live anchor and its own acquired empty read', async () => {
  useConversation.setState(useConversation.getInitialState(), true);
  useConversation.setState({ root: '/fixture' });
  const snapshot = conversationSnapshot({ id: 'anchored', agent: null, warm: 'none' as const, busy: false, cancelled: [], turns: [] });
  const held = readIndex(queryClient)!, index = { ...held, person: { ...held.person, coordinator: { id: snapshot.conversation.id, revision: snapshot.revision } } };
  receiveFullIndex(queryClient, index); cutReadScope(queryClient);
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).endsWith('/workspace/live') ? json(index) : json(snapshot));
  await useConversation.getState().refresh();
  expect(useConversation.getState().conversation).toEqual(snapshot.conversation);
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(['/api/workspace/live', '/api/coordinator']);
});

for (const order of ['index-before-receipt', 'receipt-before-index'] as const) test(`obsolete queued GET leaves the replacement conversation read live (${order})`, async () => {
  useConversation.setState(useConversation.getInitialState(), true);
  const index = readIndex(queryClient)!, root = index.root;
  useConversation.setState({ root, open: true });
  const conversation = { id: 'replacement-session', agent: 'fake', warm: 'none' as const, busy: true, cancelled: [], turns: [{
    id: 'request', at: '2026-10-27T09:00:00Z', ask: 'wait', attachments: [], status: 'queued' as const,
    waiting: false, answer: '', answeredAt: null, seen: false, error: null, result: null,
  }] };
  const empty = conversationSnapshot({ ...conversation, busy: false, turns: [] });
  const queued = conversationSnapshot(conversation);
  const running = conversationSnapshot({ ...conversation, turns: conversation.turns.map(turn => ({ ...turn, status: 'running' as const })) });
  receiveFullIndex(queryClient, { ...index, rev: index.rev + 1, person: { ...index.person, coordinator: { id: conversation.id, revision: empty.revision } } });
  const old = deferred<Response>(), receipt = deferred<Response>(), replacement = deferred<Response>();
  let gets = 0;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).endsWith('/messages') && init?.method === 'POST') return receipt.promise;
    if (String(url).endsWith('/coordinator')) {
      gets++;
      return gets === 1 ? json(empty) : gets === 2 ? old.promise : replacement.promise;
    }
    throw new Error(`unexpected request: ${url}`);
  });
  try {
    await useConversation.getState().refresh();
    rememberWriteIdentity(root, 'request', 'initial');
    const sending = useConversation.getState().ask({ conversationId: conversation.id, id: 'request', text: 'wait', attachments: [], selected: { model: 'opus' }, agent: 'fake' });
    const reading = useConversation.getState().refresh();
    await waitFor(() => expect(gets).toBe(2));
    const publish = () => {
      const held = readIndex(queryClient)!;
      receiveFullIndex(queryClient, { ...held, rev: held.rev + 1, person: { ...held.person, coordinator: { id: conversation.id, revision: running.revision } } });
    };
    if (order === 'index-before-receipt') {
      publish(); receipt.resolve(json(queued)); await sending;
    } else {
      receipt.resolve(json(queued)); await sending; publish();
    }
    await waitFor(() => expect(gets).toBe(3));
    const query = readQuery(queryClient, ['coordinator', root])!;
    old.resolve(json(queued)); await reading;
    expect(query.state.fetchStatus).toBe('fetching');
    expect(readDemandPending(query)).toBe(true);
    expect(readDemandReady(query)).toBe(true);
    replacement.resolve(json(running));
    await waitFor(() => expect(useConversation.getState().conversation?.turns[0]?.status).toBe('running'));
    await waitFor(() => expect(query.state.fetchStatus).toBe('idle'));
    expect(query.state).toMatchObject({ status: 'success', error: null, data: running });
    expect(readDemandPending(query)).toBe(false);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(gets).toBe(3);
  } finally {
    old.resolve(json(queued)); receipt.resolve(json(queued)); replacement.resolve(json(running));
    useConversation.setState(useConversation.getInitialState(), true);
  }
});



test('normal queued demand is served by the automatic gate after actual success', async () => {
  const { QueryObserver } = await import('@tanstack/react-query');
  const { requestRead, readDemandPending } = await import('../src/data/read-demand');
  const value = tree(), options = resources.taskView('/fixture', 'T1');
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json(viewsOf(value)[0]));
  await queryClient.fetchQuery(options);
  const observer = new QueryObserver(queryClient, options), stop = observer.subscribe(() => {});
  const query = readQuery(queryClient, options.queryKey)!;
  try {
    await act(async () => { requestRead(query); expect(readDemandPending(query)).toBe(true); });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(readDemandPending(query)).toBe(false));
    expect(query.state.data).toEqual(viewsOf(value)[0]);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { stop(); observer.destroy(); }
});

test('queued then refused demand does not resurrect the read and remains pending until explicit Retry succeeds', async () => {
  const { QueryObserver } = await import('@tanstack/react-query');
  const { requestRead, readDemandPending } = await import('../src/data/read-demand');
  const { readRefused } = await import('../src/data/read-model');
  const { applyReadEvidence, readState } = await import('../src/data/resources');
  const value = tree(), options = resources.taskView('/fixture', 'T1');
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json(viewsOf(value)[0]));
  await queryClient.fetchQuery(options);
  const observer = new QueryObserver(queryClient, options), stop = observer.subscribe(() => {});
  const query = readQuery(queryClient, options.queryKey)!;
  try {
    await act(async () => {
      requestRead(query); applyReadEvidence(queryClient, { kind: 'refused', query });
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(query.state.fetchStatus).toBe('idle'));
    expect(fetcher).toHaveBeenCalledTimes(1); expect(readRefused(query)).toBe(true);
    expect(query.state.data).toBeUndefined(); expect(readDemandPending(query)).toBe(true);
    await act(async () => { await readState(queryClient, options.queryKey).retry?.(); });
    expect(fetcher).toHaveBeenCalledTimes(2); expect(readRefused(query)).toBe(false);
    expect(readDemandPending(query)).toBe(false); expect(query.state.data).toEqual(viewsOf(value)[0]);
  } finally { stop(); observer.destroy(); }
});

test('queued then cut demand does not dispatch and explicit Retry joins the live anchor', async () => {
  const { QueryObserver } = await import('@tanstack/react-query');
  const { requestRead, readDemandPending } = await import('../src/data/read-demand');
  const { readState } = await import('../src/data/resources');
  const value = tree(), options = resources.taskView('/fixture', 'T1'), index = readIndex(queryClient)!;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async url =>
    String(url).endsWith('/workspace/live') ? json(index) : json(viewsOf(value)[0]));
  await queryClient.fetchQuery(options);
  const observer = new QueryObserver(queryClient, options), stop = observer.subscribe(() => {});
  const query = readQuery(queryClient, options.queryKey)!;
  try {
    await act(async () => {
      requestRead(query); cutReadScope(queryClient);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(readDemandPending(query)).toBe(true);
    await act(async () => { await readState(queryClient, options.queryKey).retry?.(); });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/task/view?task=T1', '/api/workspace/live', '/api/task/view?task=T1']);
    expect(readDemandPending(query)).toBe(false); expect(query.state.data).toEqual(viewsOf(value)[0]);
  } finally { stop(); observer.destroy(); }
});


// A cache expiry can cut the scope while the silent-stream watchdog reconnects. A newly mounted
// family branch may already be fetching before that reconnect obtains its live anchor.
test.each(['task', 'finished'] as const)('recovery replaces an unanchored in-flight %s GET after the live anchor returns', async kind => {
  const index = readIndex(queryClient)!, path = kind === 'task' ? '/api/task/view?task=T1' : '/api/task/finished?parent=root&limit=20';
  const answer = kind === 'task' ? viewsOf(tree())[0] : { rows: [], total: 0, nextAfter: null, ...served0 };
  const first = deferred<Response>();
  let reads = 0;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    if (String(url).endsWith('/workspace/live')) return json(index);
    return ++reads === 1 ? first.promise : json(answer);
  });
  cutReadScope(queryClient);
  const observer = kind === 'task' ? new QueryObserver(queryClient, resources.taskView(index.root, 'T1'))
    : new InfiniteQueryObserver(queryClient, resources.finished(index.root, null));
  const stop = observer.subscribe(() => {});
  const key = kind === 'task' ? resources.taskView(index.root, 'T1').queryKey : resources.finished(index.root, null).queryKey;
  const query = readQuery(queryClient, key)!;
  try {
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([path]);
    const recovery = recoverReads(queryClient);
    await waitFor(() => expect(readScope(queryClient)?.anchored).toBe(true));
    // Its 200 response arrives after the anchor, but the GET was issued without one and cannot commit.
    first.resolve(json(answer));
    await recovery;
    await waitFor(() => expect(query.state.status).toBe('success'));
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([path, '/api/workspace/live', path]);
    expect(query.state.data).toEqual(kind === 'task' ? answer : { pages: [answer], pageParams: [null] });
    expect(assessRead(queryClient, query).project).toBe(true);
    expect(readDemandPending(query)).toBe(false);
  } finally { first.resolve(json(answer)); stop(); observer.destroy(); }
});


test.each(['task', 'finished'] as const)('recovery joins a current in-flight %s GET without another request', async kind => {
  const index = readIndex(queryClient)!, first = deferred<Response>();
  const answer = kind === 'task' ? viewsOf(tree())[0] : { rows: [], total: 0, nextAfter: null, ...served0 };
  const fetcher = vi.spyOn(globalThis, 'fetch').mockReturnValue(first.promise);
  const observer = kind === 'task' ? new QueryObserver(queryClient, resources.taskView(index.root, 'T1'))
    : new InfiniteQueryObserver(queryClient, resources.finished(index.root, null));
  const stop = observer.subscribe(() => {});
  const key = kind === 'task' ? resources.taskView(index.root, 'T1').queryKey : resources.finished(index.root, null).queryKey;
  try {
    await recoverReads(queryClient);
    expect(fetcher).toHaveBeenCalledTimes(1);
    first.resolve(json(answer));
    await waitFor(() => expect(readQuery(queryClient, key)!.state.status).toBe('success'));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(assessRead(queryClient, readQuery(queryClient, key)!).project).toBe(true);
  } finally { first.resolve(json(answer)); stop(); observer.destroy(); }
});
