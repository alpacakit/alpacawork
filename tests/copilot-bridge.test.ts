/** Use a fake SDK JSON-RPC server. The bundled Copilot runtime is never launched. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnBridge } from './helpers/bridge-process.ts';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { assertInputOutcomes } from './fixtures/input-outcomes.ts';
import { scratch } from './helpers/managed-skills-fixture.ts';
import { privateNodeApp } from './helpers/private-node-app.ts';

const bridge = join(import.meta.dirname, '../apps/agent-cli/dist/cli.js');

async function setup(t: TestContext, resume = false, badOutput = false) {
  const area = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-copilot-')));
  t.after(() => rmSync(area, { recursive: true, force: true }));
  const requests: any[] = [];
  let socket: Socket | null = null, nextMessage = 0, sessionId = 'session-1';
  const messages = new Map<string, string>();
  let heldSend: { requestId: number; messageId: string } | null = null;
  const write = (message: object) => {
    const body = JSON.stringify(message);
    socket?.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  const event = (type: string, data: object) => write({ jsonrpc: '2.0', method: 'session.event', params: {
    sessionId, event: { id: randomUUID(), parentId: null, timestamp: new Date().toISOString(), type, data } } });
  const server = createServer(connection => {
    socket = connection;
    let buffer = Buffer.alloc(0);
    connection.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const header = buffer.subarray(0, end).toString();
        const size = Number(/Content-Length: (\d+)/i.exec(header)?.[1]);
        if (!Number.isFinite(size) || buffer.length < end + 4 + size) return;
        const message = JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString());
        buffer = buffer.subarray(end + 4 + size);
        requests.push(message);
        const reply = (result: object) => write({ jsonrpc: '2.0', id: message.id, result });
        if (message.method === 'connect') reply({ protocolVersion: 3 });
        else if (message.method === 'session.create' || message.method === 'session.resume') {
          sessionId = message.params.sessionId;
          reply({ sessionId });
        }
        else if (message.method === 'session.send') {
          if (message.params.prompt === 'refuse') {
            write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'send refused' } });
            continue;
          }
          const messageId = `message-${++nextMessage}`;
          messages.set(message.params.prompt, messageId);
          if (message.params.prompt === 'race') {
            heldSend = { requestId: message.id, messageId };
            continue;
          }
          reply({ messageId });
          const delivery = message.params.mode === 'immediate'
            ? message.params.prompt === 'late' ? 'queued' : 'steering' : 'idle';
          setImmediate(() => event('user.message', { messageId, content: message.params.prompt, delivery,
            interactionId: `interaction-${messageId}` }));
        } else if (message.method === 'ping') reply({ message: '', timestamp: new Date().toISOString(), protocolVersion: 3 });
        else reply({});
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { socket?.destroy(); server.close(); });
  const port = (server.address() as { port: number }).port;
  const args = [bridge, 'copilot', '--server-url', `127.0.0.1:${port}`, '-o', badOutput ? area : join(area, 'result')];
  if (resume) args.push('resume', 'session-1');
  const { child, exited, events, until, stderr, send } = spawnBridge(t, args, { cwd: area });

  return { area, requests, exited, events, until, child, stderr,
    send,
    answer: (prompt: string, content: string) => event('assistant.message', { messageId: randomUUID(), content,
      originatingMessageId: messages.get(prompt) }),
    startQueued: (prompt: string) => event('assistant.turn_start', { turnId: randomUUID(),
      interactionId: `interaction-${messages.get(prompt)}` }),
    releaseRace: () => {
      assert.ok(heldSend);
      write({ jsonrpc: '2.0', id: heldSend.requestId, result: { messageId: heldSend.messageId } });
      heldSend = null;
    },
    deliverRace: () => event('user.message', { messageId: messages.get('race'), content: 'race', delivery: 'idle' }),
    idle: () => event('session.idle', {}),
    error: (eligibleForAutoSwitch = false) => event('session.error', { errorType: eligibleForAutoSwitch ? 'rate_limit' : 'provider',
      message: 'provider failed', eligibleForAutoSwitch }),
    disconnect: () => socket?.destroy() };
}

test('Copilot SDK confirms first and mid-turn delivery by message ID, then completes', async t => {
  const h = await setup(t);
  h.send('one', 'start');
  await h.until(() => h.events().some(event => event.type === 'input.taken' && event.id === 'one'));
  h.send('two', 'steer');
  await h.until(() => h.events().some(event => event.type === 'input.taken' && event.id === 'two'));
  h.send('three', 'refuse');
  await h.until(() => h.events().some(event => event.type === 'input.uncertain' && event.id === 'three'));
  h.answer('start', 'answer');
  h.idle();
  await h.until(() => h.events().some(event => event.type === 'turn.completed'));
  h.child.stdin.end();
  assert.equal(await h.exited, 0);
  assertInputOutcomes(h.events(), { one: 'taken', two: 'taken', three: 'uncertain' });
  assert.equal(readFileSync(join(h.area, 'result'), 'utf8'), 'answer');
  assert.deepEqual(h.requests.filter(request => request.method === 'session.send').map(request => request.params.mode),
    ['enqueue', 'immediate', 'immediate']);
  assert.deepEqual(h.events().filter(event => event.type === 'input.accepted').map(event => event.id), ['one', 'two']);
});

test('Copilot queued input joins only after its SDK turn starts, then a later input starts a new turn', async t => {
  const h = await setup(t, true);
  h.send('one', 'start');
  await h.until(() => h.events().some(event => event.type === 'input.taken' && event.id === 'one'));
  h.send('two', 'late');
  await h.until(() => h.events().some(event => event.type === 'input.accepted' && event.id === 'two'));
  assert.equal(h.events().some(event => event.type === 'input.taken' && event.id === 'two'), false);
  assert.equal(h.events().some(event => event.type === 'input.uncertain' && event.id === 'two'), false);
  h.answer('start', 'first answer');
  h.startQueued('late');
  await h.until(() => h.events().some(event => event.type === 'input.taken' && event.id === 'two'));
  assert.equal(h.events().some(event => event.type === 'turn.completed'), false);
  h.answer('late', 'late answer');
  h.idle();
  await h.until(() => h.events().some(event => event.type === 'turn.completed'));
  assert.equal(h.events().filter(event => event.type === 'input.taken' && event.id === 'two').length, 1);
  assert.equal(h.events().some(event => event.type === 'input.uncertain' && event.id === 'two'), false);
  assert.equal(readFileSync(join(h.area, 'result'), 'utf8'), 'late answer');
  h.send('three', 'next');
  await h.until(() => h.events().some(event => event.type === 'input.taken' && event.id === 'three'));
  h.answer('next', 'next answer');
  h.idle();
  await h.until(() => h.events().filter(event => event.type === 'turn.completed').length === 2);
  h.child.stdin.end();
  assert.equal(await h.exited, 0);
  assertInputOutcomes(h.events(), { one: 'taken', two: 'taken', three: 'taken' });
  assert.equal(readFileSync(join(h.area, 'result'), 'utf8'), 'next answer');
  assert.ok(h.requests.some(request => request.method === 'session.resume' && request.params.sessionId === 'session-1'));
});

test('Copilot session idle confirms a drained queued turn even without a visible reply', async t => {
  const h = await setup(t);
  h.send('one', 'start');
  await h.until(() => h.events().some(event => event.type === 'input.taken' && event.id === 'one'));
  h.send('two', 'late');
  await h.until(() => h.events().some(event => event.type === 'input.accepted' && event.id === 'two'));
  assert.equal(h.events().some(event => event.type === 'input.taken' && event.id === 'two'), false);
  h.answer('start', 'first answer');
  h.idle();
  await h.until(() => h.events().some(event => event.type === 'turn.completed'));
  assert.equal(h.events().filter(event => event.type === 'input.taken' && event.id === 'two').length, 1);
  assert.equal(h.events().some(event => event.type === 'input.uncertain' && event.id === 'two'), false);
  h.child.stdin.end();
  assert.equal(await h.exited, 0);
  assertInputOutcomes(h.events(), { one: 'taken', two: 'taken' });
});

test('Copilot waits when the previous idle races with an unacknowledged send', async t => {
  const h = await setup(t);
  h.send('one', 'start');
  await h.until(() => h.events().some(event => event.type === 'input.taken' && event.id === 'one'));
  h.send('two', 'race');
  await h.until(() => h.requests.some(request => request.method === 'session.send' && request.params.prompt === 'race'));
  h.answer('start', 'first answer');
  h.idle();
  h.releaseRace();
  await h.until(() => h.events().some(event => event.type === 'input.accepted' && event.id === 'two'));
  assert.equal(h.events().some(event => event.type === 'input.taken' && event.id === 'two'), false);
  assert.equal(h.events().some(event => event.type === 'turn.completed'), false);
  h.deliverRace();
  await h.until(() => h.events().some(event => event.type === 'input.taken' && event.id === 'two'));
  assert.equal(h.events().some(event => event.type === 'turn.completed'), false);
  h.answer('race', 'second answer');
  h.idle();
  await h.until(() => h.events().some(event => event.type === 'turn.completed'));
  h.child.stdin.end();
  assert.equal(await h.exited, 0);
  assertInputOutcomes(h.events(), { one: 'taken', two: 'taken' });
  assert.equal(readFileSync(join(h.area, 'result'), 'utf8'), 'second answer');
  assert.equal(h.events().filter(event => event.type === 'input.taken' && event.id === 'two').length, 1);
});

test('Copilot refuses an unprocessed queued input on session error or lost transport', async t => {
  const h = await setup(t);
  h.send('one', 'start');
  await h.until(() => h.events().some(event => event.type === 'input.taken'));
  h.send('two', 'late');
  await h.until(() => h.events().some(event => event.type === 'input.accepted' && event.id === 'two'));
  h.error();
  await h.until(events => events.some(event => event.type === 'turn.failed') &&
    events.some(event => event.type === 'input.uncertain' && event.id === 'two'));
  assert.ok(h.events().some(event => event.type === 'input.uncertain' && event.id === 'two'));
  assert.equal(h.events().some(event => event.type === 'input.taken' && event.id === 'two'), false);
  h.child.stdin.end();
  assert.equal(await h.exited, 1);
  assertInputOutcomes(h.events(), { one: 'taken', two: 'uncertain' });

  const lost = await setup(t);
  lost.send('one', 'start');
  await lost.until(() => lost.events().some(event => event.type === 'input.taken'));
  lost.send('two', 'late');
  await lost.until(() => lost.events().some(event => event.type === 'input.accepted' && event.id === 'two'));
  lost.disconnect();
  assert.equal(await lost.exited, 1);
  assertInputOutcomes(lost.events(), { one: 'taken', two: 'uncertain' });
  assert.ok(lost.events().some(event => event.type === 'input.uncertain' && event.id === 'two'));
  assert.match(lost.stderr(), /Copilot SDK connection lost/);
});

test('Copilot settles a queued input exactly once when the process receives SIGTERM', async t => {
  const h = await setup(t);
  h.send('one', 'start');
  await h.until(() => h.events().some(event => event.type === 'input.taken' && event.id === 'one'));
  h.send('two', 'late');
  await h.until(() => h.events().some(event => event.type === 'input.accepted' && event.id === 'two'));
  assert.equal(h.events().some(event => event.id === 'two' && event.type === 'input.taken'), false);
  h.child.kill('SIGTERM');
  assert.equal(await new Promise(resolve => h.child.once('close', resolve)), 143);
  assertInputOutcomes(h.events(), { one: 'taken', two: 'uncertain' });
});

test('Copilot waits through an eligible auto-switch error', async t => {
  const h = await setup(t);
  h.send('one', 'start');
  await h.until(() => h.events().some(event => event.type === 'input.taken'));
  h.send('two', 'late');
  await h.until(() => h.events().some(event => event.type === 'input.accepted' && event.id === 'two'));
  h.error(true);
  h.startQueued('late');
  await h.until(() => h.events().some(event => event.type === 'input.taken' && event.id === 'two'));
  assert.equal(h.events().some(event => event.type === 'input.uncertain' && event.id === 'two'), false);
  assert.equal(h.events().some(event => event.type === 'turn.failed'), false);
  h.answer('late', 'recovered answer');
  h.idle();
  await h.until(() => h.events().some(event => event.type === 'turn.completed'));
  h.child.stdin.end();
  assert.equal(await h.exited, 0);
  assertInputOutcomes(h.events(), { one: 'taken', two: 'taken' });
  assert.equal(readFileSync(join(h.area, 'result'), 'utf8'), 'recovered answer');
});

test('Copilot exits nonzero when its result file cannot be written', async t => {
  const h = await setup(t, false, true);
  h.send('one', 'start');
  await h.until(() => h.events().some(event => event.type === 'input.taken'));
  h.answer('start', 'answer');
  h.idle();
  assert.equal(await h.exited, 1);
  assertInputOutcomes(h.events(), { one: 'taken' });
  assert.match(h.stderr(), /EISDIR/);
});

// Close during start: the real SDK spawning a runtime over stdio, with close reached through the bridge's public stdin.
const fixtures = join(import.meta.dirname, 'fixtures');
const sdk = realpathSync(join(import.meta.dirname, '../apps/agent-cli/node_modules/@github/copilot-sdk'));
const SHUTDOWN = 'runtime.shutdown';

/** The built bridge with one part of this behavior edited in a private copy: what a test then sees comes from that edit. */
function editedBridge(t: TestContext, edit: (text: string) => string): string {
  const { entry } = privateNodeApp(t, 'agent-cli');
  const before = readFileSync(entry, 'utf8'), after = edit(before);
  assert.notEqual(after, before, 'the edit must apply to the emitted bridge');
  writeFileSync(entry, after);
  return entry;
}
const withoutGuard = (t: TestContext) => editedBridge(t, text => text.replace(/if \(this\.closing\) \{\s*await this\.stopClient\(\);/, 'if (false) {'));
/** The runner as it was before input was read during start. */
const parserAfterStart = (t: TestContext) => editedBridge(t, text => {
  const from = text.indexOf('const decoder = new TextDecoder');
  const start = /work = new Promise[^\n]*resolve\(runtime\.start\(\)\)[^\n]*\.catch\(fatal\);/.exec(text);
  if (from < 0 || !start || start.index <= from) return text;
  return `${text.slice(0, from)}void runtime.start().then(() => {\n${text.slice(from, start.index)}}).catch(fatal);\n${text.slice(start.index + start[0].length)}`;
});

type Opening = { resume?: boolean; hold?: string[]; beforeSpawn?: boolean; bridge?: string };
function opening(t: TestContext, { resume = false, hold = [], beforeSpawn = false, bridge: entry = bridge }: Opening) {
  const area = scratch(t, 'alpacawork-copilot-close-'), log = join(area, 'runtime.jsonl'), runtime = join(area, 'copilot'), spawnGate = join(area, 'open-spawn');
  writeFileSync(runtime, `#!/bin/sh\nexec "${process.execPath}" "${join(fixtures, 'fake-copilot-cli.mjs')}"\n`, { mode: 0o755 });
  const gate = (method: string) => join(area, `open-${method}`);
  const b = spawnBridge(t, [...beforeSpawn ? ['--import', join(fixtures, 'copilot-spawn-gate.mjs')] : [], entry, 'copilot', ...resume ? ['resume', 'session-1'] : [], '-o', join(area, 'result')], { cwd: area, env: {
    PATH: process.env.PATH, HOME: area, COPILOT_CLI_PATH: runtime, FAKE_COPILOT_LOG: log, FAKE_COPILOT_HOLD: JSON.stringify(Object.fromEntries(hold.map(method => [method, gate(method)]))),
    COPILOT_SDK_ENTRY: pathToFileURL(join(sdk, 'dist/index.js')).href, COPILOT_SPAWN_GATE: spawnGate } });
  const rows = () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { ...b, rows, method: resume ? 'session.resume' : 'session.create', spawnGate,
    count: (method: string) => rows().filter(row => row.method === method).length,
    open: (method: string) => writeFileSync(gate(method), ''),
    types: () => b.events().map(row => row.type),
    /** The one thing a caller can send that closes the bridge during start. */
    reuseId() { b.send('one', 'first'); b.send('one', 'other'); } };
}
type Run = ReturnType<typeof opening>;
const stopBegan = (b: Run) => b.until(() => b.count(SHUTDOWN) > 0, 'stop began');
/** Each returns once start has gone on past the close, however it went on. */
const closes: { name: string; hold: (method: string) => string[]; beforeSpawn?: true; openedBefore: number; step(b: Run): Promise<void> }[] = [
  { name: 'close before the SDK spawned anything', hold: () => [], beforeSpawn: true, openedBefore: 0, async step(b) {
    b.reuseId();
    await b.until(events => events.some(row => row.type === 'input.not_sent'), 'not_sent');
    assert.deepEqual(b.rows(), [], 'nothing has spawned yet');
    writeFileSync(b.spawnGate, '');
    await b.until(() => b.count(b.method) > 0 || b.count(SHUTDOWN) > 0, 'start went on');
  } },
  { name: 'close while connect is unanswered', hold: () => ['connect', SHUTDOWN], openedBefore: 0, async step(b) {
    await b.until(() => b.count('connect') > 0, 'connect');
    b.reuseId();
    await stopBegan(b);
    b.open('connect');
    await b.until(() => b.count(b.method) > 0 || b.count(SHUTDOWN) > 1, 'start went on');
    b.open(SHUTDOWN);
  } },
  { name: 'close while the session answer is awaited', hold: method => [method, SHUTDOWN], openedBefore: 1, async step(b) {
    await b.until(() => b.count(b.method) > 0, 'session request');
    b.reuseId();
    await stopBegan(b);
    b.open(b.method);
    await b.until(events => events.some(row => row.type === 'thread.started') || b.count(SHUTDOWN) > 1, 'start went on');
    b.open(SHUTDOWN);
  } },
];
const gone = async (pid: number) => {
  for (const until = Date.now() + 5000; Date.now() < until; await delay(10)) {
    try { process.kill(pid, 0); } catch { return; }
  }
  assert.fail(`runtime ${pid} outlived the bridge`);
};
async function assertClosedClean(b: Run, openedBefore: number) {
  assert.equal(await b.exited, 1);
  assert.deepEqual(b.types(), ['input.not_sent'], 'no thread.started and no other outcome after close');
  assert.equal(b.count(b.method), openedBefore, 'no session request after close');
  assert.match(b.stderr(), /Input ID reused with different content: one/);
  for (const { spawned } of b.rows().filter(row => row.spawned)) await gone(spawned);
}

for (const resume of [false, true]) for (const close of closes) test(`Copilot ${resume ? 'resume' : 'start'}: ${close.name} opens nothing more and the bridge ends by itself`, async t => {
  const method = resume ? 'session.resume' : 'session.create';
  const b = opening(t, { resume, hold: close.hold(method), beforeSpawn: close.beforeSpawn });
  await close.step(b);
  await assertClosedClean(b, close.openedBefore);
});

test('Copilot: a session answer that never comes after close does not hold the bridge', async t => {
  const b = opening(t, { hold: ['session.create'] });
  await b.until(() => b.count('session.create') > 0, 'session request');
  b.reuseId();
  await assertClosedClean(b, 1);
});

test('Copilot: with no close the same path opens one session and stays open for input', async t => {
  const b = opening(t, {});
  await b.until(events => events.some(row => row.type === 'thread.started'), 'thread.started');
  assert.equal(b.count('session.create'), 1);
  assert.equal(b.count(SHUTDOWN), 0);
  b.child.stdin.end();
  assert.equal(await b.exited, 1);
  assert.match(b.stderr(), /no instruction arrived/);
});

// The two negative controls: each proves the checks above see the hole, and where it came from.
for (const close of closes) test(`Copilot without its guard: ${close.name} goes on to a session`, async t => {
  const b = opening(t, { hold: close.hold('session.create'), beforeSpawn: close.beforeSpawn, bridge: withoutGuard(t) });
  await close.step(b);
  await b.until(events => events.some(row => row.type === 'thread.started'), 'thread.started');
  assert.ok(b.types().indexOf('thread.started') > b.types().indexOf('input.not_sent'), 'thread.started came after close');
  t.diagnostic(JSON.stringify({ control: 'withoutGuard', phase: close.name, events: b.types(), stderr: b.stderr(),
    methods: b.rows().filter(row => row.method).map(row => row.method) }));
  if (close.beforeSpawn) {
    assert.equal(await Promise.race([b.exited.then(() => 'ended'), delay(1000).then(() => 'still running')]), 'still running', 'nothing stops what opened after close');
    assert.ok(b.rows().some(row => row.spawned));
  } else assert.equal(await b.exited, 1);
});

for (const beforeSpawn of [true, false]) test(`Copilot with input read only after start (${beforeSpawn ? 'before spawn' : 'during connect'}): a reused ID closes only after the session opened`, async t => {
  const b = opening(t, { hold: beforeSpawn ? [] : ['connect'], beforeSpawn, bridge: parserAfterStart(t) });
  if (!beforeSpawn) await b.until(() => b.count('connect') > 0, 'connect');
  b.reuseId();
  await delay(100);
  assert.deepEqual(b.types(), [], 'the instruction waits unread during start');
  if (beforeSpawn) writeFileSync(b.spawnGate, ''); else b.open('connect');
  const code = await b.exited;
  t.diagnostic(JSON.stringify({ control: 'parserAfterStart', phase: beforeSpawn ? 'before spawn' : 'during connect', code,
    events: b.types(), stderr: b.stderr(), methods: b.rows().filter(row => row.method).map(row => row.method) }));
  assert.equal(code, 1, b.stderr());
  assert.deepEqual(b.types(), ['thread.started', 'input.not_sent'], b.stderr());
  const order = b.rows().map(row => row.method);
  assert.ok(order.includes('session.create') && order.indexOf('session.create') < order.indexOf(SHUTDOWN), 'the session opened before the stop');
});

test('Copilot sign-in checks distinguish signed-out from check failure without creating a conversation', async t => {
  for (const [auth, expected] of [['ready', 0], ['signed_out', 1], ['error', 2]] as const) {
    const area = scratch(t, 'copilot-status-'), runtime = join(area, 'copilot'), log = join(area, 'requests.jsonl');
    writeFileSync(runtime, `#!/bin/sh\nexec "${process.execPath}" "${join(fixtures, 'fake-copilot-cli.mjs')}"\n`, { mode: 0o755 });
    const child = spawnBridge(t, [bridge, 'copilot', '--auth-status'], { cwd: area, env: {
      HOME: area, COPILOT_CLI_PATH: runtime, FAKE_COPILOT_LOG: log, FAKE_COPILOT_AUTH: auth,
    } });
    assert.equal(await child.exited, expected, child.stderr());
    const requests = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(requests.some(row => row.method === 'auth.getStatus'));
    assert.equal(requests.some(row => row.method?.startsWith('session.')), false);
  }
});
