import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { issueRunCredential, resolveCaller } from '@alpacawork/backend/test-dist/control/credentials.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { mcpFunnelExposure } from '@alpacawork/backend/test-dist/installation/tailnet-mcp.js';
import { claimOf } from '@alpacawork/backend/test-dist/receiver/request-scope.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { mcpCredentialHeaders } from '@alpacawork/cli/test-dist/mcp.js';
import { CLI_CONTRACT, CONTRACT_HEADER } from '@alpacawork/contract/client-contract';
import { mcpReadTool, mcpSourceHeader, mcpWriteTool } from '@alpacawork/contract/mcp';
import { RUN_FILES, runFolder } from '@alpacawork/contract/run';
import { PROBLEM_CODE, tryLock, unlock } from '@alpacawork/core';
import { RunStore } from '@alpacawork/runs';
import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { initializeControlFixture } from './helpers/control-fixture.ts';
import { cliRun } from './helpers/http-cli.ts';
import { createFixtureRun } from './helpers/run-fixture.ts';
import { reconcileLinks } from './return-handling.fixture.ts';

const protocolVersion = '2025-11-25';
const rpc = (method: string, params?: unknown) => ({ jsonrpc: '2.0', id: randomUUID(), method, params });
const read = (command: string, input?: object) => rpc('tools/call', { name: mcpReadTool, arguments: { command, input } });
const write = (command: string, restoreId: string, input: object, opId?: string) =>
  rpc('tools/call', { name: mcpWriteTool, arguments: { command, input, restoreId, opId } });
const initialize = () => rpc('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'Fixture', version: '1' } });
const send = (origin: string, message: ReturnType<typeof rpc>, extra?: HeadersInit) => fetch(new URL('/mcp', origin), {
  method: 'POST', body: JSON.stringify(message),
  headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...Object.fromEntries(new Headers(extra)) },
});
const text = (answer: { result?: { content?: { text: string }[] } }) => {
  assert.ok(answer.result?.content?.[0]?.text, JSON.stringify(answer));
  return JSON.parse(answer.result.content[0].text);
};

test('MCP claims keep their coordinator identity and Run relays require a complete credential', () => {
  assert.deepEqual(resolveCaller('/unused', claimOf(new Headers(), false, true), null),
    { kind: 'coordinator', source: 'mcp', conversation: 'mcp' });
  assert.throws(() => claimOf(new Headers({ [mcpSourceHeader]: '1' })), { code: PROBLEM_CODE.forbidden });
  const token = 'a'.repeat(64);
  assert.equal(mcpCredentialHeaders(true, { ALPACAWORK_RUN: 'R1', ALPACAWORK_RUN_TOKEN: token }).get('authorization'),
    'Alpacawork-Run R1:' + token);
  assert.throws(() => mcpCredentialHeaders(true, {}), { code: PROBLEM_CODE.invalidInput });
  assert.throws(() => mcpCredentialHeaders(false, { ALPACAWORK_RUN: 'R1' }), { code: PROBLEM_CODE.invalidInput });
  assert.throws(() => mcpCredentialHeaders(true, { ALPACAWORK_RUN: 'R1', ALPACAWORK_RUN_TOKEN: 'invalid' }), { code: PROBLEM_CODE.invalidInput });
});

test('Funnel detection uses the forwarding target including foreground handlers', () => {
  const host = 'device.example.ts.net:443';
  const web = { [host]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:5499' } } } };
  assert.equal(mcpFunnelExposure({ Web: web }, 5499), 'private');
  assert.equal(mcpFunnelExposure({ Foreground: { session: { AllowFunnel: { [host]: true }, Web: web } } }, 5499), 'funnel');
  assert.equal(mcpFunnelExposure({ AllowFunnel: { [host]: true }, TCP: { 443: { TCPForward: '127.0.0.1:5499' } } }, 5499), 'funnel');
  assert.equal(mcpFunnelExposure({ AllowFunnel: { [host]: true }, Web: web }, 443), 'private');
  assert.equal(mcpFunnelExposure({ AllowFunnel: { [host]: true } }, 5499), 'unknown');
});

test('HTTP and stdio MCP share authorization, restore fencing, receipts and file transport', { timeout: 45_000 }, async t => {
  const originalPath = process.env.PATH, originalConfig = process.env.XDG_CONFIG_HOME;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-mcp-')));
  process.env.XDG_CONFIG_HOME = join(root, 'test-config');
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let lock: number | undefined;
  t.after(async () => {
    await server?.close();
    if (lock !== undefined) { unlock(lock); closeSync(lock); }
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalConfig;
    rmSync(root, { recursive: true, force: true });
  });
  const project = initializeControlFixture(root);
  writeFileSync(join(root, 'config.yaml'), stringify({ agents: { codex: fixtureAgentSetting('codex') } }));
  const { tasks: [task] } = await new ControlTaskCommands(root, { kind: 'human' })
    .create({ parentId: project, userRequested: false, tasks: [{ title: 'MCP fixture' }] });
  const people = new PlacementStore(root);
  const placement = (() => {
    try { return people.createAndPlace({ taskId: task!.id, profileKey: 'codex', responsible: true }).placement; }
    finally { people.close(); }
  })();
  const store = new RunStore(root, { busyTimeoutMs: 10_000 });
  const run = (() => {
    try {
      return store.write(tx => {
        const created = createFixtureRun(store, tx, { task: task!.id, placementId: placement.id,
          requestId: randomUUID(), agent: 'codex', role: 'owner', caller: null, resumes: null, continues: false,
          session: null, cwd: root, launch: { adapter: 'codex', env: [], argv: ['NEVER-EXECUTE'], path: '/bin', values: {} } }, 'Fixture prompt');
        tx.update({ ...created, state: 'running', started_at: new Date().toISOString() });
        return created;
      });
    } finally { store.close(); }
  })();
  mkdirSync(runFolder(root, run.id), { recursive: true, mode: 0o700 });
  lock = openSync(join(runFolder(root, run.id), RUN_FILES.managerLock), constants.O_RDWR | constants.O_CREAT, 0o600);
  assert.equal(tryLock(lock), true);
  reconcileLinks(root, project);
  const token = issueRunCredential(root, run.id);
  const runHeaders = { Authorization: 'Alpacawork-Run ' + run.id + ':' + token };
  const runEnv = { ALPACAWORK_RUN: run.id, ALPACAWORK_RUN_TOKEN: token };

  server = await startServer(root, 0, { mcp: true });
  const url = server.url;
  const call = async (message: ReturnType<typeof rpc>, headers?: HeadersInit) => {
    const response = await send(url, message, headers);
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.id, message.id);
    return body;
  };
  const originFailure = await send(url, initialize(), { Origin: 'https://outside.example' });
  assert.equal(originFailure.status, 403);
  await originFailure.arrayBuffer();
  const badClaim = await send(url, initialize(), { 'X-Alpacawork-Provider': 'codex', 'X-Alpacawork-Conversation': 'fake' });
  assert.equal(badClaim.status, 403);
  await badClaim.arrayBuffer();
  const forged = await fetch(new URL('/api/commands/guide?name=SKILL.md', url),
    { headers: { 'X-Alpacawork-Client': 'cli', [CONTRACT_HEADER]: String(CLI_CONTRACT), [mcpSourceHeader]: '1' } });
  assert.equal(forged.status, 403);
  await forged.arrayBuffer();
  assert.equal((await fetch(new URL('/mcp', url))).status, 405);
  const init = await call(initialize());
  assert.equal(init.result.protocolVersion, protocolVersion);
  assert.match(init.result.instructions, /user’s coordinator/);
  assert.deepEqual((await call(rpc('tools/list'))).result.tools.map((tool: { name: string }) => tool.name), [mcpReadTool, mcpWriteTool]);

  const get = (log?: number) => read('task get', { task: task!.id, log });
  const viewed = text(await call(get()));
  assert.equal(viewed.task.title, 'MCP fixture');
  const identity: string = viewed.restoreId;
  const denied = await call(read('project shelf'));
  assert.equal(denied.result.isError, true);
  assert.equal(text(denied).error.code, PROBLEM_CODE.forbidden);
  const help = text(await call(read('help', { commands: ['task get', 'config inspect', 'task file get'] })));
  assert.equal(help.commands[0].inputs.find((input: { key: string }) => input.key === 'task').schema.type, 'string');
  assert.equal(help.commands[2].inputs.some((input: { key: string }) => input.key === 'output'), false);
  assert.match(help.commands[1].notes.join(' '), /unknown/);
  assert.match(text(await call(read('guide', { name: 'SKILL.md' }))).text, /# alpacawork/);
  const malformed = await call(read('guide', { name: '../package.json' }));
  assert.equal(text(malformed).error.code, PROBLEM_CODE.invalidInput);

  const comment = { task: task!.id, title: 'Saved once', description: 'Synthetic comment', expectedTaskHash: viewed.task.hash };
  const opId = randomUUID();
  const saved = await call(write('task comment', identity, comment, opId));
  assert.equal(saved.result.isError, undefined, JSON.stringify(saved));
  assert.deepEqual(text(await call(write('task comment', identity, comment, opId))), text(saved));
  assert.equal(text(await call(write('task comment', identity, { ...comment, title: 'Different input' }, opId))).error.code, PROBLEM_CODE.idempotencyConflict);
  const stale = await call(write('task comment', randomUUID(), comment, randomUUID()));
  assert.equal(text(stale).error.code, PROBLEM_CODE.restoreChanged);
  assert.equal(text(await call(get(20))).task.log.filter((entry: { title: string }) => entry.title === comment.title).length, 1);

  const destination = { task: task!.id, path: 'notes.txt' };
  const inline = '😀' + '\t'.repeat(27_000);
  const put = write('task file put', identity, { ...destination, content: inline }, randomUUID());
  assert.equal(text(await call(put)).error.code, PROBLEM_CODE.forbidden);
  const uploaded = text(await call(put, runHeaders));
  assert.equal(uploaded.bytes, Buffer.byteLength(inline));
  const range = text(await call(read('task file get', { ...destination, length: 32 * 1024, digest: true })));
  assert.ok(JSON.stringify(range).length <= 40_000);
  assert.ok(range.nextOffset < range.size);
  assert.equal(range.digest, uploaded.digest);
  const next = text(await call(read('task file get', { ...destination, offset: range.nextOffset, version: range.version })));
  assert.equal(range.text + next.text, inline);
  assert.equal(next.digest, undefined);
  const update = write('task file put', identity, { ...destination, content: 'updated', expectedDigest: range.digest }, randomUUID());
  assert.equal((await call(update, runHeaders)).result.isError, undefined);
  assert.equal(text(await call(read('task file get', { ...destination, version: range.version }))).error.code, PROBLEM_CODE.conflict);

  const source = join(root, 'synthetic-upload.bin');
  const largeSize = 8 * 1024 * 1024 + 1;
  writeFileSync(source, Buffer.alloc(largeSize, 0x51));
  const fileInput = { task: task!.id, path: 'large.bin', file: source };
  const largeId = randomUUID();
  const relay = async (endpoint: string, messages: ReturnType<typeof rpc>[], useRun = true) => {
    const reply = await cliRun(endpoint, useRun ? ['mcp', '--run'] : ['mcp'], useRun ? runEnv : {},
      messages.map(message => JSON.stringify(message) + '\n').join(''));
    assert.equal(reply.code, 0, reply.stderr);
    return reply.stdout.trim().split('\n').map(line => JSON.parse(line));
  };
  const [runInit, sent, replayed] = await relay(url, [initialize(),
    write('task file put', identity, fileInput, largeId), write('task file put', identity, fileInput, largeId)]);
  assert.match(runInit.result.instructions, /Task placement/);
  assert.equal(text(sent).bytes, largeSize);
  assert.deepEqual(text(replayed), text(sent));
  assert.equal(text(await call(read('task file get', { task: task!.id, path: fileInput.path }))).size, largeSize);
  const encoded = text(await call(read('task file get', { task: task!.id, path: fileInput.path, encoding: 'base64' })));
  assert.equal(Buffer.from(encoded.contentBase64, 'base64').length, 24 * 1024);

  let inspections = 0;
  const lost = createServer((req, res) => {
    req.resume();
    req.once('end', () => { inspections++; res.destroy(); });
  }).listen(0, '127.0.0.1');
  await once(lost, 'listening');
  try {
    const address = lost.address();
    assert.ok(address && typeof address !== 'string');
    const [unknown] = await relay('http://127.0.0.1:' + address.port, [write('config inspect', identity, {})], false);
    assert.match(text(unknown).error.message, /Execution result unknown/);
    assert.equal(inspections, 1);
  } finally { await new Promise<void>(resolve => { lost.close(() => resolve()); }); }

  await server.close();
  server = await startServer(root, Number(new URL(url).port));
  const formerlyEnabled = await send(server.url, initialize());
  assert.equal(formerlyEnabled.status, 404);
  assert.match((await formerlyEnabled.json()).error.message, /setup --mcp on/);
  const [disabled] = await relay(server.url, [write('task file put', identity, { ...fileInput, path: 'blocked.bin' }, randomUUID())]);
  assert.match(disabled.error.message, /setup --mcp on/);
  const absent = await fetch(new URL('/api/tasks/' + task!.id + '/file?path=blocked.bin', server.url), { headers: runHeaders });
  assert.equal(absent.status, 404);
  await absent.arrayBuffer();
});
