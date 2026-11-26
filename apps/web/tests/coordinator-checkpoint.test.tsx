import { rememberWriteIdentity } from '../src/data/write-identity';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
const { CoordinatorConversation: ServerConversation } = createRequire(import.meta.url)('../../backend/test-dist/coordinator/conversation.js') as typeof import('../../backend/src/coordinator/conversation');
const { installCoordinatorRoutes } = createRequire(import.meta.url)('../../backend/test-dist/receiver/coordinator-routes.js') as typeof import('../../backend/src/receiver/coordinator-routes');
import type { CoordinatorConversation } from '../src/data/coordinator';
import { coordinatorSnapshotSchema } from '@alpacawork/contract/coordinator';
let queryClient: typeof import('../src/data/query-client')['queryClient'];
let useConversation: typeof import('../src/features/coordinator/coordinator')['useConversation'];
let coordinatorReadState: typeof import('../src/data/read-model')['coordinatorReadState'];
let getReadProof: typeof import('../src/data/read-model')['getReadProof'];
let readQuery: typeof import('../src/data/read-model')['readQuery'];
let readScope: typeof import('../src/data/read-model')['readScope'];
let readEntry: typeof import('../src/data/read-model')['readEntry'];
let evaluateRead: typeof import('../src/data/read-model')['evaluateRead'];
let READ_BUNDLE_AGE: typeof import('../src/data/read-model')['READ_BUNDLE_AGE'];
let restoreReadPersistence: typeof import('../src/data/read-persistence')['restoreReadPersistence'];
let startReadPersistence: typeof import('../src/data/read-persistence')['startReadPersistence'];
let useReadPersistence: typeof import('../src/data/read-persistence')['useReadPersistence'];
let resources: typeof import('../src/data/resources')['resources'];
let receiveFullIndex: typeof import('../src/data/resources')['receiveFullIndex'];
let liveRead: typeof import('../src/data/resources')['liveRead'];
let onReadEvent: typeof import('../src/data/resources')['onReadEvent'];
let useConnection: typeof import('../src/data/connection')['useConnection'];
import { indexOf, tree } from './fixtures';
import { checkpointFixture } from './checkpoint-fixture';
import { SERVED } from './conversation-fixture';
const { Hono } = createRequire(process.cwd() + '/apps/backend/package.json')('hono');
const empty = (): CoordinatorConversation => ({ id: 'checkpoint-conversation', nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, cancelled: [], turns: [] });
const answered = (): CoordinatorConversation => ({ ...empty(), turns: [{ id: 'reply', at: '2026-10-21T10:00:00Z', ask: 'question', attachments: [],
  status: 'succeeded' as const, waiting: false, answer: 'ACQUIRED WORDS', answeredAt: '2026-10-21T10:01:00Z', seen: false, error: null, result: null }] });
let stops: (() => void)[] = [];
beforeEach(async () => {
  vi.resetModules();
  ({ queryClient } = await import('../src/data/query-client'));
  ({ useConversation } = await import('../src/features/coordinator/coordinator'));
  ({ coordinatorReadState, getReadProof, readQuery, readScope, readEntry, evaluateRead, READ_BUNDLE_AGE } = await import('../src/data/read-model'));
  ({ restoreReadPersistence, startReadPersistence, useReadPersistence } = await import('../src/data/read-persistence'));
  ({ resources, receiveFullIndex, liveRead, onReadEvent } = await import('../src/data/resources'));
  ({ useConnection } = await import('../src/data/connection'));

  queryClient.clear(); useConversation.setState(useConversation.getInitialState());
  useConnection.setState(useConnection.getInitialState()); useReadPersistence.setState(useReadPersistence.getInitialState());
});
afterEach(() => { stops.forEach(stop => stop()); stops = []; queryClient.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function fixture(conversation: CoordinatorConversation = answered()) {
  const storage = checkpointFixture(); vi.stubGlobal('indexedDB', storage.factory);
  const server = new ServerConversation('/fixture'); let current: CoordinatorConversation = conversation, failure = 0;
  vi.spyOn(server, 'read').mockImplementation(() => current);
  vi.spyOn(server, 'ask').mockImplementation(() => current);
  vi.spyOn(server, 'warm').mockImplementation(() => current);
  vi.spyOn(server, 'clear').mockImplementation(() => { current = { ...empty(), id: 'cleared-conversation' }; return current; });
  vi.spyOn(server, 'withdraw').mockImplementation(() => current); vi.spyOn(server, 'sendNow').mockImplementation(() => current);
  vi.spyOn(server, 'markSeen').mockImplementation(async (_id, seen) => ({ conversationId: current.id, seen: [...seen] }));
  const app = new Hono(); installCoordinatorRoutes(app, '/fixture', 'a', server, () => {});
  app.get('/api/commands/settings/get', (c: any) => c.json({ values: {}, revision: 'settings0' }));
  app.get('/api/person/notices', (c: any) => c.json({ state: null, revision: null }));
  const calls: { path: string; method: string }[] = [];
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    calls.push({ path, method: init?.method ?? 'GET' });
    if (failure && path === '/api/coordinator') return new Response('unavailable', { status: failure });
    return app.request('http://fixture' + path, init);
  });
  const snapshot = server.snapshot('a');
  const source = indexOf(tree());
  const index = { ...source, person: { settings: 'settings0', notices: null,
    coordinator: { id: snapshot.conversation.id, revision: snapshot.revision } } };
  await restoreReadPersistence(queryClient);
  receiveFullIndex(queryClient, index); useConnection.setState({ state: 'live', offline: false });
  useConversation.setState({ root: index.root });
  await queryClient.fetchQuery(resources.personalSettings(index.root)); await queryClient.fetchQuery(resources.notices(index.root));
  stops.push(startReadPersistence(queryClient, listener => onReadEvent(queryClient, listener)));
  await useConversation.getState().refresh();
  await waitFor(() => expect(storage.read()?.slots.some((read: any) => read.key[0] === 'coordinator')).toBe(true));
  return { storage, server, app, calls, index, snapshot, fail: (status: number) => { failure = status; }, change: (value: CoordinatorConversation) => { current = value; } };
}
async function restored() {
  const next = new QueryClient(); await restoreReadPersistence(next);
  stops.push(startReadPersistence(next, listener => onReadEvent(next, listener)));
  stops.push(() => next.clear()); return next;
}

test('actual snapshot API → read owner → checkpoint → new client → normal projection', async () => {
  const h = await fixture();
  const acquired = getReadProof(readQuery(queryClient, ['coordinator', h.index.root])!)!.acquiredAt;
  const disk = h.storage.read(); expect(disk.control.format).toBe(17);
  const next = await restored(), read = coordinatorReadState(next, h.index.root);
  expect(read.snapshot?.conversation).toEqual(h.snapshot.conversation);
  expect(read.assessment).toMatchObject({ display: true, project: false, acquiredAt: acquired });
  expect(readScope(next)?.restored).toBe(true); expect(liveRead(next)).toBeUndefined();
});

test('checkpoint metadata changes save the acquired payload without serializing both full slots', async () => {
  const h = await fixture(), before = h.storage.read();
  const stringify = JSON.stringify; let fullPayloadSlots = 0;
  vi.spyOn(JSON, 'stringify').mockImplementation(((value: any, ...args: any[]) => {
    if (value?.query?.state?.data?.conversation?.id === h.snapshot.conversation.id) fullPayloadSlots++;
    return (stringify as any)(value, ...args);
  }) as typeof JSON.stringify);
  receiveFullIndex(queryClient, { ...h.index, rev: h.index.rev + 1 });
  await waitFor(() => expect(h.storage.read().control.revision).toBeGreaterThan(before.control.revision));
  const slot = h.storage.read().slots.find((value: any) => value.key[0] === 'coordinator');
  expect(slot.query.state.data).toEqual(h.snapshot);
  expect(fullPayloadSlots).toBe(0);
});

test('same-ID revision change including seen/busy stays unverified/persistable through 503 and restart', async () => {
  const h = await fixture(), acquired = coordinatorReadState(queryClient, h.index.root).assessment.acquiredAt;
  const changed = { ...h.snapshot.conversation, busy: true, turns: h.snapshot.conversation.turns.map(turn => ({ ...turn, seen: true })) };
  const revision = h.server.snapshot('a', changed).revision;
  h.fail(503); receiveFullIndex(queryClient, { ...h.index, rev: h.index.rev + 1, person: { ...h.index.person, coordinator: { id: changed.id, revision } } });
  await waitFor(() => expect(useConversation.getState().error).toBeTruthy());
  expect(coordinatorReadState(queryClient, h.index.root).assessment).toMatchObject({ state: 'unverified', display: true, persist: true, acquiredAt: acquired });
  await waitFor(() => expect(h.storage.read().slots.find((slot: any) => slot.key[0] === 'index').query.state.data.rev).toBe(h.index.rev + 1));
  expect(coordinatorReadState(await restored(), h.index.root).snapshot?.conversation.turns[0]?.answer).toBe('ACQUIRED WORDS');
});

test('restore/render/reconnect collects no ACK or writes; a new live observation uses existing ACK transport', async () => {
  const h = await fixture(); stops.splice(0).forEach(stop => stop()); queryClient.clear();
  vi.resetModules();
  const { queryClient: client } = await import('../src/data/query-client');
  const persistence = await import('../src/data/read-persistence');
  const reads = await import('../src/data/read-model');
  const owner = await import('../src/data/resources');
  const { useConversation: conversation } = await import('../src/features/coordinator/coordinator');
  const { useConnection: connection, canSendWrites: freshCanWrite } = await import('../src/data/connection');
  await persistence.restoreReadPersistence(client);
  stops.push(persistence.startReadPersistence(client, listener => owner.onReadEvent(client, listener)));
  stops.push(() => client.clear());
  conversation.setState({ root: h.index.root }); h.calls.length = 0;
  expect(conversation.getState().conversation?.turns[0]?.answer).toBe('ACQUIRED WORDS');
  expect(reads.readScope(client)?.restored).toBe(true);
  expect(freshCanWrite()).toBe(false);
  conversation.getState().observeSeen(['reply']); expect([...conversation.getState().pendingSeen]).toEqual([]);
  owner.receiveFullIndex(client, h.index); connection.setState({ state: 'live', offline: false });
  await Promise.resolve(); expect(h.calls.filter(call => call.method === 'POST')).toEqual([]);
  conversation.getState().observeSeen(['reply']);
  await waitFor(() => expect(h.calls.filter(call => call.path === '/api/coordinator/read')).toHaveLength(1));
  await waitFor(() => expect(conversation.getState().pendingSeen.size).toBe(0));
});

test('scope, identity and shape failures never display or persist; marker differences alone never mean obsolete', async () => {
  const h = await fixture(), query = readQuery(queryClient, ['coordinator', h.index.root])!, entry = readEntry(query);
  for (const proof of [{ ...entry.proof!, origin: 'https://elsewhere' }, { ...entry.proof!, root: '/elsewhere' }, { ...entry.proof!, generation: 'elsewhere' }])
    expect(evaluateRead(h.index, { ...entry, proof })).toMatchObject({ state: 'invalid', display: false, persist: false });
  expect(evaluateRead({ ...h.index, person: { ...h.index.person, coordinator: { id: 'another', revision: 'a'.repeat(64) } } }, entry))
    .toMatchObject({ state: 'invalid', display: false, persist: false, needsRead: true });
  expect(evaluateRead(h.index, { ...entry, data: { broken: true } }).display).toBe(false);
  h.fail(403); await useConversation.getState().refresh();
  await waitFor(() => expect(coordinatorReadState(queryClient, h.index.root).assessment.state).toBe('refused'));
  expect(coordinatorReadState(queryClient, h.index.root).assessment).toMatchObject({ state: 'refused', display: false, persist: false });
});

test('old FORMAT, expired bundle and foreign origin are discarded instead of adapted', async () => {
  const h = await fixture(), original = h.storage.read();
  for (const control of [{ ...original.control, format: 9 }, { ...original.control, indexReceivedAt: Date.now() - READ_BUNDLE_AGE }, { ...original.control, scope: { ...original.control.scope, origin: 'https://elsewhere' } }]) {
    h.storage.replace({ ...original, control });
    const next = await restored(); expect(coordinatorReadState(next, h.index.root).snapshot).toBeUndefined();
    expect(coordinatorReadState(next, h.index.root).snapshot).toBeUndefined();
  }
});

test('all snapshot routes use the same scope/digest rule; ACK retains its narrow contract', async () => {
  const h = await fixture();
  for (const path of ['', '/messages', '/warm', '/messages/withdraw', '/messages/send-now', '/clear']) {
    const response = await h.app.request('http://fixture/api/coordinator' + path, path ? { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: h.server.read().id, ...(path === '/messages' ? { id: 'send', text: 'hello', attachments: [] }
        : path.startsWith('/messages/') ? { id: 'send' } : {}) }) } : undefined);
    expect(response.status).toBe(200);
    const snapshot = await response.json(); coordinatorSnapshotSchema.parse(snapshot);
    expect(snapshot).toEqual(h.server.snapshot('a', snapshot.conversation));
  }
  const ack = await h.app.request('http://fixture/api/coordinator/read', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: h.server.read().id, seen: ['reply'] }) });
  expect(await ack.json()).toEqual({ conversationId: h.server.read().id, seen: ['reply'] });
});

test('clear receipt is shown ahead of the index without persistence or index authentication', async () => {
  const h = await fixture(), rev = h.index.rev;
  await useConversation.getState().clear();
  expect(useConversation.getState().conversation?.id).toBe('cleared-conversation');
  expect(coordinatorReadState(queryClient, h.index.root).assessment).toMatchObject({ state: 'unverified', display: true, persist: false, project: false });
  expect(queryClient.getQueryData<any>(['index']).rev).toBe(rev);
  const snapshot = h.server.snapshot('a');
  receiveFullIndex(queryClient, { ...h.index, rev: rev + 1, person: { ...h.index.person, coordinator: { id: snapshot.conversation.id, revision: snapshot.revision } } });
  expect(coordinatorReadState(queryClient, h.index.root).assessment.state).toBe('current');
});

test('no snapshot and a checkpoint that omits the whole conversation remain missing', async () => {
  const h = await fixture(), original = h.storage.read();
  const blank = new QueryClient(); expect(coordinatorReadState(blank, h.index.root).snapshot).toBeUndefined(); blank.clear();
  original.slots = original.slots.filter((read: any) => read.key[0] !== 'coordinator');
  h.storage.replace(original);
  expect(coordinatorReadState(await restored(), h.index.root).assessment).toMatchObject({ state: 'missing', display: false });
});

test('unit checkpoint budget omits an oversized conversation as one whole optional group', async () => {
  const h = await fixture(); const large = answered(); large.turns[0]!.answer = 'x'.repeat(9 * 1024 * 1024); h.change(large);
  await useConversation.getState().refresh();
  await waitFor(() => expect(useReadPersistence.getState().status).toBe('partial'));
  expect(h.storage.read().slots.some((read: any) => read.key[0] === 'coordinator')).toBe(false);
  expect(useConversation.getState().conversation?.turns[0]?.answer?.length).toBe(9 * 1024 * 1024);
});

test('unit two-client checkpoint ordering cannot revive an old conversation over a higher index revision', async () => {
  const h = await fixture(), newer = await restored();
  receiveFullIndex(newer, { ...h.index, rev: h.index.rev + 1, person: { ...h.index.person, coordinator: { id: 'cleared-elsewhere', revision: 'c'.repeat(64) } } });
  await waitFor(() => expect(h.storage.read().slots.find((slot: any) => slot.key[0] === 'index').query.state.data.rev).toBe(h.index.rev + 1));
  expect(h.storage.read().slots.some((read: any) => read.key[0] === 'coordinator')).toBe(false);
  await useConversation.getState().refresh();
  await new Promise(resolve => setTimeout(resolve, 350));
  expect(h.storage.read().slots.find((slot: any) => slot.key[0] === 'index').query.state.data.rev).toBe(h.index.rev + 1);
  expect(h.storage.read().slots.some((read: any) => read.key[0] === 'coordinator')).toBe(false);
});

test('checkpoint quota abort preserves acquired words and old disk data without reporting a save', async () => {
  const h = await fixture(), savedAt = h.storage.read().control.savedAt;
  h.storage.failNextWrite(new DOMException('quota', 'QuotaExceededError'));
  const later = answered(); later.turns[0]!.answer = 'LATER UNSAVED WORDS'; h.change(later);
  await useConversation.getState().refresh();
  await waitFor(() => expect(useReadPersistence.getState().status).toBe('unavailable'));
  expect(useConversation.getState().conversation?.turns[0]?.answer).toBe('LATER UNSAVED WORDS');
  expect(h.storage.read().control.savedAt).toBe(savedAt);
  expect(h.storage.read().slots.find((read: any) => read.key[0] === 'coordinator').query.state.data.conversation.turns[0].answer).toBe('ACQUIRED WORDS');
});

test('a restore that never opens its DB stops at the existing deadline without late data or write permission', async () => {
  await fixture(); vi.stubGlobal('indexedDB', { open() { return {}; } });
  const next = new QueryClient(); await restoreReadPersistence(next);
  expect(coordinatorReadState(next, '/fixture').snapshot).toBeUndefined();
  expect(liveRead(next)).toBeUndefined();
  expect(useReadPersistence.getState().restore).toBe('skipped');
  await waitFor(() => expect(useReadPersistence.getState()).toMatchObject({ status: 'unavailable', error: 'Read storage open blocked or unavailable' }), { timeout: 1500 });
  next.clear();
});

test('scope token rotation excludes a former writer without a new tombstone or queue', async () => {
  const h = await fixture(), original = h.storage.read(), other = await restored();
  receiveFullIndex(other, { ...h.index, generation: 'replacement-generation' });
  await waitFor(() => expect(h.storage.read().control.epoch).not.toBe(original.control.epoch));
  await useConversation.getState().refresh();
  await waitFor(() => expect(useReadPersistence.getState().error).toContain('scope changed in another tab'));
  expect(h.storage.read().control.epoch).not.toBe(original.control.epoch);
  expect(h.storage.read().control.scope).toBeNull();
  expect(h.storage.read().slots.some((slot: any) => slot.key[0] === 'coordinator')).toBe(false);
});

for (const field of ['root', 'generation'] as const) test(`a POST snapshot from another ${field} ${field === "root" ? "cannot certify acceptance" : "can certify acceptance"} without replacing the current read`, async () => {
  const h = await fixture(), before = coordinatorReadState(queryClient, h.index.root);
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ ...h.snapshot, [field]: 'foreign' }))));
  vi.stubGlobal('fetch', fetcher);
  rememberWriteIdentity(h.index.root, 'reply', 'initial');
  const asking = useConversation.getState().ask({ conversationId: h.snapshot.conversation.id, id: 'reply', text: 'question', attachments: [] });
  if (field === 'root') await expect(asking).rejects.toMatchObject({ code: 'invalid_response', retry: 'check' });
  else await expect(asking).resolves.toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(coordinatorReadState(queryClient, h.index.root).snapshot).toBe(before.snapshot);
  expect(coordinatorReadState(queryClient, h.index.root).assessment.acquiredAt).toBe(before.assessment.acquiredAt);
});

test('a first GET already in flight cannot undo a later refusal with the same empty presentation', async () => {
  const h = await fixture(); queryClient.removeQueries({ queryKey: ['coordinator', h.index.root] });
  let release!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise<Response>(resolve => { release = resolve; })));
  const reading = useConversation.getState().refresh();
  const query = readQuery(queryClient, ['coordinator', h.index.root])!;
  const { applyReadEvidence } = await import('../src/data/resources');
  applyReadEvidence(queryClient, { kind: 'refused', query });
  release(new Response(JSON.stringify(h.snapshot))); await reading;
  expect(coordinatorReadState(queryClient, h.index.root).assessment).toMatchObject({ state: 'refused', display: false, persist: false });
  expect(useConversation.getState().conversation).toBeNull();
});
