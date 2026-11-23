import { afterEach, expect, test, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { acceptPersonalRead, captureResourceRead, onReadEvent, receiveFullIndex, resources } from '../src/data/resources';
import { NOTICE_VERSION, taskBaseline } from '../src/data/notice-model';
import { restoreReadPersistence, startReadPersistence, useReadPersistence } from '../src/data/read-persistence';
import { readQuery, readRefused, refuseRead } from '../src/data/read-model';
import { checkpointFixture } from './checkpoint-fixture';
import { dto, indexOf, tree, viewsOf } from './fixtures';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(stop => stop()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const source = tree({ tasks: [dto({ id: 'T1', title: 'STORED' })] }), listed = indexOf(source);
const index = { ...listed, person: { ...listed.person, settings: 'stored-settings', notices: 'stored-notices' } };
const view = viewsOf(source).find(item => item.task.id === 'T1')!;
const event = (n: number) => ({ id: `L${String(n).padStart(5, '0')}`, kind: 'comment' as const, taskId: 'T1', fromChild: false,
  at: new Date(Date.UTC(2026, 9, 1) + n * 1000).toISOString(), state: null, by: null, title: '', summary: '' });
let events = [event(1)];
const client = () => {
  const made = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  cleanup.push(() => made.clear()); return made;
};
function serve() {
  vi.stubGlobal('fetch', async (url: string) => {
    const path = new URL(String(url), 'http://fixture').pathname;
    if (path === '/api/settings/get') return Response.json({ values: {}, revision: index.person.settings });
    if (path === '/api/person/notices') return Response.json({ state: null, revision: index.person.notices });
    if (path === '/api/task/view') return Response.json(view);
    if (path === '/api/task/history') return Response.json({ generation: 'a', sourcePv: 0, events: [...events].reverse(),
      oldestKey: null, hasOlder: false, tasks: {} });
    throw new Error('Unexpected HTTP ' + url);
  });
}
/** A first visit that reads the index, the person's reads and T1's view, and stores them. */
async function firstVisit(storage: ReturnType<typeof checkpointFixture>) {
  const first = client();
  await restoreReadPersistence(first); receiveFullIndex(first, index);
  await first.fetchQuery(resources.personalSettings(index.root)); await first.fetchQuery(resources.notices(index.root));
  await first.fetchQuery(resources.taskView(index.root, 'T1'));
  const stop = startReadPersistence(first, listener => onReadEvent(first, listener)); cleanup.push(stop);
  await waitFor(() => expect(storage.read().slots.some((slot: any) => slot.key[0] === 'task')).toBe(true));
  stop();
}

test('marking a task read before the first checkpoint still saves an offline copy', async () => {
  const storage = checkpointFixture(); vi.stubGlobal('indexedDB', storage.factory); serve();
  const visit = client(); await restoreReadPersistence(visit); receiveFullIndex(visit, index);
  await visit.fetchQuery(resources.personalSettings(index.root));
  await visit.fetchQuery(resources.notices(index.root));
  await visit.fetchQuery(resources.taskView(index.root, 'T1'));
  const key = resources.notices(index.root).queryKey;
  const baseline = taskBaseline(index.tasks.find(task => task.id === 'T1')!);
  const saved = { revision: 'marked-read', state: { version: NOTICE_VERSION,
    checkpoint: { at: new Date().toISOString(), tasks: {} }, reads: { T1: baseline } } };
  expect(acceptPersonalRead(visit, key, saved, captureResourceRead(visit, key))).toBe(true);
  cleanup.push(startReadPersistence(visit, listener => onReadEvent(visit, listener)));
  await waitFor(() => {
    const slots = storage.read().slots;
    expect(slots.find((slot: any) => slot.key[0] === 'person-notices')?.query.state.data).toEqual(saved);
    expect(slots.find((slot: any) => slot.key[0] === 'task')?.query.state.data.task.id).toBe('T1');
  });
});

test('a restore that lands after this visit was refused a Task does not bring the stored copy back', async () => {
  const storage = checkpointFixture(); vi.stubGlobal('indexedDB', storage.factory); serve();
  await firstVisit(storage);
  // The next visit starts without waiting for the restore, and is refused T1 before the stored copy comes back.
  const next = client(), key = resources.taskView(index.root, 'T1').queryKey;
  refuseRead(next.getQueryCache().build(next, { queryKey: key }));
  await restoreReadPersistence(next);
  expect(useReadPersistence.getState().restore).toBe('restored');
  expect(next.getQueryData(key)).toBeUndefined();
  expect(readRefused(readQuery(next, key)!)).toBe(true);
});

test('an open History is stored when its reader closes it, not on every change while it is read', async () => {
  const storage = checkpointFixture(); vi.stubGlobal('indexedDB', storage.factory); serve();
  events = [event(1)];
  const visit = client();
  await restoreReadPersistence(visit); receiveFullIndex(visit, index);
  await visit.fetchQuery(resources.personalSettings(index.root)); await visit.fetchQuery(resources.notices(index.root));
  const observer = new QueryObserver(visit, resources.history(index.root, 'T1'));
  const close = observer.subscribe(() => {});
  await waitFor(() => expect(visit.getQueryData(resources.history(index.root, 'T1').queryKey)).toBeDefined());
  cleanup.push(startReadPersistence(visit, listener => onReadEvent(visit, listener)));
  const stored = () => storage.read().slots.filter((slot: any) => slot.key[0] === 'task-history');
  await waitFor(() => expect(storage.read().slots.some((slot: any) => slot.key[0] === 'index')).toBe(true));
  await new Promise(resolve => setTimeout(resolve, 400));
  expect(stored()).toEqual([]);
  close();
  await waitFor(() => expect(stored().map((slot: any) => slot.query.state.data.pages[0].events.length)).toEqual([1]));
});
