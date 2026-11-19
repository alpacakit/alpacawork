import { DEFAULT_SCHEMA } from '@alpacawork/contract';
import { coordinatorSnapshotSchema } from '@alpacawork/contract/coordinator';
import { commandFetch as fetch } from './helpers/command-fetch.ts';
/** Incremental publication, metadata, fault recovery, file observations and authorized screen reads. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { AGENTS_TEMPLATE } from '@alpacawork/backend/test-dist/agents-settings.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { createNoticeState } from '@alpacawork/backend/test-dist/receiver/person-state.js';
import { initializeControlFixture } from './helpers/control-fixture.ts';
import { receiverClock } from './helpers/receiver-clock.ts';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { controlDatabasePath } from '@alpacawork/db';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { issueRunCredential } from '@alpacawork/backend/test-dist/control/credentials.js';
import { RunStore } from '@alpacawork/runs';
import { DatabaseWorkspaceRecords } from '@alpacawork/backend/test-dist/receiver/workspace-records.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { projectedIndexSchema, taskProjectedViewSchema } from '@alpacawork/contract/control';
import { openIndexStream } from './index-stream.ts';
import { createFixtureRun } from './helpers/run-fixture.ts';

/** A workspace with the fixture's project-type Task (`project`), below the root project P1. */
function workspace(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-serve-load-')));
  const servers: Array<Awaited<ReturnType<typeof startServer>>> = [];
  t.after(async () => {
    const closed = await Promise.allSettled(servers.map(server => server.close()));
    rmSync(root, { recursive: true, force: true });
    const failed = closed.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  });
  const writer = new FileWriter(root);
  let project: string;
  try { project = initializeControlFixture(root); writer.save('config.yaml', null, Buffer.from(AGENTS_TEMPLATE)); }
  finally { writer.close(); }
  const start = async () => {
    const server = await startServer(root, 0);
    servers.push(server);
    return server;
  };
  return { root, project, start };
}
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json', 'X-Alpacawork-Op-Id': (body as { opId?: string })?.opId ?? randomUUID() }, body: JSON.stringify(body) });
const live = async (url: string) => {
  const response = await fetch(new URL('/api/workspace/live', url));
  assert.equal(response.status, 200);
  return projectedIndexSchema.parse(await response.json());
};

test('read marks, settings and the coordinator conversation publish current metadata through GET and SSE', async t => {
  const { root, start } = workspace(t);
  const server = await start();
  const before = await live(server.url);
  const conversation = coordinatorSnapshotSchema.parse(await (await fetch(new URL('/api/coordinator', server.url))).json()).conversation as { id: string };
  const abort = new AbortController();
  t.after(() => abort.abort());
  const stream = await openIndexStream(new URL('/api/events', server.url), abort.signal);
  let streamed = await stream.index();
  const cleared = await fetch(new URL('/api/coordinator/clear', server.url), json({ conversationId: conversation.id }));
  assert.equal(cleared.status, 200, await cleared.clone().text());
  const notices = await (await fetch(new URL('/api/person/notices', server.url))).json() as { revision: string | null };
  const saved = await fetch(new URL('/api/person/notices/save', server.url),
    json({ expectedRevision: notices.revision, state: { version: 4, checkpoint: { at: new Date().toISOString(), tasks: {} }, reads: {} } }));
  assert.equal(saved.status, 200, await saved.clone().text());
  const settings = await (await fetch(new URL('/api/settings/get', server.url))).json();
  const changedSettings = await fetch(new URL('/api/settings/set', server.url),
    json({ key: 'theme', value: 'dark', expectedRevision: settings.revision }));
  assert.equal(changedSettings.status, 200);
  const settingsSaved = await changedSettings.json();
  const after = await live(server.url);
  assert.notEqual(after.person.coordinator, before.person.coordinator);
  assert.equal(after.person.settings, settingsSaved.revision);
  assert.ok(after.rev > before.rev);
  while (streamed.rev < after.rev) streamed = await stream.index();
  assert.deepEqual(streamed.person, after.person, 'SSE and GET receive the same current metadata');
});

test('Push\'s pass asks for the read marks without reading their file again until the file changes', async t => {
  const { root } = workspace(t);
  const state = createNoticeState(root);
  const first = await state.get();
  const saved = await state.save({ version: 4, checkpoint: { at: '2026-10-15T00:00:00.000Z', tasks: {} }, reads: {} }, first.revision);
  assert.equal((await state.get()).revision, saved.revision);
  let reads = 0;
  const readFileSync = fs.readFileSync;
  const hook = t.mock.method(fs, 'readFileSync', function (...args: Parameters<typeof fs.readFileSync>) {
    reads++;
    return readFileSync(...args);
  });
  syncBuiltinESMExports();
  try {
    for (let i = 0; i < 3; i++) assert.equal((await state.get()).revision, saved.revision);
    assert.equal(reads, 0);
    // Put back or edited by hand: the changed file is read.
    const file = join(root, '.alpacawork', 'notice-state.json');
    const stored = JSON.parse(readFileSync(file, 'utf8') as string);
    fs.writeFileSync(file, JSON.stringify({ ...stored, revision: 'edited' }));
    assert.equal((await state.get()).revision, 'edited');
  } finally { hook.mock.restore(); syncBuiltinESMExports(); }
});

test('bounded audit discovers an unannounced hand edit without changing unrelated task facts', async t => {
  const { root, project, start } = workspace(t);
  const commands = new ControlTaskCommands(root, { kind: 'human' });
  const mobile = (await commands.create({ kind: 'project', color: '#39659b', parentId: 'P1', userRequested: null, tasks: [{ title: 'Mobile' }] })).tasks[0];
  const edited = (await commands.create({ parentId: project, userRequested: null, tasks: [{ title: 'Default work' }] })).tasks[0];
  const unrelated = (await commands.create({ parentId: mobile.id, userRequested: null, tasks: [{ title: 'Mobile work' }] })).tasks[0];
  const server = await start();
  const before = server.feed()!.current!;
  const unchanged = before.records.bundle(unrelated.id);
  const unchangedVersion = before.requiredPv.view[unrelated.id];
  // Deliberately bypass the application's writes to exercise missing-change recovery.
  const db = new DatabaseSync(controlDatabasePath(root));
  try { db.prepare("UPDATE tasks SET title='Edited by hand' WHERE external_id=?").run(edited.id); } finally { db.close(); }
  assert.equal((await live(server.url)).tasks.find(task => task.id === edited.id)?.title, 'Default work');
  await server.feed()!.audit(16);
  await server.feed()!.catchUp();
  const after = await live(server.url);
  assert.equal(after.tasks.find(task => task.id === edited.id)?.title, 'Edited by hand');
  assert.equal(server.feed()!.current!.records.bundle(unrelated.id), unchanged);
  assert.equal(server.feed()!.current!.requiredPv.view[unrelated.id], unchangedVersion);
});

test('project field changes reach nested tasks while preserving the root project detail version', async t => {
  const { root, project, start } = workspace(t);
  const commands = new ControlTaskCommands(root, { kind: 'human' });
  const mobile = (await commands.create({ kind: 'project', color: '#39659b', parentId: project, userRequested: null, tasks: [{ title: 'Mobile' }] })).tasks[0];
  const child = (await commands.create({ parentId: mobile.id, userRequested: null, tasks: [{ title: 'Mobile work' }] })).tasks[0];
  const server = await start();
  const rootVersion = server.feed()!.current!.requiredPv.view.P1;
  const fields = [...DEFAULT_SCHEMA].reverse();
  const changed = await fetch(new URL('/api/field/use', server.url), json({ task: project, fields,
    expectedTaskHash: (await new ControlTaskStore(root).get(project)).hash }));
  assert.equal(changed.status, 200, await changed.clone().text());
  const response = await fetch(new URL(`/api/task/view?task=${child.id}`, server.url));
  assert.equal(response.status, 200);
  assert.deepEqual(taskProjectedViewSchema.parse(await response.json()).values.fields, fields);
  assert.equal(server.feed()!.current!.requiredPv.view.P1, rootVersion);
});

test('a Run cannot read the screen\'s index of every project: its project scope holds on the screen\'s reads', async t => {
  const { root, project, start } = workspace(t);
  const commands = new ControlTaskCommands(root, { kind: 'human' });
  const secret = (await commands.create({ parentId: project, userRequested: null, tasks: [{ title: 'Other project secret' }] })).tasks[0];
  const mobile = (await commands.create({ kind: 'project', color: '#39659b', parentId: 'P1', userRequested: null, tasks: [{ title: 'Mobile' }] })).tasks[0];
  const own = (await commands.create({ parentId: mobile.id, userRequested: null, tasks: [{ title: 'Own project' }] })).tasks[0];
  const placements = new PlacementStore(root);
  const placement = placements.place({ taskId: own.id, agentId: placements.createAgent().id, profileKey: 'codex', responsible: true });
  placements.close();
  const store = new RunStore(root, { busyTimeoutMs: 0 });
  const run = store.write(tx => {
    const record = createFixtureRun(store, tx, { task: own.id, placementId: placement.id, requestId: randomUUID(), agent: 'codex',
      role: 'owner', resumes: null, continues: false, session: null, caller: null, cwd: root,
      launch: { adapter: 'codex', env: [], argv: ['unused'], path: '/bin', values: {} } }, 'prompt');
    tx.update({ ...record, state: 'running', started_at: new Date().toISOString() });
    return record;
  });
  store.close();
  receiverClock(t);
  const server = await start();
  const headers = { authorization: `Alpacawork-Run ${run.id}:${issueRunCredential(root, run.id)}` };
  for (const path of [`/api/task/view?task=${secret.id}`, '/api/workspace/live', '/api/task/search?text=secret', '/api/events'])
    assert.equal((await fetch(new URL(path, server.url), { headers })).status, 403, path);
  // A person's screen still reads it.
  assert.equal((await fetch(new URL(`/api/task/view?task=${secret.id}`, server.url))).status, 200);
});

test('a failed records read is retried without another write and keeps the last published frame', async t => {
  const { root, project, start } = workspace(t), clock = receiverClock(t);
  const server = await start();
  const before = server.feed()!.current!, advance = DatabaseWorkspaceRecords.prototype.advance;
  const hook = t.mock.method(DatabaseWorkspaceRecords.prototype, 'advance', function(this: DatabaseWorkspaceRecords, ...args: Parameters<typeof advance>) {
    throw new Error('temporary records read failure');
  });
  const created = await fetch(new URL('/api/task/new', server.url), json({ title: 'Retry without another write', parent: project }));
  assert.equal(created.status, 200);
  const current = await fetch(new URL('/api/workspace/live', server.url));
  assert.equal(current.status, 503);
  assert.equal(server.feed()!.current, before);
  hook.mock.restore();
  await clock.until(() => JSON.parse(server.feed()!.index()).tasks.some(task => task.title === 'Retry without another write'),
    'the pending recorded change is retried without another write');
  assert.ok((await live(server.url)).tasks.some(task => task.title === 'Retry without another write'));
});

test('a file observation survives a failed records read before its publication', async t => {
  const { root, project, start } = workspace(t);
  const task = (await new ControlTaskCommands(root, { kind: 'human' }).create({ parentId: project, userRequested: null, tasks: [{ title: 'Files' }] })).tasks[0];
  fs.mkdirSync(join(root, 'tasks', task.id), { recursive: true });
  const server = await start();
  const advance = DatabaseWorkspaceRecords.prototype.advance;
  let failed = false;
  const hook = t.mock.method(DatabaseWorkspaceRecords.prototype, 'advance', function(this: DatabaseWorkspaceRecords, ...args: Parameters<typeof advance>) {
    if (args[1].some(key => key.kind === 'files' && key.id === task.id)) {
      failed = true; throw new Error('temporary file records read failure');
    }
    return advance.apply(this, args);
  });
  fs.writeFileSync(join(root, 'tasks', task.id, 'new.txt'), 'new file');
  const deadline = performance.now() + 5_000;
  while (!failed && performance.now() < deadline) {
    await fetch(new URL(`/api/task/view?task=${task.id}`, server.url));
    await delay(10);
  }
  assert.equal(failed, true, 'the actual file observation reaches records before the injected fault');
  hook.mock.restore();
  const response = await fetch(new URL(`/api/task/view?task=${task.id}`, server.url));
  assert.equal(response.status, 200);
  assert.ok(taskProjectedViewSchema.parse(await response.json()).task.files?.some(file => file.name === 'new.txt'));
});
