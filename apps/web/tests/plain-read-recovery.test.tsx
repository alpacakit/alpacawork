import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { QueryObserver } from '@tanstack/react-query';
import { queryClient as client } from '../src/data/query-client';
import { receiveFullIndex, recoverReads, resources } from '../src/data/resources';
import { readQuery } from '../src/data/read-model';
import { readDemandPending, readRecoveryPending } from '../src/data/read-demand';
import { useConnection } from '../src/data/connection';
import { indexOf, tree } from './fixtures';

const index = () => indexOf(tree());
const bytes = () => resources.fileBytes(index().root, 'T1', 'sjis.csv', 'rev1');
const text = () => resources.fileText(index().root, 'T1', 'notes.txt', 'rev1');
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: (value: T) => resolve(value) };
};
beforeEach(() => {
  client.clear();
  useConnection.setState({ state: 'live', offline: false });
  receiveFullIndex(client, index());
});
afterEach(() => { client.clear(); vi.restoreAllMocks(); });

// A file can finish before the connection's delayed "live" notification. It has
// a revision key, not an index proof; recovery must not create an unpayable demand.
test.each(['bytes', 'text'] as const)('reconnecting after a %s file loads keeps its single acquisition', async kind => {
  const later = deferred<Response>();
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('a,b\n1,2\n')).mockReturnValue(later.promise);
  const observer = kind === 'bytes' ? new QueryObserver(client, bytes()) : new QueryObserver(client, text());
  const stop = observer.subscribe(() => {});
  try {
    await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
    const held = observer.getCurrentResult().data;
    const recovery = recoverReads(client);
    // This queued continuation follows recovery's anchor check even if a buggy
    // implementation has started a second, held request.
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await recovery;
    expect(observer.getCurrentResult().data).toBe(held);
    const query = readQuery(client, kind === 'bytes' ? bytes().queryKey : text().queryKey)!;
    expect(readDemandPending(query)).toBe(false);
    expect(readRecoveryPending(query)).toBe(false);
  } finally { stop(); observer.destroy(); later.resolve(new Response('a,b\n1,2\n')); }
});

test('reconnecting during a file acquisition joins it without leaving a demand behind', async () => {
  const options = bytes(), first = deferred<Response>();
  const fetcher = vi.spyOn(globalThis, 'fetch').mockReturnValue(first.promise);
  const observer = new QueryObserver(client, options), stop = observer.subscribe(() => {});
  try {
    const recovery = recoverReads(client);
    await Promise.resolve();
    first.resolve(new Response('a,b\n1,2\n'));
    await recovery;
    await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
    expect(fetcher).toHaveBeenCalledTimes(1);
    const query = readQuery(client, options.queryKey)!;
    expect(readDemandPending(query)).toBe(false);
    expect(readRecoveryPending(query)).toBe(false);
  } finally { stop(); observer.destroy(); first.resolve(new Response('a,b\n1,2\n')); }
});

test.each(['failed', 'invalidated'] as const)('reconnecting recovers a %s file exactly once', async state => {
  const options = bytes();
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('a,b\n1,2\n', { status: state === 'failed' ? 503 : 200 }))
    .mockResolvedValueOnce(new Response('a,b\n3,4\n'));
  const observer = new QueryObserver(client, options), stop = observer.subscribe(() => {});
  try {
    await vi.waitFor(() => expect(observer.getCurrentResult().status).toBe(state === 'failed' ? 'error' : 'success'));
    if (state === 'invalidated') await client.invalidateQueries({ queryKey: options.queryKey, refetchType: 'none' });
    await recoverReads(client);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(new TextDecoder().decode(observer.getCurrentResult().data as Uint8Array)).toBe('a,b\n3,4\n');
    await recoverReads(client);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const query = readQuery(client, options.queryKey)!;
    expect(readDemandPending(query)).toBe(false);
    expect(readRecoveryPending(query)).toBe(false);
  } finally { stop(); observer.destroy(); }
});
