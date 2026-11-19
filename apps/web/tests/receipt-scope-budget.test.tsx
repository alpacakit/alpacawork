/** HTTP budget/admission and confirmed-POST failure boundary. Formal oracles. */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { queryClient as client } from '../src/data/query-client';
import { canSendWrites, detailWriteBasis, rowWriteBasis, useConnection, workspaceWriteBasis } from '../src/data/connection';
import { serverReadFacts, taskReadState } from '../src/data/read-model';
import { receiveFullIndex, resources, showWrittenTask } from '../src/data/resources';
import { sendDirectIntent, checkDirectIntent } from '../src/data/direct-write';
import { intentKey, useWriteIntentStore } from '../src/data/write-intent';
import { headOf, dto, indexOf, tree } from './fixtures';
import { jsonAnswer, serverView } from './receipt-fixture';
import { receiptHttp } from './receipt-http';
let http: Awaited<ReturnType<typeof receiptHttp>> | undefined;
beforeEach(() => { client.clear(); useConnection.setState({ state: 'live', offline: false, fresh: false, writable: false }); });
afterEach(async () => { client.clear(); vi.restoreAllMocks(); await http?.close(); http = undefined; });

test('same-version ordinary Task remove has zero extra HTTP and keeps server-row authority plus B body', async () => {
  const a = dto(), b = dto({ id: 'T2', body: 'B acquired' }), value = tree({ tasks: [a, b] }), index = indexOf(value);
  receiveFullIndex(client, index);
  http = await receiptHttp(url => serverView(value, url.searchParams.get('task')!));
  vi.spyOn(globalThis, 'fetch').mockImplementation(http.fetch);
  await Promise.all([client.fetchQuery(resources.taskView(index.root, a.id)), client.fetchQuery(resources.taskView(index.root, b.id))]);
  const before = http.requests.length;
  client.removeQueries({ queryKey: resources.taskView(index.root, a.id).queryKey, exact: true });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(canSendWrites(rowWriteBasis(a.id, a.hash))).toBe(true);
  expect(taskReadState(client, index.root, b.id).view?.task.values?.notes).toBe(b.values?.notes);
  expect(http.requests.slice(before)).toEqual([]);
});

test('two unique-floor removals in one burst: retained B loses authority, one deduplicated full GET and one required Task GET recover; inactive HTTP zero', async () => {
  const a = dto({ state: 'done' }), b = dto({ id: 'T2', body: 'B acquired' }), c = dto({ id: 'T3', state: 'done' });
  const value = tree({ tasks: [a, b, c] }), index = indexOf(value); receiveFullIndex(client, index);
  http = await receiptHttp(url => url.pathname === '/api/workspace/live' ? { ...index, rev: index.rev + 1 }
    : serverView(value, url.searchParams.get('task')!));
  vi.spyOn(globalThis, 'fetch').mockImplementation(http.fetch);
  await Promise.all([a, b, c].map(t => client.fetchQuery(resources.taskView(index.root, t.id))));
  for (const t of [a, c]) showWrittenTask(client, headOf({ ...t, version: 2, hash: 'e'.repeat(64), values: { notes: 'Unique v2' } }), index);
  const before = http.requests.length;
  for (const t of [a, c]) client.removeQueries({ queryKey: resources.taskView(index.root, t.id).queryKey, exact: true });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect.soft(taskReadState(client, index.root, b.id).view?.task.values?.notes).toBe(b.values?.notes);
  expect.soft(canSendWrites(rowWriteBasis(b.id, b.hash))).toBe(false);
  expect.soft(http.requests.slice(before)).toEqual([]); // inactive Task/page/settings reads are not retried.
  await Promise.all([0, 1].map(() => client.fetchQuery({ ...resources.index(), staleTime: 0 })));
  await Promise.all([0, 1].map(() => client.fetchQuery({ ...resources.taskView(index.root, b.id), staleTime: 0 })));
  expect.soft(canSendWrites(detailWriteBasis(b.id, b.hash))).toBe(true);
  expect.soft(serverReadFacts(client)?.tasks.find(t => t.id === b.id)?.hash).toBe(b.hash);
  expect.soft(http.requests.slice(before)).toEqual([
    { method: 'GET', path: '/api/workspace/live', status: 200 },
    { method: 'GET', path: '/api/task/view?task=T2', status: 200 },
  ]);
});

test('validated successful POST plus local cache-publication exception remains confirmed and explicit Check cannot resend', async () => {
  const value = tree(), index = indexOf(value); receiveFullIndex(client, index);
  const committed = dto({ id: 'T9', parentId: 'T1', title: 'Created', version: 2, hash: 'e'.repeat(64) });
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => init?.method === 'POST'
    ? jsonAnswer({ task: headOf(committed) }) : new Response('', { status: 503 }));
  let armed = true, injected = 0;
  const stop = client.getQueryCache().subscribe(event => {
    if (armed && event.type === 'updated' && event.action.type === 'success' && event.action.manual && event.query.queryKey[0] === 'task') {
      armed = false; injected++; throw Error('Injected local publication fault after validated POST');
    }
  });
  try {
    const key = intentKey(index.root, 'create', 'T1');
    const result = await sendDirectIntent(client, key, { path: 'task/new', response: 'task', label: 'Create' },
      () => ({ parent: 'T1', title: committed.title }), workspaceWriteBasis()).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    expect(injected).toBe(1);
    expect.soft(result.error).toBeUndefined();
    expect.soft(result.value?.task.id).toBe(committed.id);
    expect.soft(useWriteIntentStore.getState().entries[key]?.status).toBe('confirmed');
    await checkDirectIntent(client, key).catch(() => undefined);
    expect.soft(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  } finally { stop(); }
});
