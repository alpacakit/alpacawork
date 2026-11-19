import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { stringify } from 'yaml';
import { ServeLifecycle } from '@alpacawork/backend/test-dist/receiver/lifecycle.js';
import { preserveFailureWorkspace } from './helpers/failure-workspace.ts';
import { commandFetch as fetch } from './helpers/command-fetch.ts';
import { receiverClock } from './helpers/receiver-clock.ts';
import { currentTaskHash, currentTaskLog, initializeControlFixture } from './helpers/control-fixture.ts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { ServerResponse, request as httpRequest, type ClientRequest } from 'node:http';
import { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { constants, mkdirSync, mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PROBLEM_CODE, Problem, tryLock, unlock } from '@alpacawork/core';
import { RUN_FILES, runFolder } from '@alpacawork/contract/run';
import { problemSchema } from '@alpacawork/contract/problem';
import { RunStore } from '@alpacawork/runs';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { PlacementCommands } from '@alpacawork/backend/test-dist/control/placement-commands.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { issueRunCredential } from '@alpacawork/backend/test-dist/control/credentials.js';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import { readControlTree } from './helpers/control-tree.ts';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { DatabaseWorkspaceRecords } from '@alpacawork/backend/test-dist/receiver/workspace-records.js';
import { readServerSettings, saveServerSettings } from '@alpacawork/backend/test-dist/server-settings.js';
import { projectedIndexSchema, requestRejectionSchema, placeAgentReceiptSchema,
  taskPlacementResultSchema, taskReportResultSchema, taskProjectedViewSchema, taskWriteResultSchema,
  type TaskRowDTO } from '@alpacawork/contract/control';
import { openIndexStream } from './index-stream.ts';
import { configSetInput } from '@alpacawork/contract/inputs';
import { DEFAULT_SCHEMA } from '@alpacawork/contract';
import { parseInput } from '@alpacawork/core';
import { cliRun } from './helpers/http-cli.ts';
import { createFixtureRun } from './helpers/run-fixture.ts';
import { reconcileLinks } from './return-handling.fixture.ts';
import { POLL_INTERVAL_MS } from '@alpacawork/backend/test-dist/poll-interval.js';

const servers = new Map<string, string>();
/** Launch profiles that never run anything: a wake this server starts launches no agent. */
const AGENTS = stringify({ agents: { "claude": fixtureAgentSetting('claude'), "codex": fixtureAgentSetting('codex') } });

/**
 * The test project (`project`) with two top Tasks, Parent with Child below it and Lone, served in this process. A task
 * with children keeps its responsible, so Parent has one (a store write, which leaves its hash) before Child, the
 * agents' own (so no notice wakes Parent), is made; Lone has none for a person to place.
 */
async function setup(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-control-entry-')));
  const writer = new FileWriter(root);
  let project: string;
  try { writer.save('config.yaml', null, Buffer.from(AGENTS)); project = initializeControlFixture(root); }
  finally { writer.close(); }
  const commands = new ControlTaskCommands(root, { kind: 'human' });
  const parent = (await commands.create({ parentId: project, userRequested: null, tasks: [{ title: 'Parent' }] })).tasks[0];
  const people = new PlacementStore(root);
  try { people.createAndPlace({ taskId: parent.id, profileKey: 'codex', responsible: true }); } finally { people.close(); }
  const child = (await commands.create({ parentId: parent.id, userRequested: false, tasks: [{ title: 'Child' }] })).tasks[0];
  const lone = (await commands.create({ parentId: project, userRequested: null, tasks: [{ title: 'Lone' }] })).tasks[0];
  const server = await startServer(root, 0);
  servers.set(root, server.url);
  t.after(async () => { await server.close(); servers.delete(root); rmSync(root, { recursive: true, force: true }); });
  return { root, project, parent, child, lone, server };
}

/**
 * The first Run of Child's responsible, running and kept alive for serve by its manager's lock (taken before it
 * runs), with its start applied to Child as a pass applies it: Child's current hash, the placement, and the
 * credential its commands carry, as CLI environment and as an HTTP header.
 */
async function childRun(t: TestContext, h: Awaited<ReturnType<typeof setup>>) {
  const id = 'R1';
  mkdirSync(runFolder(h.root, id), { recursive: true, mode: 0o700 });
  const lock = openSync(join(runFolder(h.root, id), RUN_FILES.managerLock), constants.O_RDWR | constants.O_CREAT, 0o600);
  assert.equal(tryLock(lock), true);
  t.after(() => { unlock(lock); closeSync(lock); });
  const people = new PlacementStore(h.root);
  const placement = people.createAndPlace({ taskId: h.child.id, profileKey: 'codex', responsible: true }).placement;
  people.close();
  const store = new RunStore(h.root, { busyTimeoutMs: 10_000 });
  try {
    const run = store.write(tx => {
      const created = createFixtureRun(store, tx, { task: h.child.id, placementId: placement.id,
        requestId: crypto.randomUUID(), agent: 'codex', role: 'owner', caller: null, resumes: null, continues: false,
        session: null, cwd: h.root,
        launch: { adapter: 'codex', env: [], argv: ['NEVER-EXECUTE'], path: '/bin', values: {} } },
      'Owner prompt');
      tx.update({ ...created, state: 'running', started_at: new Date().toISOString() });
      return created;
    });
    assert.equal(run.id, id);
  } finally { store.close(); }
  reconcileLinks(h.root, h.project);
  const token = issueRunCredential(h.root, id);
  return { placement, hash: (await new ControlTaskStore(h.root).get(h.child.id)).hash,
    env: { ALPACAWORK_RUN: id, ALPACAWORK_RUN_TOKEN: token }, headers: { authorization: `Alpacawork-Run ${id}:${token}` } };
}

/** One CLI command as a person runs it, outside any Run; its JSON answer. */
async function cli(root: string, ...args: string[]) {
  const mutation = ['new', 'move', 'report', 'update', 'set', 'assign'].includes(args[1] ?? '');
  const command = mutation && !args.includes('--op-id') ? [...args, '--op-id', crypto.randomUUID()] : args;
  const result = await cliRun(servers.get(root)!, command);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('move uses the same command through HTTP and CLI', async t => {
  const h = await setup(t);
  const response = await fetch(new URL('/api/task/move', h.server.url), { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: h.child.id, parent: h.project, expectedTaskHash: h.child.hash }) });
  assert.equal(response.status, 200);
  const moved = taskWriteResultSchema.parse(await response.json());
  assert.equal(moved.task.parentId, h.project);
  assert.equal(moved.task.path, h.child.path);
  const again = await cli(h.root, 'task', 'move', '--task', h.child.id, '--parent', h.parent.id,
    '--expected-task-hash', moved.task.hash);
  assert.equal(again.task.parentId, h.parent.id);
});

test('HTTP and CLI refuse a description without a title, or blank report text, without writing a log', async t => {
  const h = await setup(t);
  const beforeLogs = currentTaskLog(h.root, h.child.id).length;
  const valid = join(h.root, 'valid-description.md');
  const blank = join(h.root, 'blank-description.md');
  writeFileSync(valid, 'Evidence is ready.');
  writeFileSync(blank, ' \n ');
  for (const [title, descriptionFile] of [[undefined, valid], ['  ', valid], ['Ready', blank]] as const) {
    const description = descriptionFile === undefined ? undefined : readFileSync(descriptionFile, 'utf8');
    const response = await fetch(new URL('/api/task/report', h.server.url), { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: h.child.id, state: 'doing', title, description, opId: crypto.randomUUID(),
        expectedTaskHash: h.child.hash }) });
    assert.equal(response.status, 400, `HTTP accepted title=${JSON.stringify(title)} description=${JSON.stringify(description)}`);
    const args = ['task', 'report', '--task', h.child.id, '--state', 'doing', '--expected-task-hash', h.child.hash,
      '--op-id', crypto.randomUUID()];
    if (title !== undefined) args.push('--title', title);
    if (descriptionFile !== undefined) args.push('--description-file', descriptionFile);
    const cliResult = await cliRun(h.server.url, args);
    assert.notEqual(cliResult.code, 0, `CLI accepted title=${JSON.stringify(title)} description=${JSON.stringify(description)}`);
  }
  assert.equal((await new ControlTaskStore(h.root).snapshot()).tasks.find(task => task.id === h.child.id)?.meta.log.length,
    beforeLogs);
});

test('HTTP report confirms the commit without invoking return delivery', async t => {
  const h = await setup(t);
  const run = await childRun(t, h);
  const original = ReturnRouter.prototype.route;
  ReturnRouter.prototype.route = async () => { throw new Error('Injected return routing fault'); };
  try {
    const response = await fetch(new URL('/api/task/report', h.server.url), {
      method: 'POST', headers: { 'content-type': 'application/json', ...run.headers },
      body: JSON.stringify({ task: h.child.id, state: 'doing', title: 'Committed report',
        description: 'The child is under way.', opId: crypto.randomUUID(), expectedTaskHash: run.hash }),
    });
    assert.equal(response.status, 200);
    const answer = await response.json();
    assert.equal(answer.task.hash, currentTaskHash(h.root, h.child.id));
    assert.equal(answer.followup, undefined);
    const saved = await new ControlTaskStore(h.root).snapshot();
    assert.equal(saved.tasks.find(item => item.id === h.child.id)?.meta.log.at(-1)?.title,
      'Committed report');
  } finally { ReturnRouter.prototype.route = original; }
});

test('CLI report replays its committed receipt independently of return routing', async t => {
  const h = await setup(t);
  const run = await childRun(t, h);
  const descriptionFile = join(h.root, 'report-description.md');
  writeFileSync(descriptionFile, 'The child is under way.');
  const original = ReturnRouter.prototype.route;
  ReturnRouter.prototype.route = async () => { throw new Error('Injected return routing fault'); };
  const args = ['task', 'report', '--task', h.child.id, '--state', 'doing', '--title', 'CLI committed report',
    '--description-file', descriptionFile, '--expected-task-hash', run.hash, '--op-id', crypto.randomUUID()];
  let answer;
  try {
    const first = await cliRun(h.server.url, args, run.env);
    assert.equal(first.code, 0, first.stderr);
    answer = JSON.parse(first.stdout);
    const replay = await cliRun(h.server.url, args, run.env);
    assert.equal(replay.code, 0, replay.stderr);
    assert.deepEqual(JSON.parse(replay.stdout), answer);
  } finally { ReturnRouter.prototype.route = original; }
  assert.equal('log' in answer.task, false);
  assert.equal(currentTaskLog(h.root, h.child.id).at(-1)!.title, 'CLI committed report');
  assert.equal(answer.followup, undefined);
});

test('report HTTP returns the shared Task and report outcome contract', async t => {
  const h = await setup(t);
  const run = await childRun(t, h);
  const response = await fetch(new URL('/api/task/report', h.server.url), { method: 'POST',
    headers: { 'content-type': 'application/json', ...run.headers },
    body: JSON.stringify({ task: h.child.id, state: 'doing', title: 'Working', description: 'Work continues.',
      opId: crypto.randomUUID(), expectedTaskHash: run.hash }) });
  assert.equal(response.status, 200);
  const result = taskReportResultSchema.parse(await response.json());
  assert.equal(result.task.state, 'doing');
  assert.equal(result.outcome.kind, 'recorded');
});

test('request HTTP rejects an arbitrary placement target before admission', async t => {
  const h = await setup(t);
  const response = await fetch(new URL('/api/task/request', h.server.url), { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: h.child.id,
      body: 'Draft', opId: 'Q1', expectedTaskHash: h.child.hash,
      expectedPlacementRevision: 1, agent: 'P1' }) });
  assert.equal(response.status, 404);
  assert.equal(problemSchema.parse(await response.json()).error.code, 'not_found');
  assert.deepEqual((await readControlTree(h.root)).requests, []);
});

test('an unassigned Task refuses HTTP request without creating a Run', async t => {
  const h = await setup(t);
  const response = await fetch(new URL('/api/task/request', h.server.url), { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: h.child.id,
      body: 'Draft', opId: 'Q-unassigned', expectedTaskHash: h.child.hash,
      expectedPlacementRevision: 1 }) });
  assert.equal(response.status, 409);
  assert.equal(requestRejectionSchema.parse(await response.json()).error.code, 'responsible_missing');
  const index = projectedIndexSchema.parse(await (await fetch(new URL('/api/workspace/live', h.server.url))).json());
  assert.deepEqual(index.runs, []);
  assert.deepEqual((await readControlTree(h.root)).requests, []);
});

test('place-agent HTTP creates the current responsible person without launching', async t => {
  const h = await setup(t);
  // A person manages responsibility on a child as well as on a top Task; neither placement launches a Run.
  const below = await fetch(new URL('/api/agent/assign', h.server.url), { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: h.child.id,
      role: 'responsible', profile: 'codex', expectedTaskHash: h.child.hash }) });
  assert.equal(below.status, 200);
  const belowReceipt = taskPlacementResultSchema.parse(await below.json());
  const belowPlacement = placeAgentReceiptSchema.parse(belowReceipt.agent).placement;
  assert.deepEqual([belowPlacement.taskId, belowPlacement.responsible, belowReceipt.task.state], [h.child.id, true, 'todo']);
  const response = await fetch(new URL('/api/agent/assign', h.server.url), { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: h.lone.id,
      role: 'responsible', profile: 'codex', expectedTaskHash: h.lone.hash }) });
  assert.equal(response.status, 200);
  const firstReceipt = taskPlacementResultSchema.parse(await response.json());
  const placed = placeAgentReceiptSchema.parse(firstReceipt.agent);
  assert.deepEqual([placed.agent.id, placed.placement.taskId, placed.placement.responsible],
    [placed.placement.agentId, h.lone.id, true]);
  const replacement = await fetch(new URL('/api/agent/assign', h.server.url), { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: h.lone.id,
      role: 'responsible', profile: 'claude', expectedTaskHash: firstReceipt.task.hash,
      replace: placed.placement.id, expectedPlacementRevision: placed.placement.revision }) });
  assert.equal(replacement.status, 200);
  const changed = placeAgentReceiptSchema.parse((await replacement.json()).agent);
  assert.equal(changed.previousPlacement?.active, false);
  assert.equal(changed.placement.responsible, true);
});

test('periodic delivery waits for the admitted placement transaction', async t => {
  const h = await setup(t);
  const originalPlace = PlacementCommands.prototype.placeNewResponsible;
  const originalDeliver = ReturnRouter.prototype.route;
  let entered!: () => void, release!: () => void;
  const enteredWrite = new Promise<void>(resolve => { entered = resolve; });
  const heldWrite = new Promise<void>(resolve => { release = resolve; });
  let deliveries = 0;
  PlacementCommands.prototype.placeNewResponsible = async function (...args) {
    deliveries = 0;
    entered();
    await heldWrite;
    return originalPlace.apply(this, args);
  };
  ReturnRouter.prototype.route = async function (...args) {
    deliveries++;
    return originalDeliver.apply(this, args);
  };
  try {
    const response = fetch(new URL('/api/agent/assign', h.server.url), { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: h.lone.id,
        role: 'responsible', profile: 'codex', expectedTaskHash: h.lone.hash }) });
    await enteredWrite;
    // This is the same notification that a filesystem write gives the timer.
    h.server.context.changed?.();
    await delay(POLL_INTERVAL_MS + 200);
    assert.equal(deliveries, 0, 'the timer must not repeat delivery during the write');
    release();
    const answered = await response; assert.equal(answered.status, 200); await answered.arrayBuffer();
    for (let n = 0; deliveries === 0 && n < 100; n++) await delay(20);
    assert.ok(deliveries >= 1, 'the existing serve pass owns delivery');
  } finally {
    release();
    PlacementCommands.prototype.placeNewResponsible = originalPlace;
    ReturnRouter.prototype.route = originalDeliver;
  }
});

test('HTTP placement waits for an earlier periodic delivery', async t => {
  const h = await setup(t);
  const originalPlace = PlacementCommands.prototype.placeNewResponsible;
  const originalDeliver = ReturnRouter.prototype.route;
  let enteredDelivery!: () => void, releaseDelivery!: () => void;
  const deliveryStarted = new Promise<void>(resolve => { enteredDelivery = resolve; });
  const heldDelivery = new Promise<void>(resolve => { releaseDelivery = resolve; });
  let first = true, placementStarted = false;
  ReturnRouter.prototype.route = async function (...args) {
    if (first) {
      first = false;
      const [work, shouldYield, ordered] = args;
      return originalDeliver.call(this, work, shouldYield, execute => ordered!(async () => {
        enteredDelivery();
        await heldDelivery;
        return execute();
      }));
    }
    return originalDeliver.apply(this, args);
  };
  PlacementCommands.prototype.placeNewResponsible = async function (...args) {
    placementStarted = true;
    return originalPlace.apply(this, args);
  };
  try {
    h.server.context.changed?.();
    await deliveryStarted;
    const response = fetch(new URL('/api/agent/assign', h.server.url), { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: h.lone.id,
        role: 'responsible', profile: 'codex', expectedTaskHash: h.lone.hash }) });
    await delay(100);
    assert.equal(placementStarted, false, 'the prior delivery finishes before the write starts');
    releaseDelivery();
    const answered = await response; assert.equal(answered.status, 200); await answered.arrayBuffer();
    assert.equal(placementStarted, true);
  } finally {
    releaseDelivery();
    PlacementCommands.prototype.placeNewResponsible = originalPlace;
    ReturnRouter.prototype.route = originalDeliver;
  }
});

test('stalled POST bodies cannot starve periodic delivery or an external SSE update', async t => {
  const clock = receiverClock(t);
  const h = await setup(t), controller = new AbortController();
  const held: ClientRequest[] = [];
  const originalDeliver = ReturnRouter.prototype.route;
  let periodicCalls = 0;
  ReturnRouter.prototype.route = async function (...args) {
    periodicCalls++;
    return originalDeliver.apply(this, args);
  };
  const port = Number(new URL(h.server.url).port);
  const hold = async () => {
    const admitted = new Promise<void>(resolve => h.server.server.once('request', () => resolve()));
    const request = httpRequest({ host: '127.0.0.1', port, path: '/api/task/new', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '1000000' } });
    request.on('error', () => {});
    request.write('{');
    request.flushHeaders();
    held.push(request);
    await admitted;
    return request;
  };
  try {
    const stream = await openIndexStream(new URL('/api/events', h.server.url), controller.signal);
    const nextSnapshot = stream.index;
    await nextSnapshot();
    let current = await hold();
    const beforeEdit = periodicCalls;
    const started = performance.now();
    await new ControlTaskCommands(h.root, { kind: 'human' }).update({ id: h.child.id,
      title: 'External edit during held POST', expectedTaskHash: h.child.hash });
    let updated: Awaited<ReturnType<typeof nextSnapshot>> | undefined;
    const publication = nextSnapshot().then(value => { updated = value; });
    await clock.until(() => updated !== undefined && periodicCalls > beforeEdit,
      'periodic delivery and the external edit progress during the held POST', 4_000);
    await publication;
    assert.ok(updated?.tasks.some(task => task.id === h.child.id && task.title === 'External edit during held POST'),
      'periodic refresh must publish the external edit within four seconds');
    assert.ok(periodicCalls > beforeEdit, 'periodic delivery must run before the first held POST ends');
    const observedMs = performance.now() - started;
    assert.ok(observedMs < 4_000);
    t.diagnostic(`periodic delivery and external SSE update took ${observedMs} ms during a held POST`);
    current.destroy();
    current = await hold();
    const beforeChain = periodicCalls;
    h.server.context.changed?.();
    // Advance the same overlap window without waiting for wall-clock seconds.
    // Each request is admitted by the actual HTTP listener before the clock advances.
    for (let i = 0; i < 3; i++) {
      await clock.advance(2_250);
      const next = await hold();
      await clock.advance(750);
      current.destroy();
      current = next;
    }
    await clock.until(() => periodicCalls > beforeChain, 'delivery runs during chained POSTs');
    assert.ok(periodicCalls > beforeChain, 'periodic delivery must run during the chained POSTs');
    t.diagnostic(`periodic delivery ran ${periodicCalls - beforeChain} times during chained POSTs`);
  } finally {
    for (const request of held) request.destroy();
    controller.abort();
    ReturnRouter.prototype.route = originalDeliver;
  }
});

test('tree, list and get read the same Tasks with HTTP file URLs', async t => {
  const h = await setup(t);
  const tree = projectedIndexSchema.parse(await (await fetch(new URL('/api/workspace/live', h.server.url))).json());
  const listed = await cli(h.root, 'task', 'list');
  const task = (await cli(h.root, 'task', 'get', '--task', h.child.id)).task;
  // The screen's index and the CLI name a Task by the same T number.
  const work = (rows: Pick<TaskRowDTO, 'id' | 'kind' | 'parentId' | 'lifecycle' | 'title' | 'state'>[]) =>
    rows.filter(row => row.kind === 'task').map(({ id, kind, parentId, lifecycle, title, state }) =>
      ({ id, kind, parentId, lifecycle, title, state })).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  assert.deepEqual(work(listed.tasks), work(tree.tasks));
  assert.deepEqual(work(listed.tasks).map(row => row.id), [h.parent.id, h.child.id, h.lone.id]);
  assert.deepEqual(tree.profiles.map(profile => profile.key), ['claude', 'codex']);
  // The screen's opened view is the same document the CLI reads.
  const full = taskProjectedViewSchema.parse(await (await fetch(new URL(`/api/task/view?task=${h.child.id}`, h.server.url))).json()).task;
  assert.equal(full.id, h.child.id);
  assert.equal(full.parentId, h.parent.id);
  assert.deepEqual(task, { id: h.child.id, kind: full.kind, projectId: h.project, parentId: h.parent.id,
    userRequested: full.userRequested, folder: new URL(`/api/tasks/${h.child.id}/file?path=`, h.server.url).href,
    lifecycle: full.lifecycle, title: full.title, state: full.state, baseState: full.baseState, hold: full.hold,
    hash: full.hash, values: full.values, fields: { fields: [...DEFAULT_SCHEMA], from: null } });
  // A body left unread holds serve's close for four seconds.
  const status = async (answer: Promise<Response>) => { const read = await answer; await read.arrayBuffer(); return read.status; };
  assert.equal(await status(fetch(new URL('/api/run', h.server.url), { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{}' })), 404);
  for (const path of ['/api/task/get?task=P1', '/api/task/list', '/api/field/get'])
    assert.equal(await status(fetch(new URL(path, h.server.url))), 200, path);
});

test('an SSE client closed during its initial database read is never opened or written later', { timeout: 8_000 }, async t => {
  const h = await setup(t);
  const originalRead = ServeLifecycle.prototype.run;
  const originalWrite = ServerResponse.prototype.write;
  const originalWriteHead = ServerResponse.prototype.writeHead;
  let captured!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { captured = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let reads = 0, closedWrites = 0, closedOpens = 0;
  const socket = new Socket();
  try {
    ServeLifecycle.prototype.run = async function (work) {
      if (this.workspace === h.root) {
        reads++;
        captured();
        await held;
      }
      return originalRead.call(this, work);
    };
    ServerResponse.prototype.write = function (...args: Parameters<typeof originalWrite>) {
      if (this.destroyed && this.req?.url === '/api/events') closedWrites++;
      return originalWrite.apply(this, args);
    } as typeof originalWrite;
    ServerResponse.prototype.writeHead = function (...args: Parameters<typeof originalWriteHead>) {
      if (this.destroyed && this.req?.url === '/api/events') closedOpens++;
      return originalWriteHead.apply(this, args);
    } as typeof originalWriteHead;
    h.server.context.changed?.();
    const port = Number(new URL(h.server.url).port);
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.connect(port, '127.0.0.1', resolve);
    });
    socket.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    await Promise.race([entered, delay(3_000).then(() => { throw new Error('Initial SSE read did not begin'); })]);
    socket.destroy();
    await delay(50);
    release();
    await delay(POLL_INTERVAL_MS + 300);
    assert.ok(reads > 0);
    assert.equal(closedOpens, 0, 'a closed initial subscriber must not be opened');
    assert.equal(closedWrites, 0, 'a closed initial subscriber must not receive an event or heartbeat');
  } finally {
    socket.destroy();
    release();
    ServeLifecycle.prototype.run = originalRead;
    ServerResponse.prototype.write = originalWrite;
    ServerResponse.prototype.writeHead = originalWriteHead;
  }
});

test('SSE notices an external Run database commit without a Task file change', async t => {
  const h = await setup(t), controller = new AbortController();
  const people = new PlacementStore(h.root);
  const placement = people.createAndPlace({ taskId: h.child.id, profileKey: 'codex', responsible: true }).placement;
  people.close();
  const received: { generation: string; rev: number; runs: unknown[] }[] = [];
  const deadline = setTimeout(() => controller.abort(), 8_000);
  try {
    const stream = await openIndexStream(new URL('/api/events', h.server.url), controller.signal);
    const nextSnapshot = async () => {
      const snapshot = await stream.index();
      received.push({ generation: snapshot.generation, rev: snapshot.rev, runs: snapshot.runs });
      return snapshot;
    };
    assert.deepEqual((await nextSnapshot()).runs, []);
    const store = new RunStore(h.root, { busyTimeoutMs: 10_000 });
    try {
      const id = store.write(tx => {
        const requestId = globalThis.crypto.randomUUID();
        tx.insertRequest({ id: requestId, taskId: h.child.id, placementId: placement.id,
          placementRevision: placement.revision, taskHash: h.child.hash, waitCycleId: null, headRunId: null, mode: 'new',
          body: 'Synthetic ended history', purpose: 'instruction', author: { kind: 'human' },
          submittedAt: new Date().toISOString(), deliveryState: 'queued' });
        const created = tx.create({ task: h.child.id, placementId: placement.id, requestId,
          agent: 'codex', role: 'owner', caller: null, resumes: null, continues: false,
          session: null, cwd: h.root,
          launch: { adapter: 'codex', env: [], argv: ['NEVER-EXECUTE'], path: '/bin', values: {}} }, 'Synthetic ended history');
        const running = { ...created, state: 'running' as const, started_at: new Date().toISOString() };
        tx.update(running);
        tx.finish({ ...running, state: 'succeeded', ended_at: new Date().toISOString() }, { state: 'present', text: 'fixture reply' });
        return created.id;
      });
      let current = await nextSnapshot();
      while (!current.runs.some(run => run.id === id)) current = await nextSnapshot();
      assert.equal(current.runs.find(run => run.id === id)?.session, null);
      // Updating an existing row does not touch a Run folder or a Task document.
      store.write(tx => tx.update({ ...tx.get(id)!, session: { provider: 'codex', id: 'synthetic-session' } }));
      while (current.runs.find(run => run.id === id)?.session?.id !== 'synthetic-session') current = await nextSnapshot();
      assert.equal(current.runs.find(run => run.id === id)?.session?.id, 'synthetic-session');
      assert.ok(store.read().every(run => run.state === 'succeeded'));
    } finally { store.close(); }
  } catch (error) {
    try {
      const destination = mkdtempSync(join(tmpdir(), 'alpacawork-sse-failure-'));
      const capture = preserveFailureWorkspace(h.root, join(destination, 'workspace'));
      writeFileSync(join(destination, 'received-snapshots.json'), JSON.stringify({
        url: h.server.url, received, error: String(error), capture,
      }, null, 2));
      t.diagnostic(`SSE failure evidence: ${destination}`);
    } catch (captureError) { t.diagnostic(`SSE failure evidence unavailable: ${captureError}`); }
    throw error;
  } finally { clearTimeout(deadline); controller.abort(); }
});

test('an authenticated responsible Run may edit its values and title through HTTP CLI', async t => {
  const h = await setup(t);
  const { placement, hash, env } = await childRun(t, h);
  const valuesFile = join(h.root, 'run-values.json');
  writeFileSync(valuesFile, JSON.stringify({ notes: 'Owner text' }));
  const values = await cliRun(h.server.url, ['task', 'update', '--task', h.child.id,
    '--values-file', valuesFile, '--expected-task-hash', hash, '--op-id', 'owner-values'], env);
  assert.equal(values.code, 0, values.stderr);
  const updated = JSON.parse(values.stdout).task;
  assert.deepEqual(updated.values, { notes: 'Owner text' });
  assert.deepEqual(currentTaskLog(h.root, h.child.id).at(-1)!.actor, { kind: 'placement', placementId: placement.id });
  const title = await cliRun(h.server.url, ['task', 'update', '--task', h.child.id,
    '--title', 'Owner title', '--expected-task-hash', updated.hash, '--op-id', 'owner-title'], env);
  assert.equal(title.code, 0, title.stderr);
  assert.deepEqual(currentTaskLog(h.root, h.child.id).at(-1)!.actor, { kind: 'placement', placementId: placement.id });
  const saved = await cli(h.root, 'task', 'get', '--task', h.child.id);
  assert.equal(saved.task.title, 'Owner title');
  assert.deepEqual(saved.task.values, { notes: 'Owner text' });
});

test('an existing SSE subscriber receives CLI task, project and settings commits', { timeout: 15_000 }, async t => {
  const h = await setup(t), controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 12_000);
  try {
    const stream = await openIndexStream(new URL('/api/events', h.server.url), controller.signal);
    const first = await stream.index();
    const edited = await cli(h.root, 'task', 'update', '--task', h.child.id,
      '--title', 'CLI edited title', '--expected-task-hash', h.child.hash);
    let current = first;
    while (current.tasks.find(task => task.id === h.child.id)?.title !== 'CLI edited title')
      current = await stream.index();
    assert.equal(current.tasks.find(task => task.id === h.child.id)?.hash, edited.task.hash);
    const assigned = await cli(h.root, 'agent', 'assign', '--task', h.lone.id,
      '--role', 'responsible', '--profile', 'codex', '--expected-task-hash', h.lone.hash,
      '--op-id', 'sse-placement');
    const placementId = assigned.agent.placement.id;
    while (!current.placements.some(item => item.id === placementId)) current = await stream.index();
    assert.equal(current.placements.find(item => item.id === placementId)?.agentId, assigned.agent.agent.id);
    const settings = await readServerSettings(h.root);
    const response = await fetch(new URL('/api/config/set', h.server.url), { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: JSON.stringify({ limits: { ...settings.limits, parallel: 3 } }),
        agents: settings.agentsText, expectedConfigHash: settings.hash }) });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    const configured = projectedIndexSchema.parse(await (await fetch(new URL('/api/workspace/live', h.server.url))).json());
    while (current.sourcePv < configured.sourcePv) current = await stream.index();
    // A project's schema changes its Tasks' context: the published view version tells an opened view to read again.
    const detail = current.requiredPv.view[h.lone.id] ?? 0;
    const projectHash = (await cli(h.root, 'task', 'get', '--task', h.project)).task.hash;
    await cli(h.root, 'field', 'use', '--task', h.project, '--fields', [...DEFAULT_SCHEMA].reverse().join(','),
      '--expected-task-hash', projectHash);
    const fresh = projectedIndexSchema.parse(await (await fetch(new URL('/api/workspace/live', h.server.url))).json());
    while (current.sourcePv < fresh.sourcePv) current = await stream.index();
    assert.ok((current.requiredPv.view[h.lone.id] ?? 0) > detail, 'the schema commit requires an opened view to read again');
    assert.equal(current.tasks.find(task => task.id === h.lone.id)?.hash, assigned.task.hash);
    assert.deepEqual(current, fresh);
  } finally { clearTimeout(deadline); controller.abort(); }
});

test('SSE retains its complete index across a transient database read failure', { timeout: 12_000 }, async t => {
  const h = await setup(t), controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 10_000);
  const original = DatabaseWorkspaceRecords.prototype.advance;
  try {
    const stream = await openIndexStream(new URL('/api/events', h.server.url), controller.signal);
    const first = await stream.index();
    let failed = false;
    DatabaseWorkspaceRecords.prototype.advance = function (...args: Parameters<typeof original>) {
      if (this.root === h.root && !failed) {
        failed = true;
        throw new Problem(PROBLEM_CODE.busy, 'Synthetic busy read');
      }
      return original.apply(this, args);
    };
    h.server.context.changed?.();
    const retained = projectedIndexSchema.parse(await (await fetch(new URL('/api/workspace/live', h.server.url))).json());
    for (let attempt = 0; !failed && attempt < 20; attempt++) await delay(25);
    assert.equal(failed, true, 'the refresh attempted a read');
    assert.deepEqual(retained.tasks, first.tasks, 'a failed refresh retains the complete published Task list');
    DatabaseWorkspaceRecords.prototype.advance = original;
    const updated = await cli(h.root, 'task', 'update', '--task', h.child.id,
      '--title', 'Recovered update', '--expected-task-hash', h.child.hash);
    let current = first;
    while (current.tasks.find(task => task.id === h.child.id)?.title !== 'Recovered update')
      current = await stream.index();
    assert.equal(current.tasks.length, first.tasks.length);
    assert.equal(current.tasks.find(task => task.id === h.child.id)?.hash, updated.task.hash);
  } finally {
    DatabaseWorkspaceRecords.prototype.advance = original;
    clearTimeout(deadline);
    controller.abort();
  }
});

test('completion reports require their own title and body through CLI and HTTP before saving', async t => {
  for (const userRequested of [false, true]) await t.test(`userRequested=${userRequested}`, async t => {
    const h = await setup(t);
    const target = userRequested ? h.lone : h.child;
    const run = await childRun(t, { ...h, child: target });
    const beforeLogs = currentTaskLog(h.root, target.id).length;
    const values = { conclusion: 'The result is in the Task values.', left_running: ['none'] };
    const base = { task: target.id, state: 'done', expectedTaskHash: run.hash, values };
    for (const text of [undefined, '', ' \n\t', null]) {
      const input = { ...base, title: 'Ready', description: text, opId: crypto.randomUUID() };
      const response = await fetch(new URL('/api/task/report', h.server.url), { method: 'POST',
        headers: { 'content-type': 'application/json', ...run.headers }, body: JSON.stringify(input) });
      assert.equal(response.status, 400, JSON.stringify(await response.json()));
      const args = ['task', 'report', '--task', target.id, '--state', 'done', '--title', 'Ready',
        '--expected-task-hash', run.hash];
      if (text !== undefined) args.push('--description-file', '-');
      const command = await cliRun(h.server.url, args, run.env, text ?? '');
      assert.equal(command.code, 2, command.stdout + command.stderr);
      assert.equal(currentTaskHash(h.root, target.id), run.hash);
      assert.equal(currentTaskLog(h.root, target.id).length, beforeLogs);
    }
    const missingTitle = await cliRun(h.server.url, ['task', 'report', '--task', target.id, '--state', 'done',
      '--description-file', '-', '--expected-task-hash', run.hash], run.env, 'The result is ready.');
    assert.equal(missingTitle.code, 2, missingTitle.stdout + missingTitle.stderr);
    const command = await cliRun(h.server.url, ['task', 'report', '--task', target.id, '--state', 'done',
      '--title', 'Ready', '--description-file', '-', '--expected-task-hash', run.hash], run.env,
    'The work is complete. Its result was checked. Nothing remains.');
    assert.equal(command.code, 0, command.stdout + command.stderr);
    assert.equal(JSON.parse(command.stdout).task.state, userRequested ? 'waiting' : 'done');
    assert.equal(currentTaskLog(h.root, target.id).at(-1)?.description,
      'The work is complete. Its result was checked. Nothing remains.');
  });
});

test('a pending projected read asks routing to yield until its response finishes', async t => {
  const h = await setup(t), originalRoute = ReturnRouter.prototype.route, originalRead = h.server.context.readFrame!;
  let routeStarted!: () => void, continueRoute!: () => void, readStarted!: () => void, continueRead!: () => void;
  const routed = new Promise<void>(resolve => { routeStarted = resolve; });
  const routingGate = new Promise<void>(resolve => { continueRoute = resolve; });
  const reading = new Promise<void>(resolve => { readStarted = resolve; });
  const readGate = new Promise<void>(resolve => { continueRead = resolve; });
  let shouldYield: ((resumable: boolean) => boolean) | undefined;
  ReturnRouter.prototype.route = async function (...args) {
    shouldYield = args[1]; routeStarted(); await routingGate;
    return originalRoute.apply(this, args);
  };
  h.server.context.readFrame = async () => { readStarted(); await readGate; return originalRead(); };
  try {
    h.server.context.changed?.();
    await routed;
    const response = fetch(new URL(`/api/task/view?task=${h.lone.id}`, h.server.url));
    await reading;
    assert.equal(shouldYield?.(true), true, 'routing gives way while a view is waiting');
    continueRead();
    const answered = await response;
    assert.equal(answered.status, 200); await answered.arrayBuffer();
    assert.equal(shouldYield?.(true), false, 'a completed view releases routing pressure');
  } finally {
    continueRead(); continueRoute();
    ReturnRouter.prototype.route = originalRoute; h.server.context.readFrame = originalRead;
  }
});
