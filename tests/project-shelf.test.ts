import { taskFlow } from './task-flow.fixture.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFileSync, readFileSync, mkdirSync, realpathSync } from 'node:fs';
import { setupIndexFixture } from './helpers/index-fixture.ts';
import { commandFetch as fetch } from './helpers/command-fetch.ts';
import { openIndexStream } from './index-stream.ts';
import { projectedIndexSchema, projectShelfSchema, taskShelvedDetailSchema, taskProjectedViewSchema } from '@alpacawork/contract/control';
import { Problem } from '@alpacawork/core';
import { ControlStore } from '@alpacawork/db';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { readTaskListView, readTaskView } from '@alpacawork/backend/test-dist/control/task-views.js';
import { projectAtCwd, launchCwd, ownLocations, screenName, writeProjectLocation } from '@alpacawork/backend/test-dist/control/project-settings.js';
import { readControlTree } from './helpers/control-tree.ts';
import { readWorkspaceProjection } from './helpers/workspace-projection.ts';
import { screenTree, readScreenEnvironment } from './helpers/screen-tree.ts';
import { RequestService } from '@alpacawork/backend/test-dist/control/requests.js';
import { RunStore } from '@alpacawork/runs';
import { assignResponsible } from './helpers/control-fixture.ts';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import type { PublishedFrame } from '@alpacawork/backend/test-dist/receiver/projection-contract.js';
import type { ProjectionOwner } from '@alpacawork/backend/test-dist/receiver/projection-owner.js';

// A saved code location is stored resolved (launchDirectory), as the CLI resolves the cwd it passes; /tmp is a link on macOS.
const tmp = realpathSync('/tmp');

/** Fault the actual published-frame boundary without replacing stored Task identity. */
function mapReadFrame(t: Parameters<typeof setupIndexFixture>[0], app: { feed(): ProjectionOwner | undefined },
  change: (frame: PublishedFrame) => PublishedFrame) {
  const projection = app.feed()!, read = projection.read.bind(projection);
  return t.mock.method(projection, 'read', async (...args: Parameters<typeof read>) => change(await read(...args)));
}


async function setup(t: Parameters<typeof setupIndexFixture>[0]) {
  const h = await setupIndexFixture(t);
  const get = async (id: string) => (await new ControlTaskStore(h.root).snapshot()).tasks.find(task => task.id === id)!;
  const lifecycle = async (id: string, action: 'archive' | 'restore') => h.tasks.lifecycle({ id, action, expectedTaskHash: (await get(id)).hash });
  const project = async (parent: string, title: string) => (await h.tasks.create({ kind: 'project', color: '#39659b', parentId: parent, userRequested: null, tasks: [{ title }] })).tasks[0]!;
  return { ...h, get, lifecycle, project };
}

test('project shelving preserves child identity and explicit operations, isolates browsing from routing and launch cwd', async t => {
  const h = await setup(t), nested = await h.project(h.projectId, 'Nested'), inner = await h.project(nested.id, 'Inner');
  const kept = (await h.tasks.create({ parentId: inner.id, userRequested: null, tasks: [{ title: 'Kept' }] })).tasks[0]!;
  const mixed = (await h.tasks.create({ parentId: inner.id, userRequested: false,
    tasks: [{ title: 'Done' }, { title: 'Stopped' }, { title: 'Already deleted' }] })).tasks;
  for (const [index, state] of ['stopped', 'stopped'].entries()) await new TaskReportService(h.root).report({
    task: mixed[index]!.id, state: state as 'done' | 'stopped', expectedTaskHash: mixed[index]!.hash, opId: randomUUID(),
  }, { kind: 'human' }, { kind: 'human' });
  await h.tasks.lifecycle({ id: mixed[2]!.id, action: 'delete', expectedTaskHash: mixed[2]!.hash });
  const mixedBefore = await Promise.all(mixed.map(task => h.get(task.id)));
  const individual = await h.project(inner.id, 'Individually shelved');
  await h.lifecycle(individual.id, 'archive');
  const before = await h.get(kept.id);
  mkdirSync(join(h.root, 'tasks', kept.id), { recursive: true });
  writeFileSync(join(h.root, 'tasks', kept.id, 'kept.txt'), 'retained');
  await writeProjectLocation(h.root, inner.id, '/tmp', randomUUID());
  const config = readFileSync(join(h.root, 'config.yaml'));
  await h.lifecycle(h.projectId, 'archive');
  const direct = await readTaskView(h.root, kept.id, {}, null);
  assert.equal(direct.shelf.listed, false);
  assert.equal(direct.shelf.restoreTarget?.id, h.projectId);
  assert.deepEqual((await h.get(kept.id)), before);
  assert.equal(readFileSync(join(h.root, 'tasks', kept.id, 'kept.txt'), 'utf8'), 'retained');
  assert.deepEqual(readFileSync(join(h.root, 'config.yaml')), config);
  const visited = new Set<string>();
  const original = ReturnRouter.prototype.route;
  t.mock.method(ReturnRouter.prototype, 'route', function(this: ReturnRouter, ...args: Parameters<typeof original>) {
    for (const task of args[0].tasks) visited.add(task);
    return original.apply(this, args);
  });
  await new ReturnRouter(h.root).pass(undefined, 'every');
  assert.ok(visited.has(kept.id), 'hidden active projects remain eligible for business routing');
  const control = new ControlStore(h.root, { busyTimeoutMs: 1000 }, true);
  try { control.read(db => {
    assert.equal(ownLocations(h.root, db).some(item => item.id === inner.id), false);
    assert.equal(projectAtCwd(h.root, db, tmp, 'parent'), 'P1', 'the only visible project remains the fallback');
    assert.equal(launchCwd(h.root, db, kept.id), tmp, 'explicit launches retain inherited locations');
  }); } finally { control.close(); }
  assert.equal((await readTaskListView(h.root, {}, null)).tasks.some(task => task.id === kept.id), false);
  assert.ok((await readTaskListView(h.root, { all: true, state: ['all'] }, null)).tasks.some(task => task.id === kept.id));
  const updated = await h.tasks.update({ id: kept.id, title: 'Explicit update still works', expectedTaskHash: before.hash });
  assert.equal(updated.task.title, 'Explicit update still works');
  await h.lifecycle(h.projectId, 'restore');
  assert.equal((await h.get(individual.id)).meta.lifecycle, 'archived');
  assert.equal((await h.get(inner.id)).meta.lifecycle, 'active');
  assert.deepEqual(await Promise.all(mixed.map(task => h.get(task.id))), mixedBefore);
});

test('an explicit request below a shelved ancestor is admitted and retains its project launch location', async t => {
  const h = await setup(t), nested = await h.project(h.projectId, 'Hidden launch');
  const task = (await h.tasks.create({ parentId: nested.id, userRequested: false, tasks: [{ title: 'Explicit work' }] })).tasks[0]!;
  const responsible = await assignResponsible(h.root, task, 'fake');
  await writeProjectLocation(h.root, nested.id, '/tmp', randomUUID());
  await h.lifecycle(h.projectId, 'archive');
  const admitted = await new RequestService(h.root).request({ taskId: task.id, requestId: randomUUID(), body: 'Explicit instruction',
    expectedTaskHash: (await h.get(task.id)).hash, expectedPlacementRevision: responsible.revision },
    { purpose: 'instruction', actor: { kind: 'human' } });
  const runs = new RunStore(h.root, { busyTimeoutMs: 1000 });
  try { assert.equal(runs.get(admitted.runId)!.cwd, tmp); }
  finally { runs.close(); }
  assert.equal((await readTaskView(h.root, task.id, {}, null)).shelf.listed, false);
});

test('done state and ended Run history survive archive and restore without child writes', async t => {
  const f = await taskFlow(t), task = await f.task('Completed');
  const seat = await f.work(task); await f.report(seat, 'done'); f.end(seat);
  assert.equal((await f.get(task.id)).meta.state, 'done');
  const before = await f.get(task.id), runBefore = f.run(seat);
  await f.commands.lifecycle({ id: f.project, action: 'archive', expectedTaskHash: (await f.get(f.project)).hash });
  await f.commands.lifecycle({ id: f.project, action: 'restore', expectedTaskHash: (await f.get(f.project)).hash });
  assert.deepEqual(await f.get(task.id), before);
  assert.deepEqual(f.run(seat), runBefore);
});

test('inner restore retains the direct-parent rule and reports the outer restore target', async t => {
  const h = await setup(t), middle = await h.project(h.projectId, 'Middle'), inner = await h.project(middle.id, 'Inner');
  await h.lifecycle(inner.id, 'archive');
  await h.lifecycle(h.projectId, 'archive');
  const restored = await h.lifecycle(inner.id, 'restore');
  assert.equal(restored.task.lifecycle, 'active');
  assert.equal(restored.shelf.listed, false);
  assert.equal(restored.shelf.restoreTarget?.id, h.projectId);
  assert.equal((await readTaskView(h.root, inner.id, {}, null)).shelf.restoreTarget?.id, h.projectId);
});

test('zero projects publish SSE removals, survive restart, and restore through the existing HTTP lifecycle', async t => {
  const h = await setup(t), app = await h.start();
  const read = async (path: string) => {
    const response = await fetch(new URL(path, app.url));
    assert.equal(response.status, 200, await response.clone().text()); return response.json();
  };
  const stream = await openIndexStream(new URL('/api/events', app.url), h.signal);
  await stream.index();
  const change = async (id: string, action: 'archive' | 'restore') => {
    const response = await fetch(new URL(`/api/commands/task/${action}`, app.url), { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-alpacawork-op-id': randomUUID() },
      body: JSON.stringify({ task: id, expectedTaskHash: (await h.get(id)).hash }) });
    assert.equal(response.status, 200, await response.clone().text()); return response.json();
  };
  await change('P1', 'archive');
  const empty = projectedIndexSchema.parse(await read('/api/workspace/live'));
  assert.deepEqual(empty.projects, []); assert.deepEqual(empty.tasks, []);
  let streamed = await stream.index();
  while (streamed.rev < empty.rev) streamed = await stream.index();
  assert.deepEqual(streamed.tasks, []);
  const catalog = projectShelfSchema.parse(await read('/api/commands/project/shelf'));
  assert.equal(catalog.projects.find(project => project.id === h.projectId)?.shelf.restoreTarget?.id, 'P1');
  for (const address of ['P1', h.projectId, h.child.id]) {
    const response = await fetch(new URL(`/api/task/view?task=${address}`, app.url));
    assert.equal(response.status, 404);
    const problem = await response.json();
    assert.equal(problem.error.reason.kind, 'task_archived');
    const located = taskShelvedDetailSchema.parse(problem.error.detail);
    assert.equal(located.shelf.restoreTarget?.id, 'P1');
  }
  assert.equal((await fetch(new URL('/api/task/view?task=T99999', app.url))).status, 404);
  await app.close();
  const restarted = await h.start();
  const restartedIndex = await fetch(new URL('/api/workspace/live', restarted.url));
  assert.deepEqual(projectedIndexSchema.parse(await restartedIndex.json()).projects, []);
  const response = await fetch(new URL('/api/commands/task/restore', restarted.url), { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-alpacawork-op-id': randomUUID() },
    body: JSON.stringify({ task: 'P1', expectedTaskHash: (await h.get('P1')).hash }) });
  assert.equal(response.status, 200, await response.text());
  const located = await fetch(new URL(`/api/task/view?task=${h.child.id}`, restarted.url));
  assert.equal(taskProjectedViewSchema.parse(await located.json()).task.id, h.child.id);
});

test('zero-project configuration faults remain faults and cannot publish a writable empty view', async t => {
  const h = await setup(t);
  await h.lifecycle('P1', 'archive');
  writeFileSync(join(h.root, 'config.yaml'), 'agents: [not-valid');
  await assert.rejects(h.start(), { code: 'invalid_root' });
  const environment = readScreenEnvironment(h.root);
  assert.equal(environment.writable, false); assert.ok(environment.errors.length);
  assert.equal(screenTree(environment, []).writable, false);
});

test('a deliberately shelved project leaves no live rows or search matches', async t => {
  const h = await setup(t);
  assert.ok((await readWorkspaceProjection(h.root)).index.tasks.some(row => row.id === h.child.id));
  await h.lifecycle('P1', 'archive');
  const next = await readWorkspaceProjection(h.root);
  assert.deepEqual(next.index.tasks, []);
  assert.equal(next.search('Child').total, 0);
  assert.equal(screenName(h.root), 'alpacawork');
});

test('a known identity with a missing published row is unavailable, never not found', async t => {
  const h = await setup(t), app = await h.start();
  const stub = mapReadFrame(t, app, frame => new Proxy(frame, {
    get(target, property, receiver) {
      if (property === 'derived') return (id: string) => id === h.child.id ? undefined : target.derived(id);
      return Reflect.get(target, property, receiver);
    },
  }));
  const response = await fetch(new URL(`/api/task/view?task=${h.child.id}`, app.url));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'unavailable');
  stub.mock.restore();
  const recovered = await fetch(new URL(`/api/task/view?task=${h.child.id}`, app.url));
  assert.equal(recovered.status, 200);
  assert.equal(taskProjectedViewSchema.parse(await recovered.json()).task.id, h.child.id);
});

test('deleted projects have an explicit deleted location and are not offered as archived restore targets', async t => {
  const h = await setup(t), deleted = await h.project('P1', 'Deleted fixture project');
  await h.tasks.lifecycle({ id: deleted.id, action: 'delete', expectedTaskHash: deleted.hash });
  const app = await h.start();
  const response = await fetch(new URL(`/api/task/view?task=${deleted.id}`, app.url));
  const located = taskShelvedDetailSchema.parse((await response.json()).error.detail);
  {
    assert.equal(located.task.lifecycle, 'deleted');
    assert.equal(located.shelf.shelvedBy[0]!.lifecycle, 'deleted');
    assert.equal(located.shelf.restoreTarget, null);
  }
  const catalog = projectShelfSchema.parse(await (await fetch(new URL('/api/commands/project/shelf', app.url))).json());
  assert.equal(catalog.projects.some(project => project.id === deleted.id), false);
});

// With zero listed projects, startup must still consult the authoritative database.
test('zero-project database read faults remain faults instead of becoming an empty successful startup', async t => {
  const h = await setup(t);
  await h.lifecycle('P1', 'archive');
  t.mock.method(ControlStore.prototype, 'read', () => {
    throw new Problem('read_failed', 'Isolated fixture database read failure');
  });
  await assert.rejects(h.start(), { code: 'read_failed' });
});

test('cold zero-project startup exposes the same management catalog through CLI and HTTP', async t => {
  const h = await setup(t); await h.lifecycle('P1', 'archive');
  const app = await h.start();
  const index = projectedIndexSchema.parse(await (await fetch(new URL('/api/workspace/live', app.url))).json());
  assert.deepEqual(index.projects, []); assert.deepEqual(index.tasks, []);
  const { cliRun } = await import('./helpers/http-cli.ts');
  const cli = await cliRun(app.url.toString(), ['project', 'shelf']);
  assert.equal(cli.code, 0, cli.stderr);
  const catalog = projectShelfSchema.parse(JSON.parse(cli.stdout));
  assert.equal(catalog.projects.find(project => project.id === 'P1')?.shelf.restoreTarget?.id, 'P1');
});

test('the every-project router delivers a child return inside an active nested project hidden by its ancestor', async t => {
  const f = await taskFlow(t);
  const nested = (await f.commands.create({ kind: 'project', color: '#39659b', parentId: f.project, userRequested: false, tasks: [{ title: 'Hidden routing project' }] })).tasks[0]!;
  const owner = await f.task('Return recipient', { parentId: nested.id });
  const worker = await f.task('Return source', { parentId: owner.id });
  await f.commands.lifecycle({ id: f.project, action: 'archive', expectedTaskHash: (await f.get(f.project)).hash });
  assert.equal((await readTaskView(f.root, owner.id, {}, null)).shelf.listed, false);
  const first = await f.work(owner), child = await f.work(worker, first);
  await f.report(child, 'done'); f.end(child); f.end(first);
  const dispatched = await new ReturnRouter(f.root).pass(undefined, 'every');
  const received = f.store(runs => dispatched.acceptedRequestIds.map(id => runs.getRequest(id)!).find(request => request.taskId === owner.id));
  assert.ok(received?.runId, 'The standard all-project pass must deliver the return below the archived ancestor');
});
