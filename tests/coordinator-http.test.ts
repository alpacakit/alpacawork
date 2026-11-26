import { parse, stringify } from 'yaml';
/** Real coordinator HTTP core cases; independent private fixtures. */
import { coordinatorSnapshotSchema, coordinatorMessageResponseSchema, coordinatorMessageDigest, coordinatorResetResponseSchema } from '@alpacawork/contract/coordinator';
import { AGENT_ADAPTERS, optionsBase } from '@alpacawork/contract/agent-adapters';
import { stopGroup } from './helpers/process-groups.ts';
import { cliRun, httpStatus } from './helpers/http-cli.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from '@alpacawork/core';
import { RunStore } from '@alpacawork/runs';
import { openIndexStream } from './index-stream.ts';
import { CoordinatorConversation } from '@alpacawork/backend/test-dist/coordinator/conversation.js';
import { StopDeliveryOwner } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { ServeLifecycle } from '@alpacawork/backend/test-dist/receiver/lifecycle.js';
import { messagePart, type View, eventually, records, fixture } from './helpers/coordinator-http-fixture.ts';

test('message admission records its Request and Run and publishes the updated conversation', async t => {
  const h = await fixture(t);
  const abort = new AbortController(); t.after(() => abort.abort());
  const stream = await openIndexStream(new URL('/api/events', h.url()), abort.signal);
  const before = await stream.index();
  const conversation = await h.get(), id = crypto.randomUUID(), gate = join(h.root, 'publication-gate');
  const input = { conversationId: conversation.id, id, text: `wait:${gate}`, attachments: [] };
  try {
    const response = await h.post('/api/coordinator/messages', input);
    assert.equal(response.status, 200);
    const { conversation: accepted, message } = coordinatorMessageResponseSchema.parse(await response.json());
    assert.deepEqual(message, { id, status: 'queued', inputDigest: coordinatorMessageDigest(input) });
    assert.equal(accepted.turns.find(turn => turn.id === id)?.status, 'queued', 'serve answers with the admitted message; the Run layer starts it');
    const [stored, ...rest] = h.records(conversation.id);
    assert.deepEqual(rest, []);
    assert.equal(stored?.body, input.text, 'acceptance is durable as the Request, in the words the screen sent');
    assert.equal(stored?.run?.role, 'coordinator'); assert.equal(messagePart(stored!.prompt!), input.text);
    assert.match(stored!.prompt!, new RegExp(`Request ID of this input: ${id}.*--source-request ${id}`));
    let changed = await stream.index();
    while (changed.person.coordinator?.revision === before.person.coordinator?.revision) changed = await stream.index();
    await eventually(async () => (await h.get()).turns.find(turn => turn.id === id)?.status === 'running', 'the Run starts');
  } finally {
    writeFileSync(gate, 'release');
    const finished = await h.done(id);
    if (finished.status !== 'succeeded') t.diagnostic(JSON.stringify({ finished, records: h.records(conversation.id) }));
    assert.equal(finished.status, 'succeeded');
  }
});

test('quiesce waits for an admitted coordinator save when close starts before its publication', async t => {
  const h = await fixture(t), app = h.app(), feed = app.feed()!;
  const before = JSON.parse(feed.index()).person.coordinator;
  const conversation = await h.get(), id = crypto.randomUUID();
  let unpublishedAtClose = false, savedAtDrain = false, closing: Promise<void> | undefined;
  const quiesce = ServeLifecycle.prototype.quiesce, ask = CoordinatorConversation.prototype.ask;
  // Quiesce waits for the admitted write to commit; its publication does not start anew after quiesce.
  t.mock.method(ServeLifecycle.prototype, 'quiesce', function (this: ServeLifecycle) {
    return quiesce.call(this).then(result => {
      savedAtDrain = h.records(conversation.id).some(record => record.id === id && record.run?.role === 'coordinator');
      return result;
    });
  });
  t.mock.method(CoordinatorConversation.prototype, 'ask', function (this: CoordinatorConversation,
    input: Parameters<CoordinatorConversation['ask']>[0]) {
    closing = app.close();
    unpublishedAtClose = JSON.stringify(JSON.parse(feed.index()).person.coordinator) === JSON.stringify(before);
    return ask.call(this, input);
  });
  assert.equal((await h.post('/api/coordinator/messages', { conversationId: conversation.id, id,
    text: 'answer then drain the admitted publication', attachments: [] })).status, 200);
  assert.ok(closing); await closing;
  assert.equal(unpublishedAtClose, true, 'this close races the pending publication, not an already published turn');
  assert.equal(savedAtDrain, true, 'the admitted save is committed before quiesce reports drained');
  // The admitted message survives the stop: the next serve publishes it and starts its Run.
  t.mock.restoreAll(); await h.restart();
  assert.notDeepEqual(JSON.parse(h.app().feed()!.index()).person.coordinator, before);
  assert.equal((await h.done(id)).status, 'succeeded');
});

test('a first Codex message can write through the real CLI without warming the conversation', async t => {
  const h = await fixture(t, false, '', 'codex');
  const conversation = await h.get(), id = crypto.randomUUID();
  assert.equal((await h.post('/api/coordinator/messages', { conversationId: conversation.id, id,
    text: `create-immediately:${h.project}`, attachments: [] })).status, 200);
  const turn = await h.done(id);
  assert.equal(turn.status, 'succeeded');
  const write = JSON.parse(turn.answer!);
  assert.equal(write.code, 0, write.stderr);
  const created = JSON.parse(write.stdout).task;
  assert.equal(created.title, 'Cold-start task');
  const [record, ...rest] = h.records(conversation.id);
  assert.deepEqual(rest, []);
  assert.equal(record!.run?.resumes, null);
  assert.ok(record!.run?.session?.id);
  assert.equal(record!.run?.launch.adapter, 'codex');
  const outsider = await cliRun(h.url(), ['task', 'new', '--from-user', '--parent', h.project,
    '--title', 'Unrelated conversation', '--source-request', id, '--op-id', crypto.randomUUID()],
  { CODEX_THREAD_ID: crypto.randomUUID() });
  assert.equal(JSON.parse(outsider.stderr).error.reason.kind, 'only_screen_source_request',
    'an unowned conversation cannot claim a screen Request');
});

test('one model resumes and a model change starts a new session on the same profile', async t => {
  const h = await fixture(t, true), config = parse(h.config), path = join(h.root, 'config.yaml');
  const choose = (model: string, effort: string) => {
    const row = { agent: 'fake', values: { model, effort } };
    config.coordinatorAiStack = [row];
    writeFileSync(path, stringify(config));
    return row;
  };
  const firstRow = choose('fable', 'max');
  const { id: conversationId, nextLaunch } = await h.get();
  assert.deepEqual(nextLaunch, firstRow);
  const send = async (text: string) => {
    const input = { conversationId, id: crypto.randomUUID(), text, attachments: [] };
    const sent = await h.post('/api/coordinator/messages', input);
    assert.equal(sent.status, 200, await sent.text());
    return { input, answer: JSON.parse((await h.done(input.id)).answer!) };
  };
  const first = await send('first');
  assert.equal(first.answer.mode, 'start');
  assert.deepEqual(first.answer.args, ['fable', 'max']);
  assert.deepEqual(h.records(conversationId)[0]?.run?.launch.values, firstRow.values);
  const same = await send('same model');
  assert.equal(same.answer.mode, 'resume');
  assert.equal(same.answer.session, first.answer.session);

  const live = async () => (await (await fetch(new URL('/api/workspace/live', h.url()))).json()).person.coordinator.revision;
  const snapshot = async () => coordinatorSnapshotSchema.parse(await (await fetch(new URL('/api/coordinator', h.url()))).json());
  const before = await snapshot();
  await eventually(async () => (await live()) === before.revision, 'the first turn is published');
  const nextRow = choose('opus', 'high');
  const after = await snapshot();
  assert.deepEqual(after.conversation.nextLaunch, nextRow);
  assert.notEqual(after.revision, before.revision);
  await eventually(async () => (await live()) === after.revision, 'a settings edit republishes the coordinator marker');
  const next = await send('second');
  assert.equal(next.answer.mode, 'start');
  assert.notEqual(next.answer.session, first.answer.session);
  const reset = (await h.get()).resets.at(-1);
  assert.equal(reset?.reason.kind, 'another_ai');
  assert.equal(reset?.beforeRequestId, next.input.id);
  assert.deepEqual(next.answer.args, ['opus', 'high']);
  assert.equal((await h.post('/api/coordinator/messages', first.input)).status, 200, 'an admitted message can be replayed after a settings change');
  assert.equal((await h.post('/api/coordinator/messages', { ...first.input, id: crypto.randomUUID(), selected: firstRow.values })).status, 400);
  assert.equal((await h.get()).turns.length, 3);

  const options = AGENT_ADAPTERS.claude.options;
  config.agents.fake.options = { base: optionsBase('claude'), start: options.start,
    resume: options.resume.replace('[--model {model}] ', '') };
  const newSessionRow = choose('fable', 'high');
  assert.deepEqual((await h.get()).nextLaunch, newSessionRow);
  const third = await send('third');
  assert.equal(third.answer.mode, 'start');
  assert.notEqual(third.answer.session, next.answer.session);
  assert.deepEqual(third.answer.args, ['fable', 'high']);
});

test('the next launch displays only the options used after switching to a fresh session', async t => {
  const h = await fixture(t, true), config = parse(h.config), path = join(h.root, 'config.yaml');
  const options = AGENT_ADAPTERS.claude.options;
  config.agents.fake.params.effort = ['-', 'low'];
  config.agents.fake.options = { base: optionsBase('claude'),
    start: options.start.replace('[--model {model}] [--effort {effort}]', '--model opus'),
    resume: options.resume.replace('[--model {model}] [--effort {effort}]', '[--model {model} --effort {effort}]') };
  config.coordinatorAiStack = [{ agent: 'fake', values: { model: 'opus', effort: 'low' } }];
  writeFileSync(path, stringify(config));
  const { id: conversationId } = await h.get();
  const send = async (text: string) => {
    const id = crypto.randomUUID();
    const response = await h.post('/api/coordinator/messages', { conversationId, id, text, attachments: [] });
    assert.equal(response.status, 200, await response.text());
    return JSON.parse((await h.done(id)).answer!);
  };
  const first = await send('First message');
  config.coordinatorAiStack[0].values = { model: 'fable', effort: null };
  writeFileSync(path, stringify(config));
  assert.deepEqual((await h.get()).nextLaunch, { agent: 'fake', values: {} });
  const next = await send('Next message');
  assert.equal(next.mode, 'start');
  assert.notEqual(next.session, first.session);
  assert.deepEqual(next.args, ['opus']);
});

test('run and direct conversation callers cannot use coordinator API', async t => {
  const h = await fixture(t);
  for (const headers of [{ 'X-Alpacawork-Provider': 'claude', 'X-Alpacawork-Conversation': 'direct' },
    { authorization: 'Alpacawork-Run R1:' + '0'.repeat(64) }]) {
    assert.equal(await httpStatus(new URL('/api/coordinator', h.url()), { headers }), 403);
  }
});

test('failed first launches do not establish a resumable session', async t => {
  const h = await fixture(t);
  for (const failure of ['fail-exit', 'fail-output']) {
    const conversation = await h.get();
    const failedId = crypto.randomUUID();
    assert.equal((await h.post('/api/coordinator/messages', { conversationId: conversation.id, id: failedId,
      text: failure, attachments: [] })).status, 200);
    const failed = await h.done(failedId);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, failure === 'fail-exit' ? 'exit' : 'output');
    const nextId = crypto.randomUUID();
    assert.equal((await h.post('/api/coordinator/messages', { conversationId: conversation.id, id: nextId,
      text: 'after failure', attachments: [] })).status, 200);
    assert.equal(JSON.parse((await h.done(nextId)).answer!).mode, 'start');
    assert.equal((await h.post('/api/coordinator/clear', { conversationId: conversation.id })).status, 200);
  }
});

test('a busy resumed conversation keeps its session and can be sent again', async t => {
  const h = await fixture(t, false, '', 'codex'), conversation = await h.get();
  const firstId = crypto.randomUUID();
  assert.equal((await h.post('/api/coordinator/messages', { conversationId: conversation.id, id: firstId,
    text: 'first', attachments: [] })).status, 200);
  const first = JSON.parse((await h.done(firstId)).answer!);
  const busyId = crypto.randomUUID();
  assert.equal((await h.post('/api/coordinator/messages', { conversationId: conversation.id, id: busyId,
    text: 'busy-once', attachments: [] })).status, 200);
  assert.equal((await h.done(busyId)).error, 'conversation_busy');
  const retryId = crypto.randomUUID();
  assert.equal((await h.post('/api/coordinator/messages', { conversationId: conversation.id, id: retryId,
    text: 'busy-once', attachments: [] })).status, 200);
  const retried = JSON.parse((await h.done(retryId)).answer!);
  assert.equal(retried.mode, 'resume');
  assert.equal(retried.session, first.session);
});

test('messages wait in order; clear stops the active agent and drops its queued successor', async t => {
  const h = await fixture(t), conversation = await h.get();
  const gate = join(h.root, 'release');
  const first = crypto.randomUUID(), queued = crypto.randomUUID();
  assert.equal((await h.post('/api/coordinator/messages', { conversationId: conversation.id, id: first,
    text: `wait:${gate}`, attachments: [] })).status, 200);
  assert.equal((await h.post('/api/coordinator/messages', { conversationId: conversation.id, id: queued,
    text: 'queued', attachments: [] })).status, 200);
  const pid = await h.agentOf(conversation.id, first);
  t.after(() => stopGroup(pid));
  assert.equal((await h.get()).turns.find(turn => turn.id === queued)?.status, 'queued');
  const cleared = await h.post('/api/coordinator/clear', { conversationId: conversation.id });
  assert.equal(cleared.status, 200);
  // Before it answers, the stop is committed and published, and the waiting message withdrawn.
  const [working, successor] = h.records(conversation.id);
  assert.equal(working?.run?.stop_requested, true);
  const store = RunStore.openReadable(h.root, { busyTimeoutMs: 1000 })!;
  try {
    assert.equal(Number(store.connection.prepare(`SELECT count(*) AS n FROM run_commands c JOIN run_attempts a USING(attempt_id)
      WHERE a.run_no = ? AND c.type = 'stop' AND c.published = 1`).get(Number(working!.run!.id.slice(1)))!.n), 1);
  } finally { store.close(); }
  assert.equal(successor?.deliveryState, 'aborted'); assert.equal(successor?.run?.state, 'cancelled');
  const next = (coordinatorSnapshotSchema.parse(await cleared.json()).conversation as View);
  assert.notEqual(next.id, conversation.id); assert.deepEqual(next.turns, []);
  await eventually(() => !platform.run.signalGroup(pid, 0), 'the cleared agent stops');
  await eventually(() => h.records(conversation.id)[0]?.run?.state === 'cancelled', 'the stopped Run ends cancelled');
  assert.deepEqual((await h.get()).turns, []);
  const after = crypto.randomUUID();
  assert.equal((await h.post('/api/coordinator/messages', { conversationId: next.id, id: after,
    text: 'new', attachments: [] })).status, 200);
  assert.equal(JSON.parse((await h.done(after)).answer!).mode, 'start');
});

test('a running turn outlives serve and the next serve records its answer', async t => {
  const h = await fixture(t), conversation = await h.get();
  const gate = join(h.root, 'release'), id = crypto.randomUUID();
  assert.equal((await h.post('/api/coordinator/messages', { conversationId: conversation.id, id,
    text: `wait:${gate}`, attachments: [] })).status, 200);
  const pid = await h.agentOf(conversation.id, id);
  t.after(() => stopGroup(pid));
  await h.restart();
  assert.equal(platform.run.signalGroup(pid, 0), true, 'closing serve leaves the agent working');
  assert.equal((await h.get()).turns[0]?.status, 'running');
  writeFileSync(gate, 'released');
  const turn = await h.done(id);
  assert.equal(turn.status, 'succeeded');
  assert.equal(messagePart(JSON.parse(turn.answer!).prompt), `wait:${gate}`);
  const next = crypto.randomUUID();
  assert.equal((await h.post('/api/coordinator/messages', { conversationId: conversation.id, id: next,
    text: 'after', attachments: [] })).status, 200);
  assert.equal(JSON.parse((await h.done(next)).answer!).mode, 'resume', 'the followed turn keeps the session');
});

test('a coordinator turn ends with its agent and stops what it left in its process group', async t => {
  const h = await fixture(t), conversation = await h.get();
  const gate = join(h.root, 'release'), id = crypto.randomUUID();
  assert.equal((await h.post('/api/coordinator/messages', { conversationId: conversation.id, id,
    text: `child:${gate}`, attachments: [] })).status, 200);
  const pid = await h.agentOf(conversation.id, id);
  t.after(() => stopGroup(pid));
  writeFileSync(gate, 'released');
  const turn = await h.done(id);
  assert.equal(turn.status, 'succeeded');
  assert.equal(platform.run.signalGroup(pid, 0), false, 'nothing the turn started outlives it');
});

test('a process start identity tells a live process from a missing one', () => {
  const own = platform.run.started(process.pid);
  assert.ok(own);
  assert.equal(platform.run.started(process.pid), own);
  assert.equal(platform.run.started(2 ** 22 + 7), null);
});

test('SIGTERM during a turn ends the serve process promptly and the next serve records the answer', async t => {
  const h = await fixture(t);
  await h.stop();
  const backend = fileURLToPath(new URL('../apps/backend/dist/backend.js', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ALPACAWORK_')));
  const serve = spawn(process.execPath, [backend, '--workspace', h.root, 'workspace', 'serve', '--port', '0'],
    { stdio: ['ignore', 'pipe', 'inherit'], env });
  t.after(() => { if (serve.exitCode === null) serve.kill('SIGKILL'); });
  const [line] = await Promise.race([once(serve.stdout!, 'data'),
    once(serve, 'exit').then(() => { throw new Error('serve exited before listening'); })]) as [Buffer];
  const url = (JSON.parse(line.toString().split('\n')[0]!) as { url: string }).url;
  const conversation = coordinatorSnapshotSchema.parse(await (await fetch(new URL('/api/coordinator', url))).json()).conversation as { id: string };
  const gate = join(h.root, 'release'), id = crypto.randomUUID();
  assert.equal((await fetch(new URL('/api/coordinator/messages', url), { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: conversation.id, id, text: `wait:${gate}`, attachments: [] }) })).status, 200);
  const pid = await h.agentOf(conversation.id, id);
  t.after(() => stopGroup(pid));
  const started = performance.now();
  serve.kill('SIGTERM');
  await once(serve, 'exit');
  assert.ok(performance.now() - started < 10_000, 'a running turn does not hold serve open');
  assert.equal(platform.run.signalGroup(pid, 0), true, 'the agent keeps working');
  await h.restart();
  writeFileSync(gate, 'released');
  const turn = await h.done(id);
  assert.equal(turn.status, 'succeeded');
  assert.equal(messagePart(JSON.parse(turn.answer!).prompt), `wait:${gate}`);
});

test('a clear that answered before its stop was published still stops the agent, by the next pass or serve', async t => {
  const h = await fixture(t), conversation = await h.get();
  const gate = join(h.root, 'release'), id = crypto.randomUUID();
  assert.equal((await h.post('/api/coordinator/messages', { conversationId: conversation.id, id,
    text: `wait:${gate}`, attachments: [] })).status, 200);
  const pid = await h.agentOf(conversation.id, id);
  t.after(() => stopGroup(pid));
  t.mock.method(StopDeliveryOwner.prototype, 'gate', () => { throw new Error('serve stopped before it published the stop'); });
  assert.ok((await h.post('/api/coordinator/clear', { conversationId: conversation.id })).status >= 500);
  t.mock.restoreAll();
  await h.restart();
  assert.notEqual((await h.get()).id, conversation.id, 'the clear committed');
  await eventually(() => !platform.run.signalGroup(pid, 0), 'the agent of the cleared conversation stops');
  await eventually(() => h.records(conversation.id)[0]?.run?.state === 'cancelled', 'its Run ends cancelled');
});

test('a configured agent change starts a fresh session, then resumes within that agent across restart', async t => {
  const h = await fixture(t, true);
  // Two configured adapters, with intentionally different model and effort vocabularies.
  const config = parse(h.config);
  config.agents.other = { ...config.agents.fake, params: { ...config.agents.fake.params, model: ['sol', 'astra'], effort: ['low', 'xhigh'] } };
  writeFileSync(join(h.root, 'config.yaml'), stringify(config, { aliasDuplicateObjects: false }));
  const conversationId = (await h.get()).id;
  const send = async (agent: string, model: string, effort: string) => {
    config.coordinatorAiStack = [{ agent, values: { model, effort } }];
    writeFileSync(join(h.root, 'config.yaml'), stringify(config, { aliasDuplicateObjects: false }));
    const id = crypto.randomUUID(), input = { conversationId, id, text: 'hello', attachments: [] };
    const admission = await h.post('/api/coordinator/messages', input);
    assert.equal(admission.status, 200, await admission.text());
    const answer = JSON.parse((await h.done(id)).answer!);
    assert.equal((await h.post('/api/coordinator/messages', input)).status, 200);
    return answer;
  };
  const first = await send('fake', 'opus', 'max');
  const second = await send('other', 'sol', 'low');
  assert.equal(second.mode, 'start'); assert.notEqual(second.session, first.session);
  assert.deepEqual(second.args, ['sol', 'low']);
  await h.restart();
  const third = await send('other', 'sol', 'xhigh');
  assert.equal(third.mode, 'resume'); assert.equal(third.session, second.session);
  assert.deepEqual(third.args, ['sol', 'xhigh']);
  const fourth = await send('fake', 'fable', 'high');
  assert.equal(fourth.mode, 'start'); assert.notEqual(fourth.session, first.session);
  assert.equal((await h.get()).turns.length, 4, 'display history remains, but session context does not cross adapters');
});

test('a waiting message starts on the newly configured adapter with one memo and the original input', async t => {
  const h = await fixture(t, true), config = parse(h.config);
  config.agents.other = { ...config.agents.fake, adapter: 'codex', params: { model: [], effort: [], fast: [] } };
  // One stub per adapter, both confined to the fixture root.
  const { installAgentStub } = await import('./helpers/agent-stub.ts');
  const { fake } = await import('./helpers/coordinator-http-fixture.ts');
  process.env.PATH = installAgentStub(h.root, 'alpacawork-agent', [process.execPath, fake, '--fixture-bridge']);
  const conversationId = (await h.get()).id, first = crypto.randomUUID(), next = crypto.randomUUID();
  const gate = join(h.root, 'switch-gate');
  t.after(() => { if (existsSync(h.root)) writeFileSync(gate, 'release'); });
  assert.equal((await h.post('/api/coordinator/messages', { conversationId, id: first, text: `wait:${gate}`, attachments: [] })).status, 200);
  await h.agentOf(conversationId, first);
  const session = h.records(conversationId).find(record => record.id === first)!.run!.session!.id;
  const caller = { CLAUDE_CODE_SESSION_ID: session };
  const saved = await cliRun(h.url(), ['coordinator', 'memo', 'set', '--text-file', '-'], caller, 'Keep the selected direction');
  assert.equal(saved.code, 0, saved.stderr);
  const memo = JSON.parse(saved.stdout);
  const repeated = await cliRun(h.url(), ['coordinator', 'memo', 'set', '--text-file', '-'], caller, memo.text);
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.deepEqual(JSON.parse(repeated.stdout), memo, 'identical text keeps its timestamp');
  const get = await cliRun(h.url(), ['coordinator', 'memo', 'get'], caller);
  assert.equal(get.code, 0, get.stderr);
  assert.deepEqual(JSON.parse(get.stdout), memo);
  assert.notEqual((await cliRun(h.url(), ['coordinator', 'memo', 'get'])).code, 0, 'an outside caller cannot read the memo');
  assert.notEqual((await cliRun(h.url(), ['coordinator', 'memo', 'set', '--text-file', '-'], {}, 'Outside text')).code, 0,
    'an outside caller cannot replace the memo');
  const resetInput = { conversationId, opId: crypto.randomUUID() };
  const busy = await h.post('/api/coordinator/reset', resetInput);
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).error.code, 'coordinator_busy');

  assert.equal((await h.post('/api/coordinator/messages', { conversationId, id: next, text: 'Continue the selected direction', attachments: [] })).status, 200);
  config.coordinatorAiStack = [{ agent: 'other', values: {} }];
  writeFileSync(join(h.root, 'config.yaml'), stringify(config, { aliasDuplicateObjects: false }));
  writeFileSync(gate, 'release');
  const answer = JSON.parse((await h.done(next)).answer!);
  assert.equal(answer.mode, 'start');
  assert.equal(answer.prompt.split('Read the alpacawork skill').length, 2);
  assert.equal(answer.prompt.split(memo.text).length, 2);
  assert.equal(answer.prompt.split('Continue the selected direction').length, 2);
  assert.equal((await h.get()).resets.at(-1)?.beforeRequestId, next);

  const body = async (input: typeof resetInput) => {
    const response = await h.post('/api/coordinator/reset', input);
    assert.equal(response.status, 200, await response.clone().text());
    return coordinatorResetResponseSchema.parse(await response.json());
  };
  const one = await body(resetInput), two = await body({ ...resetInput, opId: crypto.randomUUID() });
  assert.equal(one.reset.id, two.reset.id);
  assert.equal(one.reset.beforeRequestId, null);
  assert.equal(one.conversation.context, null);
  const memoUrl = new URL(`/api/coordinator/resets/${one.reset.id}/memo`, h.url());
  assert.deepEqual(await (await fetch(memoUrl)).json(), memo);
  const last = crypto.randomUUID();
  assert.equal((await h.post('/api/coordinator/messages', { conversationId, id: last, text: 'Start after manual reset', attachments: [] })).status, 200);
  assert.equal(JSON.parse((await h.done(last)).answer!).mode, 'start');
  assert.equal((await body(resetInput)).reset.beforeRequestId, last, 'replay reads the same reset after it was used');
  assert.equal((await h.get()).resets.length, 2);
});

test('a completion publication fault is classified separately and records its cause once through HTTP', async t => {
  const h = await fixture(t);
  const source = realpathSync(mkdtempSync(join(tmpdir(), 'answer-fault-')));
  t.after(() => rmSync(source, { recursive: true, force: true }));
  writeFileSync(join(source, 'note.txt'), 'valid output');
  const reply = join(h.root, 'answer.md'); writeFileSync(reply, `Valid reply.\n[file](${source}/note.txt)`);
  const { FileJournal } = await import('@alpacawork/backend/test-dist/control/file-journal.js');
  const original = FileJournal.prototype.putManagedFile;
  const fault = Object.assign(new Error('injected answer publication fault'), { code: 'EIO' });
  t.mock.method(FileJournal.prototype, 'putManagedFile', function (this: InstanceType<typeof FileJournal>, input: { path: string }) {
    if (/^\.alpacawork\/coordinator\/[^/]+\/answers\//.test(input.path)) throw fault;
    return original.call(this, input);
  });
  const diagnostic = t.mock.method(console, 'error', () => {});
  const conversation = await h.get(), id = crypto.randomUUID();
  assert.equal((await h.post('/api/coordinator/messages', { conversationId: conversation.id, id,
    text: `answer-from:${reply}`, attachments: [] })).status, 200);
  const turn = await h.done(id) as Awaited<ReturnType<typeof h.done>> & { answerFiles?: unknown[] };
  assert.equal(turn.status, 'failed'); assert.equal(turn.error, 'attachment_save');
  assert.equal(turn.answer, null); assert.equal(turn.answerFiles, undefined);
  const failures = diagnostic.mock.calls.filter(call => call.arguments[0] === 'Coordinator completion failed');
  assert.equal(failures.length, 1);
  const context = failures[0]!.arguments[1] as { requestId: string; stage: string; cause: Error };
  assert.equal(context.requestId, id); assert.equal(context.stage, 'publish_answer_files'); assert.equal(context.cause, fault);
  // The public contract carries only the safe classification, never the exception or a ready file.
  const state = JSON.stringify(await h.get()); assert.equal(state.includes(fault.message), false);
  assert.equal(await httpStatus(new URL(`/api/coordinator/file?requestId=${id}&name=note.txt&area=answers`, h.url())), 404);
});

test('a completed reply crossing the context threshold reserves the next session', async t => {
  const h = await fixture(t, false, 'limits: {coordinator_reset_tokens: 100, coordinator_reset_percent: 0}\n');
  const conversationId = (await h.get()).id;
  const send = async (used: number) => {
    const id = crypto.randomUUID();
    const response = await h.post('/api/coordinator/messages', { conversationId, id, text: `usage:${used}`, attachments: [] });
    assert.equal(response.status, 200);
    assert.equal((await h.done(id)).status, 'succeeded');
    return id;
  };
  await send(40);
  let view = await h.get();
  assert.equal(view.context?.usedTokens, 40);
  assert.deepEqual(view.resets, []);
  await send(100);
  view = await h.get();
  const reset = view.resets[0]!;
  assert.deepEqual(reset.reason, { kind: 'context', over: { tokens: 100 } });
  assert.equal(reset.beforeRequestId, null);
  assert.equal(view.context, null);
  const id = await send(20);
  view = await h.get();
  assert.equal(view.resets.length, 1);
  assert.equal(view.resets[0]?.id, reset.id);
  assert.equal(view.resets[0]?.beforeRequestId, id);
  assert.equal(view.context?.usedTokens, 20);
});
