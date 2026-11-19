import { requestOlder } from '../src/data/read-demand';
/** The page loader never returns Query's aggregate. A discarded flight leaves the held pages in their one Owner. */
import { afterEach, expect, test, vi } from 'vitest';
import { QueryObserver } from '@tanstack/react-query';
import { queryClient } from '../src/data/query-client';
import { resources, receiveFullIndex, assessRead } from '../src/data/resources';
import { cutReadScope, readScope } from '../src/data/read-model';
import { dto, historyFixture, indexOf, served0, tree } from './fixtures';

afterEach(() => { queryClient.clear(); vi.restoreAllMocks(); });
const answer = (value: unknown) => new Response(JSON.stringify(value));
import { historyCursor } from '@alpacawork/contract';
/** A History window answer: its events, its oldest key, and whether anything is older. */
const page = (ids: string[], hasOlder: boolean) => {
  // Newest first: each later ID a minute older.
  const events = historyFixture(ids.map((id, at) => ({ id, kind: 'report' as const, title: id, at: `2026-09-24T09:${String(30 - (id === 'past' ? 10 : at)).padStart(2, '0')}:00Z` })));
  return { ...served0, events, oldestKey: events.length ? historyCursor(events.at(-1)!) : null, hasOlder };
};

test.each(['full', 'next'] as const)('a %s History flight across a cut preserves the same aggregate, then an anchored GET recovers', async mode => {
  const index = indexOf(tree({ tasks: [dto()] }));
  receiveFullIndex(queryClient, index);
  // The newest window holds `known` and says more is older; below it is `past`. Read again from `past` on, both come.
  const first = page(['known'], true), past = page(['past'], false), both = page(['known', 'past'], false);
  const pastKey = historyCursor(past.events[0]!);
  let release!: (value: Response) => void;
  let delayed = false;
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    const path = String(url); calls.push(path);
    if (path.includes('workspace/live')) return answer(index);
    if (delayed) return new Promise(resolve => { release = resolve; });
    const query = new URL(path, 'http://x').searchParams;
    return answer(query.get('mode') === 'older' ? past : query.get('since') === pastKey ? both : first);
  });
  const options = resources.history(index.root, 'T1');
  await queryClient.fetchQuery(options);
  const observer = new QueryObserver(queryClient, options);
  const stop = observer.subscribe(() => {});
  try {
    if (mode === 'full') await requestOlder(observer.getCurrentQuery());
    const held = queryClient.getQueryData(options.queryKey);
    const query = queryClient.getQueryCache().find({ queryKey: options.queryKey, exact: true })!;
    delayed = true;
    const flight = mode === 'full' ? observer.refetch() : requestOlder(observer.getCurrentQuery());
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    cutReadScope(queryClient);
    // A later anchor cannot promote a pre-cut flight. The same-revision live GET is sufficient to anchor.
    await queryClient.fetchQuery({ ...resources.index(), staleTime: 0 });
    expect(readScope(queryClient)?.anchored).toBe(true);
    release(answer(page(['discarded'], false)));
    await flight;
    expect(queryClient.getQueryData(options.queryKey)).toBe(held);
    expect(assessRead(queryClient, query)).toMatchObject({ display: true, project: false });
    const count = calls.length;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls).toHaveLength(count); // Cancellation is terminal for this demand, never a retry loop.
    delayed = false;
    await observer.refetch();
    expect(observer.getCurrentResult().data?.pages[0]!.events.map(event => event.id)).toEqual(mode === 'full' ? ['known', 'past'] : ['known']);
    expect(assessRead(queryClient, query).project).toBe(true);
    expect(calls.filter(path => path.includes('workspace/live'))).toHaveLength(1);
  } finally { stop(); observer.destroy(); }
});
