import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { QueryObserver, InfiniteQueryObserver } from '@tanstack/react-query';
import { queryClient as client } from '../src/data/query-client';
import { receiveFullIndex, receivePatch, resources, recoverReads, readState, shelvedReadDetail, showWrittenTask } from '../src/data/resources';
import { readIndex, readQuery, readEntry, evaluateRead, serverReadFacts, displayReadFacts, taskReadState, subscribeReads, readRefused, readCodec } from '../src/data/read-model';
import { bindWriteAccess, useConnection, rowWriteBasis, writeAccess, readWriteBasis } from '../src/data/connection';
import { requestRead, readRecoveryPending } from '../src/data/read-demand';
import { representedReadIds } from '../src/data/read-retention';
import { restoreReadScope } from '../src/data/read-model';
import { restoreCatalogProject } from '../src/features/archive/archive-operations';
import { indexTasks } from '../src/domain/tasks';
import { mapWorkspace } from '../src/data/map';
import { useUrlBootstrap } from '../src/state/bootstrap';
import { useTaskDetail } from '../src/data/queries';
import { useViewStore } from '../src/state/view-store';
import { AwaitedLookup } from '../src/features/reader/AwaitedLookup';
import { headOf, dto, tree, indexOf, PROJECT_TASK, screenData, TestWorkspace, baselines } from './fixtures';
import { serverView, serverPatch, serverPage, serverPageRow, jsonAnswer } from './receipt-fixture';
import type { ProjectedIndexDTO, ProjectShelfDTO } from '@alpacawork/contract/control';

const task = () => dto({ id: 'T9', path: 'tasks/T9', title: 'Newest body', body: 'Newest body', state: 'done' });
const source = () => tree({ tasks: [task()] });
const index = () => ({ ...indexOf(source()), tasks: indexOf(source()).tasks.filter(row => row.id !== 'T9') });
const shelf = (revision = 'b'.repeat(64)): ProjectShelfDTO => ({ revision, projects: [{ id: PROJECT_TASK, title: 'Project', color: '#39659b', parentId: null,
  lifecycle: 'archived', hash: 'c'.repeat(64), shelf: { listed: false, shelvedBy: [{ id: PROJECT_TASK, title: 'Project', color: '#39659b', hash: 'c'.repeat(64), lifecycle: 'archived' }],
    restoreTarget: { id: PROJECT_TASK, title: 'Project', color: '#39659b', hash: 'c'.repeat(64) } } }] });
const hidden = (base: ProjectedIndexDTO, version = 'b'.repeat(64)) => ({ ...base, rev: base.rev + 1, projectShelfVersion: version, projects: [], tasks: [], home: [] });
const refused = () => jsonAnswer({ error: { code: 'not_found', message: 'Archived project', retry: 'fix', reason: { kind: 'task_archived' },
  detail: { task: { id: 'T9', title: 'Newest body', kind: 'task', projectId: PROJECT_TASK, lifecycle: 'active' }, shelf: shelf().projects[0]!.shelf } } });
const refusedAnswer = () => new Response(refused().body, { status: 404, headers: { 'content-type': 'application/json' } });
const flush = async () => { await new Promise(resolve => setTimeout(resolve, 30)); };

beforeEach(() => { client.clear(); bindWriteAccess(client); useConnection.setState({ offline: false, state: 'live', writable: true, fresh: true });
  useViewStore.setState(useViewStore.getInitialState()); history.replaceState(null, '', '/'); });
afterEach(() => { cleanup(); client.clear(); vi.restoreAllMocks(); });

for (const concurrent of [false, true]) test(`R4: direct detail/hover/URL share one acquisition, concurrent=${concurrent}`, async () => {
  const data = screenData(tree({ tasks: [] }));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { await gate; return jsonAnswer(serverView(source(), 'T9')); });
  const hoverTask = mapWorkspace(indexOf(source()), baselines([])).tasks.find(row => row.id === 'T9');
  function Probe() {
    useTaskDetail(concurrent ? hoverTask : undefined);
    const facts = useSyncExternalStore(changed => subscribeReads(client, changed), () => serverReadFacts(client));
    useUrlBootstrap(indexTasks(mapWorkspace(facts!, baselines([])).tasks)); return null;
  }
  history.replaceState(null, '', '/?task=T9');
  let flight: Promise<unknown> | undefined;
  if (concurrent) flight = client.fetchQuery(resources.taskView(data.info.root, 'T9'));
  render(<TestWorkspace data={data}><Probe /></TestWorkspace>);
  await act(async () => { release(); await flight; });
  await waitFor(() => expect(useViewStore.getState().selected).toBe('T9'));
  expect(useViewStore.getState().reader.address).toBeNull();
  expect(taskReadState(client, data.info.root, 'T9').view?.task.values?.notes).toBe('Newest body');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('R3: a patch that changes the view with unchanged shelf refreshes the body', async () => {
  const base = indexOf(source()); receiveFullIndex(client, base);
  let next = serverView(source(), 'T9');
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonAnswer(next));
  const options = resources.taskView(base.root, 'T9'); await client.fetchQuery(options);
  const observer = new QueryObserver(client, options), stop = observer.subscribe(() => {});
  try {
    const changed = tree({ tasks: [{ ...task(), title: 'After update', values: { notes: 'After update' }, version: 2, hash: 'd'.repeat(64) }] });
    next = serverView(changed, 'T9', undefined, 1);
    receivePatch(client, serverPatch(base, indexOf(changed).tasks));
    await waitFor(() => expect(taskReadState(client, base.root, 'T9').view?.task.values?.notes).toBe('After update'));
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { stop(); }
});

for (const corrupt of ['missing', 'identity', 'parent', 'hash']) test(`a view whose own row ${corrupt === 'missing' ? 'is missing' : `disagrees in ${corrupt}`} is rejected, then normal GET recovers`, async () => {
  const base = index(); receiveFullIndex(client, base);
  const good = serverView(source(), 'T9');
  const { row: _row, ...without } = good;
  const broken = corrupt === 'missing' ? without : { ...good,
    row: { ...good.row, [corrupt === 'identity' ? 'id' : corrupt === 'parent' ? 'parentId' : 'hash']: corrupt === 'hash' ? 'f'.repeat(64) : 'T999' } };
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonAnswer(broken));
  const options = resources.taskView(base.root, 'T9');
  await expect(client.fetchQuery(options)).rejects.toMatchObject({ code: 'invalid_response' });
  expect(taskReadState(client, base.root, 'T9').view).toBeUndefined();
  fetcher.mockResolvedValue(jsonAnswer(good)); await recoverReads(client, [options.queryKey]); await flush();
  expect(taskReadState(client, base.root, 'T9').assessment.state).toBe('current');
});

test('warmed finished/search/details do not revive hidden projects, including restored device reads', async () => {
  const base = index(); receiveFullIndex(client, base);
  const view = serverView(source(), 'T9');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).includes('view?') ? jsonAnswer(view)
    : String(url).includes('search?') ? jsonAnswer({ rows: [serverPageRow(source(), 'T9')], ancestors: [], total: 1, nextAfter: null, lines: {}, generation: 'a', sourcePv: 0 })
      : jsonAnswer(serverPage([serverPageRow(source(), 'T9')])));
  await client.fetchQuery(resources.taskView(base.root, 'T9'));
  await client.fetchInfiniteQuery(resources.finished(base.root, null));
  await client.fetchInfiniteQuery(resources.taskSearch(base.root, 'body', null));
  // Hiding the project changes what the page and the search return, as the server's required versions say.
  const raised = { ...hidden(base), sourcePv: 1 as never, requiredPv: { ...base.requiredPv, view: { T9: 1 as never }, page: { 'finished:root': 1 as never }, search: { root: 1 as never } } };
  receiveFullIndex(client, raised);
  restoreReadScope(client, false);
  expect(serverReadFacts(client)?.tasks ?? []).toEqual([]); expect(displayReadFacts(client)?.tasks ?? []).toEqual([]);
  expect(readState(client, resources.finished(base.root, null).queryKey).data).toBeUndefined();
  expect(readState(client, resources.taskSearch(base.root, 'body', null).queryKey).assessment).toMatchObject({ project: false, needsRead: true });
});

for (const active of [false, true]) test(`restore recovers a shelved refusal using official recovery, active=${active}`, async () => {
  const base = hidden(index()); receiveFullIndex(client, base);
  let visible = false;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => visible ? jsonAnswer(serverView(source(), 'T9')) : refusedAnswer());
  const options = resources.taskView(base.root, 'T9');
  await expect(client.fetchQuery(options)).rejects.toMatchObject({ reason: { kind: 'task_archived' } });
  const query = readQuery(client, options.queryKey)!;
  expect(shelvedReadDetail(query.state.error)?.shelf.restoreTarget?.id).toBe(PROJECT_TASK);
  const observer = active ? new QueryObserver(client, { ...options, enabled: true, retryOnMount: false }) : undefined;
  const stop = observer?.subscribe(() => {});
  try {
    visible = true; receiveFullIndex(client, { ...index(), rev: base.rev + 1, projectShelfVersion: 'e'.repeat(64) });
    await waitFor(() => expect(taskReadState(client, base.root, 'T9').assessment.state).toBe('current'));
    expect(readRefused(query)).toBe(false); expect(readRecoveryPending(query)).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { stop?.(); }
});

test('failed recovery stops; explicit later recovery succeeds', async () => {
  const base = hidden(index()); receiveFullIndex(client, base);
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(refusedAnswer());
  const options = resources.taskView(base.root, 'T9'); await expect(client.fetchQuery(options)).rejects.toBeDefined();
  fetcher.mockImplementation(async () => { throw new Error('Temporary fault'); });
  receiveFullIndex(client, { ...index(), rev: base.rev + 1, projectShelfVersion: 'e'.repeat(64) });
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2)); await flush();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(readRecoveryPending(readQuery(client, options.queryKey)!)).toBe(false);
  fetcher.mockResolvedValue(jsonAnswer(serverView(source(), 'T9'))); await recoverReads(client, [options.queryKey]); await flush();
  expect(taskReadState(client, base.root, 'T9').assessment.state).toBe('current');
});

test('an old shelved response after restore cannot make the restored URL permanently refused', async () => {
  const base = hidden(index()); receiveFullIndex(client, base);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { if (++calls === 1) { await gate; return refusedAnswer(); } return jsonAnswer(serverView(source(), 'T9')); });
  const options = resources.taskView(base.root, 'T9'); const first = client.fetchQuery(options).catch(() => {});
  receiveFullIndex(client, { ...index(), rev: base.rev + 1, projectShelfVersion: 'e'.repeat(64) });
  release(); await first;
  await waitFor(() => expect(taskReadState(client, base.root, 'T9').assessment.state).toBe('current'));
  expect(calls).toBe(2);
});

for (const ahead of [false, true]) test(`catalog actual revision qualifies restore basis only against matching index, ahead=${ahead}`, async () => {
  const base = hidden(index()); receiveFullIndex(client, base);
  const catalog = shelf(ahead ? 'd'.repeat(64) : base.projectShelfVersion);
  const target = catalog.projects[0]!.shelf.restoreTarget!;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => String(url).includes('project/shelf') ? jsonAnswer(catalog)
    : jsonAnswer({ task: headOf({ ...task(), id: target.id, kind: 'project', settings: { color: '#39659b' }, parentId: null, path: `tasks/${target.id}`, hash: target.hash, version: 2 }) }));
  const options = resources.projectShelf(base.root); const acquired = await client.fetchQuery(options); await flush();
  expect(readCodec(options.queryKey)).toBeDefined();
  expect(representedReadIds(options.queryKey, catalog)).toEqual([]);
  expect(writeAccess(rowWriteBasis(target.id, target.hash))).toBe('conflict');
  expect(writeAccess(readWriteBasis(options.queryKey, catalog.revision))).toBe(ahead ? 'conflict' : 'allowed');
  if (ahead) await expect(restoreCatalogProject(client, base.root, acquired, target)).rejects.toMatchObject({ code: 'conflict' });
  else {
    await restoreCatalogProject(client, base.root, acquired, target);
    const sent = fetcher.mock.calls.find(([url]) => String(url).includes('task/restore'))!;
    expect(JSON.parse(String(sent[1]?.body))).toMatchObject({ task: target.id, expectedTaskHash: target.hash });
  }
});

test('active catalog is re-acquired once when its shelf marker moves', async () => {
  const base = hidden(index()); receiveFullIndex(client, base);
  let catalog = shelf(base.projectShelfVersion);
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonAnswer(catalog));
  const options = resources.projectShelf(base.root); await client.fetchQuery(options);
  const observer = new QueryObserver(client, options), stop = observer.subscribe(() => {});
  try {
    catalog = shelf('d'.repeat(64)); receiveFullIndex(client, { ...base, rev: base.rev + 1, projectShelfVersion: catalog.revision });
    await waitFor(() => expect(readState<ProjectShelfDTO>(client, options.queryKey).data?.revision).toBe(catalog.revision));
    await waitFor(() => expect(readState(client, options.queryKey).assessment.state).toBe('current'));
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { stop(); }
});

for (const parameter of ['project'] as const) test(`hidden ${parameter} URLs retain the address on a schema-checked refusal`, async () => {
  const data = screenData(tree({ tasks: [] }));
  const id = 'P200';
  const payload = await refused().json(); payload.error.detail.task.id = id;
  if (parameter === 'project') { payload.error.detail.task.kind = 'project'; payload.error.detail.task.projectId = id; }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(payload), { status: 404 }));
  function Probe() {
    const facts = useSyncExternalStore(changed => subscribeReads(client, changed), () => serverReadFacts(client));
    useUrlBootstrap(indexTasks(mapWorkspace(facts!, baselines([])).tasks)); return null;
  }
  history.replaceState(null, '', '/?' + parameter + '=' + id);
  render(<TestWorkspace data={data}><Probe /></TestWorkspace>);
  await waitFor(() => expect(shelvedReadDetail(readQuery(client, resources.taskView(data.info.root, id).queryKey)?.state.error)).toBeDefined());
  await flush(); expect(new URL(location.href).searchParams.get(parameter)).toBe(id);
});

test('a later read demand during a running recovery is served finitely', async () => {
  const base = hidden(index()); receiveFullIndex(client, base);
  const options = resources.taskView(base.root, 'T9');
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(refusedAnswer());
  await expect(client.fetchQuery(options)).rejects.toBeDefined();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let attempts = 0;
  fetcher.mockImplementation(async () => { if (++attempts === 1) await gate; return jsonAnswer(serverView(source(), 'T9')); });
  const observer = new QueryObserver(client, { ...options, retryOnMount: false }), stop = observer.subscribe(() => {});
  try {
    receiveFullIndex(client, { ...index(), rev: base.rev + 1, projectShelfVersion: 'e'.repeat(64) });
    await waitFor(() => expect(attempts).toBe(1));
    requestRead(readQuery(client, options.queryKey)!);
    const later = recoverReads(client, [options.queryKey]);
    await flush(); release(); await later;
    await waitFor(() => expect(taskReadState(client, base.root, 'T9').viewSettled).toBe(true));
    await flush(); expect(attempts).toBe(2);
  } finally { release(); stop(); }
});

test('R3: closed old view, newer GET, absent live row and URL do not roll body back', async () => {
  const data = screenData(tree({ tasks: [] }));
  let answer = serverView(tree({ tasks: [{ ...task(), title: 'Old body', values: { notes: 'Old body' } }] }), 'T9');
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonAnswer(answer));
  await client.fetchQuery(resources.taskView(data.info.root, 'T9'));
  answer = serverView(source(), 'T9');
  await client.fetchQuery({ ...resources.taskView(data.info.root, 'T9'), staleTime: 0 });
  function Probe() {
    const facts = useSyncExternalStore(changed => subscribeReads(client, changed), () => serverReadFacts(client));
    useUrlBootstrap(indexTasks(mapWorkspace(facts!, baselines([])).tasks)); return null;
  }
  history.replaceState(null, '', '/?task=T9'); render(<TestWorkspace data={data}><Probe /></TestWorkspace>);
  await waitFor(() => expect(useViewStore.getState().selected).toBe('T9'));
  expect(taskReadState(client, data.info.root, 'T9').view?.task.values?.notes).toBe('Newest body');
  expect(useViewStore.getState().reader.address).toBeNull();
});

for (const cut of ['root', 'generation'] as const) test(`an in-flight shelf recovery cannot cross a ${cut} switch`, async () => {
  const base = hidden(index()); receiveFullIndex(client, base);
  const options = resources.taskView(base.root, 'T9');
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(refusedAnswer());
  await expect(client.fetchQuery(options)).rejects.toBeDefined();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  fetcher.mockImplementation(async () => { await gate; return jsonAnswer(serverView(source(), 'T9')); });
  receiveFullIndex(client, { ...index(), rev: base.rev + 1, projectShelfVersion: 'e'.repeat(64) });
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  receiveFullIndex(client, { ...index(), tasks: [], [cut]: cut === 'root' ? '/new-root' : 'new-generation' });
  release(); await flush();
  expect(readQuery(client, options.queryKey)).toBeUndefined();
  expect(serverReadFacts(client)?.tasks ?? []).toEqual([]);
});

test('a shelving refusal about a different Task is invalid and cannot withdraw this Query', async () => {
  const base = index(); receiveFullIndex(client, base);
  const payload = await refused().json(); payload.error.detail.task.id = 'T999';
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(payload), { status: 404 }));
  const options = resources.taskView(base.root, 'T9');
  await expect(client.fetchQuery(options)).rejects.toMatchObject({ code: 'invalid_response' });
  expect(readRefused(readQuery(client, options.queryKey)!)).toBe(false);
});


test('an active timeline selection retired by the shelf is not sent again; a later valid selection recovers', async () => {
  const base = indexOf(source()); receiveFullIndex(client, base);
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonAnswer({busy: [], earliest: null, generation: 'a', sourcePv: readIndex(client)!.sourcePv}));
  const options = resources.timelineAxis(base.root, null, ['T9'], []);
  await client.fetchQuery(options);
  const observer = new QueryObserver(client, options), stop = observer.subscribe(() => {});
  try {
    // Hiding the project changes the time line, but its lane is gone: it is not asked for.
    const raised = { ...base.requiredPv, timeline: { T9: 1 as never } };
    receiveFullIndex(client, { ...hidden(base), sourcePv: 1 as never, requiredPv: raised });
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(readState(client, options.queryKey).assessment.project).toBe(false);
    // Restored, the lane is back and the time line changed again.
    receiveFullIndex(client, {...base, rev: base.rev + 2, sourcePv: 2 as never, requiredPv: { ...base.requiredPv, timeline: { T9: 2 as never } }});
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(readState(client, options.queryKey).assessment.project).toBe(true));
  } finally { stop(); }
});


test('an old project URL remains a standard active read across offline startup and reconnect', async () => {
  const base = hidden(index());
  const data = screenData(tree({tasks: []})); receiveFullIndex(client, {...base,root:data.info.root});
  useConnection.setState({offline: true, state: 'connecting'});
  const catalog = shelf(base.projectShelfVersion);
  const fetcher = vi.spyOn(globalThis,'fetch').mockImplementation(async url => String(url).includes('project/shelf') ? jsonAnswer(catalog)
    : new Response(JSON.stringify({error:{code:'not_found',message:'Archived',retry:'fix',reason:{kind:'task_archived'},
      detail:{task:{id:PROJECT_TASK,title:'Project',kind:'project',projectId:PROJECT_TASK,lifecycle:'archived'},shelf:catalog.projects[0]!.shelf}}}),{status:404}));
  render(<TestWorkspace data={data}><AwaitedLookup address={PROJECT_TASK} placement="list" reason={{kind:'scope_lookup_unavailable'}} skeleton={<span>Waiting</span>} /></TestWorkspace>);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => { receiveFullIndex(client, {...base,rev:base.rev + 1,root:data.info.root}); await new Promise(resolve => setTimeout(resolve, 20)); });
  await act(async () => { useConnection.setState({offline:false,state:'live'}); await recoverReads(client); });
  await waitFor(() => expect(document.querySelector('[data-archive-notice]')).not.toBeNull());
  await waitFor(() => expect((document.querySelector('[data-archive-restore]') as HTMLButtonElement).disabled).toBe(false));
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes('task/view'))).toHaveLength(1);
});
