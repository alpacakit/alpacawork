import { commandFetch as fetch } from './helpers/command-fetch.ts';
import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { stringify } from 'yaml';
import type { RunRecord } from '@alpacawork/contract/run';
import { managerScript } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { ProjectionOwner } from '@alpacawork/backend/test-dist/receiver/projection-owner.js';
import { DatabaseWorkspaceRecords } from '@alpacawork/backend/test-dist/receiver/workspace-records.js';
import { fields } from './runs-fixtures.ts';
import { RunStore } from '@alpacawork/runs';
import { createFixtureRun } from './helpers/run-fixture.ts';
import { receiverClock } from './helpers/receiver-clock.ts';
/** Formal command, current-read, file-publication and Push boundaries. All faults live in this isolated subject. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { ServerResponse } from 'node:http';
import { ControlStore, controlChanges } from '@alpacawork/db';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ControlTaskStore, TaskRepository } from '@alpacawork/backend/test-dist/control/task-store.js';
import { startServer, type ServerOptions } from '@alpacawork/backend/test-dist/receiver/server.js';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import { EventJournal, executionFolder, identityOf } from '@alpacawork/backend/test-dist/runs/execution-files.js';
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { reserveAttempt, StopDeliveryOwner } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { PushStore } from '@alpacawork/backend/test-dist/receiver/push.js';
import { projectedIndexSchema, taskWriteResultSchema, taskProjectedViewSchema } from '@alpacawork/contract/control';
import { DEFAULT_LIMITS } from '@alpacawork/contract';
import { assignResponsible, initializeControlFixture } from './helpers/control-fixture.ts';
import { cliRun } from './helpers/http-cli.ts';
import { openIndexStream } from './index-stream.ts';
import { POLL_INTERVAL_MS } from '@alpacawork/backend/test-dist/poll-interval.js';

/** The root project a new workspace starts with; the fixture's project is below it. */
const ROOT_PROJECT = 'P1';
const deferred = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };
function pauseCurrentReads(t: TestContext, app: Awaited<ReturnType<typeof startServer>>, after: () => Promise<void>): void {
  const projection = app.feed()!;
  const read = projection.read;
  t.mock.method(projection, 'read', async function(this: ProjectionOwner, ...args: Parameters<ProjectionOwner['read']>) {
    const frame = await read.apply(this, args);
    await after();
    return frame;
  });
}

async function fixture(t: TestContext, options: ServerOptions = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'update-boundary-')));
  writeFileSync(join(root, 'config.yaml'), stringify({ agents: { "codex": fixtureAgentSetting('codex') } }));
  const project = initializeControlFixture(root);
  const task = (await new ControlTaskCommands(root, { kind: 'human' }).create({ parentId: project, userRequested: null, tasks: [{ title: 'Original' }] })).tasks[0];
  const app = await startServer(root, 0, options);
  const expiry = setTimeout(() => void app.close(), 60_000);
  t.after(async () => { clearTimeout(expiry); await app.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, project, task, app };
}
async function post(url: string, path: string, input: object, opId: string = randomUUID()) {
  const response = await fetch(new URL('/api/' + path, url), { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Alpacawork-Op-Id': opId }, body: JSON.stringify(input), signal: AbortSignal.timeout(10_000) });
  return { status: response.status, body: await response.json() };
}
const read = async (url: string, path: string) => {
  const response = await fetch(new URL('/api/' + path, url), { signal: AbortSignal.timeout(10_000) });
  return { status: response.status, body: await response.json() };
};

test('Q3: old assets without a fixed ID cannot execute a DB mutation or create a receipt', async t => {
  const h = await fixture(t);
  const response = await fetch(new URL('/api/commands/task/update', h.app.url), { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: h.task.id, title: 'Must not save', expectedTaskHash: h.task.hash }) });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.retry, 'check');
  assert.equal((await new ControlTaskStore(h.root).get(h.task.id)).hash, h.task.hash);
  const db = new ControlStore(h.root, undefined, true);
  try { assert.equal(db.read(db => db.prepare('SELECT count(*) AS n FROM cli_operations').get()!.n), 0); } finally { db.close(); }
});

test('HTTP and CLI share immutable admission; one Task codec, no after snapshot, CAS and ID collision', async t => {
  const h = await fixture(t), opId = randomUUID();
  let snapshots = 0, wholeProjects = 0, writing = false;
  const write = ControlStore.prototype.writeOperationAsync;
  t.mock.method(ControlStore.prototype, 'writeOperationAsync', function(this: ControlStore, input, callback) {
    return write.call(this, input, async (...args) => { writing = true; try { return await callback(...args); } finally { writing = false; } });
  });
  const snapshot = TaskRepository.prototype.snapshot;
  t.mock.method(TaskRepository.prototype, 'snapshot', function(this: TaskRepository, project?: string, taskIds?: readonly string[]) {
    if (writing) { snapshots++; if (!taskIds) wholeProjects++; } return snapshot.call(this, project, taskIds);
  });
  const input = { task: h.task.id, title: 'Committed', expectedTaskHash: h.task.hash };
  const first = await post(h.app.url, 'commands/task/update', input, opId);
  assert.equal(first.status, 200);
  const saved = taskWriteResultSchema.parse(first.body).task;
  // A write answers the Task it saved; its folder is only in task get/view.
  assert.equal(saved.folder, undefined);
  assert.equal(saved.files, undefined);
  // The command's read point and TaskTransition's, both of the written Task's branch before the save; the response
  // reads the saved Task alone.
  assert.equal(wholeProjects, 0, 'an update reads no whole project');
  assert.equal(snapshots, 2, 'no snapshot after the write; the response is targeted');
  const next = await post(h.app.url, 'commands/task/update', { task: h.task.id, title: 'Another writer', expectedTaskHash: saved.hash });
  assert.equal(next.status, 200);
  const cli = await cliRun(h.app.url, ['task', 'update', '--task', h.task.id, '--title', 'Committed', '--expected-task-hash', h.task.hash, '--op-id', opId]);
  assert.equal(cli.code, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), first.body);
  assert.deepEqual((await post(h.app.url, 'commands/task/update', input, opId)).body, first.body);
  assert.equal((await post(h.app.url, 'commands/task/update', { ...input, title: 'Different' }, opId)).body.error.code, 'idempotency_conflict');
  assert.equal((await post(h.app.url, 'commands/task/update', input)).status, 409);
  assert.equal((await read(h.app.url, `task/view?task=${h.task.id}`)).body.task.hash, next.body.task.hash);
});

test('operation IDs belong in headers; response and receipt faults roll back before commit', async t => {
  const h = await fixture(t);
  const idInBody = await globalThis.fetch(new URL('/api/commands/task/report', h.app.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Alpacawork-Op-Id': 'header-id' },
    body: JSON.stringify({ task: h.task.id, opId: 'header-id', state: 'doing',
      title: 'Report', description: 'Must not be saved', expectedTaskHash: h.task.hash }),
  });
  assert.equal(idInBody.status, 400);
  const db = new ControlStore(h.root);
  db.write(connection => connection.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON cli_operations BEGIN SELECT RAISE(ABORT,'receipt fault'); END`));
  db.close();
  assert.ok((await post(h.app.url, 'commands/task/update', { task: h.task.id, title: 'Rollback', expectedTaskHash: h.task.hash })).status >= 500);
  assert.equal((await new ControlTaskStore(h.root).get(h.task.id)).hash, h.task.hash);
  const drop = new ControlStore(h.root); drop.write(connection => connection.exec('DROP TRIGGER reject_receipt')); drop.close();
  const get = TaskRepository.prototype.get;
  t.mock.method(TaskRepository.prototype, 'get', function(this: TaskRepository, id: string) {
    const task = get.call(this, id); return { ...task, meta: { ...task.meta, title: '' } };
  });
  assert.ok((await post(h.app.url, 'commands/task/update', { task: h.task.id, title: 'Bad response', expectedTaskHash: h.task.hash })).status >= 500);
  assert.equal((await new ControlTaskStore(h.root).get(h.task.id)).hash, h.task.hash);
});

test('a failed catch-up preserves its published frame and current GETs fail until their arrival floor is available', async t => {
  const h = await fixture(t);
  const made = await post(h.app.url, 'commands/task/new', { kind: 'project', color: '#39659b', parent: ROOT_PROJECT, title: 'Other' });
  assert.equal(made.status, 200);
  const other = String(made.body.task.id);
  const otherTask = (await new ControlTaskCommands(h.root, { kind: 'human' }).create({ parentId: other, userRequested: null,
    tasks: [{ title: 'Other old' }] })).tasks[0];
  await read(h.app.url, 'workspace/live');
  const before = h.app.feed()!.current!;
  const advance = DatabaseWorkspaceRecords.prototype.advance;
  const fault = t.mock.method(DatabaseWorkspaceRecords.prototype, 'advance', function(this: DatabaseWorkspaceRecords, ...args: Parameters<typeof advance>) {
    throw new Error('captured Task read failed');
  });
  assert.equal((await post(h.app.url, 'commands/task/update', { task: otherTask.id, title: 'Other changed', expectedTaskHash: otherTask.hash })).status, 200);
  assert.equal((await post(h.app.url, 'commands/task/update', { task: h.task.id, title: 'Healthy new', expectedTaskHash: h.task.hash })).status, 200);
  assert.equal((await read(h.app.url, 'workspace/live')).status, 503);
  assert.equal((await read(h.app.url, `task/view?task=${otherTask.id}`)).status, 503);
  assert.equal((await read(h.app.url, `task/view?task=${h.task.id}`)).status, 503);
  assert.equal(h.app.feed()!.current, before, 'no partially assembled facts replace the published frame');
  const retained = projectedIndexSchema.parse(JSON.parse(h.app.feed()!.index()));
  assert.equal(retained.tasks.find(task => task.id === h.task.id)?.title, 'Original');
  assert.equal(retained.tasks.find(task => task.id === otherTask.id)?.title, 'Other old');
  fault.mock.restore();
  const recovered = await read(h.app.url, 'workspace/live');
  assert.equal(recovered.status, 200);
  const current = projectedIndexSchema.parse(recovered.body);
  assert.equal(current.tasks.find(task => task.id === h.task.id)?.title, 'Healthy new');
  assert.equal(current.tasks.find(task => task.id === otherTask.id)?.title, 'Other changed');
  const abort = new AbortController();
  const stream = await openIndexStream(new URL('/api/events', h.app.url), abort.signal);
  try { assert.deepEqual(await stream.index(), current); } finally { abort.abort(); }
});

test('a current GET observes its commit floor while an older response still holds its captured frame', async t => {
  const h = await fixture(t), gate = deferred(), entered = deferred();
  let pause = true;
  pauseCurrentReads(t, h.app, async () => { if (pause) { pause = false; entered.release(); await gate.promise; } });
  const oldRead = read(h.app.url, `task/view?task=${h.task.id}`);
  await entered.promise;
  try {
    const saved = await post(h.app.url, 'commands/task/update', { task: h.task.id, title: 'During old read', expectedTaskHash: h.task.hash });
    assert.equal(saved.status, 200, 'a captured read cannot own the writer lane');
    const current = await read(h.app.url, `task/view?task=${h.task.id}`);
    assert.equal(current.status, 200);
    const view = taskProjectedViewSchema.parse(current.body);
    assert.equal(view.task.hash, saved.body.task.hash);
    gate.release();
    const old = taskProjectedViewSchema.parse((await oldRead).body);
    assert.equal(old.task.hash, h.task.hash, 'the older response retains the frame it acquired');
    assert.ok(view.sourcePv > old.sourcePv);
    assert.equal((await read(h.app.url, `task/view?task=${h.task.id}`)).body.task.hash, saved.body.task.hash,
      'finishing the old response cannot replace the newer publication');
  } finally { gate.release(); }
});

test('Q6: response never finishing cannot block the next writer or a current GET', async t => {
  receiverClock(t); // This current read must make progress even before the next periodic tick.
  const h = await fixture(t), end = ServerResponse.prototype.end;
  const held: ServerResponse[] = [];
  t.mock.method(ServerResponse.prototype, 'end', function(this: ServerResponse, ...args: any[]) {
    if (!held.length && this.req.url?.startsWith('/api/commands/task/update')) { held.push(this); return this; }
    return (end as any).apply(this, args);
  });
  const slow = post(h.app.url, 'commands/task/update', { task: h.task.id, title: 'Slow socket write', expectedTaskHash: h.task.hash });
  const deadline = performance.now() + 3000;
  while (!held.length && performance.now() < deadline) await delay(5);
  assert.equal(held.length, 1);
  try {
    const current = taskProjectedViewSchema.parse((await read(h.app.url, `task/view?task=${h.task.id}`)).body).task;
    assert.equal(current.title, 'Slow socket write');
    assert.equal((await post(h.app.url, 'commands/task/update', { task: h.task.id, title: 'Next writer', expectedTaskHash: current.hash })).status, 200);
  } finally { end.call(held[0]!); await slow; }
});

test('Q6: quiesce ends GET waiters, drains accepted reads, and late finish cannot start another read', async t => {
  const h = await fixture(t), entered = deferred(), gate = deferred();
  let reads = 0;
  const notices = h.app.context.noticeState!, get = notices.get.bind(notices);
  t.mock.method(notices, 'get', async () => { reads++; entered.release(); await gate.promise; return get(); });
  h.app.context.changed!();
  const current = read(h.app.url, `task/view?task=${h.task.id}`);
  await entered.promise;
  const quiesce = post(h.app.url, 'runtime/quiesce', {});
  try {
    assert.equal((await current).status, 503);
    let drained = false; void quiesce.then(() => { drained = true; }); await delay(25); assert.equal(drained, false);
    gate.release(); assert.equal((await quiesce).status, 200);
    const count = reads;
    assert.equal((await read(h.app.url, `task/view?task=${h.task.id}`)).status, 503);
    assert.equal((await post(h.app.url, 'commands/task/update', { task: h.task.id, title: 'No admission', expectedTaskHash: h.task.hash })).status, 503);
    await delay(20); assert.equal(reads, count);
  } finally { gate.release(); }
});

test('Q7: Push save fault cannot reject committed writes or block screen/SSE; next tick retries observation', async t => {
  const h = await fixture(t);
  let faults = 0;
  const mocked = t.mock.method(PushStore.prototype as any, 'persist', async function(this: PushStore, ...args: any[]) { faults++; throw Error('push save fault'); });
  const opId = randomUUID();
  // A person stops the Task they asked for: the home list's row, noticed as stopped.
  const input = { task: h.task.id, opId, state: 'stopped', title: 'Stop now', description: 'Check', expectedTaskHash: h.task.hash };
  const saved = await post(h.app.url, 'commands/task/report', input, opId);
  assert.equal(saved.status, 200);
  assert.equal((await read(h.app.url, `task/view?task=${h.task.id}`)).body.task.hash, saved.body.task.hash);
  const index = await read(h.app.url, 'workspace/live'); assert.equal(index.status, 200);
  const deadline = performance.now() + 2000;
  while (!faults && performance.now() < deadline) await delay(10);
  assert.ok(faults);
  mocked.mock.restore();
  const end = performance.now() + 4000;
  const pushFile = join(h.root, '.alpacawork/push.json');
  while (!JSON.parse(readFileSync(pushFile, 'utf8')).seen.some((key: string) => key.startsWith(`${h.task.id}:`)) && performance.now() < end) await delay(20);
  assert.ok(JSON.parse(readFileSync(pushFile, 'utf8')).seen.some((key: string) => key.startsWith(`${h.task.id}:`)));
});

test('gate postcommit fault retains the immutable saved result', async t => {
  const h = await fixture(t);
  t.mock.method(StopDeliveryOwner.prototype, 'gate', () => { throw Error('delivery gate fault'); });
  const result = await post(h.app.url, 'commands/task/update', { task: h.task.id, title: 'Saved despite delivery fault', expectedTaskHash: h.task.hash });
  assert.equal(result.status, 200);
  assert.equal((await new ControlTaskStore(h.root).get(h.task.id)).hash, result.body.task.hash);
  t.mock.restoreAll();
});

test('a formal file publication remains current after an older captured file read completes', async t => {
  const h = await fixture(t), entered = deferred(), gate = deferred();
  let pause = true;
  pauseCurrentReads(t, h.app, async () => { if (pause) { pause = false; entered.release(); await gate.promise; } });
  const old = read(h.app.url, `task/view?task=${h.task.id}`);
  await entered.promise;
  try {
    const bytes = Buffer.from('new file after the old scan');
    const response = await fetch(new URL(`/api/tasks/${h.task.id}/file?path=epoch.txt`, h.app.url), {
      method: 'PUT', headers: { 'X-Alpacawork-Op-Id': randomUUID(),
        'X-Alpacawork-Content-Digest': createHash('sha256').update(bytes).digest('hex') }, body: bytes });
    assert.equal(response.status, 200); await response.arrayBuffer();
    const current = await read(h.app.url, `task/view?task=${h.task.id}`);
    assert.equal(current.status, 200);
    const answer = taskProjectedViewSchema.parse(current.body);
    assert.ok(answer.task.files?.some(file => file.name === 'epoch.txt' && file.size === bytes.length));
    gate.release();
    const previous = taskProjectedViewSchema.parse((await old).body);
    assert.ok(answer.sourcePv > previous.sourcePv, 'the current response includes the later file publication');
    const afterOld = taskProjectedViewSchema.parse((await read(h.app.url, `task/view?task=${h.task.id}`)).body);
    assert.ok(afterOld.task.files?.some(file => file.name === 'epoch.txt' && file.size === bytes.length));
    assert.ok(afterOld.sourcePv >= answer.sourcePv);
  } finally { gate.release(); }
});

test('Q6: an admitted mutation may commit during quiesce without registering another projection job', async t => {
  const h = await fixture(t), entered = deferred(), gate = deferred();
  const original = ControlStore.prototype.writeOperationAsync; let reads = 0;
  t.mock.method(ControlStore.prototype, 'writeOperationAsync', function(this: ControlStore, input: any, callback: () => Promise<any>) {
    return original.call(this, input, async () => { const result = await callback(); entered.release(); await gate.promise; return result; });
  });
  const snapshot = TaskRepository.prototype.snapshot;
  t.mock.method(TaskRepository.prototype, 'snapshot', function(this: TaskRepository, project?: string, taskIds?: readonly string[]) { if (!taskIds) reads++; return snapshot.call(this, project, taskIds); });
  const saved = post(h.app.url, 'commands/task/update', { task: h.task.id, title: 'Accepted before quiesce', expectedTaskHash: h.task.hash });
  await entered.promise;
  try {
    const stop = post(h.app.url, 'runtime/quiesce', {}); await delay(20);
    gate.release(); assert.equal((await saved).status, 200); assert.equal((await stop).status, 200);
    const count = reads; await delay(20); assert.equal(reads, count); assert.equal(count, 0);
    assert.equal((await new ControlTaskStore(h.root).get(h.task.id)).meta.title, 'Accepted before quiesce');
  } finally { gate.release(); }
});

const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/example', expirationTime: null,
  keys: { p256dh: 'BAAeFXiNM4nLLiGrGmHlXrcRxEiganHmMidSakDxHs8vMYDqt4vtd9nqOGW6MAH9rzXsFSETkMJd06dq3yX_kc8', auth: 'UUALvnVwjZoGLy-BHN4_LA' } };

test('Q7: a failed Push file save does not expose an unsaved subscription through the official GET', async t => {
  const h = await fixture(t);
  const mocked = t.mock.method(PushStore.prototype as any, 'persist', async () => { throw Error('push save failed'); });
  assert.ok((await post(h.app.url, 'notify/subscribe', { subscription, label: 'Unsaved' })).status >= 500);
  assert.deepEqual((await read(h.app.url, 'notify/devices')).body.devices, []);
  mocked.mock.restore();
  assert.equal((await post(h.app.url, 'notify/subscribe', { subscription, label: 'Saved' })).status, 200);
  assert.equal((await read(h.app.url, 'notify/devices')).body.devices.length, 1);
});

test('Q7: delivery completed after another observe/save is committed to the current event by key', async t => {
  const entered = deferred(), gate = deferred(); let calls = 0;
  const h = await fixture(t, { pushSender: async () => { calls++; entered.release(); await gate.promise; return { status: 201 }; } });
  await post(h.app.url, 'notify/subscribe', { subscription, label: 'First label' });
  const opId = randomUUID();
  await post(h.app.url, 'commands/task/report', { task: h.task.id, state: 'stopped',
    title: 'Notify once', description: 'Stopped', opId, expectedTaskHash: h.task.hash }, opId);
  await Promise.race([entered.promise, delay(5000).then(() => { throw Error('delivery did not start'); })]);
  try {
    assert.equal((await post(h.app.url, 'notify/subscribe', { subscription, label: 'Changed while sending' })).status, 200);
    assert.equal((await read(h.app.url, `task/view?task=${h.task.id}`)).status, 200);
    gate.release();
    const path = join(h.root, '.alpacawork/push.json'), deadline = performance.now() + 3000;
    let sent = false;
    while (!sent && performance.now() < deadline) {
      const data = JSON.parse(readFileSync(path, 'utf8'));
      sent = data.events.some((event: any) => Object.values(event.deliveries).some((delivery: any) => delivery.sent_at));
      if (!sent) await delay(10);
    }
    assert.equal(sent, true, 'the durable current object holds delivery completion');
    await delay(POLL_INTERVAL_MS + 100); assert.equal(calls, 1, 'the saved delivery is not retried');
  } finally { gate.release(); }
});

test('Run authentication is checked before every receipt replay', async t => {
  const h = await fixture(t), opId = randomUUID();
  const first = await post(h.app.url, 'commands/task/update', { task: h.task.id, title: 'Default commit', expectedTaskHash: h.task.hash }, opId);
  assert.equal(first.status, 200);
  assert.equal((await read(h.app.url, `commands/operation/get?opId=${opId}`)).body.body.task.title, 'Default commit');
  const response = await fetch(new URL('/api/commands/task/update', h.app.url), { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-Alpacawork-Op-Id': opId, Authorization: `Alpacawork-Run R1:${'a'.repeat(64)}` },
    body: JSON.stringify({ task: h.task.id, title: 'Default commit', expectedTaskHash: h.task.hash }) });
  assert.equal(response.status, 403, 'even an exact receipt replay cannot bypass Run authentication');
  assert.equal((await read(h.app.url, `task/view?task=${h.task.id}`)).body.task.hash, first.body.task.hash);
});


test('Q6: a pass queued behind a mutation does not start business work after quiesce', async t => {
  const clock = receiverClock(t), h = await fixture(t), entered = deferred(), gate = deferred();
  const original = ControlStore.prototype.writeOperationAsync; let routes = 0;
  const pass = ReturnRouter.prototype.route;
  t.mock.method(ReturnRouter.prototype, 'route', function(this: ReturnRouter, ...args: any[]) { routes++; return pass.apply(this, args); });
  t.mock.method(ControlStore.prototype, 'writeOperationAsync', function(this: ControlStore, input: any, callback: () => Promise<any>) {
    return original.call(this, input, async () => { const result = await callback(); entered.release(); await gate.promise; return result; });
  });
  const mutation = post(h.app.url, 'commands/task/update', { task: h.task.id, title: 'Admitted', expectedTaskHash: h.task.hash });
  await entered.promise;
  try {
    await clock.advance(1000);
    const stop = post(h.app.url, 'runtime/quiesce', {});
    for (let n = 0; n < 100; n++) {
      if ((await read(h.app.url, 'runtime/readiness')).body.state === 'quiescing') break;
      await delay(5);
    }
    gate.release(); assert.equal((await mutation).status, 200); assert.equal((await stop).status, 200);
    assert.equal(routes, 0, 'quiesce drains the admitted writer and skips pending business reconciliation');
  } finally { gate.release(); }
});


test('Return publication reads each inserted result by identity without reloading the growing collection', async t => {
  receiverClock(t);
  const h = await fixture(t), store = new RunStore(h.root, { busyTimeoutMs: 1000 });
  try {
    store.write(tx => {
      const launch: RunRecord['launch'] = { adapter: 'codex', env: [], argv: ['/usr/bin/false'], path: '/bin', values: {} };
      const caller = createFixtureRun(store, tx, { task: h.task.id, placementId: 'Pcaller-fixture', requestId: randomUUID(),
        agent: 'codex', role: 'owner', resumes: null, continues: false, session: null, caller: null, cwd: h.root, launch }, 'Parent caller');
      // The caller's seat sends each worker Request in its open wait cycle, so each closes with a return to the seat.
      const waitCycleId = randomUUID(), at = new Date().toISOString();
      store.connection.prepare('INSERT INTO wait_cycles(id,task_id,opened_at) VALUES (?,?,?)').run(waitCycleId, h.task.id, at);
      store.connection.prepare('INSERT INTO agents(id,created_at) VALUES (?,?)').run('Areturn-fixture', at);
      store.connection.prepare(`INSERT INTO placements(id,task_id,agent_id,profile_key,responsible,revision,started_at)
        VALUES (?,?,?,?,0,1,?)`).run('Preturn-fixture', h.task.id, 'Areturn-fixture', 'codex', at);
      for (let i = 0; i < 12; i++) {
        const requestId = randomUUID();
        tx.insertRequest({ id: requestId, taskId: h.task.id, placementId: 'Preturn-fixture', placementRevision: 1,
          taskHash: h.task.hash, waitCycleId, headRunId: null, mode: 'new', body: 'Completed fixture work', purpose: 'instruction',
          author: { kind: 'placement', placementId: caller.placementId }, submittedAt: at, deliveryState: 'queued' });
        const queued = createFixtureRun(store, tx, { task: h.task.id, placementId: 'Preturn-fixture', requestId,
          agent: 'codex', role: 'worker', resumes: null, continues: false, session: null, caller: { run: caller.id }, cwd: h.root,
          launch }, 'Completed fixture work');
        const running = { ...queued, state: 'running' as const, started_at: new Date().toISOString() };
        tx.update(running);
        tx.finish({ ...running, state: 'succeeded', ended_at: new Date().toISOString() }, { state: 'present', text: 'Completed result' });
      }
    });
  } finally { store.close(); }
  const original = RunStore.prototype.write;
  t.mock.method(RunStore.prototype, 'write', function(this: RunStore, callback: (tx: any) => unknown) {
    return original.call(this, tx => {
      const all = tx.returns; let reads = 0;
      tx.returns = (...args: unknown[]) => {
        if (++reads > 4) throw Error('A result must not require another complete Return read');
        return all(...args);
      };
      return callback(tx);
    });
  });
  assert.equal((await post(h.app.url, 'commands/workspace/returns', {})).status, 200);
  const published = await read(h.app.url, `commands/task/returns?task=${h.task.id}`);
  assert.equal(published.status, 200);
  assert.equal(published.body.returns.length, 12);
});


test('Run reconciliation preserves unrelated task bundles and detail versions', async t => {
  const clock = receiverClock(t), h = await fixture(t);
  const made = await post(h.app.url, 'commands/task/new', { kind: 'project', color: '#39659b', parent: ROOT_PROJECT, title: 'Untouched' });
  assert.equal(made.status, 200);
  const other = String(made.body.task.id);
  const runs = new RunStore(h.root, { busyTimeoutMs: 1000 });
  t.after(() => runs.close());
  runs.write(tx => {
    const previous = createFixtureRun(runs, tx, fields({ agent: 'codex', task: h.task.id }), 'prepare the shared agent before measuring reuse');
    tx.update({ ...previous, state: 'cancelled', reason: 'stopped', ended_at: new Date().toISOString() });
  });
  let passes = 0;
  const pass = ReturnRouter.prototype.route;
  t.mock.method(ReturnRouter.prototype, 'route', async function(this: ReturnRouter, ...args: Parameters<ReturnRouter['route']>) {
    const result = await pass.apply(this, args); passes++; return result;
  });
  await clock.until(() => passes > 0, 'warm the startup reconciliation');
  await read(h.app.url, 'workspace/live');
  const before = h.app.feed()!.current!;
  const otherBundle = before.records.bundle(other);
  const otherVersion = before.requiredPv.view[other];
  const changedOwners = new Set<string>();
  const advance = DatabaseWorkspaceRecords.prototype.advance;
  t.mock.method(DatabaseWorkspaceRecords.prototype, 'advance', function(this: DatabaseWorkspaceRecords, ...args: Parameters<typeof advance>) {
    const change = advance.apply(this, args);
    for (const owner of change.owners) changedOwners.add(owner);
    return change;
  });
  const run = runs.write(tx => {
    const run = createFixtureRun(runs, tx, fields({ agent: 'codex', task: h.task.id }), 'isolated missing-manager fixture');
    tx.update({ ...run, state: 'running', started_at: new Date().toISOString() });
    return run;
  });
  await clock.until(() => runs.get(run.id)?.state !== 'running', 'serve settles the missing manager');
  const result = await read(h.app.url, `task/view?task=${h.task.id}`);
  assert.equal(result.status, 200);
  assert.equal((await read(h.app.url, 'workspace/live')).status, 200);
  const after = h.app.feed()!.current!;
  assert.equal(changedOwners.has(other), false, 'settling a Run cannot read an unrelated task bundle again');
  assert.equal(after.records.bundle(other), otherBundle);
  assert.equal(after.requiredPv.view[other], otherVersion);
});

test('Q7: quiesce drains an accepted Push tick still reading its notice input', async t => {
  const clock = receiverClock(t), h = await fixture(t);
  let passes = 0;
  const pass = ReturnRouter.prototype.route;
  t.mock.method(ReturnRouter.prototype, 'route', async function(this: ReturnRouter, ...args: Parameters<ReturnRouter['route']>) {
    const result = await pass.apply(this, args); passes++; return result;
  });
  await clock.until(() => passes > 0, 'warm the startup reconciliation');
  await read(h.app.url, 'workspace/live');
  const entered = deferred(), gate = deferred();
  const notices = h.app.context.noticeState!, get = notices.get.bind(notices);
  let reads = 0, deliveries = 0;
  t.mock.method(notices, 'get', async (...args: Parameters<typeof get>) => {
    reads++; entered.release(); await gate.promise; return get(...args);
  });
  t.mock.method(PushStore.prototype, 'tick', async () => { deliveries++; });
  await clock.advance(1000); await entered.promise;
  let drained = false;
  const closing = post(h.app.url, 'runtime/quiesce', {}).then(result => { drained = true; return result; });
  try {
    await delay(25); assert.equal(drained, false, 'the accepted notice read belongs to drain');
    gate.release(); assert.equal((await closing).status, 200);
    const completed = { reads, deliveries };
    await clock.advance(1000); await delay(10);
    assert.deepEqual({ reads, deliveries }, completed, 'drained serve cannot enqueue another Push tick');
    assert.ok(deliveries > 0);
  } finally { gate.release(); }
});


test('completion routing acknowledges only its captured protocol progress without invalidating unrelated tasks', async t => {
  const clock = receiverClock(t), h = await fixture(t);
  const made = await post(h.app.url, 'commands/task/new', { kind: 'project', color: '#39659b', parent: ROOT_PROJECT, title: 'Untouched' });
  assert.equal(made.status, 200);
  const other = String(made.body.task.id);
  const runs = new RunStore(h.root, { busyTimeoutMs: 1000 }); t.after(() => runs.close());
  const otherTask = (await new ControlTaskCommands(h.root, { kind: 'human' }).create({ parentId: other, userRequested: null, tasks: [{ title: 'Other Task' }] })).tasks[0];
  const { run, launch } = runs.write(tx => {
    const run = createFixtureRun(runs, tx, fields({ agent: 'codex', task: h.task.id }), 'protocol completion fixture; no process');
    const launch = reserveAttempt(runs, tx, run, managerScript, DEFAULT_LIMITS);
    tx.update({ ...run, state: 'running', started_at: new Date().toISOString() });
    tx.update({ ...tx.get(run.id)!, state: 'needs_review', reason: null });
    return { run, launch };
  });
  const journal = new EventJournal(executionFolder(h.root, run.id, launch.attemptId), identityOf(launch));
  journal.append('completed', { outcome: { state: 'needs_review', reason: 'conversation_busy' }, session: null,
    measuredUsage: null, exit: { code: 1, signal: null }, result: { state: 'missing', digest: null, size: 0 } });
  new RunEventImporter(runs).pass();
  runs.write(() => runs.connection.prepare('UPDATE run_attempts SET dirty=0 WHERE attempt_id=?').run(launch.attemptId));
  let passes = 0;
  const pass = ReturnRouter.prototype.route;
  t.mock.method(ReturnRouter.prototype, 'route', async function(this: ReturnRouter, ...args: Parameters<ReturnRouter['route']>) {
    const result = await pass.apply(this, args); passes++; return result;
  });
  await clock.until(() => passes > 0, 'warm the normal dirty=0 control');
  await read(h.app.url, 'workspace/live');
  const before = h.app.feed()!.current!;
  const otherBundle = before.records.bundle(otherTask.id), otherVersion = before.requiredPv.view[otherTask.id];
  const last = passes;
  runs.write(() => runs.connection.prepare('UPDATE run_attempts SET dirty=1 WHERE attempt_id=?').run(launch.attemptId));
  const cursor = () => runs.connection.prepare('SELECT dirty,completed_digest FROM run_attempts WHERE attempt_id=?').get(launch.attemptId)!;
  assert.equal(cursor().dirty, 1); assert.ok(cursor().completed_digest);
  await clock.until(() => passes > last && cursor().dirty === 0, 'normal serve consumes completion dirtiness');
  assert.equal((await read(h.app.url, `task/view?task=${h.task.id}`)).status, 200);
  assert.equal((await read(h.app.url, `task/view?task=${otherTask.id}`)).status, 200);
  assert.equal((await read(h.app.url, 'workspace/live')).status, 200);
  assert.equal(h.app.feed()!.current!.records.bundle(otherTask.id), otherBundle);
  assert.equal(h.app.feed()!.current!.requiredPv.view[otherTask.id], otherVersion);
  await clock.advance(1000); await read(h.app.url, 'workspace/live');
  assert.equal(cursor().dirty, 0);
  assert.equal(h.app.feed()!.current!.records.bundle(otherTask.id), otherBundle);
  runs.write(() => runs.connection.prepare('UPDATE run_attempts SET dirty=1 WHERE attempt_id=?').run(launch.attemptId));
  const changes = controlChanges(h.root)!;
  const through = changes.latest;
  const importer = new RunEventImporter(runs), work = { tasks: new Set([h.task.id]) };
  importer.acknowledgeRouting(work, importer.routingReceipts(work));
  assert.equal(changes.latest, through, 'acknowledging protocol progress adds no screen facts');
});

test('Task snapshot batches parent/history reads and shares the exact targeted codec', async t => {
  const h = await fixture(t), commands = new ControlTaskCommands(h.root, { kind: 'human' });
  // A task with children has a responsible.
  await assignResponsible(h.root, h.task, 'codex');
  for (let i = 0; i < 3; i++) await commands.create({ parentId: h.task.id, userRequested: false, tasks: [{ title: 'Child ' + i }] });
  const control = new ControlStore(h.root, undefined, true);
  try { control.read(db => {
    const sql: string[] = [], prepare = db.prepare;
    t.mock.method(db, 'prepare', function(statement: string) { sql.push(statement); return prepare.call(db, statement); });
    const tasks = new TaskRepository(h.root, db), snapshot = tasks.snapshot();
    // The serve of this fixture keeps the history it has read: a read then reads only the entries after that.
    const historyReads = sql.filter(statement => /l\.entry[\s\S]*FROM task_log/.test(statement));
    assert.ok(historyReads.length <= 1, 'one ordered history read for the project, independent of Task count');
    for (const task of snapshot.tasks) assert.deepEqual(tasks.get(task.id), task, 'same history, parent, body and revision');
  }); } finally { control.close(); }
});


test('Run snapshot heads retain aborted and joined conversation semantics', async t => {
  const h = await fixture(t), runs = new RunStore(h.root, { busyTimeoutMs: 1000 }); t.after(() => runs.close());
  const first = runs.write(tx => {
    const first = createFixtureRun(runs, tx, fields({ agent: 'codex', task: h.task.id }), 'conversation head');
    const aborted = createFixtureRun(runs, tx, fields({ agent: 'codex', task: h.task.id }), 'aborted request');
    tx.updateRequest(aborted.requestId!, 'aborted');
    const joined = createFixtureRun(runs, tx, fields({ agent: 'codex', task: h.task.id }), 'joined input');
    tx.finish({ ...joined, state: 'joined', into: first.id, ended_at: new Date().toISOString() }, { state: 'missing', text: null });
    return first;
  });
  assert.equal(runs.snapshot().headRunIds.get(first.placementId), first.id);
  assert.equal(runs.conversationHead(first.placementId)?.id, first.id);

});

test('Task creation validates the branch and parent without reading unrelated history', async t => {
  const h = await fixture(t);
  // A task with a child has a responsible; placing it moves the Task's hash.
  const owner = await assignResponsible(h.root, h.task, 'codex');
  const parent = await new ControlTaskStore(h.root).get(h.task.id);
  // A read narrowed to named Tasks (TaskRepository.related) is targeted; only a read of whole projects is refused.
  const snapshot = TaskRepository.prototype.snapshot;
  t.mock.method(TaskRepository.prototype, 'snapshot', function(this: TaskRepository, project?: string, taskIds?: readonly string[]) {
    if (!taskIds) throw new Error('unrelated full history read');
    return snapshot.call(this, project, taskIds);
  });
  const top = await post(h.app.url, 'commands/task/new', { parent: h.project, title: 'No unrelated history' });
  assert.equal(top.status, 200, 'a Task below its project needs the branch, not every existing history');
  const commands = new ControlTaskCommands(h.root, { kind: 'placement', placementId: owner.id });
  const child = (await commands.create({ parentId: h.task.id, userRequested: false,
    tasks: [{ title: 'With current parent' }], expectedParentHash: parent.hash })).tasks[0];
  assert.equal(child.parentId, h.task.id);
  await assert.rejects(commands.create({ parentId: h.task.id, userRequested: false,
    tasks: [{ title: 'Stale parent' }], expectedParentHash: '0'.repeat(64) }), { code: 'conflict' });
  assert.equal((await read(h.app.url, 'commands/task/get?task=' + child.id)).body.task.title, 'With current parent');

});
