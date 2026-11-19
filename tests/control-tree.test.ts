import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { stringify } from 'yaml';
import { commandFetch as fetch } from './helpers/command-fetch.ts';
import { createFixtureRun } from './helpers/run-fixture.ts';
import { assignResponsible, initializeControlFixture, seedFixtureTask } from './helpers/control-fixture.ts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '@alpacawork/runs';
import { touch } from '@alpacawork/db';
import { projectedIndexSchema, controlTreeSchema, taskProjectedViewSchema } from '@alpacawork/contract/control';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { readControlTree } from './helpers/control-tree.ts';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { RESULT_LIMIT } from '@alpacawork/backend/test-dist/runs/files.js';

async function setup(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-tree2-')));
  const servers: Array<Awaited<ReturnType<typeof startServer>>> = [];
  t.after(async () => {
    for (const server of servers) await server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const writer = new FileWriter(root);
  // A profile for the Parent's responsible; never a real agent.
  const fakeConfig = stringify({ agents: { "codex": fixtureAgentSetting('codex') } });
  let project: string;
  try { writer.save('config.yaml', null, Buffer.from(fakeConfig)); project = initializeControlFixture(root); }
  finally { writer.close(); }
  const commands = new ControlTaskCommands(root, { kind: 'human' });
  const parent = (await commands.create({ parentId: project, userRequested: null, tasks: [{ title: 'Parent' }] })).tasks[0];
  // A task with a child has a responsible.
  await assignResponsible(root, parent, 'codex');
  const child = seedFixtureTask(root, parent.id, 'Child');
  return { root, parent, child, async start() {
    const server = await startServer(root, 0);
    servers.push(server);
    return server;
  } };
}

test('tree projection joins actual placement, Run and logical parent data', async t => {
  const h = await setup(t);
  const store = new PlacementStore(h.root);
  const agent = store.createAgent();
  const placement = store.place({ taskId: h.child.id, agentId: agent.id, profileKey: 'codex', responsible: true });
  store.close();
  const runs = new RunStore(h.root, { busyTimeoutMs: 0 });
  const launchCwd = join(h.root, 'separate-run-directory');
  try { runs.write(tx => createFixtureRun(runs, tx, { task: h.child.id, placementId: placement.id, requestId: globalThis.crypto.randomUUID(),
    agent: 'codex', role: 'owner', resumes: null, continues: false, session: null, caller: null,
    cwd: launchCwd, launch: { adapter: 'codex', env: [], argv: ['unused-fake'], path: '/bin', values: {}} }, 'No launch')); }
  finally { runs.close(); }
  const tree = controlTreeSchema.parse(await readControlTree(h.root));
  assert.equal(tree.tasks.find(task => task.id === h.child.id)?.parentId, h.parent.id);
  const childPlacement = tree.placements.find(item => item.taskId === h.child.id);
  assert.deepEqual([childPlacement?.agentId, childPlacement?.runtime.displayState], [agent.id, 'idle']);
  assert.equal(tree.runs[0]?.placementId, placement.id);
  assert.equal(tree.runs[0]?.cwd, launchCwd);
  assert.notEqual(tree.runs[0]?.cwd, join(h.root, tree.tasks.find(task => task.id === h.child.id)!.path));
});

test('GET /api/workspace/live publishes the projection contract from the authoritative stores', async t => {
  const h = await setup(t);
  const app = await h.start();
  const response = await fetch(new URL('/api/workspace/live', app.url));
  assert.equal(response.status, 200);
  const tree = projectedIndexSchema.parse(await response.json());
  const child = tree.tasks.find(task => task.id === h.child.id);
  assert.equal(child?.parentId, h.parent.id);
  assert.ok(tree.projects.some(project => project.id === child?.projectId));
  assert.equal(tree.writable, true);
  const events = await fetch(new URL('/api/events', app.url));
  assert.equal(events.status, 200);
  const reader = events.body!.getReader();
  try {
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /event: index/);
    assert.match(first, new RegExp(`id: ${tree.generation}:${tree.rev}`));
    const data = first.split('\n').find(line => line.startsWith('data: '));
    assert.ok(data);
    assert.deepEqual(projectedIndexSchema.parse(JSON.parse(data.slice(6))), tree);
  } finally { await reader.cancel(); }
});

test('an unreadable Run snapshot is exposed without inventing placement activity', async t => {
  const h = await setup(t);
  const placements = new PlacementStore(h.root);
  let placementId: string;
  try {
    const agent = placements.createAgent('Sol');
    placementId = placements.place({ taskId: h.child.id, agentId: agent.id, profileKey: 'codex', responsible: true }).id;
  } finally { placements.close(); }
  const runs = new RunStore(h.root, { busyTimeoutMs: 0 });
  try { runs.write(tx => createFixtureRun(runs, tx, { task: h.child.id,
    placementId,
    requestId: globalThis.crypto.randomUUID(), agent: 'codex', role: 'owner', resumes: null,
    continues: false, session: null, caller: null, cwd: h.root,
    launch: { adapter: 'codex', env: [], argv: ['unused'], path: '/bin', values: {} } }, 'prompt')); }
  finally { runs.close(); }
  const changeRuns = (agent: string, title?: string) => {
    const store = new RunStore(h.root, { busyTimeoutMs: 1000 });
    try { store.write(tx => {
      store.connection.prepare("UPDATE runs SET record = json_set(record, '$.agent', ?)").run(agent);
      for (const row of store.connection.prepare('SELECT id FROM runs').all()) touch(store.connection, { kind: 'run', id: `R${row.id}` });
      if (title) {
        store.connection.prepare('UPDATE tasks SET title=? WHERE external_id=?').run(title, h.child.id);
        touch(store.connection, { kind: 'task', id: h.child.id });
      }
    }); } finally { store.close(); }
  };
  changeRuns('Not An Agent');
  const tree = controlTreeSchema.parse(await readControlTree(h.root));
  assert.equal(tree.writable, false);
  assert.equal(tree.working, null);
  assert.equal(tree.errors.some(error => error.code === 'runs_unavailable'), true);
  assert.equal(tree.placements[0]?.runtime.displayState, 'unknown');
  const app = await h.start();
  const response = await fetch(new URL('/api/workspace/live', app.url));
  assert.equal(response.status, 200, 'readable Task facts remain available at startup');
  const live = projectedIndexSchema.parse(await response.json());
  assert.deepEqual(live.tasks.filter(task => task.kind === 'task').map(task => task.title).sort(), ['Child', 'Parent']);
  assert.equal(live.writable, false);
  assert.equal(live.errors.some(error => error.code === 'runs_unavailable'), true);
  assert.equal(live.placements[0]?.runtime.displayState, 'unknown');
  const current = await fetch(new URL(`/api/task/view?address=${encodeURIComponent(h.child.id)}`, app.url));
  assert.equal(current.status, 200, 'fresh Task facts remain current when Run activity is unknown');
  assert.equal(taskProjectedViewSchema.parse(await current.json()).task.title, 'Child');

  // A subsequent valid degraded read must publish fresh Task facts even after a healthy read.
  changeRuns('codex');
  const healthy = projectedIndexSchema.parse(await (await fetch(new URL('/api/workspace/live', app.url))).json());
  assert.equal(healthy.writable, true);
  assert.deepEqual(healthy.errors, []);
  assert.notEqual(healthy.placements[0]?.runtime.displayState, 'unknown');
  changeRuns('Not An Agent', 'Fresh degraded Task');
  const retained = projectedIndexSchema.parse(await (await fetch(new URL('/api/workspace/live', app.url))).json());
  assert.equal(retained.writable, false);
  assert.deepEqual(retained.home, healthy.home, 'an unreadable Run snapshot retains the published home rows');
  assert.equal(retained.tasks.find(task => task.id === h.child.id)?.title, 'Fresh degraded Task',
    'valid degraded reads publish current Task facts');
  assert.equal(retained.placements[0]?.runtime.displayState, 'unknown');
  assert.ok(!retained.staleIds.includes(h.child.id));
  const fresh = await fetch(new URL(`/api/task/view?address=${encodeURIComponent(h.child.id)}`, app.url));
  assert.equal(fresh.status, 200);
  assert.equal(taskProjectedViewSchema.parse(await fresh.json()).task.title, 'Fresh degraded Task');
});

test('Task records remain readable when their file folder is absent', async t => {
  const h = await setup(t);
  const placements = new PlacementStore(h.root);
  try {
    const agent = placements.createAgent('Sol');
    placements.place({ taskId: h.child.id, agentId: agent.id, profileKey: 'codex', responsible: true });
  } finally { placements.close(); }
  const tree = controlTreeSchema.parse(await readControlTree(h.root));
  assert.equal(tree.writable, true);
  assert.deepEqual(tree.tasks.filter(task => task.kind === 'task').map(task => task.id), [h.parent.id, h.child.id]);
  assert.deepEqual(tree.placements.map(item => item.taskId).sort(), [h.parent.id, h.child.id].sort());
  assert.deepEqual(tree.errors, []);
});

test('tree and HTTP expose only the latest final owner result with explicit file status', async t => {
  const h = await setup(t), store = new RunStore(h.root, { busyTimeoutMs: 0 });
  t.after(() => store.close());
  const people = new PlacementStore(h.root);
  const agent = people.createAgent();
  const placement = people.place({ taskId: h.child.id, agentId: agent.id, profileKey: 'codex', responsible: true });
  people.close();
  const finished = (role: 'owner' | 'worker', body: string | null, extra: { resumes?: string } = {}) => {
    const run = store.write(tx => {
      const created = createFixtureRun(store, tx, { requestId: globalThis.crypto.randomUUID(), task: h.child.id, placementId: placement.id, agent: 'codex', role,
        resumes: extra.resumes ?? null, continues: false,
        session: null, caller: null, cwd: h.root,
        launch: { adapter: 'codex', env: [], argv: ['unused-fake'], path: '/bin', values: {}} }, 'Prompt');
      tx.update({ ...created, state: 'running', started_at: new Date().toISOString() });
      tx.finish({ ...tx.get(created.id)!, state: 'succeeded', ended_at: new Date().toISOString() },
        { state: 'present', text: body ?? '' });
      return created;
    });
    return run;
  };
  finished('owner', 'Old owner reply');
  finished('worker', 'Worker reply');
  const latest = finished('owner', '- 対応方針: Latest reply');
  const expected = { runId: latest.id, state: 'present' };
  assert.deepEqual((await readControlTree(h.root)).replies, { [h.child.id]: expected });
  const app = await h.start();
  const reply = async () => {
    const response = await fetch(new URL(`/api/task/view?address=${encodeURIComponent(h.child.id)}`, app.url));
    assert.equal(response.status, 200);
    return taskProjectedViewSchema.parse(await response.json()).reply;
  };
  assert.deepEqual(await reply(), expected);
  const changeResult = (state: string) => {
    store.write(tx => {
      store.connection.prepare('UPDATE runs SET result = NULL, result_state = ? WHERE id = ?').run(state, Number(latest.id.slice(1)));
      touch(store.connection, { kind: 'run', id: latest.id });
    });
  };
  changeResult('missing');
  assert.deepEqual((await readControlTree(h.root)).replies[h.child.id],
    { runId: latest.id, state: 'missing' });
  assert.deepEqual(await reply(), { runId: latest.id, state: 'missing' });
  changeResult('unreadable');
  assert.equal((await readControlTree(h.root)).replies[h.child.id]?.state, 'unreadable');
  assert.deepEqual(await reply(), { runId: latest.id, state: 'unreadable' });
  changeResult('too_large');
  assert.equal((await readControlTree(h.root)).replies[h.child.id]?.state, 'too_large');
  assert.deepEqual(await reply(), { runId: latest.id, state: 'too_large' });
  const continued = finished('owner', 'Continued reply', { resumes: latest.id });
  assert.deepEqual((await readControlTree(h.root)).replies[h.child.id],
    { runId: continued.id, state: 'present' });
  assert.deepEqual(await reply(), { runId: continued.id, state: 'present' });
});

for (const count of [100, 200, 1000]) test(`tree selects the same latest reply from ${count} Runs with one relationship scan`, async t => {
  const h = await setup(t);
  let idReads = 0;
  const { ended } = await import('./runs-fixtures.ts');
  const records = Array.from({ length: count }, (_, i) => {
    const id = `R${i + 1}`;
    return { ...ended(id, { task: h.child.id, requestId: `request-${i + 1}` }),
      get id() { idReads++; return id; } };
  });
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  t.after(() => store.close());
  const snapshot = store.snapshot();
  t.mock.method(store, 'snapshot', () => ({ ...snapshot, records }));
  const tree = await readControlTree(h.root, { source: () => store });
  assert.deepEqual(tree.replies, { [h.child.id]: { runId: `R${count}`, state: 'missing' } });
  assert.equal(tree.runs.length, count);
  t.diagnostic(`Run ID reads: ${idReads}`);
  // The tree's own: its projection, the ID sort and one relationship scan. The balls' (ballsOf): one index of the Runs
  // for the seats and one for the return facts, read once for every Task's ball, not once per Task.
  assert.equal(idReads, 4 * count + 2 * count, 'tree and its balls each index the Runs once');
});
