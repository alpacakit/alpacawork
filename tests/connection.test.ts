import { commandFetch as fetch } from './helpers/command-fetch.ts';
import { cleanCliEnv } from './helpers/http-cli.ts';
import { describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { connect, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { ControlStore } from '@alpacawork/db';
import { initialControlDocument } from '@alpacawork/raw';
import { MAX_TITLE_LENGTH } from '@alpacawork/raw/values';
import { TaskRepository } from '@alpacawork/backend/test-dist/control/task-store.js';
import { createInterface } from 'node:readline';

/**
 * The connection-limit cases live apart from platform.test.ts because they
 * are waiting, not working: each one sits out a server timeout measured in tens
 * of seconds. node --test runs files in parallel but the tests inside one file
 * in order, so a file of their own lets their waits overlap the rest of the
 * suite, and a workspace per test (instead of a shared beforeEach) lets their
 * waits overlap each other. What either case asserts is unchanged.
 */
const project = resolve(import.meta.dirname, '..');
const BACKEND = 'apps/backend/dist/backend.js';

type Workspace = { root: string; adopt(child: ReturnType<typeof spawn>): void; adoptSocket(socket: Socket): void };

function run(root: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(done => {
    const home = dirname(root);
    const child = spawn(process.execPath, [BACKEND, '--workspace', root, ...args], { cwd: project,
      env: cleanCliEnv({ HOME: home, XDG_CONFIG_HOME: join(home, '.config') }), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout!.on('data', d => stdout += d); child.stderr!.on('data', d => stderr += d);
    child.on('close', code => done({ code, stdout, stderr }));
  });
}
async function cli(root: string, command: string, ...args: string[]) {
  const result = await run(root, [command, ...args]);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  return JSON.parse(result.stdout);
}
/** One throwaway workspace per test, torn down by the test's own after hook. */
async function workspace(t: TestContext): Promise<Workspace> {
  const area = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-connection-')));
  const root = join(area, 'tasks');
  const children: ReturnType<typeof spawn>[] = [];
  const sockets: Socket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    rmSync(area, { recursive: true, force: true });
  });
  await cli(root, 'workspace', 'init');
  return { root, adopt: child => { children.push(child); }, adoptSocket: socket => { sockets.push(socket); } };
}
async function start(work: Workspace) {
  const child = spawn(process.execPath, ['tests/drive-server.ts', work.root], { cwd: project, env: cleanCliEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  work.adopt(child);
  let stderr = ''; child.stderr!.on('data', d => stderr += d);
  const lines = createInterface({ input: child.stdout! });
  const line = await Promise.race([once(lines, 'line').then(([v]) => v), once(child, 'exit').then(() => { throw new Error(stderr); })]);
  const info = JSON.parse(line as string); info.base = info.url.split('/#')[0]; return info;
}
/**
 * Waits for `work`, giving up after `ms`, and then cancels the deadline. The
 * cancellation is the point: a timers/promises timer holds the event loop open
 * until it fires, so a 45s guard that had already lost the race kept this
 * file's worker process alive for ~24s after the last assertion passed. The
 * tests were finished; the process was not. Aborting the guard costs nothing
 * while the race is undecided and releases the loop the moment it is.
 */
async function within<T>(work: Promise<T>, ms: number, lapsed: T): Promise<T> {
  const guard = new AbortController();
  try {
    return await Promise.race([work, delay(ms, lapsed, { signal: guard.signal })]);
  } finally {
    guard.abort();
  }
}
/**
 * The server declares requestTimeout/headersTimeout = 5000. node only judges
 * those on its connection sweep, so a sweep interval left at the 30s default
 * silently stretches the cutoff sixfold while every assertion below still
 * passes. Only a measured bound catches that, hence the window on `elapsed`:
 * 5000ms declared + at most one 1000ms sweep, widened to 4000-10000ms so that
 * a loaded machine has ~4s of slack while a return to the 30s default (~30000ms)
 * still fails by a wide margin.
 */
const CUTOFF_FLOOR = 4000, CUTOFF_CEILING = 10000;

describe('connection limits', { concurrency: 3 }, () => {
test('a stalled request is closed at the declared five seconds, not tens of seconds later', { timeout: 60000 }, async (t) => {
  const work = await workspace(t);
  const app = await start(work), port = Number(new URL(app.base).port);
  const socket = connect(port, '127.0.0.1'); work.adoptSocket(socket); await once(socket, 'connect');
  let data = ''; socket.on('data', d => data += d);
  const began = Date.now();
  socket.write(`GET /api/commands/field/get HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`);
  const closed = await within(once(socket, 'close').then(() => true), 45000, false);
  const elapsed = Date.now() - began;
  socket.destroy();
  t.diagnostic(`stalled request closed after ${elapsed}ms`);
  assert.equal(closed, true, 'headers that never finish must not hold a connection open');
  assert.equal(data.split('\r\n')[0], 'HTTP/1.1 408 Request Timeout');
  assert.ok(elapsed >= CUTOFF_FLOOR, `closed after ${elapsed}ms, sooner than the declared 5s cutoff`);
  assert.ok(elapsed <= CUTOFF_CEILING, `closed after ${elapsed}ms; the server declares a 5s cutoff, so it is not being enforced when declared`);
});
test('a subscriber that never reads is dropped once its send buffer exceeds the publication limit', { timeout: 60000 }, async (t) => {
  const work = await workspace(t), root = work.root;
  // The index carries a row per Task: many Tasks with the longest titles make the initial index alone exceed the 4 MiB
  // buffer limit (a Task's values never ride in its row).
  const seeded = seedRows(root, 6000, 'あ'.repeat(MAX_TITLE_LENGTH - 6));
  const app=await start(work),port=Number(new URL(app.base).port);
  const post=async(path:string,body:object)=>{
    const response=await fetch(new URL('/api/'+path,app.base),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal(response.status,200,await response.clone().text());
    return response.json();
  };
  // Each round publishes a change: a retitle of a few seeded Tasks.
  const change=async(round:number)=>{for(const task of seeded.slice(0,4)){const saved=await post('commands/task/update',{task:task.id,title:`Round ${round} ${task.id}`,expectedTaskHash:task.hash});task.hash=saved.task.hash;}};
  const socket=connect(port,'127.0.0.1');work.adoptSocket(socket);await once(socket,'connect');
  // The subscriber never reads, so every published change stays in the server's write buffer.
  socket.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
  // Receiving bytes proves that the initial index has registered this subscriber.
  // Leave the bytes unread so the following publications exercise real backpressure.
  await once(socket, 'readable');
  // The initial index exceeds the 4 MiB buffer limit. One subsequent
  // publication must check that backlog and drop the unread subscriber.
  // The bytes first fill the socket buffers between this client and the server's thread, so the server's own backlog
  // grows only after them: changes go on being published until it is over the limit.
  const ended=once(socket,'end').then(()=>true);
  let dropped=false;
  for(let round=0;round<6&&!dropped;round++){
    await change(round);
    dropped=await within(new Promise<boolean>(resolve=>{socket.once('close',()=>resolve(true));}),round<5?1500:0,false);
  }
  socket.resume();
  dropped=await within(ended,20000,false);
  socket.destroy();
  assert.equal(dropped,true,'a subscriber that cannot keep up must be disconnected, not buffered without bound');
});
/** `count` Tasks under P1 with `title`, in one write before the server starts. */
function seedRows(root: string, count: number, title: string): { id: string; hash: string }[] {
  const control = new ControlStore(root, { busyTimeoutMs: 1000 });
  try {
    return control.write(db => {
      const tasks = new TaskRepository(root, db);
      return Array.from({ length: count }, (_, n) => {
        const id = tasks.create('task', id => ({ values: {}, meta: initialControlDocument(id, 'P1', `${n} ${title}`,
          { kind: 'task', userRequested: true, actor: { kind: 'human' } }) }));
        return { id, hash: tasks.get(id).hash };
      });
    });
  } finally { control.close(); }
}
test('an incomplete POST body is closed before the server can answer', { timeout: 60000 }, async (t) => {
  const work = await workspace(t);
  const app=await start(work),port=Number(new URL(app.base).port);
  async function stall(head:string){
    const socket=connect(port,'127.0.0.1');work.adoptSocket(socket);await once(socket,'connect');
    let data='';socket.on('data',d=>data+=d);socket.write(head);
    const closed=await within(once(socket,'close').then(()=>true),45000,false);
    socket.destroy();return {closed,status:data.split('\r\n')[0]};
  }
  const body = await stall(`POST /api/commands/task/request HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{`);
  assert.equal(body.closed,true,'a body that never finishes must not hold a connection open');
  assert.equal(body.status,'HTTP/1.1 408 Request Timeout');
});
});
