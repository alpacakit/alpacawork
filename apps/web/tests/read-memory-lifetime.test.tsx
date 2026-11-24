import { afterEach, expect, test, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { observeReadProofs, READ_BUNDLE_AGE, READ_MAX_BYTES } from '../src/data/read-model';
import { startReadRetention } from '../src/data/read-retention';
import { restoreReadPersistence } from '../src/data/read-persistence';
import { api, resources } from '../src/data/resources';
import { searchAnswer } from './fixtures';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
for (const kind of ['search', 'axis'] as const) for (const dbUnavailable of [false, true]) test(`${kind} has one finite memory timer after release, independent of disk (${dbUnavailable})`, async () => {
  vi.useFakeTimers();
  if (dbUnavailable) vi.stubGlobal('indexedDB', { open() { throw new DOMException('Unavailable', 'UnknownError'); } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  observeReadProofs(client);
  if (dbUnavailable) await restoreReadPersistence(client);
  const options = kind === 'search' ? resources.taskSearch('/workspace', 'words', null) : resources.timelineAxis('/workspace', []);
  const lifetime = kind === 'search' ? 60_000 : READ_BUNDLE_AGE;
  const fetcher = vi.spyOn(api, 'request').mockResolvedValue(kind === 'search' ? searchAnswer([]) : { ranges: [], start: null, end: null });
  const observer = new QueryObserver(client, options as any);
  const stop = observer.subscribe(() => {});
  try {
    await vi.advanceTimersByTimeAsync(1);
    const query = client.getQueryCache().find({ queryKey: options.queryKey, exact: true })!;
    expect(query.gcTime).toBe(Infinity);
    await vi.advanceTimersByTimeAsync(lifetime + 1);
    expect(client.getQueryData(options.queryKey)).toBeDefined();
    stop(); observer.destroy();
    await vi.advanceTimersByTimeAsync(0);
    // TanStack has no GC timer; the existing retention controller owns the sole expiry.
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(lifetime - 1);
    expect(client.getQueryData(options.queryKey)).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { stop(); observer.destroy(); client.clear(); }
});

for (const kind of ['search', 'axis'] as const) test(`${kind} protects an inactive fetch until it settles`, async () => {
  vi.useFakeTimers();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); observeReadProofs(client);
  const options = kind === 'search' ? resources.taskSearch('/workspace', 'words', null) : resources.timelineAxis('/workspace', []);
  let release!: (value: unknown) => void;
  vi.spyOn(api, 'request').mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const fetch = client.fetchQuery(options as any);
  try {
    await vi.advanceTimersByTimeAsync(READ_BUNDLE_AGE);
    expect(client.getQueryCache().find({ queryKey: options.queryKey, exact: true })).toBeDefined();
    release(kind === 'search' ? searchAnswer([]) : { ranges: [], start: null, end: null }); await fetch;
    await vi.advanceTimersByTimeAsync((kind === 'search' ? 60_000 : READ_BUNDLE_AGE) - 1);
    expect(client.getQueryData(options.queryKey)).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
  } finally { client.clear(); }
});

test('memory retention sizes an active payload only after its protection is released', async () => {
  vi.useFakeTimers();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
  const key = ['task-search', '/workspace', 'large', null];
  const data = { body: 'x'.repeat(READ_MAX_BYTES) };
  client.setQueryData(key, data);
  const observer = new QueryObserver(client, { queryKey: key, queryFn: async () => data });
  const stop = observer.subscribe(() => {});
  const encode = vi.spyOn(TextEncoder.prototype, 'encode');
  startReadRetention(client);
  try {
    client.setQueryData(key, data);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getQueryData(key)).toBe(data);
    expect(encode).not.toHaveBeenCalled();
    stop(); observer.destroy();
    await vi.advanceTimersByTimeAsync(0);
    expect(encode).toHaveBeenCalled();
    expect(client.getQueryData(key)).toBeUndefined();
  } finally { stop(); observer.destroy(); client.clear(); }
});
