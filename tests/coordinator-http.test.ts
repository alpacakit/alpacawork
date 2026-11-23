import { parse, stringify } from 'yaml';
/** Real coordinator HTTP core cases; independent private fixtures. */
import { coordinatorSnapshotSchema } from '@alpacawork/contract/coordinator';
import { stopGroup } from './helpers/process-groups.ts';
import { cliRun, httpStatus } from './helpers/http-cli.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from '@alpacawork/core';
import { RunStore } from '@alpacawork/runs';
import { openIndexStream } from './index-stream.ts';
import { CoordinatorConversation } from '@alpacawork/backend/test-dist/coordinator/conversation.js';
import { StopDeliveryOwner } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { ServeLifecycle } from '@alpacawork/backend/test-dist/receiver/lifecycle.js';
import { messagePart, WARM, type View, eventually, records, fixture } from './helpers/coordinator-http-fixture.ts';

test('a message is admitted at once as its Request and coordinator Run, with one index publication at most before the answer', async t => {
  const h = await fixture(t), app = h.app(), feed = app.feed()!;
  const abort = new AbortController(); t.after(() => abort.abort());
  const stream = await openIndexStream(new URL('/api/events', h.url()), abort.signal);
  const before = await stream.index();
  const events: string[] = [], update = feed.update.bind(feed), republish = feed.republish.bind(feed);
  // A conversation change publishes through a fresh tree read or, when no tree changed, a republish of the last one.
  t.mock.method(feed, 'update', (...args: Parameters<typeof feed.update>) => {
    if (args[1].coordinator !== before.person.coordinator) events.push('publish');
    return update(...args);
  });
  t.mock.method(feed, 'republish', (...args: Parameters<typeof feed.republish>) => {
    if (args[0].coordinator !== before.person.coordinator) events.push('publish');
    return republish(...args);
  });
  app.server.on('request', (req, res) => {
    if (req.url === '/api/coordinator/messages') res.once('finish', () => events.push('response'));
  });
  const conversation = await h.get(), id = crypto.randomUUID(), gate = join(h.root, 'publication-gate');
  const input = { conversationId: conversation.id, id, text: `wait:${gate}`, attachments: [] };
  try {
    const response = await h.post('/api/coordinator/messages', input);
    assert.equal(response.status, 200);
    const accepted = (coordinatorSnapshotSchema.parse(await response.json()).conversation as View);
    assert.equal(accepted.turns.find(turn => turn.id === id)?.status, 'queued', 'serve answers with the admitted message; the Run layer starts it');
    const [stored, ...rest] = h.records(conversation.id);
    assert.deepEqual(rest, []);
    assert.equal(stored?.body, input.text, 'acceptance is durable as the Request, in the words the screen sent');
    assert.equal(stored?.run?.role, 'coordinator'); assert.equal(messagePart(stored!.prompt!), input.text);
    assert.match(stored!.prompt!, new RegExp(`Request ID of this input: ${id}.*--source-request ${id}`));
    assert.ok(events.includes('response'));
    assert.ok(events.slice(0, events.indexOf('response')).filter(event => event === 'publish').length <= 1,
      'one acceptance must not rebuild the index separately for its Request, its Run and their launch');
    let changed = await stream.index();
    while (changed.person.coordinator === before.person.coordinator) changed = await stream.index();
    assert.ok(events.includes('publish'), 'SSE carries the changed conversation');
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
  assert.equal((await h.get()).warm, 'none');
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

test('a new conversation warms up once in the background, hidden, and its first message goes on in that session', async t => {
  const h = await fixture(t);
  const conversation = await h.get();
  assert.equal((await h.post('/api/coordinator/warm', { conversationId: 'other' })).status, 409);
  const warming = (coordinatorSnapshotSchema.parse(await (await h.post('/api/coordinator/warm', { conversationId: conversation.id })).json()).conversation as View);
  assert.equal(warming.warm, 'preparing'); assert.deepEqual(warming.turns, []);
  // Sent while the warm-up runs, the message waits behind it.
  const id = crypto.randomUUID(), gate = join(h.root, 'first-gate'), text = `wait:${gate}`;
  assert.equal((await h.post('/api/coordinator/messages', { conversationId: conversation.id, id, text, attachments: [] })).status, 200);
  // The Request remains the message identity while its Run works and after completion.
  await h.agentOf(conversation.id, id);
  assert.equal(h.records(conversation.id).find(record => record.id === id)?.run?.state, 'running');
  writeFileSync(gate, 'release');
  const first = JSON.parse((await h.done(id)).answer!);
  assert.equal(first.mode, 'resume'); assert.equal(messagePart(first.prompt), text);
  const after = await h.get();
  assert.equal(after.warm, 'ready'); assert.deepEqual(after.turns.map(turn => turn.id), [id]);
  // A conversation that has had a turn does not warm up again.
  const again = (coordinatorSnapshotSchema.parse(await (await h.post('/api/coordinator/warm', { conversationId: conversation.id })).json()).conversation as View);
  assert.equal(again.warm, 'ready');
  const [warm, message, ...rest] = h.records(conversation.id);
  assert.deepEqual(rest, []);
  assert.equal(warm!.warm, true); assert.equal(warm!.body, WARM, 'the warm-up asks only that the skills be read');
  assert.equal(warm!.run?.state, 'succeeded'); assert.equal(warm!.run?.session?.id, first.session);
  assert.equal(message!.id, id); assert.equal(message!.run?.resumes, warm!.run?.id);
});

test('coordinator inputs reach the agent unchanged on warm-up, direct start and restart after a failed warm-up', async t => {
  const h = await fixture(t);
  const marks = join(h.root, '.alpacawork/coordinator');
  t.after(() => { rmSync(join(marks, '.warm-hold'), { force: true }); });
  const send = async (conversationId: string) => {
    const id = crypto.randomUUID(), text = 'T3 1-choice';
    assert.equal((await h.post('/api/coordinator/messages', { conversationId, id, text, attachments: [] })).status, 200);
    return id;
  };
  const answer = async (id: string) => JSON.parse((await h.done(id)).answer!) as { mode: string; prompt: string };
  let conversation = await h.get();
  await h.post('/api/coordinator/warm', { conversationId: conversation.id });
  const resumed = await answer(await send(conversation.id));
  assert.equal(resumed.mode, 'resume'); assert.equal(messagePart(resumed.prompt), 'T3 1-choice');
  // The fake agent reports the actual prompt it received, the hidden warm-up's included.
  const [warm] = h.records(conversation.id);
  assert.equal(warm!.warm, true); assert.equal(JSON.parse(warm!.result!).prompt, WARM);
  assert.match(warm!.body, /Reply only with: ready/);

  conversation = (coordinatorSnapshotSchema.parse(await (await h.post('/api/coordinator/clear', { conversationId: conversation.id })).json()).conversation as View);
  const direct = await answer(await send(conversation.id));
  assert.equal(direct.mode, 'start'); assert.equal(messagePart(direct.prompt), 'T3 1-choice');

  // A failed warm-up restarts the waiting message without adding instructions.
  conversation = (coordinatorSnapshotSchema.parse(await (await h.post('/api/coordinator/clear', { conversationId: conversation.id })).json()).conversation as View);
  mkdirSync(marks, { recursive: true });
  writeFileSync(join(marks, '.warm-hold'), ''); writeFileSync(join(marks, '.warm-fail'), '');
  await h.post('/api/coordinator/warm', { conversationId: conversation.id });
  await eventually(() => h.records(conversation.id).find(record => record.warm)?.run?.state === 'running', 'warm-up runs');
  const waiting = await send(conversation.id);
  rmSync(join(marks, '.warm-hold'));
  const fallback = await answer(waiting);
  assert.equal(fallback.mode, 'start'); assert.equal(messagePart(fallback.prompt), 'T3 1-choice');
});

test('clearing repeatedly warms and sends with an omitted launch option, without reusing the cleared session', async t => {
  const h = await fixture(t, true, '', 'codex');
  let conversation = await h.get(), previousSession: string | undefined;
  for (let cycle = 0; cycle < 3; cycle++) {
    const old = conversation.id;
    const cleared = await h.post('/api/coordinator/clear', { conversationId: old });
    assert.equal(cleared.status, 200);
    conversation = coordinatorSnapshotSchema.parse(await cleared.json()).conversation as View;
    assert.notEqual(conversation.id, old);
    const warm = { conversationId: conversation.id };
    const responses = await Promise.all([h.post('/api/coordinator/warm', warm), h.post('/api/coordinator/warm', warm)]);
    for (const response of responses) assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await h.post('/api/coordinator/warm', { conversationId: old })).status, 409,
      'a late warm-up cannot change the new conversation');
    const id = crypto.randomUUID();
    assert.equal((await h.post('/api/coordinator/messages', {
      conversationId: conversation.id, id, text: 'Synthetic follow-up', attachments: [],
    })).status, 200);
    const finished = await h.done(id);
    assert.equal(finished.status, 'succeeded');
    const answer = JSON.parse(finished.answer!);
    assert.equal(answer.mode, 'resume');
    assert.notEqual(answer.session, previousSession);
    previousSession = answer.session;
    const records = h.records(conversation.id), warms = records.filter(record => record.warm);
    assert.equal(warms.length, 1, 'duplicate warm requests admit one preparation');
    assert.equal(warms[0]!.run?.state, 'succeeded');
    assert.equal(warms[0]!.run?.launch.values.fast, undefined);
    assert.equal((await h.get()).warm, 'ready');
    assert.equal((await h.post('/api/coordinator/warm', {
      ...warm, selected: { fast: false },
    })).status, 400, 'a client cannot override the configured row');
  }
});

test('clear stops a held warm-up', async t => {
  // A message waiting behind a warm-up is the first test's; a turn outliving serve and a failed first Run starting anew
  // are their own tests' and continuation's.
  const h = await fixture(t);
  const marks = join(h.root, '.alpacawork', 'coordinator');
  mkdirSync(marks, { recursive: true });
  // A failed assertion must not leave the fake agent held.
  t.after(() => { rmSync(join(marks, '.warm-hold'), { force: true }); });
  const warmRun = (conversationId: string, state: string) => eventually(() => {
    const run = h.records(conversationId).find(record => record.warm)?.run;
    return run?.state === state && (state !== 'running' || run.pids.agent !== null) && run;
  }, `Warm-up did not reach ${state}`);
  writeFileSync(join(marks, '.warm-hold'), '');
  const conversation = await h.get();
  await h.post('/api/coordinator/warm', { conversationId: conversation.id });
  const held = (await warmRun(conversation.id, 'running')).pids.agent!;
  assert.equal((await h.post('/api/coordinator/clear', { conversationId: conversation.id })).status, 200);
  await eventually(() => !platform.run.signalGroup(held, 0), 'the cleared warm-up stops');
  assert.equal((await warmRun(conversation.id, 'cancelled')).reason, 'stopped');
});

test('warm-up and messages use the saved coordinator row, including a setting change on the same session', async t => {
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
  const warm = await h.post('/api/coordinator/warm', { conversationId });
  assert.equal(warm.status, 200);
  const first = await send('first');
  assert.equal(first.answer.mode, 'resume');
  assert.deepEqual(first.answer.args, ['fable', 'max']);
  assert.deepEqual(h.records(conversationId).find(record => record.warm)?.run?.launch.values, firstRow.values);

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
  assert.equal(next.answer.mode, 'resume');
  assert.equal(next.answer.session, first.answer.session);
  assert.deepEqual(next.answer.args, ['opus', 'high']);
  assert.equal((await h.post('/api/coordinator/messages', first.input)).status, 200, 'an admitted message can be replayed after a settings change');
  assert.equal((await h.post('/api/coordinator/messages', { ...first.input, id: crypto.randomUUID(), selected: firstRow.values })).status, 400);
  assert.equal((await h.get()).turns.length, 2);
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
  const third = await send('other', 'astra', 'xhigh');
  assert.equal(third.mode, 'resume'); assert.equal(third.session, second.session);
  assert.deepEqual(third.args, ['astra', 'xhigh']);
  const fourth = await send('fake', 'fable', 'high');
  assert.equal(fourth.mode, 'start'); assert.notEqual(fourth.session, first.session);
  assert.equal((await h.get()).turns.length, 4, 'display history remains, but session context does not cross adapters');
});

test('a queued adapter switch after warm-up uses its defaults and a failed switch leaves the last working session intact', async t => {
  const h = await fixture(t, true);
  const config = parse(h.config);
  config.agents.other = { ...config.agents.fake, params: { ...config.agents.fake.params, model: ['sol', 'astra'], effort: ['low', 'xhigh'] } };
  writeFileSync(join(h.root, 'config.yaml'), stringify(config, { aliasDuplicateObjects: false }));
  const conversationId = (await h.get()).id;
  const marks = join(h.root, '.alpacawork/coordinator'), gate = join(marks, '.warm-hold');
  mkdirSync(marks, { recursive: true });
  writeFileSync(gate, '');
  t.after(() => { rmSync(gate, { force: true }); });
  const choose = (agent: string, values = {}) => {
    config.coordinatorAiStack = [{ agent, values }];
    writeFileSync(join(h.root, 'config.yaml'), stringify(config, { aliasDuplicateObjects: false }));
  };
  choose('fake', { model: 'fable', effort: 'max' });
  assert.equal((await h.post('/api/coordinator/warm', { conversationId })).status, 200);
  const id = crypto.randomUUID();
  choose('other');
  assert.equal((await h.post('/api/coordinator/messages', { conversationId, id, text: 'queued switch', attachments: [] })).status, 200);
  rmSync(gate);
  const first = JSON.parse((await h.done(id)).answer!);
  assert.equal(first.mode, 'start'); assert.deepEqual(first.args, ['sol','low']);
  const fail = crypto.randomUUID();
  choose('fake');
  assert.equal((await h.post('/api/coordinator/messages', { conversationId, id: fail, text: 'fail-exit', attachments: [] })).status, 200);
  assert.equal((await h.done(fail)).status, 'failed');
  const back = crypto.randomUUID();
  choose('other');
  assert.equal((await h.post('/api/coordinator/messages', { conversationId, id: back, text: 'back', attachments: [] })).status, 200);
  const next = JSON.parse((await h.done(back)).answer!);
  assert.equal(next.mode,'resume'); assert.equal(next.session,first.session);
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
