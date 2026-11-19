import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import { QueryClient, QueryObserver, onlineManager, type InfiniteData } from '@tanstack/react-query';
import { historyCursor } from '@alpacawork/contract';
import { HISTORY_WINDOW_MAX, HISTORY_WINDOW_SIZE, type IndexPatchDTO, type ProjectedIndexDTO, type TaskHistoryDTO } from '@alpacawork/contract/control';
import { holdHistory } from '../src/data/history-window';
import { requestOlder } from '../src/data/read-demand';
import { evaluateRead, observeReadProofs, readEntry, readQuery } from '../src/data/read-model';
import { indexKey, receiveFullIndex, receivePatch, resources } from '../src/data/resources';
import { moveHistoryToLatest } from '../src/data/history-resource';
import { dto, indexOf, tree } from './fixtures';

// The real History resource, Query, transport and decoder; only fetch answers, as a server holding `events` would.
type Event = TaskHistoryDTO['events'][number];
const clients: QueryClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.clear(); onlineManager.setOnline(true); vi.restoreAllMocks(); });
const eventually = async (check: () => void) => vi.waitFor(check, { interval: 1, timeout: 2000 });
const event = (n: number, title = ''): Event => ({ id: `L${String(n).padStart(5, '0')}`, kind: 'comment', taskId: 'T1', fromChild: false,
  at: new Date(Date.UTC(2026, 9, 1) + n * 1000).toISOString(), state: null, by: null, title, summary: '' });
const numbers = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, n) => from + n);

/** A server's History of T1: newest first, cut as the contract's four requests ask, each answer from `pv`. */
function server(initial: Event[]) {
  const state = { events: [...initial], pv: 1 };
  const requests: URLSearchParams[] = [];
  const pending: { answer: () => void; fail: () => void }[] = [];
  let hold = false;
  const newest = () => [...state.events].sort((a, b) => historyCursor(b).localeCompare(historyCursor(a)));
  const window = (events: Event[], hasOlder: boolean) => ({ generation: 'a', sourcePv: state.pv, events, hasOlder,
    oldestKey: events.length ? historyCursor(events.at(-1)!) : null });
  const answer = (query: URLSearchParams): [unknown, number] => {
    const all = newest(), mode = query.get('mode');
    if (mode === 'older') {
      const below = all.filter(e => historyCursor(e) < query.get('before')!), limit = Number(query.get('limit'));
      return [window(below.slice(0, limit), below.length > limit), 200];
    }
    if (mode === 'protect') {
      // As the server: the protected position widens the newest HISTORY_WINDOW_SIZE of what is held, never narrows it.
      const reach = all.filter(e => historyCursor(e) >= query.get('protect')!).length;
      const held = all.filter(e => historyCursor(e) >= query.get('since')!).length;
      if (reach > HISTORY_WINDOW_MAX) return [{ error: { code: 'conflict', retry: 'reread', message: 'too large',
        reason: { kind: 'history_window_too_large', limit: HISTORY_WINDOW_MAX } } }, 409];
      const kept = all.slice(0, Math.max(reach, Math.min(held, HISTORY_WINDOW_SIZE)));
      return [window(kept, all.length > kept.length), 200];
    }
    const since = mode === 'since' ? all.filter(e => historyCursor(e) >= query.get('since')!) : all;
    const kept = since.slice(0, mode === 'since' ? Number(query.get('keep')) : 80);
    return [window(kept, all.length > kept.length), 200];
  };
  vi.spyOn(globalThis, 'fetch').mockImplementation(url => new Promise<Response>((resolve, reject) => {
    const query = new URL(String(url), 'http://x').searchParams;
    requests.push(query);
    const [body, status] = answer(query);
    const respond = () => resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
    if (hold) pending.push({ answer: respond, fail: () => reject(new TypeError('offline')) }); else respond();
  }));
  return { state, requests, modes: () => requests.map(query => query.get('mode')), pending,
    holdAnswers: (value: boolean) => { hold = value; } };
}

/** A screen holding the list and T1's History open, the History first read at the server's version. */
async function screen(initial: Event[]) {
  const s = server(initial);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client); observeReadProofs(client);
  receiveFullIndex(client, indexOf(tree({ tasks: [dto({ id: 'T1' })] })));
  const options = resources.history('/fixture', 'T1');
  const observer = new QueryObserver(client, options);
  let stop: (() => void) | undefined = observer.subscribe(() => {});
  onTestFinished(() => stop?.());
  await eventually(() => expect(ids(client)).toBeDefined());
  const query = () => readQuery(client, options.queryKey)!;
  return { ...s, client, query,
    ids: () => ids(client)!,
    held: () => client.getQueryData<InfiniteData<TaskHistoryDTO>>(options.queryKey)!,
    /** The server records a change: its version rises, and the list's patch says T1's History needs it. */
    change: (mutate: (events: Event[]) => void) => {
      mutate(s.state.events); s.state.pv++;
      const index = client.getQueryData<ProjectedIndexDTO>(indexKey)!;
      expect(receivePatch(client, patchOf(index, { history: { upsert: { T1: s.state.pv as never }, remove: [] } }))).not.toBeNull();
    },
    current: () => evaluateRead(client.getQueryData<ProjectedIndexDTO>(indexKey), readEntry(query())).state,
    close: () => { stop?.(); stop = undefined; },
  };
}
const ids = (client: QueryClient) => client.getQueryData<InfiniteData<TaskHistoryDTO>>(['task-history', '/fixture', 'T1'])
  ?.pages.flatMap(page => page.events.map(each => Number(each.id.slice(1))));
const emptyKeyed = { upsert: {}, remove: [] };
function patchOf(index: ProjectedIndexDTO, requiredPv: Partial<IndexPatchDTO['requiredPv']>): IndexPatchDTO {
  return { rev: index.rev + 1, generation: index.generation, sourcePv: Math.max(index.sourcePv + 1, ...Object.values(requiredPv).flatMap(each => Object.values(each.upsert))) as IndexPatchDTO['sourcePv'],
    tasks: { upsert: [], remove: [] }, placements: { upsert: [], remove: [] }, runs: { upsert: [], remove: [] }, home: { upsert: [], remove: [] },
    counts: { closed: emptyKeyed, home: emptyKeyed, tasks: emptyKeyed, children: emptyKeyed },
    requiredPv: { view: emptyKeyed, history: emptyKeyed, page: emptyKeyed, timeline: emptyKeyed, search: emptyKeyed, ...requiredPv } as IndexPatchDTO['requiredPv'],
    meta: {} };
}
const settled = (s: Awaited<ReturnType<typeof screen>>) => eventually(() => expect(s.query().state.fetchStatus).toBe('idle'));
/** Widen the window by `pages` older reads. */
async function widen(s: Awaited<ReturnType<typeof screen>>, pages: number) {
  for (let n = 0; n < pages; n++) await requestOlder(s.query());
  await settled(s);
}

test('read back 640 events while new ones come: no gap, and the position read is kept', async () => {
  const s = await screen(numbers(1, 640).map(n => event(n)));
  expect(s.ids()).toEqual(numbers(561, 640).reverse());
  await widen(s, 7);
  expect(s.ids()).toEqual(numbers(1, 640).reverse());
  // The reader is at the oldest event: the window from there to the newest comes back whole.
  holdHistory(s.query(), () => ({ kind: 'through', cursor: historyCursor(event(1)) }));
  s.change(events => events.push(event(641)));
  await eventually(() => expect(s.ids()).toEqual(numbers(1, 641).reverse()));
  expect(s.requests.at(-1)!.get('mode')).toBe('protect');
  expect(s.current()).toBe('current');
});

test('a change to an event already held comes in one read again, with no new event', async () => {
  const s = await screen(numbers(1, 10).map(n => event(n)));
  s.change(events => { events[4] = event(5, 'answered'); });
  await eventually(() => expect(s.held().pages[0]!.events.find(each => each.id === 'L00005')!.title).toBe('answered'));
  expect(s.modes()).toEqual(['latest', 'since']);
  expect(s.ids()).toEqual(numbers(1, 10).reverse());
  expect(s.current()).toBe('current');
});

test('two changes in a row both arrive, the window ending at the newest version', async () => {
  const s = await screen(numbers(1, 10).map(n => event(n)));
  s.holdAnswers(true);
  s.change(events => events.push(event(11)));
  await eventually(() => expect(s.pending).toHaveLength(1));
  s.change(events => events.push(event(12)));
  s.holdAnswers(false);
  s.pending.shift()!.answer();
  await eventually(() => expect(s.ids()).toEqual(numbers(1, 12).reverse()));
  await settled(s);
  expect(s.current()).toBe('current');
});

test('widened just after a change: the window is as old as its oldest part, and is read again', async () => {
  const s = await screen(numbers(1, 200).map(n => event(n)));
  // The server moves on without telling the list yet: the older part comes from a newer version than the head.
  s.state.pv = 5;
  await widen(s, 1);
  expect(s.ids()).toEqual(numbers(41, 200).reverse());
  const index = s.client.getQueryData<ProjectedIndexDTO>(indexKey)!;
  receivePatch(s.client, patchOf(index, { history: { upsert: { T1: 3 as never }, remove: [] } }));
  // Required 3: the older part (5) reaches it, the head (1) does not, so the window is read again.
  await eventually(() => expect(s.modes().at(-1)).toBe('since'));
  await settled(s);
  expect(s.current()).toBe('current');
});

test('widening asked while the window is being read again waits for that read, and keeps what it widened', async () => {
  const s = await screen(numbers(1, 200).map(n => event(n)));
  s.holdAnswers(true);
  s.change(events => events.push(event(201)));
  await eventually(() => expect(s.pending).toHaveLength(1));
  const widening = requestOlder(s.query());
  // One request at a time per window: the wider read is not sent beside the one in flight.
  expect(s.requests).toHaveLength(2);
  s.holdAnswers(false);
  s.pending.shift()!.answer();
  await widening;
  await settled(s);
  expect(s.modes()).toEqual(['latest', 'since', 'older']);
  expect(s.ids()).toEqual(numbers(42, 201).reverse());
});

test('read again past the window size, its oldest edge comes up and it stays continuous', async () => {
  const s = await screen(numbers(1, 80).map(n => event(n)));
  s.change(events => events.push(...numbers(81, 100).map(n => event(n))));
  await eventually(() => expect(s.ids()).toEqual(numbers(21, 100).reverse()));
  expect(s.requests.at(-1)!.get('keep')).toBe('80');
  expect(s.held().pages[0]!.nextBefore).toBe(historyCursor(event(21)));
});

test('a protected window of 640 is kept whole when read again', async () => {
  const s = await screen(numbers(1, 640).map(n => event(n)));
  await widen(s, 7);
  holdHistory(s.query(), () => ({ kind: 'all' }));
  s.change(events => { events[0] = event(1, 'renamed'); });
  await eventually(() => expect(s.held().pages[0]!.events.at(-1)!.title).toBe('renamed'));
  expect(s.ids()).toEqual(numbers(1, 640).reverse());
});

test('a protected range past the limit is refused: the window stays, and moving to the latest reads the newest', async () => {
  const s = await screen(numbers(1, HISTORY_WINDOW_MAX).map(n => event(n)));
  await widen(s, HISTORY_WINDOW_MAX / 80 - 1);
  expect(s.ids()).toHaveLength(HISTORY_WINDOW_MAX);
  holdHistory(s.query(), () => ({ kind: 'through', cursor: historyCursor(event(1)) }));
  s.change(events => events.push(event(HISTORY_WINDOW_MAX + 1)));
  await eventually(() => expect((s.query().state.error as { reason?: { kind: string } } | null)?.reason?.kind).toBe('history_window_too_large'));
  expect(s.ids()).toEqual(numbers(1, HISTORY_WINDOW_MAX).reverse());
  expect(s.current()).not.toBe('current');
  moveHistoryToLatest(s.client, '/fixture', 'T1');
  await eventually(() => expect(s.ids()).toEqual(numbers(HISTORY_WINDOW_MAX - 78, HISTORY_WINDOW_MAX + 1).reverse()));
  expect(s.modes().at(-1)).toBe('latest');
});

test('a closed History goes back to its newest 80 events', async () => {
  const s = await screen(numbers(1, 640).map(n => event(n)));
  await widen(s, 7);
  s.close();
  await eventually(() => expect(s.ids()).toEqual(numbers(561, 640).reverse()));
  expect(s.held().pages[0]!.nextBefore).toBe(historyCursor(event(561)));
});

test('a failed read again keeps the window it had', async () => {
  const s = await screen(numbers(1, 10).map(n => event(n)));
  s.holdAnswers(true);
  s.change(events => events.push(event(11)));
  await eventually(() => expect(s.pending).toHaveLength(1));
  s.pending.shift()!.fail();
  await settled(s);
  expect(s.ids()).toEqual(numbers(1, 10).reverse());
  expect(s.current()).not.toBe('current');
});

test("a change reads again only that Task's History, in the screen the list told", async () => {
  const s = await screen(numbers(1, 5).map(n => event(n)));
  // Another Task's History open in the same screen, and the same Task's in another screen.
  const other = new QueryObserver(s.client, resources.history('/fixture', 'T2'));
  onTestFinished(other.subscribe(() => {}));
  const elsewhere = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(elsewhere); observeReadProofs(elsewhere);
  receiveFullIndex(elsewhere, indexOf(tree({ tasks: [dto({ id: 'T1' })] })));
  onTestFinished(new QueryObserver(elsewhere, resources.history('/fixture', 'T1')).subscribe(() => {}));
  await eventually(() => expect(s.requests).toHaveLength(3));
  await settled(s);
  s.change(events => events.push(event(6)));
  await eventually(() => expect(s.ids()).toEqual(numbers(1, 6).reverse()));
  await settled(s);
  expect(s.requests.slice(3).map(query => query.get('task'))).toEqual(['T1']);
});

test('a History let go while its read is under way is not brought back by the late answer', async () => {
  const s = await screen(numbers(1, 5).map(n => event(n)));
  s.holdAnswers(true);
  s.change(events => events.push(event(6)));
  await eventually(() => expect(s.pending).toHaveLength(1));
  s.close();
  s.client.removeQueries({ queryKey: ['task-history', '/fixture', 'T1'], exact: true });
  s.pending.shift()!.answer();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(s.client.getQueryCache().find({ queryKey: ['task-history', '/fixture', 'T1'] })).toBeUndefined();
});

test('a late answer for a History let go does not overwrite the read of it opened again', async () => {
  const s = await screen(numbers(1, 5).map(n => event(n)));
  s.holdAnswers(true);
  s.change(events => events.push(event(6)));
  await eventually(() => expect(s.pending).toHaveLength(1));
  const late = s.pending.shift()!;
  s.close();
  s.client.removeQueries({ queryKey: ['task-history', '/fixture', 'T1'], exact: true });
  // Opened again after it was let go: a new read, of what the server holds now.
  s.change(events => events.push(event(7)));
  const reopened = new QueryObserver(s.client, resources.history('/fixture', 'T1'));
  onTestFinished(reopened.subscribe(() => {}));
  await eventually(() => expect(s.pending).toHaveLength(1));
  s.pending.shift()!.answer();
  await eventually(() => expect(s.ids()).toEqual(numbers(1, 7).reverse()));
  late.answer();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(s.ids()).toEqual(numbers(1, 7).reverse());
  expect(s.current()).toBe('current');
});

test('a failed wider read keeps where the window ends, and asking again widens from there', async () => {
  const s = await screen(numbers(1, 200).map(n => event(n)));
  const edge = s.held().pages[0]!.nextBefore;
  s.holdAnswers(true);
  const failing = requestOlder(s.query());
  await eventually(() => expect(s.pending).toHaveLength(1));
  s.pending.shift()!.fail();
  await failing; await settled(s);
  expect(s.ids()).toEqual(numbers(121, 200).reverse());
  expect(s.held().pages[0]!.nextBefore).toBe(edge);
  s.holdAnswers(false);
  await widen(s, 1);
  expect(s.requests.at(-1)!.get('before')).toBe(edge);
  expect(s.ids()).toEqual(numbers(41, 200).reverse());
});

test('when nothing is left from the held oldest event on, the window starts again from the newest events', async () => {
  const s = await screen(numbers(1, 100).map(n => event(n)));
  expect(s.ids()).toEqual(numbers(21, 100).reverse());
  // Every held event is gone; older ones remain.
  s.change(events => { events.splice(20); });
  await eventually(() => expect(s.ids()).toEqual(numbers(1, 20).reverse()));
  expect(s.modes().slice(-2)).toEqual(['since', 'latest']);
  expect(s.held().pages[0]!.nextBefore).toBeNull();
});
