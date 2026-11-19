/** The receipt boundary. Assertions describe API
 * truth, visible documents and send admission, never an internal receipt type.
 */
import { afterEach, beforeEach, expect, test, vi, type MockInstance } from 'vitest';
import { dehydrate, hydrate, QueryClient } from '@tanstack/react-query';
import { projectedIndexSchema, taskWriteResultSchema, type ProjectedIndexDTO, type TaskProjectedViewDTO } from '@alpacawork/contract/control';
import { queryClient as client } from '../src/data/query-client';
import { canSendWrites, detailWriteBasis, rowWriteBasis, useConnection, workspaceWriteBasis } from '../src/data/connection';
import { requireWriteAccess } from '../src/data/client';
import { checkDirectIntent, sendDirectIntent } from '../src/data/direct-write';
import { intentKey, useWriteIntentStore } from '../src/data/write-intent';
import { serverReadFacts, READ_TASK_AGE } from '../src/data/read-model';
import { observeReadRefusals, receivePatch, receiveFullIndex, resources, showWrittenTask } from '../src/data/resources';
import { readerTask } from '../src/data/queries';
import { writeTask } from '../src/data/task-write';
import { headOf, dto, indexOf, rowOf, tree } from './fixtures';
import { jsonAnswer, serverPatch, serverView } from './receipt-fixture';
import { receiptHttp } from './receipt-http';

beforeEach(() => {
  client.clear();
  useConnection.setState({ state: 'live', offline: false, fresh: false, writable: false });
});
let http: Awaited<ReturnType<typeof receiptHttp>> | undefined;
afterEach(async () => { client.clear(); vi.useRealTimers(); vi.restoreAllMocks(); await http?.close(); http = undefined; });
const posts = (fetcher: MockInstance<typeof fetch>) =>
  fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
const strictIndex = () => projectedIndexSchema.parse(client.getQueryData(['index']));

for (const answer of ['success', '503', '403', 'disconnect'] as const)
for (const sse of ['before', 'after', 'none'] as const)
test(`POST committed; delayed GET ${answer}; SSE ${sse}: success stays confirmed, unrelated writes survive, no automatic POST replay`, async () => {
  const value = tree({ tasks: [dto(), dto({ id: 'T2', title: 'Other task' })] });
  const index = indexOf(value); receiveFullIndex(client, index);
  const other = rowWriteBasis('T2'); expect(canSendWrites(other)).toBe(true);
  const committed = dto({ id: 'T9', parentId: 'T1', title: 'Created', body: 'Committed body', version: 2, hash: 'e'.repeat(64) });
  const served = tree({ tasks: [...value.tasks, committed] });
  const view = serverView(served, committed.id);
  const row = { ...rowOf(committed, served), movedAt: 1_800_000_000_456 };
  let release!: (response: Response) => void, reject!: (error: Error) => void;
  const gate = new Promise<Response>((resolve, fail) => { release = resolve; reject = fail; });
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (init?.method === 'POST') return jsonAnswer({ task: headOf(committed) });
    if (String(url).startsWith('/api/task/view?')) return gate;
    throw Error(`Unexpected request ${url}`);
  });
  observeReadRefusals(client);
  const key = intentKey(index.root, 'create', 'T1');
  let ended = false;
  const outcome = sendDirectIntent(client, key, { path: 'task/new', response: 'task', label: 'Created' },
    () => ({ parent: 'T1', title: 'Created', expectedParentHash: value.tasks[0]!.hash }), workspaceWriteBasis())
    .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
    .finally(() => { ended = true; });
  await vi.waitFor(() => expect(ended || fetcher.mock.calls.some(([, init]) => init?.method === 'GET')).toBe(true));
  expect(posts(fetcher)).toHaveLength(1);
  // Before delivering GET/SSE, examine the actual cache. Soft checks keep all
  // observations visible.
  expect.soft(projectedIndexSchema.safeParse(client.getQueryData(['index'])).success).toBe(true);
  expect.soft(serverReadFacts(client)?.tasks.find(row => row.id === 'T2')?.title).toBe('Other task');
  expect.soft(canSendWrites(other)).toBe(true);
  expect.soft(canSendWrites(detailWriteBasis('T9', committed.hash))).toBe(false);
  // The ordinary Reader load shares any in-flight product GET. A receipt
  // implementation is free to arrange that GET without a second transport.
  const read = client.fetchQuery({ ...resources.taskView(index.root, 'T9'), staleTime: 0 }).catch(() => undefined);
  if (sse === 'before') receivePatch(client, serverPatch(client.getQueryData<ProjectedIndexDTO>(['index'])!, [row]));
  if (answer === 'disconnect') reject(new TypeError('Connection closed after POST committed'));
  else release(answer === 'success' ? jsonAnswer(view) : new Response('', { status: Number(answer) }));
  const result = await outcome; await read;
  expect.soft(result.error).toBeUndefined();
  expect.soft(result.value?.task).toMatchObject({ id: 'T9', values: committed.values, version: 2 });
  expect.soft(useWriteIntentStore.getState().entries[key]?.status).toBe('confirmed');
  expect.soft(posts(fetcher)).toHaveLength(1);
  if (sse === 'after') receivePatch(client, serverPatch(client.getQueryData<ProjectedIndexDTO>(['index'])!, [row]));
  expect.soft(projectedIndexSchema.safeParse(client.getQueryData(['index'])).success).toBe(true);
  expect.soft(canSendWrites(other)).toBe(true);
  if (answer === 'success') {
    expect.soft(client.getQueryData<TaskProjectedViewDTO>(resources.taskView(index.root, 'T9').queryKey)?.task)
      .toMatchObject({ values: committed.values, version: 2 });
    // The view carries no list numbers: its order (movedAt) arrives with the list's row.
    expect.soft(readerTask(client, index.root, 'T9')).toMatchObject({ title: committed.title, version: 2, ...(sse === 'none' ? {} : { movedAt: row.movedAt }) });
  } else {
    expect.soft(canSendWrites(detailWriteBasis('T9', committed.hash))).toBe(false);
    if (sse === 'none') expect.soft(canSendWrites(rowWriteBasis('T9', committed.hash))).toBe(false);
  }
  // Confirmed POSTs have no outstanding operation to check. A read failure
  // cannot create an operation replay, even on an explicit check command.
  await checkDirectIntent(client, key).catch(() => undefined);
  expect.soft(posts(fetcher)).toHaveLength(1);
  const restored = new QueryClient();
  try {
    hydrate(restored, JSON.parse(JSON.stringify(dehydrate(client))));
    expect.soft(projectedIndexSchema.safeParse(restored.getQueryData(['index'])).success).toBe(true);
  } finally { restored.clear(); }
});

test.each(['root', 'generation'] as const)('scope %s changes after POST starts: committed outcome stays successful and cannot contaminate the new scope', async kind => {
  const index = indexOf(tree()); receiveFullIndex(client, index);
  const basis = workspaceWriteBasis(), committed = dto({ id: 'T9', parentId: 'T1', version: 2 });
  let deliver!: (response: Response) => void;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => init?.method === 'POST'
    ? new Promise(resolve => { deliver = resolve; }) : Promise.resolve(new Response('', { status: 503 })));
  const pending = writeTask(client, 'task/new', { title: 'Created' }, taskWriteResultSchema, 'scope-receipt', basis);
  receiveFullIndex(client, { ...index, ...(kind === 'root' ? { root: '/other' } : { generation: 'other' }) });
  deliver(jsonAnswer({ task: headOf(committed) }));
  await expect(pending).resolves.toMatchObject({ task: { id: 'T9', version: 2 } });
  const now = strictIndex();
  expect(now.tasks.some(row => row.id === 'T9')).toBe(false);
  expect(client.getQueryData(resources.taskView(now.root, 'T9').queryKey)).toBeUndefined();
  expect(canSendWrites(basis)).toBe(false);
  expect(() => requireWriteAccess(basis)).toThrow();
  expect(posts(fetcher)).toHaveLength(1);
});

test.each(['root', 'generation'] as const)('scope %s changes during the additional GET: its old response cannot revoke POST success or enter the new scope', async kind => {
  const value = tree(), index = indexOf(value); receiveFullIndex(client, index);
  const committed = dto({ id: 'T9', parentId: 'T1', version: 2 });
  let release!: (response: Response) => void;
  const gate = new Promise<Response>(resolve => { release = resolve; });
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
    init?.method === 'POST' ? jsonAnswer({ task: headOf(committed) }) : gate);
  let ended = false;
  const outcome = writeTask(client, 'task/new', { title: 'Created' }, taskWriteResultSchema, 'get-scope-receipt', workspaceWriteBasis())
    .then(value => ({ value, error: undefined }), error => ({ value: undefined, error })).finally(() => { ended = true; });
  await vi.waitFor(() => expect(ended || fetcher.mock.calls.some(([, init]) => init?.method === 'GET')).toBe(true));
  const read = client.fetchQuery(resources.taskView(index.root, 'T9')).catch(() => undefined);
  receiveFullIndex(client, { ...index, ...(kind === 'root' ? { root: '/other' } : { generation: 'other' }) });
  release(jsonAnswer(serverView(tree({ tasks: [...value.tasks, committed] }), 'T9')));
  const result = await outcome; await read;
  expect(result.error).toBeUndefined();
  expect(result.value?.task.id).toBe('T9');
  const now = strictIndex();
  expect(now.tasks.some(row => row.id === 'T9')).toBe(false);
  expect(serverReadFacts(client)?.tasks.some(row => row.id === 'T9')).toBe(false);
  expect(posts(fetcher)).toHaveLength(1);
});

test.each(['live', 'closed', 'shelved'] as const)('a known %s document keeps its committed body after a temporary GET failure without acquiring full-detail write authority', async kind => {
  const old = dto({ body: 'Held body', state: kind === 'closed' ? 'done' : 'doing', lifecycle: kind === 'shelved' ? 'archived' : 'active' });
  const value = tree({ tasks: [old, dto({ id: 'T2', title: 'Other task' })] });
  const all = indexOf(value), index = { ...all, tasks: all.tasks.filter(row => row.id !== old.id || kind === 'live') };
  receiveFullIndex(client, index);
  const options = resources.taskView(index.root, old.id);
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonAnswer(serverView(value, old.id)));
  await client.fetchQuery(options);
  const committed = { ...old, values: { notes: 'Committed body' }, version: 2, hash: 'e'.repeat(64) };
  fetcher.mockImplementation(async () => new Response('', { status: 503 }));
  await showWrittenTask(client, headOf(committed), index);
  await client.fetchQuery({ ...options, staleTime: 0 }).catch(() => undefined);
  strictIndex();
  expect(client.getQueryData<TaskProjectedViewDTO>(options.queryKey)?.task).toMatchObject({ values: committed.values, version: 2 });
  expect(readerTask(client, index.root, old.id)).toMatchObject({ hash: committed.hash, version: 2 });
  expect(canSendWrites(detailWriteBasis(old.id, committed.hash))).toBe(false);
  expect(() => requireWriteAccess(rowWriteBasis('T2'))).not.toThrow();
});

test.each(['held', 'removed', 'expired', 'restored'] as const)('receipt minimum version survives %s: old GET cannot certify a new edit', async lifetime => {
  if (lifetime === 'expired') vi.useFakeTimers();
  const old = dto({ state: 'done', title: 'Old', body: 'Old body' });
  const value = tree({ tasks: [old, dto({ id: 'T2' })] });
  const index = { ...indexOf(value), tasks: indexOf(value).tasks.filter(row => row.id !== old.id) };
  receiveFullIndex(client, index);
  let served = serverView(value, old.id);
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonAnswer(served));
  const options = resources.taskView(index.root, old.id);
  await client.fetchQuery(options);
  expect(canSendWrites(detailWriteBasis(old.id, old.hash))).toBe(true);
  // A closed receipt avoids any live-row insertion, isolating floor retention
  // from the independent original new/reopen invalid-index defect.
  const committed = { ...old, values: { notes: 'Committed body' }, version: 2, hash: 'e'.repeat(64) };
  await showWrittenTask(client, headOf(committed), index);
  expect.soft(client.getQueryData<TaskProjectedViewDTO>(options.queryKey)?.task).toMatchObject({ values: committed.values, version: 2 });
  if (lifetime === 'removed') client.removeQueries({ queryKey: options.queryKey, exact: true });
  if (lifetime === 'expired') {
    await vi.advanceTimersByTimeAsync(READ_TASK_AGE + 1);
    expect(client.getQueryData(options.queryKey)).toBeUndefined(); vi.useRealTimers();
  }
  if (lifetime === 'restored') {
    const saved = JSON.parse(JSON.stringify(dehydrate(client)));
    client.clear(); hydrate(client, saved); receiveFullIndex(client, index);
  }
  if (lifetime === 'removed' || lifetime === 'expired') {
    // Task-only recovery is the preserved original oracle in the evidence.
    // After losing unique evidence, the selected plan requires a full live GET
    // started after the cut, then a newly started Task GET. Return both as HTTP,
    // and count resources.index()'s actual request rather than installing data.
    http = await receiptHttp(url => {
      if (url.pathname === '/api/workspace/live') return index;
      if (url.pathname === '/api/task/view' && url.searchParams.get('task') === old.id) return served;
      throw Error(`Unexpected receipt request ${url}`);
    });
    fetcher.mockImplementation(http.fetch);
  }
  await client.fetchQuery({ ...options, staleTime: 0 }).catch(() => undefined);
  expect.soft(canSendWrites(detailWriteBasis(old.id, old.hash))).toBe(false);
  expect.soft(canSendWrites(rowWriteBasis(old.id, old.hash))).toBe(false);
  expect.soft(serverReadFacts(client)?.tasks.find(row => row.id === old.id)?.version).not.toBe(1);
  // A real current server GET restores eligibility; disabling all reads fails.
  served = serverView(tree({ tasks: [committed, dto({ id: 'T2' })] }), old.id);
  if (http) {
    expect(http.requests.map(request => request.path)).toEqual([`/api/task/view?task=${old.id}`]);
    await client.fetchQuery({ ...resources.index(), staleTime: 0 });
    expect(http.requests.at(-1)?.path).toBe('/api/workspace/live');
    expect(http.requests.filter(request => request.path === '/api/workspace/live')).toHaveLength(1);
  }
  await client.fetchQuery({ ...options, staleTime: 0 });
  expect(canSendWrites(detailWriteBasis(old.id, committed.hash))).toBe(true);
  if (http) {
    expect(http.requests).toEqual([
      { method: 'GET', path: `/api/task/view?task=${old.id}`, status: 200 },
      { method: 'GET', path: '/api/workspace/live', status: 200 },
      { method: 'GET', path: `/api/task/view?task=${old.id}`, status: 200 },
    ]);
  }
  expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  strictIndex();
});

test.each(['before-cut', 'before-anchor'] as const)('a Task flight started %s cannot acquire authority from a later complete live GET', async timing => {
  const old = dto({ state: 'done', title: 'Closed document' });
  const other = dto({ id: 'T2', state: 'done', body: 'Known other body' });
  const value = tree({ tasks: [old, other] });
  const index = { ...indexOf(value), tasks: indexOf(value).tasks.filter(row => ![old.id, other.id].includes(row.id)) };
  receiveFullIndex(client, index);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  let delayed = false;
  http = await receiptHttp(async url => {
    if (url.pathname === '/api/workspace/live') return index;
    if (url.pathname === '/api/task/view' && url.searchParams.get('task') === other.id) {
      if (delayed) { entered(); await gate; }
      return serverView(value, other.id);
    }
    if (url.pathname === '/api/task/view' && url.searchParams.get('task') === old.id) return serverView(value, old.id);
    throw Error(`Unexpected request ${url}`);
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(http.fetch);
  const options = resources.taskView(index.root, other.id);
  await client.fetchQuery(options);
  await client.fetchQuery(resources.taskView(index.root, old.id));
  expect(canSendWrites(detailWriteBasis(other.id, other.hash))).toBe(true);
  await showWrittenTask(client, headOf({ ...old, values: { notes: 'Unique committed body' }, version: 2, hash: 'e'.repeat(64) }), index);
  delayed = true;
  let pending: Promise<unknown> | undefined;
  const flight = async () => { pending = client.fetchQuery({ ...options, staleTime: 0 }); await reached; };
  try {
    if (timing === 'before-cut') await flight();
    client.removeQueries({ queryKey: resources.taskView(index.root, old.id).queryKey, exact: true });
    if (timing === 'before-anchor') await flight();
    expect.soft(canSendWrites(detailWriteBasis(other.id, other.hash)), 'cut must remove old authority').toBe(false);
    await client.fetchQuery({ ...resources.index(), staleTime: 0 });
    release(); await pending;
    expect.soft(canSendWrites(detailWriteBasis(other.id, other.hash)), 'later anchor cannot bless a previous flight').toBe(false);
    delayed = false;
    await client.fetchQuery({ ...options, staleTime: 0 });
    expect(canSendWrites(detailWriteBasis(other.id, other.hash)), 'new flight after anchor is the positive control').toBe(true);
    expect(http.requests.filter(request => request.path === '/api/workspace/live')).toHaveLength(1);
    expect(http.requests.every(request => request.method === 'GET' && request.status === 200)).toBe(true);
    strictIndex();
  } finally { release(); await pending?.catch(() => undefined); }
});

test('the HTTP recovery oracle rejects a Task-only answer at workspace/live, then accepts a complete live GET and necessary Task GET', async () => {
  const task = dto({ state: 'done', body: 'Known closed body' });
  const value = tree({ tasks: [task] });
  const index = { ...indexOf(value), tasks: indexOf(value).tasks.filter(row => row.id !== task.id) };
  receiveFullIndex(client, index);
  let taskOnly = true;
  http = await receiptHttp(url => {
    if (url.pathname === '/api/workspace/live') return taskOnly ? serverView(value, task.id) : index;
    if (url.pathname === '/api/task/view' && url.searchParams.get('task') === task.id) return serverView(value, task.id);
    throw Error(`Unexpected request ${url}`);
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(http.fetch);
  const before = client.getQueryData(['index']);
  await expect(client.fetchQuery({ ...resources.index(), staleTime: 0 })).rejects.toThrow();
  expect(client.getQueryData(['index'])).toBe(before);
  taskOnly = false;
  await client.fetchQuery({ ...resources.index(), staleTime: 0 });
  await client.fetchQuery(resources.taskView(index.root, task.id));
  expect(canSendWrites(detailWriteBasis(task.id, task.hash))).toBe(true);
  expect(http.requests.map(request => request.path)).toEqual(['/api/workspace/live', '/api/workspace/live', `/api/task/view?task=${task.id}`]);
  strictIndex();
});

test('explicit confirmation keeps its original opId and payload; a subsequent edit gets a new operation', async () => {
  const old = dto(), index = indexOf(tree()); receiveFullIndex(client, index);
  const committed = { ...old, title: 'Committed', version: 2, hash: 'e'.repeat(64) };
  let lost = true;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if (init?.method !== 'POST') return jsonAnswer(serverView(tree({ tasks: [committed] }), old.id));
    if (lost) { lost = false; throw TypeError('POST response lost'); }
    return jsonAnswer({ task: headOf(committed) });
  });
  const key = intentKey(index.root, 'title', old.id), recovery = { path: 'task/edit', response: 'task' as const, label: old.id };
  await expect(sendDirectIntent(client, key, recovery, () => ({ task: old.id, title: 'Committed', expectedTaskHash: old.hash }), rowWriteBasis(old.id)))
    .rejects.toMatchObject({ retry: 'check' });
  await expect(sendDirectIntent(client, key, recovery, () => ({ task: old.id, title: 'New unsent text' }), rowWriteBasis(old.id)))
    .rejects.toThrow();
  expect(posts(fetcher)).toHaveLength(1);
  await checkDirectIntent(client, key);
  const sent = posts(fetcher);
  expect(sent).toHaveLength(2);
  expect(sent[1]![1]!.body).toBe(sent[0]![1]!.body);
  expect(sent[1]![1]!.headers).toEqual(sent[0]![1]!.headers);
  expect(useWriteIntentStore.getState().entries[key]?.status).toBe('confirmed');
  receivePatch(client, serverPatch(client.getQueryData<ProjectedIndexDTO>(['index'])!, [rowOf(committed, tree({ tasks: [committed] }))]));
  await sendDirectIntent(client, key, recovery, () => ({ task: old.id, title: 'New unsent text', expectedTaskHash: committed.hash }), rowWriteBasis(old.id, committed.hash));
  const next = posts(fetcher)[2]![1]!;
  expect(new Headers(next.headers).get('X-Alpacawork-Op-Id')).not.toBe(new Headers(sent[0]![1]!.headers).get('X-Alpacawork-Op-Id'));
  expect(JSON.parse(String(next.body)).title).toBe('New unsent text');
});
