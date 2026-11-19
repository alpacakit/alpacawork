import { afterEach, expect, test, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { projectedIndexSchema, taskViewSchema } from '@alpacawork/contract/control';
import { evaluateRead, isReadDataImmutable, readEntry, readIndex, readQuery, reuseReadPayload, READ_DAY } from '../src/data/read-model';
import { assessRead, onReadEvent, receiveFullIndex, resources } from '../src/data/resources';
import { restoreReadPersistence, startReadPersistence, useReadPersistence } from '../src/data/read-persistence';
import { checkpointFixture } from './checkpoint-fixture';
import { dto, indexOf, tree, viewsOf } from './fixtures';

const clients: QueryClient[] = [], stops: (() => void)[] = [];
afterEach(() => { stops.splice(0).forEach(stop => stop()); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const client = () => {
  const value = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(value); return value;
};
const start = (value: QueryClient) => {
  const stop = startReadPersistence(value, changed => onReadEvent(value, changed));
  stops.push(stop); return stop;
};
const taskSlot = (disk: ReturnType<ReturnType<typeof checkpointFixture>['read']>) => disk.slots.find((slot: any) => slot.key[0] === 'task');
async function fixture() {
  const storage = checkpointFixture(); vi.stubGlobal('indexedDB', storage.factory);
  const source = tree({ tasks: [dto({ id: 'T1', body: 'ACQUIRED BODY' })] });
  const initial = indexOf(source);
  const index = projectedIndexSchema.parse({ ...initial, person: { ...initial.person, settings: 'identity-settings' } });
  const view = viewsOf(source).find(item => item.task.id === 'T1')!;
  vi.stubGlobal('fetch', async (url: string) => {
    const path = new URL(String(url), 'http://fixture').pathname;
    if (path === '/api/settings/get') return Response.json({ values: {}, revision: index.person.settings });
    if (path === '/api/person/notices') return Response.json({ state: null, revision: index.person.notices });
    if (path === '/api/task/view') return Response.json(view);
    throw new Error('Unexpected fixture HTTP ' + url);
  });
  const value = client(); await restoreReadPersistence(value); receiveFullIndex(value, index);
  await value.fetchQuery(resources.personalSettings(index.root)); await value.fetchQuery(resources.notices(index.root));
  await value.fetchQuery(resources.taskView(index.root, 'T1'));
  const query = readQuery(value, ['task', index.root, 'T1'])!;
  expect(evaluateRead(index, readEntry(query)).persist).toBe(true);
  const stop = start(value);
  await waitFor(() => expect(taskSlot(storage.read())).toBeDefined());
  return { storage, value, index, query, stop };
}
async function flush(storage: ReturnType<typeof checkpointFixture>) {
  const revision = storage.read().control.revision;
  window.dispatchEvent(new Event('pagehide'));
  await waitFor(() => expect(storage.read().control.revision).toBeGreaterThan(revision));
}
function failTaskGets() {
  const previous = globalThis.fetch;
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => new URL(String(url), 'http://fixture').pathname === '/api/task/view'
    ? Promise.resolve(Response.json({ error: { code: 'unavailable', message: 'No new Task acquisition', retry: 'later' } }, { status: 503 }))
    : previous(url, init));
}

test('payload comparison reuses only a full-key deep immutable basis, strictly matching the current text', async () => {
  const h = await fixture(), known = h.query.state.data as any, key = h.query.queryKey;
  const bases = [{ key, data: known }], text = JSON.stringify(known);
  expect(reuseReadPayload([...key], text, bases)).toBe(known);
  expect(reuseReadPayload(['task', h.index.root, 'T2'], text, bases)).toBeUndefined();
  expect(reuseReadPayload([...key, null], text, bases)).toBeUndefined();
  expect(reuseReadPayload(key, text, [])).toBeUndefined();
  expect(reuseReadPayload(key, ' ' + text, bases)).toBeUndefined();
  expect(reuseReadPayload(key, text.replace('ACQUIRED', 'ALTERED'), bases)).toBeUndefined();
  const unproven = client(); unproven.setQueryData(key, Object.freeze(structuredClone(known)));
  const other = unproven.getQueryCache().get(h.query.queryHash)!;
  expect(isReadDataImmutable(other.state.data)).toBe(false);
  expect(reuseReadPayload(key, text, [{ key: other.queryKey, data: other.state.data }])).toBeUndefined();
});

test.each([false, true])('a live index revision uses the prior committed payload only while its WeakRef survives, missing=%s', async missing => {
  const h = await fixture(), previous = readIndex(h.value)!;
  expect(isReadDataImmutable(previous)).toBe(true);
  if (missing) {
    const deref = WeakRef.prototype.deref;
    vi.spyOn(WeakRef.prototype, 'deref').mockImplementation(function (this: WeakRef<object>) {
      const data = deref.call(this); return data === previous ? undefined : data;
    });
  }
  receiveFullIndex(h.value, { ...previous, rev: previous.rev + 1 });
  const parse = vi.spyOn(projectedIndexSchema._zod, 'run');
  await flush(h.storage);
  const oldParses = parse.mock.calls.filter(([input]) => (input.value as typeof previous).rev === previous.rev);
  // The structure Owner serves both normalization and qualification. A missing
  // WeakRef needs one cold parse, never a second parse for the same read value.
  expect(oldParses).toHaveLength(missing ? 1 : 0);
  expect(h.storage.read().slots.find((slot: any) => slot.key[0] === 'index').query.state.data.rev).toBe(previous.rev + 1);
  expect(useReadPersistence.getState().status).not.toBe('unavailable');
});

test('a fresh restore shares its first index parse with slot qualification', async () => {
  const h = await fixture(); h.stop();
  const parse = vi.spyOn(projectedIndexSchema._zod, 'run'), next = client();
  await restoreReadPersistence(next);
  expect(readIndex(next)?.rev).toBe(h.index.rev);
  expect(parse).toHaveBeenCalledTimes(1);
});

test('restore uses actual normalized index scope while keeping the raw stored payload unchanged', async () => {
  const h = await fixture(); h.stop();
  const codec = projectedIndexSchema.clone().transform(value => ({ ...value, root: 'normalized-other-root' }));
  vi.spyOn(projectedIndexSchema, 'safeParse').mockImplementation(value => codec.safeParse(value));
  const next = client(); await restoreReadPersistence(next);
  expect(readIndex(next)).toBeUndefined();
  expect(h.storage.read().slots.find((slot: any) => slot.key[0] === 'index').query.state.data.root).toBe(h.index.root);
});

test.each(['key', 'hash', 'queryKey', 'queryHash', 'proof', 'proof-rev', 'future-used', 'future-data', 'acquisition-time', 'received-at', 'scope', 'body'] as const)(
  'structural reuse never bypasses %s checkpoint metadata or scope rejection', async kind => {
    const h = await fixture(); h.stop();
    const raw = h.storage.read(), slot = raw.slots.find((item: any) => item.key[0] === 'index');
    if (kind === 'key') slot.key = ['task', h.index.root, 'T1'];
    else if (kind === 'hash') slot.hash = 'forged';
    else if (kind === 'queryKey') slot.query.queryKey = ['task', h.index.root, 'T1'];
    else if (kind === 'queryHash') slot.query.queryHash = 'forged';
    else if (kind === 'proof') slot.qualification.proof.generation = 'foreign';
    else if (kind === 'proof-rev') slot.qualification.proof.rev = h.index.rev + 1;
    else if (kind === 'future-used') slot.usedAt = Date.now() + 2 * READ_DAY;
    else if (kind === 'future-data') slot.query.state.dataUpdatedAt = Date.now() + 2 * READ_DAY;
    else if (kind === 'acquisition-time') slot.acquiredAt++;
    else if (kind === 'received-at') raw.control.indexReceivedAt--;
    else if (kind === 'scope') raw.control.scope.generation = 'foreign';
    else slot.query.state.data.root = 'foreign';
    h.storage.replace(raw);
    const next = client(); await restoreReadPersistence(next);
    expect(readIndex(next)).toBeUndefined();
  });

test('the writer decodes equal held data through the current Query identity without a second payload parse', async () => {
  const h = await fixture(), parse = vi.spyOn(taskViewSchema.shape.task._zod, 'run');
  await flush(h.storage);
  expect(parse).not.toHaveBeenCalled();
  expect(taskSlot(h.storage.read()).query.state.data.task.values.notes).toBe('ACQUIRED BODY');
});

test('equal held data keeps newly parsed metadata rather than the Query proof or times', async () => {
  const h = await fixture(); h.stop(); failTaskGets();
  const raw = h.storage.read(), slot = taskSlot(raw);
  slot.usedAt = Date.now() - 1_000; slot.query.dehydratedAt -= 5_000; slot.qualification.proof.uncertain = true;
  h.storage.replace(raw);
  const next = client(); receiveFullIndex(next, h.index); next.setQueryData(h.query.queryKey, h.query.state.data);
  await restoreReadPersistence(next);
  await next.fetchQuery(resources.personalSettings(h.index.root)); await next.fetchQuery(resources.notices(h.index.root));
  const parse = vi.spyOn(taskViewSchema.shape.task._zod, 'run'); start(next);
  await waitFor(() => expect(h.storage.read().control.revision).toBeGreaterThan(raw.control.revision));
  const saved = taskSlot(h.storage.read());
  expect(saved.usedAt).toBe(slot.usedAt); expect(saved.query.dehydratedAt).toBe(slot.query.dehydratedAt);
  expect(saved.qualification.proof.uncertain).toBe(true); expect(parse).not.toHaveBeenCalled();
});

test.each(['foreign-proof', 'extra-envelope'] as const)('equal payload cannot hide %s metadata or borrow another acquisition', async kind => {
  const h = await fixture(); h.stop(); failTaskGets();
  const raw = h.storage.read(), slot = taskSlot(raw);
  if (kind === 'foreign-proof') slot.qualification.proof.generation = 'foreign';
  else slot.extra = true;
  h.storage.replace(raw);
  const next = client(); receiveFullIndex(next, h.index);
  next.setQueryData(h.query.queryKey, h.query.state.data); // Structure is shared, acquisition is not.
  await restoreReadPersistence(next);
  await next.fetchQuery(resources.personalSettings(h.index.root)); await next.fetchQuery(resources.notices(h.index.root));
  const parse = vi.spyOn(taskViewSchema.shape.task._zod, 'run'); start(next);
  await waitFor(() => expect(h.storage.read().control.revision).toBeGreaterThan(raw.control.revision));
  if (kind === 'foreign-proof') expect(taskSlot(h.storage.read())).toBeUndefined();
  else {
    // Malformed envelopes were never part of decoded held slots, so the writer
    // leaves their raw rows alone; the real restore boundary must still reject them.
    expect(taskSlot(h.storage.read()).extra).toBe(true);
    const restored = client(); await restoreReadPersistence(restored);
    expect(readIndex(restored)).toBeDefined(); expect(readQuery(restored, h.query.queryKey)).toBeUndefined();
  }
  expect(parse).not.toHaveBeenCalled();
  expect(next.getQueryData(h.query.queryKey)).toBe(h.query.state.data);
  expect(assessRead(next, readQuery(next, h.query.queryKey)!).persist).toBe(false);
});

test('a raw slot missing at the same epoch is not borrowed from the Query used only for structure', async () => {
  const h = await fixture(); h.stop(); failTaskGets();
  const raw = h.storage.read(); raw.slots = raw.slots.filter((slot: any) => slot.key[0] !== 'task'); h.storage.replace(raw);
  const next = client(); receiveFullIndex(next, h.index); next.setQueryData(h.query.queryKey, h.query.state.data);
  await restoreReadPersistence(next);
  await next.fetchQuery(resources.personalSettings(h.index.root)); await next.fetchQuery(resources.notices(h.index.root));
  start(next); await flush(h.storage);
  expect(taskSlot(h.storage.read())).toBeUndefined();
  expect(next.getQueryData(h.query.queryKey)).toBe(h.query.state.data);
});

test.each(['invalid-json', 'non-string', 'nonfinite', 'invalid-shape', 'extra-state', 'foreign-proof'] as const)('unprocessed raw %s is rejected without borrowing Query identity', async kind => {
  const h = await fixture(); h.stop();
  const raw = h.storage.readRaw(), slot = taskSlot(raw), payload = JSON.parse(slot.payload);
  if (kind === 'invalid-json') slot.payload = '{broken';
  if (kind === 'non-string') slot.payload = payload;
  if (kind === 'nonfinite') slot.payload = slot.payload.replace('"version":1', '"version":1e400');
  if (kind === 'invalid-shape') { payload.task.values = 'malformed'; slot.payload = JSON.stringify(payload); }
  if (kind === 'extra-state') slot.query.state.data = payload;
  if (kind === 'foreign-proof') slot.qualification.proof.generation = 'foreign';
  h.storage.replaceRaw(raw);
  const next = client(); await restoreReadPersistence(next);
  expect(readIndex(next)).toBeDefined(); expect(next.getQueryData(h.query.queryKey)).toBeUndefined();
  // The adapter did not normalize or conceal the injected primitive/type/metadata.
  expect(h.storage.readRaw()).toEqual(raw);
});

test('decode crossing the absolute monotonic deadline cannot hydrate before the timeout callback executes', async () => {
  const h = await fixture(); h.stop();
  const raw = h.storage.readRaw(), indexText = raw.slots.find((slot: any) => slot.key[0] === 'index').payload;
  let clock = 0; vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const parse = JSON.parse;
  vi.spyOn(JSON, 'parse').mockImplementation((text, ...args) => {
    const value = parse(text, ...args); if (text === indexText) clock = 501; return value;
  });
  const fault = vi.fn(), next = client(); await restoreReadPersistence(next, fault);
  expect(readIndex(next)).toBeUndefined(); expect(readQuery(next, h.query.queryKey)).toBeUndefined();
  expect(useReadPersistence.getState()).toMatchObject({ restore: 'skipped' });
  expect(fault).not.toHaveBeenCalled();
});

test('removing the Query keeps its stored row as written', async () => {
  const h = await fixture();
  h.value.removeQueries({ queryKey: h.query.queryKey, exact: true });
  await flush(h.storage);
  expect(taskSlot(h.storage.read()).query.state.data.task.values.notes).toBe('ACQUIRED BODY');
  expect(readQuery(h.value, h.query.queryKey)).toBeUndefined();
  expect(useReadPersistence.getState().status).not.toBe('unavailable');
});

test.each(['terminal', 'stop', 'generation'] as const)('restore transaction completed after %s cannot hydrate, bind or revive saved display', async kind => {
  const h = await fixture(); h.stop();
  const release = h.storage.holdNextCommit(); stops.push(release);
  const next = client(), restoring = restoreReadPersistence(next);
  const stop = start(next);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const before = h.storage.counts().started;
  if (kind === 'terminal') h.storage.versionChange();
  if (kind === 'stop') stop();
  if (kind === 'generation') { stop(); start(next); }
  const status = useReadPersistence.getState();
  release(); await restoring;
  expect(next.getQueryData(h.query.queryKey)).toBeUndefined();
  expect(readIndex(next)).toBeUndefined();
  expect(useReadPersistence.getState()).toEqual(status);
  expect(h.storage.counts().started).toBe(before);
});

test('native JSON signed zero survives actual GET, text checkpoint and cold restore', async () => {
  const h = await fixture(), previous = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const response = await previous(url, init);
    if (new URL(String(url), 'http://fixture').pathname !== '/api/task/view') return response;
    return new Response((await response.text()).replace(/"sourcePv":-?\d+/g, '"sourcePv":-0'), { headers: { 'Content-Type': 'application/json' } });
  });
  h.value.removeQueries({ queryKey: h.query.queryKey, exact: true });
  await h.value.fetchQuery(resources.taskView(h.index.root, 'T1')); await flush(h.storage);
  const query = readQuery(h.value, h.query.queryKey)!;
  expect(Object.is((query.state.data as any).sourcePv, -0)).toBe(true);
  const raw = h.storage.readRaw(), slot = taskSlot(raw);
  expect(slot.payload).toContain('"sourcePv":-0'); expect('data' in slot.query.state).toBe(false);
  h.stop(); const cold = client(); await restoreReadPersistence(cold);
  expect(Object.is((cold.getQueryData(h.query.queryKey) as any).sourcePv, -0)).toBe(true);
});


test('startup budget releases the UI while late storage resumes saving without replacing live reads', async () => {
  const h = await fixture(); h.stop();
  const release = h.storage.holdNextCommit(); stops.push(release);
  const next = client(), fault = vi.fn();
  await restoreReadPersistence(next, fault);
  expect(useReadPersistence.getState().restore).toBe('skipped');
  expect(readIndex(next)).toBeUndefined();
  start(next);
  const live = { ...h.index, rev: h.index.rev + 1 };
  receiveFullIndex(next, live);
  await next.fetchQuery(resources.personalSettings(live.root));
  await next.fetchQuery(resources.notices(live.root));
  release();
  await waitFor(() => expect(h.storage.read().slots.find((slot: any) => slot.key[0] === 'index').query.state.data.rev).toBe(live.rev));
  expect(readIndex(next)?.rev).toBe(live.rev);
  expect(next.getQueryData(h.query.queryKey)).toBeUndefined();
  expect(useReadPersistence.getState()).toMatchObject({ status: 'saved', error: undefined, restore: 'skipped' });
  expect(fault).not.toHaveBeenCalled();
});

test('a real open failure is still reported, exactly once', async () => {
  const failure = new DOMException('Storage denied', 'SecurityError');
  vi.stubGlobal('indexedDB', { open() { throw failure; } });
  const fault = vi.fn(); await restoreReadPersistence(client(), fault);
  expect(fault).toHaveBeenCalledExactlyOnceWith(failure);
  expect(useReadPersistence.getState()).toMatchObject({ status: 'unavailable', error: 'Storage denied' });
});


test('a storage failure after startup continued is still reported once', async () => {
  const request: { onerror?: () => void; error?: Error } = {};
  vi.stubGlobal('indexedDB', { open() { return request; } });
  const fault = vi.fn(); await restoreReadPersistence(client(), fault);
  expect(useReadPersistence.getState().restore).toBe('skipped');
  expect(fault).not.toHaveBeenCalled();
  const failure = new DOMException('Late denial', 'UnknownError');
  request.error = failure; request.onerror!();
  await waitFor(() => expect(fault).toHaveBeenCalledExactlyOnceWith(failure));
  expect(useReadPersistence.getState()).toMatchObject({ status: 'unavailable', error: 'Late denial' });
});
