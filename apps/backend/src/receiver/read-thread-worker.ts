import { commandLinks, commandOrigin } from './command-links.js';
import { clientContract } from './client-contract.js';
/** See read-thread.ts. Whatever this thread is not sure of goes to the main thread, which answers as it always has. */
import { connect, createServer as createTcpServer, type Socket } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { parentPort, workerData } from 'node:worker_threads';
import { collectHttpRoutes } from '@alpacakit/channels/http';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { compressApiResponses } from './api-compression.js';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { errorBody, failure } from '@alpacawork/core';
import { ControlStore, markControlFileSound } from '@alpacawork/db';
import { RunStore } from '@alpacawork/runs';
import type { Caller } from '../control/authorize.js';
import { resolveCaller, resolvingMayImport } from '../control/credentials.js';
import { serverCommandTree, serverCommands, type Context } from './entries.js';
import { claimOf, jsonHeaders, requestScope } from './request-scope.js';
import type { ReadThreadData } from './read-thread.js';

const { root, port, publicHost, backendPort, soundFile, answers } = workerData as ReadThreadData;
if (soundFile) markControlFileSound(soundFile);

const commands = new Map<string, (query: Record<string, string[]>) => Record<string, unknown> | null>();
const eligible = [...serverCommands.values()].filter(command => command.implementation.readThread);
const readsByPath = new Map(eligible.map(command => [command.path, command.implementation.readThread!]));
function repeatedQuery(url: URL) {
  const query: Record<string, string[]> = Object.create(null);
  for (const [key, value] of url.searchParams) (query[key] ??= []).push(value);
  return query;
}
/** The caller each answered connection was judged with: a connection is judged once, and no import runs here. */
type AcceptedRead = { caller: Caller; input: Record<string, unknown> };
const judged = new WeakMap<object, AcceptedRead>();

const api = new Hono();
api.use('/api/*', compressApiResponses);
api.use('/api/*', clientContract());
collectHttpRoutes(serverCommandTree.tree).forEach(route => {
  const path = '/api' + route.path, read = readsByPath.get(path);
  if (route.method !== 'GET' || !read) return;
  commands.set(path, query => {
    const input = route.input.parseQuery(query) as Record<string, unknown>;
    return read(input) ? input : null;
  });
  api.get(path, async c => {
    const { cwd } = requestScope(c.req.raw.headers, true);
    const { caller, input } = judged.get((c.env as { incoming: { socket: object } }).incoming.socket)!;
    // One read point for the whole answer: on this thread the main thread's commits can fall between its parts.
    const control = new ControlStore(root, { busyTimeoutMs: 1000 }, true);
    try {
      const result = await control.readAsync(async () => route.handler(input as never,
        { root, caller: () => caller, cwd } as Context as never));
      return result instanceof Response ? result : c.json(commandLinks(result, commandOrigin(c.req.raw, publicHost)), 200, jsonHeaders);
    } finally { control.close(); }
  });
});
api.onError((error, c) => c.json(errorBody(error), failure(error).status as ContentfulStatusCode, jsonHeaders));
const answer = getRequestListener(api.fetch, { overrideGlobalObjects: false });
let answering = 0;
let finished: (() => void) | undefined;
const answered = new WeakSet<Socket>();
const reads = createHttpServer({ keepAliveTimeout: 0 }, (req, res) => {
  // Each connection is judged once, by its first request: the next request on it may be anything.
  res.setHeader('Connection', 'close');
  if (answered.has(req.socket)) { res.writeHead(400).end(); return; }
  answered.add(req.socket);
  answering++;
  res.once('close', () => { if (--answering === 0) finished?.(); });
  void answer(req, res);
});

const MAX_HEAD = 64 * 1024, HEAD_WAIT_MS = 5_000;
/** The names this listener answers to; a connection can still arrive with its request after listening has stopped. */
let hosts: ReadonlySet<string> = new Set();

/** The caller when this thread answers the connection whose first request's head is `head`; else the main thread does. */
function answerable(head: string): AcceptedRead | null {
  const end = head.indexOf('\r\n');
  const [method, target, version] = head.slice(0, end).split(' ');
  if (method !== 'GET' || version !== 'HTTP/1.1' || !target) return null;
  const url = new URL(target, 'http://read.invalid');
  const parse = commands.get(url.pathname);
  if (!parse) return null;
  const headers = new Headers();
  for (const line of head.slice(end + 2).split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  // A browser's request, another host or anything to refuse is the main thread's to judge.
  if (headers.get('x-alpacawork-client') !== 'cli' || headers.has('origin') || !hosts.has(headers.get('host') ?? '')) return null;
  const input = parse(repeatedQuery(url));
  if (input === null) return null;
  const claim = claimOf(headers);
  const store = RunStore.openReadable(root, { busyTimeoutMs: 1000 });
  if (!store) return null;
  try { return resolvingMayImport(claim, store) ? null : { caller: resolveCaller(root, claim, store, false), input }; }
  finally { store.close(); }
}

/** The connections no request has decided yet; closing hands them to the main thread, which answers them as it closes. */
const undecided = new Set<() => Promise<void>>();
function passOn(socket: Socket, head: Buffer): Promise<void> {
  const backend = connect({ port: backendPort, host: '127.0.0.1', noDelay: true, allowHalfOpen: true });
  const connected = new Promise<void>(resolve => { backend.once('connect', resolve); backend.once('error', () => resolve()); });
  const fail = () => { socket.destroy(); backend.destroy(); };
  backend.on('error', fail);
  socket.on('error', fail);
  backend.on('close', () => socket.destroy());
  socket.on('close', () => backend.destroy());
  if (head.length) backend.write(head);
  socket.pipe(backend);
  backend.pipe(socket);
  socket.resume();
  return connected;
}
function answerHere(socket: Socket, head: Buffer, accepted: AcceptedRead) {
  judged.set(socket, accepted);
  socket.pause();
  socket.unshift(head);
  reads.emit('connection', socket);
  process.nextTick(() => socket.resume());
}

const front = createTcpServer({ noDelay: true, allowHalfOpen: true, pauseOnConnect: false }, socket => {
  let head = Buffer.alloc(0);
  const settled = (caller: AcceptedRead | null): Promise<void> => {
    clearTimeout(timer);
    undecided.delete(handOver);
    socket.off('data', received);
    socket.off('end', ended);
    socket.off('error', failed);
    if (caller) { answerHere(socket, head, caller); return Promise.resolve(); }
    return passOn(socket, head);
  };
  const handOver = () => settled(null);
  undecided.add(handOver);
  // No complete head in time: the main thread keeps its own header deadline for it.
  const timer = setTimeout(() => { void settled(null); }, HEAD_WAIT_MS);
  const ended = () => { void settled(null); };
  const failed = () => { clearTimeout(timer); undecided.delete(handOver); socket.destroy(); };
  const received = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const lineEnd = head.indexOf('\r\n');
    const line = lineEnd < 0 ? '' : head.subarray(0, lineEnd).toString('latin1');
    // Most connections are decided by their first line, without waiting for the rest of a head that may be slow to come.
    if (!answers || head.length > MAX_HEAD || lineEnd >= 0 && (!line.startsWith('GET ') || !commands.has(line.slice(4, line.lastIndexOf(' ')).split('?')[0]!))) { void settled(null); return; }
    const end = head.indexOf('\r\n\r\n');
    if (end < 0) return;
    let caller: AcceptedRead | null = null;
    try { caller = answerable(head.subarray(0, end).toString('latin1')); }
    catch { /* The main thread gives the refusal. */ }
    void settled(caller);
  };
  socket.on('data', received);
  socket.on('end', ended);
  socket.on('error', failed);
});
front.on('error', (error: NodeJS.ErrnoException) => {
  parentPort!.postMessage({ failed: { message: error.message, ...error.code ? { code: error.code } : {} } });
});
front.listen(port, '127.0.0.1', () => {
  const bound = (front.address() as { port: number }).port;
  hosts = new Set([`127.0.0.1:${bound}`, `localhost:${bound}`, ...publicHost ? [publicHost] : []]);
  parentPort!.postMessage({ listening: bound });
});
// Closing: no new connection, and those still waiting go to the main thread, which answers them as it closes.
parentPort!.on('message', (message: 'stop' | 'finish') => {
  if (message === 'stop') {
    front.close(() => undefined);
    void Promise.all([...undecided].map(handOver => handOver())).then(() => parentPort!.postMessage({ stopped: true }));
    return;
  }
  const done = () => parentPort!.postMessage({ finished: true });
  if (answering === 0) done(); else finished = done;
});
