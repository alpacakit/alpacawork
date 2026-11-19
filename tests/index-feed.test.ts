import { controlRunFixture } from './helpers/control-run-fixture.ts';
import { commandFetch as fetch } from './helpers/command-fetch.ts';
import { receiverClock } from './helpers/receiver-clock.ts';

/** HTTP/SSE projected index delivery, paging, reconnects, personal revisions and gzip. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupIndexFixture as setup } from './helpers/index-fixture.ts';
import { writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import {
  projectedIndexSchema, controlTreeSchema,
  taskHistoryWindowSchema, taskProjectedPageSchema, taskProjectedSearchSchema, taskProjectedTimelineSchema, taskProjectedViewSchema,
} from '@alpacawork/contract/control';
import { DEFAULT_SCHEMA, fieldCatalog, renderContext } from '@alpacawork/contract';
import { PROBLEM_CODE } from '@alpacawork/core';
import { UNSAVED_SETTINGS } from '@alpacawork/backend/test-dist/receiver/person-state.js';
import { readControlTree } from './helpers/control-tree.ts';
import { readWorkspaceProjection } from './helpers/workspace-projection.ts';
import { ControlStore, touch } from '@alpacawork/db';
import { readControlSource, taskListView } from '@alpacawork/backend/test-dist/control/task-views.js';
import { openIndexStream } from './index-stream.ts';


test('search returns bounded pages and reaches every match without duplicates', async t => {
  const h = await setup(t);
  const tree = await readControlTree(h.root);
  const example = tree.tasks.find(task => task.id === h.child.id)!;
  const many = { ...tree, tasks: [...tree.tasks.filter(task => task.id !== h.child.id), ...Array.from({ length: 95 }, (_, index) => ({
    ...example, id: index === 0 ? h.child.id : `T${index + 100}`, path: index === 0 ? h.child.path : `tasks/T${index + 100}`, title: `Needle ${index}`,
  }))] };
  const app = await h.start();
  await h.project(many);
  const search = async (after?: string) => {
    const url = new URL(`/api/task/search?text=Needle&limit=40${after ? `&after=${after}` : ''}`, app.url);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    return taskProjectedSearchSchema.parse(await response.json());
  };
  const first = await search();
  const second = await search(first.nextAfter!);
  const third = await search(second.nextAfter!);
  assert.deepEqual([first.rows.length, second.rows.length, third.rows.length], [40, 40, 15]);
  assert.equal(first.total, 95);
  assert.equal(third.nextAfter, null);
  assert.equal(new Set([...first.rows, ...second.rows, ...third.rows].map(row => row.id)).size, 95);
  assert.equal((await fetch(new URL('/api/task/search?text=Needle&limit=0', app.url))).status, 400);
  assert.equal((await fetch(new URL('/api/task/search?text=Needle&after=T999', app.url))).status, 400);
  // Narrowed to a project's subtree; a scope that is no listed project is not found.
  assert.equal(taskProjectedSearchSchema.parse(await (await fetch(new URL(`/api/task/search?text=Needle&scope=${h.projectId}`, app.url)))
    .json()).total, 95);
  assert.equal((await fetch(new URL(`/api/task/search?text=Needle&scope=${h.parent.id}`, app.url))).status, 400);
  assert.equal((await fetch(new URL('/api/task/search?text=Needle&scope=P999999', app.url))).status, 404);
  await h.project({ ...many, tasks: many.tasks.map(task => task.id === first.rows[0]!.id
    ? { ...task, title: 'Renamed' } : task) });
  const stale = await fetch(new URL(`/api/task/search?text=Needle&after=${first.nextAfter}`, app.url));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.retry, 'reread');
});

test('search sends timestamps and sorts later records ahead of older running work, including parents', async t => {
  const h = await setup(t);
  const tree = await readControlTree(h.root);
  const run = controlRunFixture('R999', { task: h.child.id, placementId: 'P999', agent: 'codex',
    requestId: 'Q999', cwd: '/fixture/run', state: 'running',
    created_at: '2027-10-01T00:00:00.000Z', started_at: '2027-10-01T00:00:00.000Z' });
  const app = await h.start();
  const unrelated = { ...tree.tasks.find(task => task.id === h.parent.id)!, id: 'T999', parentId: h.projectId,
    path: 'tasks/T999', title: 'Needle unrelated' };
  const newerRun = { ...run, id: 'R1000', taskId: unrelated.id, startedAt: '2027-10-01T00:00:00.001Z' };
  const quiet = { ...unrelated, id: 'T1000', path: 'tasks/T1000', log: unrelated.log.map(entry => ({ ...entry, at: '2027-10-01T12:00:00Z' })) };
  const needles = tree.tasks.map(task => task.kind === 'task' ? { ...task, title: `Needle ${task.id}` } : task);
  await h.project({ ...tree, tasks: [...needles, unrelated], runs: [...tree.runs, run, newerRun] });
  const response = await fetch(new URL('/api/task/search?text=Needle', app.url));
  assert.equal(response.status, 200);
  const result = taskProjectedSearchSchema.parse(await response.json());
  assert.ok(result.rows.every(row => Number.isSafeInteger(row.movedAt)));
  assert.deepEqual(result.rows.map(row => row.id), [unrelated.id, h.parent.id, h.child.id]);
  assert.equal(result.rows[0]!.movedAt - result.rows[1]!.movedAt, 1, 'a millisecond survives JSON');
  // A newer quiet record precedes running work, while a new child start lifts it and its parent.
  await h.project({ ...tree, tasks: [...needles, unrelated, quiet],
    runs: [...tree.runs, { ...run, id: 'R1001', startedAt: '2027-10-02T00:00:00.000Z' }, newerRun] });
  const resumed = taskProjectedSearchSchema.parse(await (await fetch(new URL('/api/task/search?text=Needle', app.url))).json());
  assert.deepEqual(resumed.rows.map(row => row.id), [h.parent.id, h.child.id, quiet.id, unrelated.id]);
});

test('finished Tasks are fetched as bounded pages, a parent\'s children or a scope\'s top level, not from the whole index', async t => {
  const h = await setup(t);
  const tree = await readControlTree(h.root);
  const example = tree.tasks.find(task => task.id === h.child.id)!;
  const top = tree.tasks.find(task => task.id === h.projectId)!.parentId!;
  // Parts of the work the user did not ask for: each is on its parent's page alone.
  const finished = Array.from({ length: 25 }, (_, index) => ({ ...example,
    id: index === 0 ? h.child.id : `T${index + 100}`, path: index === 0 ? h.child.path : `tasks/T${index + 100}`, parentId: h.parent.id, userRequested: false,
    title: `Finished ${index}`, state: 'done' as const,
  }));
  const descendant = { ...example, id: 'T999', path: 'tasks/T999', parentId: finished[0]!.id, userRequested: false,
    title: 'A descendant', state: 'done' as const };
  // Finished work the user asked for: the home list's Done section, on the top page of every project that holds it.
  const asked = { ...example, id: 'T996', path: 'tasks/T996', parentId: h.projectId, userRequested: true, title: 'Finished request',
    state: 'done' as const };
  const archived = { ...example, id: 'T998', path: 'tasks/T998', lifecycle: 'archived' as const,
    title: 'An archived Task' };
  const many = { ...tree, tasks: [...tree.tasks.filter(task => task.id !== h.child.id), ...finished, descendant, asked, archived] };
  const app = await h.start();
  await h.project(many);
  const live = projectedIndexSchema.parse(JSON.parse(app.feed()!.index()));
  const parent = encodeURIComponent(h.parent.id);
  // Every project's and each listed project's subtree, the root project's holding the fixture project's: the server
  // counts each once, so the screen adds none up.
  for (const scope of ['root', top, h.projectId])
    assert.deepEqual(live.counts.closed[scope], { finished: 1, freshFinished: 0, shelved: 1 }, scope);
  // And every Task each holds, whoever asked for it, live, finished or shelved; project Tasks are not counted.
  const tasks = many.tasks.filter(task => task.kind === 'task').length;
  assert.ok(tasks > 28);
  for (const scope of ['root', top, h.projectId]) assert.equal(live.counts.tasks[scope], tasks, scope);
  assert.equal(live.counts.children[h.parent.id]?.finished, 25);
  assert.ok(live.tasks.every(row => !finished.some(item => item.id === row.id) && row.id !== archived.id));
  assert.equal((await fetch(new URL('/api/tree', app.url))).status, 404, 'the all-Task route is retired');
  const response = await fetch(new URL(`/api/task/finished?parent=${parent}&limit=20`, app.url));
  assert.equal(response.status, 200);
  const page = taskProjectedPageSchema.parse(await response.json());
  assert.equal(page.total, 25);
  assert.equal(page.rows.length, 20);
  assert.ok(page.nextAfter);
  assert.ok(page.rows.every(row => !('stateLog' in row)));
  assert.ok(page.rows.every(row => !('ball' in row) && !('question' in row)),
    'closed page omits empty ball and question fields');
  assert.ok(page.rows.every(row => !row.latestReport || row.latestReport.id !== row.stateMark?.id),
    'a report that changed state appears once in a bounded row');
  assert.equal(page.rows.find(row => row.id === finished[0]!.id)?.childCounts.finished, 1);
  const second = taskProjectedPageSchema.parse(await (await fetch(new URL(
    `/api/task/finished?parent=${parent}&limit=20&after=${page.nextAfter}`, app.url))).json());
  assert.equal(second.rows.length, 5);
  assert.equal(second.nextAfter, null);
  assert.equal(new Set([...page.rows, ...second.rows].map(row => row.id)).size, 25);
  // The top page: of every project (parent=root), or of a project's subtree (its scope).
  const rowsAt = async (path: string) =>
    taskProjectedPageSchema.parse(await (await fetch(new URL(path, app.url))).json()).rows.map(row => row.id);
  for (const scope of ['', `&scope=${top}`, `&scope=${h.projectId}`])
    assert.deepEqual(await rowsAt(`/api/task/finished?parent=root${scope}`), [asked.id], scope);
  assert.equal((await fetch(new URL(`/api/task/finished?parent=root&scope=${h.parent.id}`, app.url))).status, 400,
    'a scope has a public project ID');
  assert.equal((await fetch(new URL('/api/task/finished?parent=root&scope=P999999', app.url))).status, 404);
  for (const scope of ['', `?scope=${h.projectId}`])
    assert.deepEqual(await rowsAt(`/api/task/shelved${scope}`), [archived.id], scope);
  // The screen's URL names a Task by its folder; its ID reaches the same Task, below its projects.
  for (const named of [finished[0]!.path, finished[0]!.id]) {
    const address = taskProjectedViewSchema.parse(await (await fetch(new URL(`/api/task/view?address=${encodeURIComponent(named)}`, app.url))).json());
    assert.equal(address.row.id, finished[0]!.id);
    assert.deepEqual(address.ancestors.map(row => row.id), [top, h.projectId, h.parent.id]);
  }
  for (const address of [`other/${finished[0]!.id}`, `${finished[0]!.path}/`, `tasks/${finished[0]!.path}`])
    assert.equal((await fetch(new URL(`/api/task/view?address=${encodeURIComponent(address)}`, app.url))).status, 404,
      'only the exact Task folder or its ID resolves');
  const byId = taskProjectedViewSchema.parse(await (await fetch(new URL(`/api/task/view?task=${finished[0]!.id}`, app.url))).json());
  const byAddress = taskProjectedViewSchema.parse(await (await fetch(new URL(`/api/task/view?address=${finished[0]!.id}`, app.url))).json());
  assert.deepEqual({ row: byId.row, ancestors: byId.ancestors }, { row: byAddress.row, ancestors: byAddress.ancestors }, 'row-click and URL reads own the same row and closed ancestry');
  // The visible Tasks' records come in pages of the limit, each page cursor leading to the next until none is left.
  const events: ReturnType<typeof taskProjectedTimelineSchema.parse>['events'] = [];
  for (let after: string | null = '', pages = 0; after !== null; pages++) {
    assert.ok(pages < finished.length, 'the cursor reaches the last page');
    const time = taskProjectedTimelineSchema.parse(await (await fetch(new URL(
      `/api/task/timeline?scope=${parent}&visible=${encodeURIComponent(finished.map(item => item.id).join(','))}&folded=&from=2020-01-01T00%3A00%3A00.000Z&to=2100-01-01T00%3A00%3A00.000Z&limit=10${after ? `&after=${after}` : ''}`, app.url))).json());
    assert.ok(time.events.length <= 10, 'a page holds at most its limit');
    events.push(...time.events);
    after = time.nextAfter;
  }
  assert.ok(events.every(event => event.kind === 'log'));
  assert.ok(events.length >= finished.length && events.length <= 2 * finished.length, 'each visible Task\'s records, once');
  const quiet = taskProjectedTimelineSchema.parse(await (await fetch(new URL(
    `/api/task/timeline?scope=root&visible=${h.parent.id}&folded=&from=2050-01-01T00%3A00%3A00.000Z&to=2050-01-02T00%3A00%3A00.000Z&limit=10`, app.url))).json());
  assert.ok(quiet.rows.some(row => row.id === h.parent.id), 'an ongoing row is available even with no in-window event');
  assert.ok(quiet.anchors[h.parent.id], 'the state before the window is paged as an anchor');
  assert.equal((await fetch(new URL('/api/task/finished?parent=root&limit=21', app.url))).status, 400);
  assert.equal((await fetch(new URL('/api/task/finished?parent=T997', app.url))).status, 404);
  const run = controlRunFixture('R999', { task: descendant.id, placementId: 'P999', agent: 'codex',
    requestId: 'Q999', cwd: '/fixture/run', state: 'succeeded',
    created_at: '2099-01-01T00:00:00.000Z', started_at: '2099-01-01T00:00:00.000Z',
    ended_at: '2099-01-02T00:00:00.000Z' });
  await h.project({ ...many, runs: [...many.runs, run] });
  const runChanged = taskProjectedPageSchema.parse(await (await fetch(new URL(
    `/api/task/finished?parent=${parent}`, app.url))).json());
  assert.deepEqual(runChanged.rows.map(row => row.id), page.rows.map(row => row.id),
    'the descendant Run changes the sort key without changing the visible order');
  assert.ok(runChanged.sourcePv > page.sourcePv, 'a descendant Run publishes the changed page sort key');
  const runStale = await fetch(new URL(`/api/task/finished?parent=${parent}&after=${page.nextAfter}`, app.url));
  assert.equal(runStale.status, 409);
  await h.project({ ...many, tasks: many.tasks.map(task => task.id === finished[0]!.id
    ? { ...task, title: 'Updated' } : task) });
  const stale = await fetch(new URL(`/api/task/finished?parent=${parent}&after=${page.nextAfter}`, app.url));
  assert.equal(stale.status, 409);
  assert.deepEqual((await stale.json()).error.retry, 'reread');
});

test('search lists its matches latest moved first, as the list does, and pages on in that order', async t => {
  const h = await setup(t);
  const tree = await readControlTree(h.root);
  const example = tree.tasks.find(task => task.id === h.child.id)!;
  const at = (id: string, title: string, time: string, parentId = h.projectId) => ({ ...example, id, parentId,
    path: `tasks/${id}`, title, log: example.log.map(entry => ({ ...entry, at: time })) });
  const app = await h.start();
  await h.project({ ...tree, tasks: [...tree.tasks,
    at('T200', 'Order old', '2026-01-01T00:00:00.000Z'), at('T201', 'Order new', '2026-03-01T00:00:00.000Z'),
    at('T202', 'Order middle', '2026-02-01T00:00:00.000Z'),
    // Moved at the same time as T202: made later, so after it.
    at('T1000', 'Order middle too', '2026-02-01T00:00:00.000Z'),
    // An old parent whose child moved last moves with it, as in the list.
    at('T203', 'Order parent', '2025-01-01T00:00:00.000Z'), at('T204', 'Quiet child', '2026-04-01T00:00:00.000Z', 'T203')] });
  const page = async (after?: string) => taskProjectedSearchSchema.parse(await (await fetch(new URL(
    `/api/task/search?text=Order&limit=2${after ? `&after=${after}` : ''}`, app.url))).json());
  const ids: string[] = [];
  let next: string | undefined;
  do {
    const found = await page(next);
    ids.push(...found.rows.map(row => row.id));
    next = found.nextAfter ?? undefined;
  } while (next);
  assert.deepEqual(ids, ['T203', 'T201', 'T202', 'T1000', 'T200']);
});

test('the view carries the context in its project\'s schema order, and what its questions ask', async t => {
  const h = await setup(t);
  const tree = await readControlTree(h.root);
  // What the responsible asks the user is a question, with what it asks fixed in its record when it was asked.
  const decide = [{ decide_question: 'Publication destination', decide_choices: [{ decide_choice: 'A', decide_choice_detail: 'Internal' }] }];
  const asked = { id: 'Lask', kind: 'asked' as const, at: '2026-10-07T00:00:00.000Z', title: 'Publication destination', description: 'Where to publish',
    actor: { kind: 'placement' as const, placementId: 'P1' }, fromState: null, toState: null, askedTo: null, decide };
  const fields = ['policy', 'goal', 'decide', 'user_instructions', 'conclusion', 'notes'];
  await h.project({ ...tree, tasks: tree.tasks.map(task => task.id === h.child.id ? { ...task,
    values: { goal: 'Ship it', policy: ['Verify first'], pr: ['hidden: not in the schema'] }, log: [...task.log, asked] } : task) });
  const store = new ControlStore(h.root);
  try { store.write(db => {
    const project = db.prepare('SELECT id FROM tasks WHERE external_id=?').get(h.projectId)!.id;
    db.prepare('DELETE FROM project_fields WHERE project_task_id=?').run(project);
    for (const [position, field] of fields.entries())
      db.prepare('INSERT INTO project_fields(project_task_id,position,field_id) VALUES (?,?,?)').run(project, position, field);
    touch(db, { kind: 'project_field', id: h.projectId });
  }); } finally { store.close(); }
  const view = (await readWorkspaceProjection(h.root)).view(h.child.id);
  // A field the schema leaves out keeps its value but is not shown.
  assert.equal(view.values.context, '## Policy\n- Verify first\n\n## Goal\nShip it');
  assert.deepEqual([view.values.fields, view.values.from], [fields, h.projectId]);
  assert.deepEqual(view.questions?.map(question => [question.id, question.decide]), [[asked.id, decide]]);
});

test('a request heading stays small and its full text is read with History', async t => {
  const h = await setup(t);
  const tree = await readControlTree(h.root);
  const at = '2026-10-07T00:00:00.000Z';
  const request = { id: 'Q123', taskId: h.child.id, placementId: 'P1', runId: null, aboutRunId: null,
    purpose: 'instruction', author: { kind: 'human' }, recipientRole: null, mode: 'new',
    body: 'Heading\nFull text', submittedAt: at, deliveryState: 'queued' } as const;
  await h.project({ ...tree, requests: [request] });
  const feed = await readWorkspaceProjection(h.root);
  const child = h.child.id;
  const head = feed.view(child).requestHeads[0]!;
  assert.equal(head.headline, 'Heading');
  assert.equal(head.bodyBytes, Buffer.byteLength(request.body));
  assert.equal('body' in head, false);
  const app = await h.start();
  const history = await fetch(new URL(`/api/task/history?task=${encodeURIComponent(child)}&mode=latest`, app.url));
  assert.equal(history.status, 200);
  const event = taskHistoryWindowSchema.parse(await history.json()).events.find(event => event.kind === 'request' && event.id === request.id);
  assert.equal(event?.summary, request.body);
  assert.equal((await fetch(new URL('/api/task/request-body', app.url))).status, 404);
});

test('SSE sends the whole index then patches, and reconnects with a current whole index', async t => {
  const h = await setup(t);
  const app = await h.start();
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await openIndexStream(new URL('/api/events', app.url), AbortSignal.any([controller.signal, h.signal]));
  const first = await stream.index();
  assert.deepEqual(first.tasks.filter(row => row.kind === 'task').map(row => row.id).sort(), [h.parent.id, h.child.id].sort());
  await h.tasks.update({ id: h.child.id, title: 'Seen live', expectedTaskHash: h.child.hash });
  app.context.changed?.();
  let live = await stream.index();
  while (live.tasks.find(row => row.id === h.child.id)?.title !== 'Seen live') live = await stream.index();
  assert.deepEqual(live, projectedIndexSchema.parse(await (await fetch(new URL('/api/workspace/live', app.url))).json()));
  // Missed while away: one edit.
  const cursor = `${live.generation}:${live.rev}`;
  controller.abort();
  const edited = (await readControlTree(h.root)).tasks.find(task => task.id === h.child.id)!;
  await h.tasks.update({ id: h.child.id, title: 'Missed', expectedTaskHash: edited.hash });
  app.context.changed?.();
  for (let tries = 0; tries < 50; tries++) {
    const tree = projectedIndexSchema.parse(await (await fetch(new URL('/api/workspace/live', app.url))).json());
    if (tree.rev > live.rev) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const again = new AbortController();
  t.after(() => again.abort());
  const resumed = await openIndexStream(new URL('/api/events', app.url), AbortSignal.any([again.signal, h.signal]), { 'Last-Event-ID': cursor });
  const missed = await resumed.event();
  assert.equal(missed.event, 'index');
  const restored = projectedIndexSchema.parse(JSON.parse(missed.data));
  assert.ok(restored.rev > live.rev);
  assert.equal(restored.tasks.find(row => row.id === h.child.id)?.title, 'Missed');
  assert.deepEqual(restored, projectedIndexSchema.parse(await (await fetch(new URL('/api/workspace/live', app.url))).json()));
  const fresh = new AbortController();
  t.after(() => fresh.abort());
  const other = await openIndexStream(new URL('/api/events', app.url), AbortSignal.any([fresh.signal, h.signal]), { 'Last-Event-ID': `other:${live.rev}` });
  assert.equal((await other.event()).event, 'index');
});

for (const encoding of ['identity', 'gzip']) test(`an unchanged resumed SSE connection opens before any heartbeat (${encoding})`, async t => {
  // No maintenance tick or heartbeat may stand in for opening the HTTP response.
  receiverClock(t);
  const h = await setup(t);
  const app = await h.start();
  const index = projectedIndexSchema.parse(await (await fetch(new URL('/api/workspace/live', app.url))).json());
  const response = await fetch(new URL('/api/events', app.url), {
    headers: { 'Last-Event-ID': `${index.generation}:${index.rev}`, 'Accept-Encoding': encoding },
    signal: AbortSignal.any([h.signal, AbortSignal.timeout(2_000)]),
  });
  try {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.equal(response.headers.get('content-encoding'), encoding === 'gzip' ? 'gzip' : null);
  } finally { await response.body?.cancel(); }
});

test('a closing serve answers a request on a connection it still holds as unavailable, which a screen retries', async t => {
  const h = await setup(t);
  const app = await h.start();
  const url = new URL(app.url);
  // A browser's kept-alive connection with a request arriving as the serve stops listening (a production swap).
  const socket = connect(Number(url.port), url.hostname);
  t.after(() => socket.destroy());
  let received = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => { received += chunk; });
  socket.write(`GET /api/events HTTP/1.1\r\nHost: ${url.host}\r\n`);
  await new Promise(resolve => setTimeout(resolve, 50));
  const closed = app.close();
  const listening = () => new Promise<boolean>(resolve => {
    const probe = connect(Number(url.port), url.hostname);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => resolve(false));
  });
  for (let tries = 0; tries < 100 && await listening(); tries++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await listening(), false, 'the serve stops listening while it still holds the connection');
  socket.write('\r\n');
  for (let tries = 0; tries < 100 && !received.includes('\r\n\r\n{'); tries++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(received, /^HTTP\/1\.1 503 /, received);
  assert.match(received, new RegExp(`"code":"${PROBLEM_CODE.unavailable}"`));
  socket.destroy();
  await closed;
});

test('the opened view and search answer from the served tree', async t => {
  const h = await setup(t);
  // A new title and values: two records, so History pages.
  const values = { goal: 'Ship it', conditions: ['Works', 'Tested'], notes: 'Needle in the body\nSecond line' };
  await h.tasks.update({ id: h.child.id, title: 'Child task', values, expectedTaskHash: h.child.hash });
  const app = await h.start();
  const tree = controlTreeSchema.parse(await readControlTree(h.root));
  const child = encodeURIComponent(h.child.id);
  const view = taskProjectedViewSchema.parse(await (await fetch(new URL(`/api/task/view?task=${child}`, app.url))).json());
  assert.deepEqual(view.task, { ...tree.tasks.find(task => task.id === h.child.id)!, log: [] });
  assert.deepEqual(view.requestHeads, []);
  // The context tab shows the text a launch carries: the values in the schema's order (renderContext).
  assert.deepEqual(view.values, { values, fields: [...DEFAULT_SCHEMA], from: null,
    context: renderContext(DEFAULT_SCHEMA, values, fieldCatalog([])) });
  assert.equal(view.reply, null);
  const history = taskHistoryWindowSchema.parse(await (await fetch(new URL(`/api/task/history?task=${child}&mode=latest`, app.url))).json());
  assert.ok(history.events.length >= 2);
  const held = taskHistoryWindowSchema.parse(await (await fetch(new URL(
    `/api/task/history?task=${child}&mode=since&since=${encodeURIComponent(history.oldestKey!)}&keep=1`, app.url))).json());
  assert.equal(held.events.length, 1);
  assert.equal(held.hasOlder, true);
  const older = taskHistoryWindowSchema.parse(await (await fetch(new URL(
    `/api/task/history?task=${child}&mode=older&limit=1&before=${encodeURIComponent(held.oldestKey!)}`, app.url))).json());
  assert.equal(older.events.length, 1);
  assert.notEqual(older.events[0]!.id, held.events[0]!.id);
  const since = taskHistoryWindowSchema.parse(await (await fetch(new URL(
    `/api/task/history?task=${child}&mode=since&since=${encodeURIComponent(held.oldestKey!)}&keep=80`, app.url))).json());
  assert.ok(since.events.some(event => event.id === held.events[0]!.id));
  assert.ok(since.events.every(event => event.at >= held.events[0]!.at));
  const old = `${held.events[0]!.at}|log|${held.events[0]!.id}`;
  for (const operation of [`mode=older&before=${encodeURIComponent(old)}`, `mode=since&since=${encodeURIComponent(old)}&keep=80`])
    assert.equal((await fetch(new URL(`/api/task/history?task=${child}&${operation}`, app.url))).status, 400);
  const missing = await fetch(new URL('/api/task/view?task=T999', app.url));
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'not_found');
  const search = async (text: string) => taskProjectedSearchSchema.parse(await
    (await fetch(new URL(`/api/task/search?text=${encodeURIComponent(text)}`, app.url))).json()).rows.map(row => row.id);
  assert.deepEqual(await search('NEEDLE'), [h.child.id]);
  // Found only in its values, a task comes with the value's line, so the list can say why it is there; by its title, without.
  const lines = async (text: string) => taskProjectedSearchSchema.parse(await
    (await fetch(new URL(`/api/task/search?text=${encodeURIComponent(text)}`, app.url))).json()).lines;
  assert.deepEqual(await lines('needle'), { [h.child.id]: 'Needle in the body' });
  assert.deepEqual(await lines('parent'), {});
  assert.deepEqual(await search('parent'), [h.parent.id]);
  assert.deepEqual(await search('nothing like this'), []);
  assert.deepEqual(await search('child needle'), [], 'a query must not cross title and values');
  assert.deepEqual(taskListView(await readControlSource(h.root), { text: 'child needle' }).tasks, []);
  assert.equal((await fetch(new URL('/api/task/search?text=', app.url))).status, 200);
  for (const path of ['/api/task/view', `/api/task/history?task=${child}&mode=older&before=broken&limit=0`, `/api/task/history?task=${child}&mode=older&before=broken`]) {
    const response = await fetch(new URL(path, app.url));
    assert.equal(response.status, 400, path);
    assert.equal((await response.json()).error.code, 'invalid_input');
  }
});

test('each row names the project it belongs to, a project\'s row itself, and the menu lists the projects nested', async t => {
  const h = await setup(t);
  const app = await h.start();
  const index = projectedIndexSchema.parse(await (await fetch(new URL('/api/workspace/live', app.url))).json());
  const top = index.projects.find(project => project.depth === 0)!.id;
  assert.deepEqual(index.projects.map(project => [project.id, project.parentId, project.depth]),
    [[top, null, 0], [h.projectId, top, 1]]);
  assert.deepEqual(index.tasks.map(row => [row.id, row.projectId]).sort(),
    [[top, top], [h.projectId, h.projectId], [h.parent.id, h.projectId], [h.child.id, h.projectId]].sort());
});

test('person writes publish only revision metadata in the index stream', async t => {
  const h = await setup(t);
  const app = await h.start();
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await openIndexStream(new URL('/api/events', app.url), AbortSignal.any([controller.signal, h.signal]));
  const first = await stream.index();
  assert.equal(first.person.notices, null);
  assert.equal(first.person.settings, UNSAVED_SETTINGS);
  const state = { version: 4, checkpoint: { at: new Date().toISOString(), tasks: {} }, reads: {} };
  const save = await fetch(new URL('/api/person/notices/save', app.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, expectedRevision: null }),
  });
  assert.equal(save.status, 200);
  const saved = await save.json();
  let changed = await stream.index();
  while (changed.person.notices !== saved.revision) changed = await stream.index();
  assert.deepEqual(changed.tasks, first.tasks);
  assert.equal(changed.person.settings, UNSAVED_SETTINGS);
  const personal = await (await fetch(new URL('/api/settings/get', app.url), {
    headers: { 'Accept-Language': 'zh-TW,pt-PT;q=0.9,es;q=0.8' },
  })).json();
  assert.equal(personal.values.language, 'pt-BR', 'the first browser request chooses the language');
  let initialized = changed;
  while (initialized.person.settings !== personal.revision) initialized = await stream.index();
  assert.equal(initialized.person.settings, personal.revision);
  const settingsSave = await fetch(new URL('/api/settings/set', app.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'theme', value: 'dark', expectedRevision: personal.revision }),
  });
  assert.equal(settingsSave.status, 200);
  const settings = await settingsSave.json();
  let settingsDelta = await stream.index();
  while (settingsDelta.person.settings !== settings.revision) settingsDelta = await stream.index();
  assert.equal(settingsDelta.person.settings, settings.revision);
  assert.equal(settingsDelta.person.notices, saved.revision);
});

test('a read-mark save publishes its revision while retaining current Task facts and detail versions', async t => {
  const h = await setup(t), app = await h.start();
  const before = app.feed()!.current!;
  const bundle = before.records.bundle(h.child.id), version = before.requiredPv.view[h.child.id];
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await openIndexStream(new URL('/api/events', app.url), AbortSignal.any([controller.signal, h.signal]));
  const first = await stream.index();
  const state = { version: 4, checkpoint: { at: new Date().toISOString(), tasks: {} }, reads: {} };
  const save = await fetch(new URL('/api/person/notices/save', app.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, expectedRevision: null }),
  });
  assert.equal(save.status, 200);
  const saved = await save.json();
  let changed = await stream.index();
  while (changed.person.notices !== saved.revision) changed = await stream.index();
  assert.deepEqual(changed.tasks, first.tasks);
  const after = app.feed()!.current!;
  assert.equal(after.records.bundle(h.child.id), bundle);
  assert.equal(after.requiredPv.view[h.child.id], version);
  const view = await fetch(new URL(`/api/task/view?task=${h.child.id}`, app.url));
  assert.equal(view.status, 200);
  assert.equal(taskProjectedViewSchema.parse(await view.json()).task.id, h.child.id);
});

test('a damaged personal file leaves the Task index readable and its own endpoint fails', async t => {
  const h = await setup(t);
  writeFileSync(join(h.root, '.alpacawork', 'notice-state.json'), '{bad');
  const app = await h.start();
  const index = projectedIndexSchema.parse(await (await fetch(new URL('/api/workspace/live', app.url))).json());
  assert.equal(index.person.notices, null);
  assert.equal(index.tasks.filter(row => row.kind === 'task').length, 2);
  assert.equal((await fetch(new URL('/api/person/notices', app.url))).status, 503);
});

/** One raw HTTP exchange, so the encoding on the wire is seen as sent. */
function raw(url: string, headers: Record<string, string>, until?: (body: Buffer) => boolean) {
  return new Promise<{ headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
    const request = httpRequest(url, { headers }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => {
        chunks.push(chunk);
        if (until?.(Buffer.concat(chunks))) { request.destroy(); resolve({ headers: response.headers, body: Buffer.concat(chunks) }); }
      });
      response.on('end', () => resolve({ headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', error => { if (!request.destroyed) reject(error); });
    request.end();
  });
}

test('JSON and the event stream are gzip-compressed only for a client that accepts it', async t => {
  const h = await setup(t);
  const app = await h.start();
  const base = app.url.replace(/\/$/, '');
  const zipped = await raw(`${base}/api/workspace/live`, { 'Accept-Encoding': 'gzip' });
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  const index = projectedIndexSchema.parse(JSON.parse(gunzipSync(zipped.body).toString()));
  const plain = await raw(`${base}/api/workspace/live`, {});
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.deepEqual(projectedIndexSchema.parse(JSON.parse(plain.body.toString())), index);
  // Each event is flushed whole, so the first one can be read before the stream ends.
  const stream = await raw(`${base}/api/events`, { 'Accept-Encoding': 'gzip' }, body => {
    try { return gunzipSync(body, { finishFlush: 2 }).toString().includes('\n\n'); } catch { return false; }
  });
  assert.equal(stream.headers['content-encoding'], 'gzip');
  const event = gunzipSync(stream.body, { finishFlush: 2 }).toString();
  assert.match(event, /^id: [-\w]+:[0-9]+\nevent: index\ndata: /);
  assert.deepEqual(projectedIndexSchema.parse(JSON.parse(/^data: (.+)$/m.exec(event)![1]!)), index);
  const unzipped = await raw(`${base}/api/events`, {}, body => body.toString().includes('\n\n'));
  assert.equal(unzipped.headers['content-encoding'], undefined);
  assert.match(unzipped.body.toString(), /event: index/);
});

test('timeline page cursors retain an unchanged scope and require a restart after its published version changes', async t => {
  const h = await setup(t);
  const tree = await readControlTree(h.root);
  const app = await h.start();
  await h.project(tree);
  const visible = encodeURIComponent(tree.tasks.map(task => task.id).join(','));
  const read = (after?: string) => fetch(new URL(`/api/task/timeline?scope=root&visible=${visible}&folded=&from=2020-01-01T00%3A00%3A00.000Z&to=2100-01-01T00%3A00%3A00.000Z&limit=1${after ? `&after=${after}` : ''}`, app.url));
  const first = taskProjectedTimelineSchema.parse(await (await read()).json());
  assert.ok(first.nextAfter, 'more than one page to read');
  const whole = async (after: string | null) => {
    const events = [];
    while (after) {
      const response = await read(after);
      assert.equal(response.status, 200);
      const page = taskProjectedTimelineSchema.parse(await response.json());
      assert.equal(page.sourcePv, first.sourcePv, 'unchanged pages read the same prepared frame');
      events.push(...page.events); after = page.nextAfter;
    }
    return events;
  };
  const untouched = await whole(first.nextAfter);
  await h.project({ ...tree, tasks: tree.tasks.map(task => task.id === h.child.id ? { ...task, title: 'Updated meanwhile' } : task) });
  assert.ok(untouched.length > 0);
  assert.equal((await read(first.nextAfter!)).status, 409, 'a changed timeline starts from the first page');
  const after = taskProjectedTimelineSchema.parse(await (await read()).json());
  assert.ok(after.sourcePv > first.sourcePv, 'a new chain reads the update');
  // A cursor whose list is no longer held is refused as ever, so its reader starts again.
  const gone = Buffer.from(JSON.stringify({ version: 'gone', offset: 1 })).toString('base64url');
  const refused = await read(gone);
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error.retry, 'reread');
});
