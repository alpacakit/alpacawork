import { parse, stringify } from 'yaml';
import { fixtureAgentSetting, installAgentStub } from './helpers/agent-stub.ts';
import { coordinatorSnapshotSchema } from '@alpacawork/contract/coordinator';
/**
 * Sending a waiting message to the coordinator at work ("send now") through serve: the Run layer hands it to the
 * working Run's manager as input, and the agent's receipt joins it there. What was handed over, and how far it got, is
 * the working Run's input (run_inputs) to that message's Run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RunStore } from '@alpacawork/runs';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { initializeControlFixture } from './helpers/control-fixture.ts';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { names } from '@alpacawork/backend/test-dist/runs/execution-files.js';
import { preserveTestFailure } from './helpers/failure-workspace.ts';
import { httpStatus } from './helpers/http-cli.ts';
import { until as untilFact } from './runs-runtime.fixture.ts';

const fake = new URL('./fixtures/fake-coordinator-input.mjs', import.meta.url).pathname;
type Turn = { id: string; status: string; into?: string; deliveryError?: string; answer: string | null };
async function fixture(t: { after: (fn: () => Promise<void>) => void }, agent = fake, options = {}, adapter: 'claude' | 'codex' = 'claude') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-coordinator-input-')));
  const writer = new FileWriter(root);
  let project: string;
  const configPath = join(root, 'config.yaml');
  try {
    const setting = fixtureAgentSetting(adapter);
    setting.params.model = ['one', 'two']; setting.params.effort = ['low', 'high'];
    if (adapter === 'codex') setting.params.fast = [];
    writer.save('config.yaml', null, Buffer.from(stringify({ agents: { fake: setting }, coordinatorAiStack: [{ agent: 'fake', values: {} }] })));
    project = initializeControlFixture(root);
  } finally { writer.close(); }
  process.env.PATH = installAgentStub(root, adapter === 'claude' ? 'claude' : 'alpacawork-agent', [process.execPath, agent, ...(adapter === 'claude' ? ['--fixture-native'] : [])]);
  let server = await startServer(root, 0, options);
  const get = async () => coordinatorSnapshotSchema.parse(await (await fetch(new URL('/api/coordinator', server.url))).json()).conversation as { id: string; nextLaunch: import('@alpacawork/contract').AiRow | null; turns: Turn[] };
  const conversationId = (await get()).id;
  const post = async (path: string, body: unknown) => {
    const response = await fetch(new URL(`/api/coordinator/${path}`, server.url), { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId, ...body as object }) });
    const raw = await response.json();
    const result = response.ok && ['messages', 'warm', 'clear', 'messages/withdraw', 'messages/send-now'].includes(path) ? coordinatorSnapshotSchema.parse(raw).conversation : raw;
    return { status: response.status, result };
  };
  t.after(async () => {
    await post('clear', {});
    await server.close(); rmSync(root, { recursive: true, force: true });
  });
  const until = async (check: (state: Awaited<ReturnType<typeof get>>) => boolean) => {
    for (let count = 0; count < 800; count++) {
      const state = await get(); if (check(state)) return state;
      await delay(25);
    }
    assert.fail(`Timed out: ${JSON.stringify(await get())}`);
  };
  const ask = async (text: string, id = crypto.randomUUID(), attachments: string[] = []) => {
    assert.equal((await post('messages', { id, text, attachments })).status, 200); return id;
  };
  const choose = (agent: string, values: Record<string, string> = {}) => {
    const config = parse(readFileSync(configPath, 'utf8'));
    if (agent === 'other') config.agents.other = config.agents.fake;
    config.coordinatorAiStack = [{ agent, values }];
    writeFileSync(configPath, stringify(config, { aliasDuplicateObjects: false }));
  };
  const begin = async () => {
    const id = await ask(`hold:${join(root, 'release')}`);
    // The Run is running once the scheduler reserves it; its agent's pid comes with the imported start.
    await until(state => state.turns.find(item => item.id === id)?.status === 'running' && existsSync(join(root, 'agent-started')) &&
      run(id).pids.agent !== null && run(id).session !== null);
    return id;
  };
  /** Reads the control database as the records stand now. */
  const read = <T,>(work: (store: RunStore) => T): T => {
    const store = RunStore.openReadable(root, { busyTimeoutMs: 1000 });
    assert.ok(store);
    try { return work(store); } finally { store.close(); }
  };
  /** The coordinator Run answering message `id`. */
  const run = (id: string) => read(store => {
    const row = store.connection.prepare('SELECT id FROM runs WHERE request_id = ?').get(id);
    assert.ok(row, `message ${id} has a Run`);
    return store.runtimeGet(`R${row.id}`)!;
  });
  /** The input that handed message `id` to a Run already working, if it was handed over. */
  const input = (id: string) => read(store => {
    const row = store.connection.prepare(`SELECT i.input_id, i.state FROM run_inputs i
      WHERE i.initial = 0 AND i.instruction_run_no = (SELECT id FROM runs WHERE request_id = ?)`).get(id);
    return row ? { id: String(row.input_id), state: String(row.state) } : null;
  });
  return { root, project, get, post, ask, choose, begin, until, conversationId, url: () => server.url, run, input,
    release: () => writeFileSync(join(root, 'release'), ''),
    stop: () => server.close(),
    restart: async () => { await server.close(); server = await startServer(root); },
    output: (id: string) => readFileSync(join(root, '.alpacawork/runs', run(id).id, 'stdout.log'), 'utf8') };
}

test('a published taken receipt joins B during the tree pass backoff, without releasing A or another write', async t => {
  let measuredCost = 0, arm = false, routes = 0, imports = 0;
  const nativeNow = performance.now.bind(performance);
  t.mock.method(performance, 'now', () => nativeNow() + measuredCost);
  const lines: { step: string; gapMs?: number }[] = [], error = console.error;
  t.mock.method(console, 'error', (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('{"timing"')) lines.push(JSON.parse(args[0]));
    else error(...args);
  });
  const route = ReturnRouter.prototype.pass, imported = RunEventImporter.prototype.pass;
  t.mock.method(ReturnRouter.prototype, 'pass', async function (this: ReturnRouter, ...args: Parameters<typeof route>) {
    routes++;
    const result = await route.apply(this, args);
    // Model a costly, completed tree pass without blocking the receiver's event loop or delaying a real manager.
    if (arm) { arm = false; measuredCost += 5_000; }
    return result;
  });
  t.mock.method(RunEventImporter.prototype, 'pass', function (this: RunEventImporter, ...args: Parameters<typeof imported>) {
    imports++; return imported.apply(this, args);
  });
  const h = await fixture(t, fake, { timing: true });
  try {
    const a = await h.begin(), gate = join(h.root, 'take-B');
    const b = await h.ask('take:' + gate);
    arm = true;
    assert.equal((await h.post('messages/send-now', { id: b })).status, 200);
    await untilFact(() => lines.some(line => line.step === 'pass' && (line.gapMs ?? 0) >= 15_000), 'the measured tree backoff was installed');
    const protocol = join(h.root, '.alpacawork/runs', h.run(a).id, 'protocol');
    const bRun = h.run(b).id;
    await untilFact(() => readdirSync(protocol).some(attempt => {
      const events = join(protocol, attempt, 'events');
      return names(events).some(name => {
        const event = JSON.parse(readFileSync(join(events, name), 'utf8'));
        return event.type === 'input_attempt' && event.payload.instructionRunId === bRun;
      });
    }), 'the real manager transferred B before its receipt');
    const before = { routes, imports };
    writeFileSync(gate, 'taken');
    await untilFact(() => h.run(b).state === 'joined',
      'published input receipt reaches the real coordinator API during tree backoff', 5_000);
    assert.equal((await h.get()).turns.find(turn => turn.id === b)?.status, 'joined');
    assert.equal(h.run(b).into, h.run(a).id);
    assert.equal(h.input(b)?.state, 'taken');
    assert.equal(existsSync(join(h.root, 'release')), false, 'A stays at its original gate');
    assert.equal(routes, before.routes, 'receipt demand does not restart the backed-off tree routing');
    assert.ok(imports > before.imports, 'the authoritative event importer accepted the receipt');
    t.diagnostic(JSON.stringify({ a, b, before, after: { routes, imports }, lines }));
  } catch (error) {
    await preserveTestFailure(t, h.root, { failure: { error }, origin: h.url(),
      diagnostics: async () => ({ lines, routes, imports, measuredCost, conversation: await h.get() }) });
    throw error;
  }
});

test('withdraw removes only queued work, retains attachments for recovery, and refuses running and stale conversations', async t => {
  const h = await fixture(t), parent = await h.begin(), id = crypto.randomUUID();
  const file = new URL(`/api/coordinator/attachments?conversationId=${h.conversationId}&requestId=${id}&name=sample.png`, h.url());
  assert.equal(await httpStatus(file, { method: 'POST', headers: { 'X-Alpacawork-Op-Id': crypto.randomUUID() },
    body: Buffer.from([137, 80, 78, 71, 1]) }), 200);
  await h.ask('cancel me', id, ['sample.png']);
  assert.equal((await h.post('messages/withdraw', { id: parent })).status, 409);
  assert.equal((await h.post('messages/withdraw', { id, conversationId: 'old' })).status, 409);
  assert.equal((await h.post('messages/withdraw', { id })).status, 200);
  assert.equal((await h.get()).turns.some(turn => turn.id === id), false);
  assert.equal(h.run(id).state, 'cancelled', 'its Run is cancelled with its Request');
  assert.equal(await httpStatus(new URL(`/api/coordinator/file?requestId=${id}&name=sample.png`, h.url())), 200);
  const folder = join(h.root, '.alpacawork/coordinator', h.conversationId, 'attachments', id);
  assert.equal(existsSync(folder), true, 'cancelled files remain available for input recovery');
  assert.equal((await h.post('clear', {})).status, 200);
  assert.equal(await httpStatus(new URL(`/api/coordinator/file?requestId=${id}&name=sample.png`, h.url())), 404);
  for (let count = 0; count < 400 && existsSync(folder); count++) await delay(50);
  assert.equal(existsSync(folder), false, 'serve sweeps files only after the conversation is cleared');
});

test('send now writes once to the same live process, exposes sending, then joins on taken with absolute image paths', async t => {
  const h = await fixture(t), parent = await h.begin(), gate = join(h.root, 'take'), id = crypto.randomUUID();
  const file = new URL(`/api/coordinator/attachments?conversationId=${h.conversationId}&requestId=${id}&name=sample.png`, h.url());
  await fetch(file, { method: 'POST', headers: { 'X-Alpacawork-Op-Id': crypto.randomUUID() }, body: Buffer.from([137, 80, 78, 71, 1]) });
  // Use a separate message for the controlled receipt; attachments are verified in another instruction.
  const waiting = await h.ask(`take:${gate}`);
  const pid = h.run(parent).pids.agent;
  assert.equal((await h.post('messages/send-now', { id: waiting })).status, 200);
  await h.until(state => state.turns.find(turn => turn.id === waiting)?.status === 'sending');
  assert.equal((await h.post('messages/withdraw', { id: waiting })).status, 409);
  assert.equal((await h.post('messages/send-now', { id: waiting })).status, 200, 'asking again changes nothing');
  writeFileSync(gate, '');
  await h.until(state => state.turns.find(turn => turn.id === waiting)?.status === 'joined');
  assert.equal((await h.get()).turns.find(turn => turn.id === waiting)?.into, parent);
  await h.ask('look', id, ['sample.png']);
  await h.post('messages/send-now', { id });
  await h.until(state => state.turns.find(turn => turn.id === id)?.status === 'joined');
  assert.equal(h.run(parent).pids.agent, pid);
  h.release();
  const state = await h.until(state => state.turns.find(turn => turn.id === parent)?.status === 'succeeded');
  const prompts = JSON.parse(state.turns.find(turn => turn.id === parent)!.answer!).prompts as string[];
  assert.equal(prompts.length, 3, 'lost HTTP response does not send twice');
  assert.match(prompts[2]!, new RegExp(`!\\[sample.png\\]\\(${h.root}/`));
  assert.deepEqual(state.turns.map(turn => turn.status), ['succeeded', 'joined', 'joined']);
});

test('a refusal leaves its handover uncertain, so the message is never delivered again', async t => {
  const h = await fixture(t, fake, {}, 'codex'); await h.begin();
  const id = await h.ask('refuse');
  await h.post('messages/send-now', { id });
  await h.until(() => h.input(id)?.state === 'uncertain');
  assert.equal((await h.get()).turns.find(turn => turn.id === id)?.status, 'sending');
  assert.equal((await h.post('messages/send-now', { id })).status, 200);
  h.release(); await h.until(state => state.turns[0]?.status === 'succeeded');
  assert.equal((await h.get()).turns.find(turn => turn.id === id)?.status, 'sending');
  assert.equal((await h.post('messages/withdraw', { id })).status, 409);
});

test('send now preserves explicit recipients without adding viewing context to the agent input', async t => {
  const h = await fixture(t), parent = await h.begin();
  const inputs = [{ tasks: [h.project], text: `${h.project} look` },
    { tasks: [], text: 'General question https://example.test/?task=T1' }];
  const requests: string[] = [];
  for (const input of inputs) {
    const id = crypto.randomUUID(); requests.push(id);
    assert.equal((await h.post('messages', { id, ...input, attachments: [] })).status, 200);
    assert.equal((await h.post('messages/send-now', { id })).status, 200);
    await h.until(state => state.turns.find(turn => turn.id === id)?.status === 'joined');
    const run = h.run(id);
    assert.equal(run.role, 'coordinator');
    if (run.role !== 'coordinator') assert.fail('coordinator Run required');
    assert.deepEqual(run.message.tasks, input.tasks);
    assert.equal(run.message.context, null);
    const store = RunStore.openReadable(h.root, { busyTimeoutMs: 1000 })!;
    try {
      const targets = store.connection.prepare(`SELECT k.external_id FROM task_dialogues d
        JOIN tasks k ON k.id=d.task_uuid WHERE d.request_id=?`)
        .all(id).map(row => row.external_id);
      assert.deepEqual(targets, input.tasks, 'joined message keeps only its own explicit targets');
    } finally { store.close(); }
  }
  h.release();
  const state = await h.until(state => state.turns.find(turn => turn.id === parent)?.status === 'succeeded');
  const { prompts } = JSON.parse(state.turns.find(turn => turn.id === parent)!.answer!) as { prompts: string[] };
  prompts.slice(1).forEach((prompt, index) => assert.match(prompt,
    new RegExp(`Request ID of this input: ${requests[index]}.*--source-request ${requests[index]}`)));
  assert.deepEqual(prompts.slice(1).map(prompt => prompt.replace(/^Request ID of this input: [^\n]+\n/m, '')), inputs.map(input => input.text));
});

test('a message the working agent cannot take, for its model or effort, answers on its own and holds back no later one', async t => {
  const h = await fixture(t), parent = await h.begin();
  const different: string[] = [];
  for (const selected of [{ model: 'two' }, { effort: 'high' }]) {
    h.choose('fake', selected);
    const id = await h.ask('different');
    assert.equal((await h.post('messages/send-now', { id })).status, 200);
    different.push(id);
  }
  h.choose('fake', { model: 'one', effort: 'low' });
  const same = await h.ask('same choices');
  assert.equal((await h.post('messages/send-now', { id: same })).status, 200);
  await h.until(state => state.turns.find(turn => turn.id === same)?.status === 'joined');
  for (const id of different) {
    assert.equal((await h.get()).turns.find(turn => turn.id === id)?.status, 'queued', 'a launch other than the working one cannot take it in');
    assert.equal(h.input(id), null);
  }
  h.release();
  const state = await h.until(state => different.every(item => state.turns.find(turn => turn.id === item)?.status === 'succeeded'));
  assert.equal(state.turns.find(turn => turn.id === parent)?.status, 'succeeded');
});

test('across a serve restart the working agent still takes in a message sent now', async t => {
  const h = await fixture(t), parent = await h.begin();
  // Its manager, not serve, holds the agent's input.
  await h.restart();
  const id = await h.ask('after restart');
  assert.equal((await h.post('messages/send-now', { id })).status, 200);
  await h.until(state => state.turns.find(turn => turn.id === id)?.status === 'joined');
  assert.equal((await h.get()).turns.find(turn => turn.id === id)?.into, parent);
  h.release();
  await h.until(state => state.turns.find(turn => turn.id === parent)?.status === 'succeeded');
});

for (const failure of ['crash', 'missing']) test(`a taken instruction remains joined after ${failure} without an answer`, async t => {
  const h = await fixture(t);
  const parent = await h.begin(), earlier = await h.ask('earlier'), id = await h.ask(failure);
  await h.post('messages/send-now', { id });
  await h.until(state => state.turns.find(turn => turn.id === earlier)?.status === 'succeeded');
  const state = await h.get();
  assert.equal(state.turns.find(turn => turn.id === parent)?.status, 'failed');
  assert.deepEqual(state.turns.map(turn => turn.id), [parent, earlier, id]);
  assert.equal(state.turns.find(turn => turn.id === id)?.status, 'joined');
  assert.equal(state.turns.find(turn => turn.id === id)?.into, parent);
});

test('restart keeps uncertain delivery pending until the parent ends, then holds its reservation, and preserves a taken instruction', async t => {
  const h = await fixture(t), parent = await h.begin(), joined = await h.ask('taken'), earlier = await h.ask('earlier'), pending = await h.ask('untaken');
  await h.post('messages/send-now', { id: joined });
  await h.until(state => state.turns.find(turn => turn.id === joined)?.status === 'joined');
  await h.post('messages/send-now', { id: pending });
  await h.until(() => h.input(pending)?.state === 'attempted');
  await h.restart();
  const state = await h.get();
  assert.equal(state.turns.find(turn => turn.id === joined)?.status, 'joined');
  assert.equal(state.turns.find(turn => turn.id === pending)?.status, 'sending');
  h.release();
  await h.until(state => state.turns.find(turn => turn.id === parent)?.status === 'succeeded');
  // The untaken instruction keeps its reservation: no new turn starts after its parent answers.
  assert.equal((await h.get()).turns.find(turn => turn.id === pending)?.status, 'sending');
  await delay(300);
  assert.equal((await h.get()).turns.find(turn => turn.id === earlier)?.status, 'queued');
  assert.equal(h.input(pending)?.state, 'uncertain');
});

test('clearing a conversation never hands its successor\'s messages to the old process, even while it is still stopping', async t => {
  const h = await fixture(t);
  writeFileSync(join(h.root, 'ignore-stop'), '');
  const parent = await h.begin();
  const clearing = h.post('clear', {});
  try {
    const next = await h.until(state => state.id !== h.conversationId);
    const id = crypto.randomUUID();
    assert.equal((await h.post('messages', { conversationId: next.id, id, text: 'new conversation', attachments: [] })).status, 200);
    assert.equal((await h.post('messages/send-now', { conversationId: next.id, id })).status, 409, 'nothing works in the new conversation yet');
    h.release(); await clearing;
    const state = await h.until(state => state.turns.find(turn => turn.id === id)?.status === 'succeeded');
    const { prompts } = JSON.parse(state.turns.find(turn => turn.id === id)!.answer!) as { prompts: string[] };
    assert.equal(prompts.length, 1, 'it was its own Run\'s first message');
    assert.equal(h.input(id), null);
    assert.equal(h.run(parent).stop_requested, true);
  } finally { h.release(); await clearing; }
});

test('a receipt taken while serve was down joins on restart, without delivering it twice', async t => {
  const h = await fixture(t), parent = await h.begin(), gate = join(h.root, 'take-before-restart');
  const text = `take:${gate}`, id = await h.ask(text);
  await h.post('messages/send-now', { id });
  await h.until(state => state.turns.find(turn => turn.id === id)?.status === 'sending');
  // The receipt comes while no serve imports it: the working Run's manager keeps it until one does.
  await h.stop();
  writeFileSync(gate, '');
  const handed = h.input(id);
  assert.match(handed?.id ?? '', /^[0-9a-f-]{36}$/);
  for (let count = 0; count < 200 && !h.output(parent).includes(handed!.id); count++) await delay(10);
  assert.ok(h.output(parent).includes(handed!.id), 'receipt persisted in parent stdout before restart');
  await h.restart();
  await h.until(state => state.turns.find(turn => turn.id === id)?.status === 'joined');
  assert.equal(JSON.stringify((await h.get()).turns.find(turn => turn.id === id)).includes(handed!.id), false, 'internal input ID is private');
  h.release();
  const state = await h.until(state => state.turns.find(turn => turn.id === parent)?.status === 'succeeded');
  assert.equal(state.turns.find(turn => turn.id === id)?.status, 'joined');
  assert.equal(state.turns.find(turn => turn.id === id)?.into, parent);
  assert.equal(state.turns.find(turn => turn.id === id)?.answer, null);
  assert.deepEqual(JSON.parse(state.turns.find(turn => turn.id === parent)!.answer!).prompts.map((prompt: string) =>
    prompt.replace(/^Request ID of this input: [^\n]+\n/m, '')),
    [`hold:${join(h.root, 'release')}`, text]);
});

test('a receipt emitted after restart still joins its parent instead of being resent', async t => {
  const h = await fixture(t), parent = await h.begin(), gate = join(h.root, 'late-take');
  const id = await h.ask(`take:${gate}`);
  await h.post('messages/send-now', { id });
  await h.until(state => state.turns.find(turn => turn.id === id)?.status === 'sending');
  await h.restart();
  assert.equal((await h.get()).turns.find(turn => turn.id === id)?.status, 'sending');
  writeFileSync(gate, '');
  await h.until(state => state.turns.find(turn => turn.id === id)?.status === 'joined');
  h.release();
  await h.until(state => state.turns.find(turn => turn.id === parent)?.status === 'succeeded');
  assert.equal((await h.get()).turns.find(turn => turn.id === id)?.status, 'joined');
});

test('an asynchronous EPIPE holds the input reservation while the parent keeps working', async t => {
  const h = await fixture(t, new URL('./fixtures/closed-coordinator-input.mjs', import.meta.url).pathname);
  const parent = await h.begin(), id = await h.ask('do-once');
  assert.equal((await h.post('messages/send-now', { id })).status, 200);
  const state = await h.until(() => h.input(id)?.state === 'uncertain');
  assert.equal(state.turns.find(turn => turn.id === id)?.status, 'sending');
  assert.equal(state.turns.find(turn => turn.id === parent)?.status, 'running');
  assert.match(h.input(id)!.id, /^[0-9a-f-]{36}$/);
  const other = await h.ask('another');
  assert.equal((await h.post('messages/send-now', { id: other })).status, 200);
  await delay(300);
  assert.equal((await h.get()).turns.find(turn => turn.id === other)?.status, 'queued', 'a closed input takes nothing more');
  assert.equal(h.input(other), null);
  assert.equal((await h.post('messages/withdraw', { id })).status, 409);
});


test('a different adapter cannot join a live input, even when all launch choices match', async t => {
  const h = await fixture(t);
  const parent = await h.begin(), id = crypto.randomUUID();
  h.choose('other');
  assert.equal((await h.post('messages', { id, text: 'other adapter', attachments: [] })).status, 200);
  assert.equal((await h.post('messages/send-now', {id})).status, 200);
  await delay(300);
  assert.equal((await h.get()).turns.find(turn => turn.id === id)?.status, 'queued');
  assert.equal(h.input(id), null);
  h.release();
  await h.until(state => state.turns.find(turn => turn.id === id)?.status === 'succeeded');
  assert.equal((await h.get()).nextLaunch?.agent, 'other');
  assert.equal(h.run(id).agent, 'other');
  assert.deepEqual(JSON.parse((await h.get()).turns.find(turn => turn.id === parent)!.answer!).prompts.length, 1);
});

test('send now inherits the live adapter launch rather than the last completed adapter', async t => {
  const h = await fixture(t);
  h.choose('fake', { model: 'two', effort: 'high' });
  const first = await h.ask('first');
  await h.until(state => state.turns.find(turn => turn.id === first)?.status === 'succeeded');
  const parent = crypto.randomUUID(), id = crypto.randomUUID();
  h.choose('other');
  assert.equal((await h.post('messages', { id: parent, text: `hold:${join(h.root, 'release')}`, attachments: [] })).status, 200);
  await h.until(state => state.turns.find(turn => turn.id === parent)?.status === 'running');
  assert.equal((await h.post('messages', { id, text: 'same choices', attachments: [] })).status, 200);
  assert.equal((await h.post('messages/send-now', { id })).status, 200);
  await h.until(state => state.turns.find(turn => turn.id === id)?.status === 'joined');
  h.release();
  await h.until(state => state.turns.find(turn => turn.id === parent)?.status === 'succeeded');
});
