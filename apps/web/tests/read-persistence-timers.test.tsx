import { afterEach, expect, test, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { readIndex, readQuery } from '../src/data/read-model';
import { applyReadEvidence, onReadEvent, receiveFullIndex, resources } from '../src/data/resources';
import { hasPendingReadRefusal, restoreReadPersistence, startReadPersistence } from '../src/data/read-persistence';
import { checkpointFixture } from './checkpoint-fixture';
import { dto, indexOf, tree, viewsOf } from './fixtures';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(stop => stop()); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
const settleTimer = () => new Promise(resolve => setTimeout(resolve, 350));
async function fixture() {
  const storage = checkpointFixture(); vi.stubGlobal('indexedDB', storage.factory);
  const source = tree({ tasks: [dto({ id: 'T1', body: 'ACQUIRED' })] }), initial = indexOf(source);
  const index = { ...initial, person: { ...initial.person, settings: 'timer-settings' } };
  const view = viewsOf(source).find(item => item.task.id === 'T1')!;
  vi.stubGlobal('fetch', async (url: string) => {
    const path = new URL(String(url), 'http://fixture').pathname;
    if (path === '/api/settings/get') return Response.json({ values: {}, revision: index.person.settings });
    if (path === '/api/person/notices') return Response.json({ state: null, revision: index.person.notices });
    if (path === '/api/task/view') return Response.json(view);
    throw new Error('Unexpected timer fixture HTTP ' + url);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  cleanup.push(() => client.clear()); await restoreReadPersistence(client); receiveFullIndex(client, index);
  await client.fetchQuery(resources.personalSettings(index.root)); await client.fetchQuery(resources.notices(index.root));
  await client.fetchQuery(resources.taskView(index.root, 'T1'));
  const stop = startReadPersistence(client, listener => onReadEvent(client, listener));
  cleanup.push(stop);
  await waitFor(() => expect(storage.read().slots.some((slot: any) => slot.key[0] === 'task')).toBe(true));
  return { storage, client, index, stop };
}

test('one synchronous index success and live publication share one normal reservation', async () => {
  const h = await fixture(), before = h.storage.counts().committed;
  receiveFullIndex(h.client, { ...h.index, rev: h.index.rev + 1 });
  await waitFor(() => expect(h.storage.counts().committed).toBe(before + 1));
  await settleTimer();
  expect(h.storage.counts().started).toBe(before + 1);
  expect(readIndex(h.client)?.rev).toBe(h.index.rev + 1);
});

test('dirty work received during an IDB write retains its normal reservation', async () => {
  const h = await fixture(), before = h.storage.counts().committed;
  const release = h.storage.holdNextRead(); cleanup.push(release);
  receiveFullIndex(h.client, { ...h.index, rev: h.index.rev + 1 });
  await waitFor(() => expect(h.storage.counts().started).toBe(before + 1));
  receiveFullIndex(h.client, { ...h.index, rev: h.index.rev + 2 });
  release();
  await waitFor(() => expect(h.storage.counts().committed).toBe(before + 2));
  await settleTimer();
  expect(h.storage.counts().started).toBe(before + 2);
  expect(h.storage.read().slots.find((slot: any) => slot.key[0] === 'index').query.state.data.rev).toBe(h.index.rev + 2);
});

test('a strict refusal keeps its normal follow-up without a third pass from an already consumed timer', async () => {
  const h = await fixture(), before = h.storage.counts().committed, epoch = h.storage.read().control.epoch;
  const query = readQuery(h.client, ['task', h.index.root, 'T1'])!;
  applyReadEvidence(h.client, { kind: 'refused', query });
  expect(hasPendingReadRefusal(query, h.client)).toBe(true);
  await waitFor(() => expect(h.storage.counts().committed).toBe(before + 2));
  await settleTimer();
  expect(h.storage.counts().started).toBe(before + 2);
  expect(h.storage.read().slots.some((slot: any) => slot.key[0] === 'task')).toBe(false);
  expect(h.storage.read().control.epoch).not.toBe(epoch);
  expect(hasPendingReadRefusal(query, h.client)).toBe(false);
});

test('each successful selection replaces its expiry reservation and stop releases the last handle', async () => {
  const timeouts = vi.spyOn(globalThis, 'setTimeout'), cleared = vi.spyOn(globalThis, 'clearTimeout');
  const h = await fixture(), before = h.storage.counts().committed;
  const expiries = () => timeouts.mock.calls.flatMap(([callback, delay], at) =>
    typeof callback === 'function' && callback.name === 'flush' && Number(delay) > 86_400_000 ? [timeouts.mock.results[at]!.value] : []);
  cleanup.push(() => { for (const handle of expiries()) clearTimeout(handle); });
  expect(expiries()).toHaveLength(1);
  const release = h.storage.holdNextRead(); cleanup.push(release);
  receiveFullIndex(h.client, { ...h.index, rev: h.index.rev + 1 });
  await waitFor(() => expect(h.storage.counts().started).toBe(before + 1));
  window.dispatchEvent(new Event('pagehide')); release();
  await waitFor(() => expect(h.storage.counts().committed).toBe(before + 2));
  const handles = expiries();
  // Both iterations save a new selection and therefore set a deadline; the
  // older one must not survive merely because another result overwrote its handle.
  expect(handles).toHaveLength(3);
  for (const handle of handles.slice(0, -1)) expect(cleared.mock.calls.some(([value]) => value === handle)).toBe(true);
  expect(cleared.mock.calls.some(([value]) => value === handles.at(-1))).toBe(false);
  h.stop(); expect(cleared.mock.calls.some(([value]) => value === handles.at(-1))).toBe(true);
});

// Start the deterministic clock only after the real startup fixture has closed its timer handles.
async function controlled() {
  const h = await fixture(); h.stop();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const stop = startReadPersistence(h.client, listener => onReadEvent(h.client, listener));
  cleanup.push(stop); await vi.advanceTimersByTimeAsync(250);
  return { ...h, stop };
}
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const publish = (h: Awaited<ReturnType<typeof fixture>>, rev: number) => receiveFullIndex(h.client, { ...h.index, rev: h.index.rev + rev });

test('busy normal dirty cannot start before its first absolute 250ms due time', async () => {
  const h = await controlled(), before = h.storage.counts().started;
  const release = h.storage.holdNextCommit(); cleanup.push(release);
  publish(h, 1); await tick(250); expect(h.storage.counts().started).toBe(before + 1);
  publish(h, 2); await tick(100); release(); await tick();
  expect(h.storage.counts().started).toBe(before + 1);
  await tick(149); expect(h.storage.counts().started).toBe(before + 1);
  await tick(1); expect(h.storage.counts().started).toBe(before + 2);
  expect(h.storage.starts().at(-1)!.at - h.storage.starts().at(-2)!.at).toBe(250);
  await tick(1000); expect(h.storage.counts().started).toBe(before + 2);
});

test('a normal deadline reached while busy survives without another 250ms wait or a duplicate timer', async () => {
  const h = await controlled(), before = h.storage.counts().started;
  const release = h.storage.holdNextCommit(); cleanup.push(release);
  publish(h, 1); await tick(250); publish(h, 2); await tick(300);
  expect(h.storage.counts().started).toBe(before + 1);
  release(); await tick(); expect(h.storage.counts().started).toBe(before + 2);
  await tick(2000); expect(h.storage.counts().started).toBe(before + 2);
});

test.each(['pagehide', 'hidden', 'expiry'] as const)('%s retains an immediate request during a write, ahead of the normal due time', async kind => {
  const h = await controlled();
  const timeouts = vi.spyOn(globalThis, 'setTimeout');
  window.dispatchEvent(new Event('pagehide')); await tick();
  const before = h.storage.counts().started;
  const release = h.storage.holdNextCommit(); cleanup.push(release);
  publish(h, 1); await tick(250); publish(h, 2);
  if (kind === 'pagehide') window.dispatchEvent(new Event('pagehide'));
  if (kind === 'hidden') { vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')); }
  if (kind === 'expiry') {
    const callback = timeouts.mock.calls.find(([callback, delay]) => typeof callback === 'function' && callback.name === 'flush' && Number(delay) > 86_400_000)![0] as () => void;
    callback();
  }
  await tick(10); release(); await tick();
  expect(h.storage.counts().started).toBe(before + 2);
  await tick(1000); expect(h.storage.counts().started).toBe(before + 2);
});

test('strict refusal preempts a normal reservation, and its follow-up waits on one normal deadline', async () => {
  const h = await controlled(), before = h.storage.counts().started;
  publish(h, 1); await tick(100);
  const query = readQuery(h.client, ['task', h.index.root, 'T1'])!;
  applyReadEvidence(h.client, { kind: 'refused', query }); await tick();
  expect(h.storage.counts().started).toBe(before + 1); expect(h.storage.starts().at(-1)?.durability).toBe('strict');
  await tick(149); expect(h.storage.counts().started).toBe(before + 1);
  // The earlier normal request was consumed by the strict write; one follow-up is due 250ms later.
  await tick(101); expect(h.storage.counts().started).toBe(before + 2);
  await tick(1000); expect(h.storage.counts().started).toBe(before + 2);
});

test('three transient failures use only 250/1000ms retries; a new explicit operation can retry after exhaustion', async () => {
  const h = await controlled(), before = h.storage.counts().started;
  const fail = () => h.storage.failNextWrite(new DOMException('transient', 'AbortError'));
  fail(); window.dispatchEvent(new Event('pagehide')); await tick();
  fail(); await tick(249); expect(h.storage.counts().started).toBe(before + 1);
  await tick(1); expect(h.storage.counts().started).toBe(before + 2);
  fail(); await tick(999); expect(h.storage.counts().started).toBe(before + 2);
  await tick(1); expect(h.storage.counts().started).toBe(before + 3);
  await tick(4000); expect(h.storage.counts().started).toBe(before + 3);
  window.dispatchEvent(new Event('pagehide')); await tick(); expect(h.storage.counts().committed).toBe(before + 1);
  fail(); window.dispatchEvent(new Event('pagehide')); await tick();
  await tick(250); expect(h.storage.counts().started).toBe(before + 6); // success reset the retry count
});

test('quota never self-retries and a pagehide during retry wait preempts the same single reservation', async () => {
  const h = await controlled(), before = h.storage.counts().started;
  h.storage.failNextWrite(new DOMException('quota', 'QuotaExceededError'));
  window.dispatchEvent(new Event('pagehide')); await tick(); await tick(2000);
  expect(h.storage.counts().started).toBe(before + 1);
  h.storage.failNextWrite(new DOMException('abort', 'AbortError'));
  window.dispatchEvent(new Event('pagehide')); await tick(); await tick(100);
  window.dispatchEvent(new Event('pagehide')); await tick(); expect(h.storage.counts().started).toBe(before + 3);
  await tick(2000); expect(h.storage.counts().started).toBe(before + 3);
  h.storage.failNextWrite(new DOMException('abort', 'AbortError'));
  window.dispatchEvent(new Event('pagehide')); await tick(); h.stop(); await tick(5000);
  expect(h.storage.counts().started).toBe(before + 4);
});


test.each(['normal', 'refusal', 'clear'] as const)('a new %s request received during a permanent failure survives with its own deadline', async kind => {
  const h = await controlled(), before = h.storage.counts().started;
  const releaseRead = h.storage.holdNextCommit(); cleanup.push(releaseRead);
  h.storage.abortNextCommit(new DOMException('quota', 'QuotaExceededError'));
  window.dispatchEvent(new Event('pagehide')); await tick();
  const query = readQuery(h.client, ['task', h.index.root, 'T1'])!;
  if (kind === 'normal') publish(h, 1);
  if (kind === 'refusal') applyReadEvidence(h.client, { kind: 'refused', query });
  if (kind === 'clear') receiveFullIndex(h.client, { ...h.index, generation: 'new-generation' });
  const releaseCommit = h.storage.holdNextCommit(); cleanup.push(releaseCommit);
  releaseRead(); await tick();
  if (kind === 'normal') { expect(h.storage.counts().started).toBe(before + 1); await tick(250); }
  expect(h.storage.counts().started).toBe(before + 2);
  if (kind === 'refusal') expect(hasPendingReadRefusal(query, h.client)).toBe(true);
  releaseCommit(); await tick();
  if (kind === 'refusal') { expect(hasPendingReadRefusal(query, h.client)).toBe(false); expect(h.storage.read().slots.some((slot: any) => slot.key[0] === 'task')).toBe(false); }
  if (kind === 'clear') expect(h.storage.read().slots).toHaveLength(0);
  await tick(2000);
  expect(h.storage.counts().started).toBe(before + (kind === 'normal' ? 2 : 3));
});
