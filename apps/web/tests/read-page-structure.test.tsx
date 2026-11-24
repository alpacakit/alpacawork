import { afterEach, expect, test, vi } from 'vitest';
import { InfiniteQueryObserver, QueryClient, type QueryKey } from '@tanstack/react-query';
import { z } from 'zod';
import { taskProjectedPageSchema as taskPageSchema, taskProjectedSearchSchema as taskSearchSchema, type TaskProjectedSearchDTO as SearchDTO } from '@alpacawork/contract/control';
import { captureReadProof, evaluateRead, observeReadProofs, readCodec, readNormalized, refuseRead } from '../src/data/read-model';
import { assessRead, receiveFullIndex, resources } from '../src/data/resources';
import { dto, indexOf, served0, tree } from './fixtures';

const clients: QueryClient[] = [];
afterEach(() => { clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); });
const page = (nextAfter: string | null = null): SearchDTO => ({
  rows: [], ancestors: [], lines: {}, total: 0, nextAfter, ...served0,
});
const bundle = <T,>(pages: T[], pageParams: (string | null)[] = [null]) => ({ pages, pageParams });
function fixture() {
  const index = indexOf(tree({ tasks: [dto({ id: 'T1' })] }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client); observeReadProofs(client); receiveFullIndex(client, index);
  const options = resources.taskSearch(index.root, 'words', null);
  const entry = (data: unknown, key: QueryKey = options.queryKey) => ({ key, data, proof: captureReadProof(index, key) });
  return { client, index, options, entry };
}

test('paged reads append through Query and check each immutable page once, on arrival, without revisiting older pages', async () => {
  const f = fixture(), total = 4;
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = new URL(String(input), 'http://fixture');
    expect(url.pathname).toBe('/api/task/search');
    const at = Number(url.searchParams.get('after') ?? 0);
    return new Response(JSON.stringify(page(at + 1 < total ? String(at + 1) : null)),
      { headers: { 'Content-Type': 'application/json' } });
  });
  const parse = vi.spyOn(taskSearchSchema, 'safeParse');
  // The transport uses schema.parse; count its traversal too, so bypassing the
  // optimized safeParse helper cannot make this a green test with zero checks.
  const traversal = vi.spyOn(taskSearchSchema._zod, 'run');
  const observer = new InfiniteQueryObserver(f.client, { ...f.options, enabled: false });
  const stop = observer.subscribe(() => {});
  try {
    for (let at = 0; at < total; at++) {
      const before = observer.getCurrentResult().data?.pages.slice() ?? [];
      await observer.fetchNextPage();
      const query = f.client.getQueryCache().find({ queryKey: f.options.queryKey, exact: true })!;
      expect(assessRead(f.client, query)).toMatchObject({ state: 'current', display: true });
      const acquired = observer.getCurrentResult().data!.pages;
      expect(acquired).toHaveLength(at + 1);
      before.forEach((old, position) => expect(acquired[position]).toBe(old));
      // The transport's check is the only one: drawing the page does not check it again.
      expect(traversal).toHaveBeenCalledTimes(at + 1);
      for (let seen = 0; seen <= at; seen++) {
        expect(traversal.mock.calls.filter(([payload]) =>
          (payload.value as SearchDTO).nextAfter === (seen + 1 < total ? String(seen + 1) : null))).toHaveLength(1);
      }
    }
    expect(parse).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(total);
    expect(observer.getCurrentResult().hasNextPage).toBe(false);
  } finally { stop(); observer.destroy(); }
});

test('a page read again with changes is checked once, on arrival, and not again when drawn', async () => {
  const f = fixture(), options = resources.finished(f.index.root, null);
  let total = 1;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify({ rows: [], total: total++, nextAfter: null, ...served0 }), { headers: { 'Content-Type': 'application/json' } }));
  const traversal = vi.spyOn(taskPageSchema._zod, 'run');
  const observer = new InfiniteQueryObserver(f.client, options);
  const stop = observer.subscribe(() => {});
  try {
    const query = () => f.client.getQueryCache().find({ queryKey: options.queryKey, exact: true })!;
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.pages[0]?.total).toBe(1));
    await observer.refetch();
    const acquired = observer.getCurrentResult().data!.pages[0]!;
    expect(acquired.total).toBe(2);
    expect(assessRead(f.client, query())).toMatchObject({ state: 'current', display: true });
    expect(traversal).toHaveBeenCalledTimes(2);
  } finally { stop(); observer.destroy(); }
});

test('new envelopes and changed pages still follow the full codec after a successful page proof', () => {
  const f = fixture(), shared = page();
  expect(evaluateRead(f.index, f.entry(bundle([shared]))).state).toBe('current');
  const variants: [string, unknown][] = [
    ['valid partial', bundle([shared, page('next')], [null, 'cursor'])],
    ['strict', { ...bundle([shared]), extra: true }],
    ['nonempty pages', bundle([], [])],
    ['nonempty params', bundle([shared], [])],
    ['same length', bundle([shared, shared])],
    ['first null', bundle([shared], ['cursor'])],
    ['unique cursors', bundle([shared, shared, shared], [null, 'cursor', 'cursor'])],
    ['param type', { pages: [shared, shared], pageParams: [null, 1] }],
    ['invalid middle page', bundle([shared, { ...page(), nextAfter: 1 }, shared], [null, 'a', 'b'])],
    ['strict page', bundle([shared, { ...page(), extra: true }], [null, 'a'])],
    ['changed page', bundle([{ ...shared, nextAfter: '' }])],
  ];
  const codec = readCodec(f.options.queryKey)!;
  for (const [name, data] of variants) {
    const expected = codec.safeParse(data).success;
    expect(evaluateRead(f.index, f.entry(data)).state !== 'invalid', name).toBe(expected);
  }
});

test.each(['finished', 'shelved'] as const)('a search page proof cannot certify the same object as %s data', kind => {
  const f = fixture(), shared = page();
  expect(evaluateRead(f.index, f.entry(bundle([shared]))).state).toBe('current');
  const key = kind === 'finished' ? resources.finished(f.index.root, null).queryKey : resources.shelved(f.index.root, null).queryKey;
  const parse = vi.spyOn(taskPageSchema, 'safeParse');
  expect(evaluateRead(f.index, f.entry(bundle([shared]), key)).state).toBe('invalid');
  expect(parse).toHaveBeenCalledTimes(1);
});

test('a History window is one continuous page: each new envelope is checked whole, and one of two pages is refused', () => {
  const f = fixture(), key = ['task-history', f.index.root, 'T1'];
  const shared = { events: [], nextBefore: null };
  const parse = vi.spyOn(readCodec(key)!, 'safeParse');
  expect(evaluateRead(f.index, f.entry(bundle([shared]), key)).state).toBe('current');
  expect(evaluateRead(f.index, f.entry(bundle([{ ...shared }]), key)).state).toBe('current');
  expect(evaluateRead(f.index, f.entry(bundle([shared, shared], [null, 'older']), key)).state).toBe('invalid');
  expect(parse).toHaveBeenCalledTimes(3);
});

test('hostile JSON cannot enter the memo through a shallow freeze or invoke an accessor', () => {
  const f = fixture(), getter = vi.fn(() => 'page');
  const accessor = page(); Object.defineProperty(accessor, 'nextAfter', { get: getter, enumerable: true });
  const sparse = page(); sparse.rows.length = 1;
  const inherited = Object.assign(Object.create({ custom: true }), page());
  const symbolic = Object.assign(page(), { [Symbol('hidden')]: true });
  const cyclic = { ...page(), cycle: null as unknown }; cyclic.cycle = cyclic;
  const parse = vi.spyOn(taskSearchSchema, 'safeParse');
  for (const hostile of [accessor, sparse, inherited, symbolic, cyclic, { ...page(), nonfinite: Infinity }]) {
    Object.freeze(hostile);
    expect(evaluateRead(f.index, f.entry(bundle([hostile]))).state).toBe('invalid');
  }
  expect(getter).not.toHaveBeenCalled();
  expect(parse).not.toHaveBeenCalled();
  const shallow = Object.freeze(page());
  expect(Object.isFrozen(shallow.rows)).toBe(false);
  expect(evaluateRead(f.index, f.entry(bundle([shallow]))).state).toBe('current');
  expect(Object.isFrozen(shallow.rows)).toBe(true);
  expect(parse).toHaveBeenCalledTimes(1);
});

test('cold page normalization parses once; proof hits still produce detached, freshly normalized outputs', () => {
  const f = fixture(), codec = readCodec(f.options.queryKey)!, parse = vi.spyOn(codec, 'safeParse');
  const data = bundle([page()]);
  const first = readNormalized(f.options.queryKey, data)!.data as typeof data;
  expect(parse).toHaveBeenCalledTimes(1);
  expect(first.pages[0]).not.toBe(data.pages[0]);
  (first.pages[0] as SearchDTO).nextAfter = 'mutated output';
  const second = readNormalized(f.options.queryKey, data)!.data as typeof data;
  expect(second).toEqual(data); expect(second.pages[0]).not.toBe(first.pages[0]);
  expect(parse).toHaveBeenCalledTimes(2);
  const inspected = bundle([page('inspected')]);
  expect(evaluateRead(f.index, f.entry(inspected)).state).toBe('current');
  const third = readNormalized(f.options.queryKey, inspected)!.data as typeof inspected;
  expect(third).toEqual(inspected); expect(third.pages[0]).not.toBe(inspected.pages[0]);
  expect(parse).toHaveBeenCalledTimes(3);
});

test.each(['transform', 'default', 'strip', 'order', 'null-prototype'] as const)('page proof never substitutes raw or cached output for %s normalization', mode => {
  const f = fixture(), data = bundle([page()]);
  const codec = readCodec(f.options.queryKey)!;
  // First take the optimized boolean path, then demand its actual codec output.
  expect(evaluateRead(f.index, f.entry(data)).state).toBe('current');
  const basePage = taskSearchSchema.clone();
  const element = mode === 'default' ? basePage.extend({ normalizedDefault: z.string().default('ACTUAL DEFAULT') })
    : mode === 'transform' ? basePage.transform(value => ({ ...value, nextAfter: 'TRANSFORMED' }))
      : mode === 'order' ? basePage.transform(({ nextAfter, ...rest }) => ({ nextAfter, ...rest }))
        : mode === 'strip' ? basePage.omit({ lines: true }).strip() : basePage;
  const normalizedCodec = z.object({ pages: z.array(element), pageParams: z.array(z.string().nullable()) });
  const expected = normalizedCodec.parse(data);
  const parse = vi.spyOn(codec, 'safeParse').mockImplementation(value => normalizedCodec.safeParse(value));
  const first = readNormalized(f.options.queryKey, data)!.data as typeof expected;
  first.pages[0]!.nextAfter = 'MUTATED OUTPUT';
  const second = readNormalized(f.options.queryKey, data)!.data as typeof expected;
  expect(second).toEqual(expected); expect(second.pages[0]).not.toBe(data.pages[0]); expect(second.pages[0]).not.toBe(first.pages[0]);
  expect(parse).toHaveBeenCalledTimes(2);
  if (mode === 'order') expect(Object.keys(second.pages[0]!)[0]).toBe('nextAfter');
  if (mode === 'null-prototype') {
    // A separately acquired null-prototype page gets the normal codec prototype.
    const raw = bundle([Object.assign(Object.create(null), page())]);
    const normalized = readNormalized(f.options.queryKey, raw)!.data as typeof expected;
    expect(Object.getPrototypeOf(normalized.pages[0])).toBe(Object.prototype);
  }
});

test('successful page proofs lend no root, generation, demand or refusal qualification', () => {
  const f = fixture(), data = bundle([page()]);
  expect(evaluateRead(f.index, f.entry(data)).state).toBe('current');
  expect(evaluateRead({ ...f.index, root: '/other' }, f.entry(bundle(data.pages))).state).toBe('invalid');
  expect(evaluateRead({ ...f.index, generation: 'other' }, f.entry(bundle(data.pages))).state).toBe('invalid');
  expect(evaluateRead(f.index, { ...f.entry(bundle(data.pages)), proof: undefined }).state).toBe('invalid');
  expect(evaluateRead(f.index, { ...f.entry(bundle(data.pages)), pending: true })).toMatchObject({ state: 'unverified', project: false });
  f.client.setQueryData(f.options.queryKey, data);
  const query = f.client.getQueryCache().find({ queryKey: f.options.queryKey, exact: true })!;
  refuseRead(query, f.index);
  expect(assessRead(f.client, query)).toMatchObject({ state: 'refused', display: false, project: false, persist: false });
});
