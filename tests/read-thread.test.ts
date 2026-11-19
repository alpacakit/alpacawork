import { CLI_CONTRACT, CONTRACT_HEADER } from '@alpacawork/contract/client-contract';
import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { stringify } from 'yaml';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, closeSync, constants, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RUN_FILES, runFolder } from '@alpacawork/contract/run';
import { tryLock, unlock } from '@alpacawork/core';
import { controlDatabasePath } from '@alpacawork/db';
import { RunStore } from '@alpacawork/runs';
import { issueRunCredential } from '@alpacawork/backend/test-dist/control/credentials.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { TaskFileIndex } from '@alpacawork/backend/test-dist/control/task-files.js';
import { fileDigest } from '@alpacawork/backend/test-dist/control/file-journal.js';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { initializeControlFixture } from './helpers/control-fixture.ts';
import { createFixtureRun } from './helpers/run-fixture.ts';

const CLI = { 'x-alpacawork-client': 'cli', [CONTRACT_HEADER]: String(CLI_CONTRACT) };
const AGENTS = stringify({ agents: { "claude": fixtureAgentSetting('claude') } });
function workspace(): { root: string; project: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'read-thread-')));
  const writer = new FileWriter(root);
  try { writer.save('config.yaml', null, Buffer.from(AGENTS)); return { root, project: initializeControlFixture(root) }; }
  finally { writer.close(); }
}
const human = { kind: 'human' } as never;
async function serve(t: { after: (fn: () => Promise<void> | void) => void }) {
  const { root, project } = workspace();
  const { tasks: [task] } = await new ControlTaskCommands(root, human).create({ parentId: project, userRequested: null, tasks: [{ title: 'Work' }] } as never);
  const server = await startServer(root, 0);
  t.after(async () => { await server.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, server, task: task!.id };
}
/** Time to the answer's first byte, from another process: this one may be busy holding the main thread. */
function firstByte(url: string, headers: Record<string, string> = {}) {
  const child = spawn('curl', ['-s', '-m', '20', '-o', '/dev/null', '-w', '%{http_code} %{time_starttransfer}',
    ...Object.entries(headers).flatMap(([name, value]) => ['-H', `${name}: ${value}`]), url], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  return new Promise<{ status: number; seconds: number }>(resolve => child.on('close', () => {
    const [status, seconds] = out.split(' ');
    resolve({ status: Number(status), seconds: Number(seconds) });
  }));
}
const holdMainThread = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

test('a command\'s read is answered while the main thread is held; anything else waits for it', async t => {
  const { server, task } = await serve(t);
  const read = firstByte(new URL(`/api/task/get?task=${task}`, server.url).href, CLI);
  const list = firstByte(new URL('/api/task/list', server.url).href, CLI);
  const screen = firstByte(new URL(`/api/task/get?task=${task}`, server.url).href);
  holdMainThread(3_000);
  const [got, listed, shown] = await Promise.all([read, list, screen]);
  assert.equal(got.status, 200);
  assert.equal(listed.status, 200);
  assert.equal(shown.status, 200);
  assert(got.seconds < 2.5, `task get took ${got.seconds}s behind a held main thread`);
  assert(listed.seconds < 2.5, `task list took ${listed.seconds}s behind a held main thread`);
  assert(shown.seconds > got.seconds, 'a screen\'s request goes through the main thread');
});

/** A running Run of `task`, kept alive for serve by its manager's lock, and the header its commands carry. */
function runningRun(t: { after: (fn: () => void) => void }, root: string, task: string, session: { provider: 'codex'; id: string } | null) {
  const id = 'R1';
  mkdirSync(runFolder(root, id), { recursive: true, mode: 0o700 });
  const lock = openSync(join(runFolder(root, id), RUN_FILES.managerLock), constants.O_RDWR | constants.O_CREAT, 0o600);
  assert.equal(tryLock(lock), true);
  t.after(() => { unlock(lock); closeSync(lock); });
  const people = new PlacementStore(root);
  const { placement } = people.createAndPlace({ taskId: task, profileKey: 'claude', responsible: true });
  people.close();
  const store = new RunStore(root, { busyTimeoutMs: 10_000 });
  try {
    store.write(tx => {
      const created = createFixtureRun(store, tx, { task, placementId: placement.id, requestId: crypto.randomUUID(), agent: 'claude', role: 'owner', caller: null,
        resumes: null, continues: false, session, cwd: root,
        launch: { adapter: 'codex', env: [], argv: ['NEVER-EXECUTE'], path: '/bin', values: {} } }, 'Owner prompt');
      tx.update({ ...created, state: 'running', started_at: new Date().toISOString() });
    });
  } finally { store.close(); }
  return { authorization: `Alpacawork-Run ${id}:${issueRunCredential(root, id)}` };
}
async function serveWithRun(t: Parameters<typeof serve>[0], session: { provider: 'codex'; id: string } | null) {
  const { root, project } = workspace();
  const { tasks: [task] } = await new ControlTaskCommands(root, human).create({ parentId: project, userRequested: null, tasks: [{ title: 'Work' }] } as never);
  const headers = runningRun(t, root, task!.id, session);
  const server = await startServer(root, 0);
  t.after(async () => { await server.close(); rmSync(root, { recursive: true, force: true }); });
  return { server, task: task!.id, headers };
}

test('a Run\'s reads and a conversation\'s are answered while the main thread is held', async t => {
  const { server, task, headers } = await serveWithRun(t, { provider: 'codex', id: 'session-1' });
  const url = (path: string) => new URL(path, server.url).href;
  const reads = [`/api/task/get?task=${task}`, '/api/task/list', `/api/task/returns?task=${task}`, '/api/run/get?run=R1'].map(path =>
    firstByte(url(path), { ...CLI, ...headers }));
  const conversation = firstByte(url(`/api/task/get?task=${task}`), { ...CLI, 'x-alpacawork-provider': 'claude', 'x-alpacawork-conversation': 'outside' });
  holdMainThread(3_000);
  for (const read of [...await Promise.all(reads), await conversation]) {
    assert.equal(read.status, 200);
    assert(read.seconds < 2.5, `a read took ${read.seconds}s behind a held main thread`);
  }
});

test('a conversation an import could change is resolved on the main thread, as before', async t => {
  const { server, task } = await serveWithRun(t, null);
  const read = await fetch(new URL(`/api/task/get?task=${task}`, server.url), { headers: { ...CLI, 'x-alpacawork-provider': 'claude', 'x-alpacawork-conversation': 'outside' } });
  assert.equal(read.status, 200);
});

test('a Run\'s own project bounds what the thread answers', async t => {
  const { root, project } = workspace();
  const commands = new ControlTaskCommands(root, human);
  const { tasks: [task] } = await commands.create({ parentId: project, userRequested: null, tasks: [{ title: 'Work' }] } as never);
  const top = (await commands.create({ kind: 'project', color: '#39659b', parentId: 'P1', userRequested: null, tasks: [{ title: 'Other' }] } as never)).tasks[0]!;
  const { tasks: [other] } = await commands.create({ parentId: top.id, userRequested: null, tasks: [{ title: 'Elsewhere' }] } as never);
  const headers = runningRun(t, root, task!.id, { provider: 'codex', id: 'session-2' });
  const server = await startServer(root, 0);
  t.after(async () => { await server.close(); rmSync(root, { recursive: true, force: true }); });
  const read = (id: string, extra: Record<string, string>) => fetch(new URL(`/api/task/get?task=${id}`, server.url), { headers: extra });
  const refused = await read(other!.id, { ...CLI, ...headers });
  const same = await read(other!.id, headers);
  assert.equal(refused.status, same.status);
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), await same.json());
  assert.equal((await read(task!.id, { ...CLI, ...headers })).status, 200);
});

test('opening a Task shows what its work folder holds, which no watch reports', async t => {
  const { root, server, task } = await serve(t);
  const view = async () => (await (await fetch(new URL(`/api/task/view?task=${task}`, server.url))).json()) as { task: { files: { name: string }[] } };
  assert.deepEqual((await view()).task.files, []);
  mkdirSync(join(root, 'tasks', task, 'work', 'deep'), { recursive: true });
  writeFileSync(join(root, 'tasks', task, 'work', 'deep', 'note.md'), 'x');
  assert.deepEqual((await view()).task.files.map(file => file.name), ['work/deep/note.md']);
});

test('what a running Task\'s work folder holds reaches the screen without opening it again', async t => {
  const { server, task, headers } = await serveWithRun(t, { provider: 'codex', id: 'session-3' });
  assert.ok(headers.authorization);
  const { root } = await (await fetch(new URL('/api/identity', server.url))).json() as { root: string };
  const view = async () => (await (await fetch(new URL('/api/task/view?task=' + task, server.url))).json()) as { task: { files: { name: string }[] } };
  assert.deepEqual((await view()).task.files, []);
  const events = await fetch(new URL('/api/events', server.url));
  const reader = events.body!.getReader();
  await reader.read();
  mkdirSync(join(root, 'tasks', task, 'work', 'deep'), { recursive: true });
  writeFileSync(join(root, 'tasks', task, 'work', 'deep', 'made.md'), 'x');
  const seen = await Promise.race([reader.read().then(() => true), new Promise<boolean>(resolve => setTimeout(resolve, 10_000, false))]);
  await reader.cancel();
  assert.equal(seen, true, 'the index moves on its own');
  assert.deepEqual((await view()).task.files.map(file => file.name), ['work/deep/made.md']);
});

test('a Task folder that cannot be read keeps its own project out, not the others', { skip: process.getuid?.() === 0 }, async t => {
  const { root, project } = workspace();
  const commands = new ControlTaskCommands(root, human);
  const { tasks: [broken] } = await commands.create({ parentId: project, userRequested: null, tasks: [{ title: 'Broken' }] } as never);
  const top = (await commands.create({ kind: 'project', color: '#39659b', parentId: 'P1', userRequested: null, tasks: [{ title: 'Other' }] } as never)).tasks[0]!;
  const { tasks: [fine] } = await commands.create({ parentId: top.id, userRequested: null, tasks: [{ title: 'Fine' }] } as never);
  const folder = join(root, 'tasks', broken!.id, 'closed');
  mkdirSync(folder, { recursive: true });
  const server = await startServer(root, 0);
  t.after(async () => { chmodSync(folder, 0o700); await server.close(); rmSync(root, { recursive: true, force: true }); });
  chmodSync(folder, 0o000);
  writeFileSync(join(root, 'tasks', broken!.id, 'touched.md'), 'x');
  const { tasks: [added] } = await commands.create({ parentId: top.id, userRequested: null, tasks: [{ title: 'Added' }] } as never);
  const status = async (id: string) => (await fetch(new URL(`/api/task/view?task=${id}`, server.url))).status;
  assert.equal(await status(fine!.id), 200);
  assert.equal(await status(added!.id), 200);
});

test('a request that arrives while the service closes neither ends the thread nor goes unanswered', async t => {
  const { server, task } = await serve(t);
  const { port } = new URL(server.url);
  const socket = connect(Number(port), '127.0.0.1');
  await new Promise(resolve => socket.once('connect', resolve));
  const faults: unknown[] = [], original = console.error;
  console.error = (...args: unknown[]) => { faults.push(args); };
  t.after(() => { console.error = original; socket.destroy(); });
  const answered = new Promise<string>((resolve, reject) => { let out = ''; socket.on('data', chunk => { out += chunk; }); socket.on('close', () => resolve(out)); socket.once('error', reject); });
  // TCP connect only completes the kernel handshake; the listener may not have accepted it yet.
  // Begin this request, then complete a later connection through the same listener before closing.
  // The first request's remaining headers still arrive during shutdown.
  socket.write(`GET /api/task/get?task=${task} HTTP/1.1\r\n`);
  const ready = await fetch(new URL('/api/identity', server.url));
  assert.equal(ready.status, 200); await ready.arrayBuffer();
  const closed = server.close();
  socket.write(`Host: 127.0.0.1:${port}\r\nX-Alpacawork-Client: cli\r\n${CONTRACT_HEADER}: ${CLI_CONTRACT}\r\nConnection: close\r\n\r\n`);
  const [, reply] = await Promise.all([closed, answered]);
  assert.match(reply, /^HTTP\/1\.1 (200|503)/);
  assert(!faults.some(args => String((args as unknown[])[0]).includes('read thread')), 'the thread did not fail');
});

test('the thread\'s answer and the main thread\'s are the same', async t => {
  const { server, task } = await serve(t);
  const read = async (path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(new URL(path, server.url), { headers });
    return { status: response.status, type: response.headers.get('content-type'), cache: response.headers.get('cache-control'), body: await response.json() };
  };
  for (const path of [`/api/task/get?task=${task}`, `/api/task/get?task=${task}&log=5&runs=2`, '/api/task/list', `/api/task/returns?task=${task}`,
    '/api/field/get', '/api/task/get?task=T999999', '/api/run/get?run=R999999', '/api/task/get'])
    assert.deepEqual(await read(path, CLI), await read(path), path);
});

test('what is refused is refused as before, on either thread', async t => {
  const { server, task } = await serve(t);
  const path = new URL(`/api/task/get?task=${task}`, server.url);
  const { port } = path;
  const raw = (headers: string) => new Promise<string>((resolve, reject) => {
    const client = spawn('node', ['-e', `const s=require('net').connect(${port},'127.0.0.1');let o='';s.on('data',d=>o+=d);s.on('close',()=>console.log(o));s.write(${JSON.stringify(`GET ${path.pathname}${path.search} HTTP/1.1\r\n${headers}Connection: close\r\n\r\n`)})`], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    client.stdout.on('data', chunk => { out += chunk; });
    client.on('close', () => resolve(out));
    client.on('error', reject);
  });
  assert.match(await raw(`Host: evil.example\r\nX-Alpacawork-Client: cli\r\n${CONTRACT_HEADER}: ${CLI_CONTRACT}\r\n`), /^HTTP\/1\.1 403[\s\S]*host_not_local_service/);
  assert.match(await raw(`Host: 127.0.0.1:${port}\r\nOrigin: http://evil.example\r\nX-Alpacawork-Client: cli\r\n${CONTRACT_HEADER}: ${CLI_CONTRACT}\r\n`), /^HTTP\/1\.1 403[\s\S]*cross_origin_request_rejected/);
  assert.match(await raw(`Host: 127.0.0.1:${port}\r\nAuthorization: nonsense\r\nX-Alpacawork-Client: cli\r\n${CONTRACT_HEADER}: ${CLI_CONTRACT}\r\n`), /^HTTP\/1\.1 403[\s\S]*invalid_run_authorization_header/);
  assert.match(await raw(`Host: 127.0.0.1:${port}\r\nAuthorization: Alpacawork-Run R1:${'0'.repeat(64)}\r\nX-Alpacawork-Client: cli\r\n${CONTRACT_HEADER}: ${CLI_CONTRACT}\r\n`), /^HTTP\/1\.1 403[\s\S]*run_credential_missing_or_invalid/);
});

test('a connection is passed on unread: a stream and a body arrive whole', async t => {
  const { server, task, root } = await serve(t);
  const events = await fetch(new URL('/api/events', server.url));
  assert.equal(events.status, 200);
  const reader = events.body!.getReader();
  assert((await reader.read()).value!.length > 0, 'the stream delivers through the thread');
  await reader.cancel();
  const bytes = Buffer.alloc(3_000_000, 7);
  const put = await fetch(new URL(`/api/tasks/${task}/file?path=big.bin`, server.url), { method: 'PUT', body: bytes, headers: { 'content-type': 'application/octet-stream', 'x-alpacawork-content-digest': fileDigest(bytes), 'x-alpacawork-op-id': 'b5b5e1d8-9c1b-4d9b-8f6a-0f3a1a1a1a1a' } });
  assert.equal(put.status, 200, await put.clone().text());
  assert.equal(readFileSync(join(root, 'tasks', task, 'big.bin')).length, bytes.length);
});

test('a port in use fails the start with its own error', async t => {
  const blocker = createServer();
  await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => { blocker.close(); });
  const { root } = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(startServer(root, (blocker.address() as { port: number }).port), { code: 'EADDRINUSE' });
});

test('a serve returns a database in rollback mode to WAL', async t => {
  const { root } = workspace();
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => { await server?.close(); rmSync(root, { recursive: true, force: true }); });
  const file = controlDatabasePath(root);
  const before = new DatabaseSync(file);
  before.exec('PRAGMA journal_mode=DELETE');
  assert.equal(before.prepare('PRAGMA journal_mode').get()!.journal_mode, 'delete');
  before.close();
  server = await startServer(root, 0);
  const after = new DatabaseSync(file, { readOnly: true });
  assert.equal(after.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
  after.close();
});

test('a Task\'s change walks that Task\'s folder alone', async t => {
  const root = mkdtempSync(join(tmpdir(), 'read-thread-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const task of ['T1', 'T2']) { mkdirSync(join(root, 'tasks', task), { recursive: true }); writeFileSync(join(root, 'tasks', task, 'a.md'), 'a'); }
  const index = new TaskFileIndex(), writer = new FileWriter(root);
  t.after(() => writer.close());
  const names = (folder: string) => index.read(writer, ['tasks/T1', 'tasks/T2']).get(folder)!.map(file => file.name);
  assert.deepEqual(names('tasks/T1'), ['a.md']);
  for (const task of ['T1', 'T2']) writeFileSync(join(root, 'tasks', task, 'b.md'), 'b');
  assert.deepEqual(names('tasks/T1'), ['a.md'], 'a list is kept until it is marked');
  index.invalidate('tasks/T1');
  assert.deepEqual(names('tasks/T1'), ['a.md', 'b.md']);
  assert.deepEqual(names('tasks/T2'), ['a.md'], 'another Task\'s list is not walked');
  index.invalidate();
  let turns = 0;
  await index.refresh(() => new FileWriter(root), async () => { turns++; });
  assert.equal(turns, 2, 'a whole repair yields between folders');
  assert.deepEqual(names('tasks/T2'), ['a.md', 'b.md']);
});
