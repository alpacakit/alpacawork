import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { IndexPatchDTO, ProjectedIndexDTO } from '@alpacawork/contract/control';
import { readScheduler, startReadScheduler } from '../src/data/read-scheduler';
import { useConnection } from '../src/data/connection';
import { observeReadProofs } from '../src/data/read-model';
import { indexKey, receiveFullIndex, receivePatch, resources } from '../src/data/resources';
import { analysisHome } from '../src/features/analysis/place';
import { useViewStore } from '../src/state/view-store';
import { dto, homeFixture, indexOf, tree, viewsOf } from './fixtures';

// The real scheduler, resources and Query; fetch answers each read when the test lets it, and records the order.
const clients: QueryClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.clear(); vi.restoreAllMocks(); setVisible(true); });
const eventually = (check: () => void) => vi.waitFor(check, { interval: 1, timeout: 2000 });
let visibility: DocumentVisibilityState = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
function setVisible(visible: boolean) { visibility = visible ? 'visible' : 'hidden'; document.dispatchEvent(new Event('visibilitychange')); }
const ids = ['T1', 'T2', 'T3', 'T4'];
const plain = tree({ tasks: ids.map(id => dto({ id })) });

function screen(value = plain, navigationReady = true) {
  useViewStore.setState({ navigationReady, project: null, query: '', analysis: null });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client); observeReadProofs(client);
  receiveFullIndex(client, indexOf(value));
  useConnection.setState({ state: 'live', offline: false, fresh: true });
  onTestFinished(startReadScheduler(client));
  const asked: string[] = [], pending: (() => void)[] = [];
  let hold = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(url => new Promise<Response>(resolve => {
    const query = new URL(String(url), 'http://x'), id = query.searchParams.get('task')!;
    const view = query.pathname.endsWith('/task/view');
    asked.push(`${view ? 'view' : 'history'} ${id}`);
    const sourcePv = (client.getQueryData<ProjectedIndexDTO>(indexKey)?.sourcePv ?? 0) as number;
    const body = view ? { ...viewsOf(value, sourcePv).find(each => each.task.id === id)! }
      : { generation: 'a', sourcePv, events: [], oldestKey: null, hasOlder: false, tasks: {} };
    const answer = () => resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
    if (hold) pending.push(answer); else answer();
  }));
  return { client, scheduler: readScheduler(client)!, asked, pending, hold: (value: boolean) => { hold = value; },
    answerAll: () => { while (pending.length) pending.shift()!(); } };
}
const emptyKeyed = { upsert: {}, remove: [] };
function raise(client: QueryClient, view: Record<string, number>) {
  const index = client.getQueryData<ProjectedIndexDTO>(indexKey)!, pv = Math.max(index.sourcePv + 1, ...Object.values(view));
  const patch = { rev: index.rev + 1, generation: index.generation, sourcePv: pv, tasks: { upsert: [], remove: [] },
    placements: { upsert: [], remove: [] }, runs: { upsert: [], remove: [] }, home: { upsert: [], remove: [] },
    counts: { closed: emptyKeyed, home: emptyKeyed, tasks: emptyKeyed, children: emptyKeyed },
    requiredPv: { view: { upsert: view, remove: [] }, history: emptyKeyed, page: emptyKeyed, timeline: emptyKeyed, search: emptyKeyed }, meta: {} };
  expect(receivePatch(client, patch as unknown as IndexPatchDTO)).not.toBeNull();
}

test('what is opened is read first; what is ahead waits for it, then goes one at a time, a pointer before the next card', async () => {
  const s = screen();
  s.hold(true);
  s.scheduler.opened('T1', true);
  s.scheduler.next(['T2']);
  s.scheduler.pointed('T3');
  await eventually(() => expect(s.asked).toEqual(['view T1', 'history T1']));
  s.answerAll();
  await eventually(() => expect(s.asked).toHaveLength(3));
  // One at a time: nothing else is asked while that one is out.
  expect(s.asked[2]).toBe('view T3');
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(s.asked).toHaveLength(3);
  s.answerAll();
  await eventually(() => expect(s.asked).toHaveLength(4)); s.answerAll();
  await eventually(() => expect(s.asked).toHaveLength(5)); s.answerAll();
  expect(s.asked.slice(3)).toEqual(['view T2', 'history T2']);
});

test('in a background tab nothing is read ahead until the tab is shown again', async () => {
  const s = screen();
  setVisible(false);
  s.scheduler.next(['T2']);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(s.asked).toEqual([]);
  setVisible(true);
  await eventually(() => expect(s.asked).toEqual(['view T2', 'history T2']));
});

test('a held view is read again ahead only when its required version rises, and not while its reader shows it', async () => {
  const s = screen();
  await s.client.prefetchQuery(resources.taskView('/fixture', 'T1'));
  await s.client.prefetchQuery(resources.taskView('/fixture', 'T2'));
  expect(s.asked).toEqual(['view T1', 'view T2']);
  // A patch that raises no held view reads nothing.
  raise(s.client, { T4: 1 });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(s.asked).toEqual(['view T1', 'view T2']);
  raise(s.client, { T2: 3 });
  await eventually(() => expect(s.asked).toEqual(['view T1', 'view T2', 'view T2']));
});

test('a read already current is not read ahead', async () => {
  const s = screen();
  await s.client.prefetchQuery(resources.taskView('/fixture', 'T1'));
  s.scheduler.pointed('T1');
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(s.asked).toEqual(['view T1']);
});

test("the user's turn rows nothing is held of are read ahead, after what is opened; working rows are not", async () => {
  // T1 and T3 wait for the user's review, T2 is at work; T3's view and History are already held.
  const turns = tree({ tasks: ids.map(id => dto({ id })), home: homeFixture([{ taskId: 'T1', section: 'review' },
    { taskId: 'T2', section: 'doing' }, { taskId: 'T3', section: 'review' }]) });
  const s = screen(turns);
  await s.client.prefetchQuery(resources.taskView('/fixture', 'T3'));
  await s.client.prefetchQuery(resources.history('/fixture', 'T3'));
  s.asked.length = 0;
  s.hold(true);
  s.scheduler.opened('T4', false);
  // The list moves on: T3's view needs the new version, T1 has nothing held yet.
  raise(s.client, { T3: 2 });
  await eventually(() => expect(s.asked).toEqual(['view T4']));
  for (let at = 1; at <= 3; at++) { s.answerAll(); await eventually(() => expect(s.asked).toHaveLength(at + 1)); }
  s.answerAll();
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(s.asked).toEqual(['view T4', 'view T3', 'view T1', 'history T1']);
});

test("opening analysis skips the home list's reads until the list is shown", async () => {
  const turns = tree({ tasks: ids.map(id => dto({ id })), home: homeFixture([{ taskId: 'T1', section: 'review' }]) });
  const s = screen(turns, false);
  raise(s.client, {});
  useViewStore.setState({ navigationReady: true, analysis: analysisHome() });
  raise(s.client, {});
  // A task opened over the analysis still reads its detail and History.
  s.scheduler.opened('T2', true);
  await eventually(() => expect(s.asked).toEqual(['view T2', 'history T2']));
  // Returning to the list needs no new index receipt to prepare its rows.
  useViewStore.setState({ analysis: null });
  await eventually(() => expect(s.asked).toEqual(['view T2', 'history T2', 'view T1', 'history T1']));
});
