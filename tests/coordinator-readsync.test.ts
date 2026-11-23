import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { stringify } from 'yaml';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { PROBLEM_CODE } from '@alpacawork/core';
import { RunStore } from '@alpacawork/runs';
import { coordinatorConversationSchema, coordinatorReadAckSchema, coordinatorSnapshotSchema } from '@alpacawork/contract/coordinator';
import { CoordinatorConversation } from '@alpacawork/backend/test-dist/coordinator/conversation.js';
import { createCoordinatorReadState } from '@alpacawork/backend/test-dist/receiver/person-state.js';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { initializeControlFixture } from './helpers/control-fixture.ts';
import { openIndexStream } from './index-stream.ts';

const config = stringify({ agents: { "fake": fixtureAgentSetting('codex') }, coordinatorAiStack: [{ agent: 'fake', values: {} }] });

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'coordinator-readsync-')));
  let cleanup = async () => {};
  t.after(async () => { await cleanup(); rmSync(root, { recursive: true, force: true }); });
  initializeControlFixture(root);
  writeFileSync(join(root, 'config.yaml'), config);
  let notifications = 0;
  const conversation = new CoordinatorConversation(root, () => { notifications++; });
  const id = conversation.read().id;
  const file = join(root, '.alpacawork/coordinator-read.json');
  const ask = async () => {
    const request = crypto.randomUUID();
    const snapshot = await conversation.ask({ conversationId: conversation.read().id, id: request,
      text: 'Read this reply', attachments: [] });
    coordinatorConversationSchema.parse(snapshot);
    return request;
  };
  const complete = (request: string, failed = false) => {
    const store = new RunStore(root, { busyTimeoutMs: 1000 });
    try {
      const number = store.connection.prepare('SELECT id FROM runs WHERE request_id=?').get(request)!.id;
      const run = store.runtimeGet(`R${number}`)!;
      store.write(tx => {
        const running = { ...run, state: 'running' as const, reason: null, started_at: new Date().toISOString() };
        tx.update(running);
        const ended = { ...running, state: failed ? 'failed' as const : 'succeeded' as const,
          reason: failed ? 'exit' as const : null, ended_at: new Date().toISOString() };
        tx.finish(ended, failed ? { state: 'missing', text: null } : { state: 'present', text: 'A complete reply' });
      });
    } finally { store.close(); }
  };
  const answer = async (failed = false) => { const request = await ask(); complete(request, failed); return request; };
  const seen = () => conversation.read().turns.filter(turn => turn.seen).map(turn => turn.id);
  const state = () => JSON.parse(readFileSync(file, 'utf8'));
  return { root, id, file, conversation, ask, complete, answer, seen, state, notifications: () => notifications,
    cleanup: (work: () => Promise<void>) => { cleanup = work; } };
}

test('read union keeps holes, deduplicates ACKs and never rewrites or notifies an unchanged set', async t => {
  const h = fixture(t); await h.conversation.seedSeen();
  const first = await h.answer(), hole = await h.answer(), last = await h.answer(true);
  assert.deepEqual(await h.conversation.markSeen(h.id, [last, first, last]), { conversationId: h.id, seen: [first, last].sort() });
  assert.deepEqual(h.seen(), [first, last]);
  assert.equal(h.conversation.read().turns.find(turn => turn.id === hole)!.seen, false);
  const stored = h.state(), inode = statSync(h.file).ino, notices = h.notifications();
  await h.conversation.markSeen(h.id, [last, first]);
  assert.deepEqual(h.state(), stored); assert.equal(statSync(h.file).ino, inode);
  assert.equal(h.notifications(), notices);
  await Promise.all([h.conversation.markSeen(h.id, [hole]), new CoordinatorConversation(h.root).markSeen(h.id, [first, last])]);
  assert.deepEqual(h.seen(), [first, hole, last]);
});

test('equal timestamps and a late older reply keep separate identities and stable Request/Run order', async t => {
  const h = fixture(t); await h.conversation.seedSeen();
  const clock = t.mock.method(Date.prototype, 'toISOString', () => '2026-10-21T10:00:00.000Z');
  const older = await h.ask(), newer = await h.answer();
  await h.conversation.markSeen(h.id, [newer]);
  h.complete(older); clock.mock.restore();
  const turns = h.conversation.read().turns;
  assert.deepEqual(turns.map(turn => turn.id), [older, newer]);
  assert.equal(turns[0]!.answeredAt, turns[1]!.answeredAt);
  assert.deepEqual(turns.map(turn => turn.seen), [false, true]);
  await h.conversation.markSeen(h.id, [older]);
  assert.deepEqual(h.seen(), [older, newer]);
});

test('an invalid batch commits nothing; unfinished, warm, joined and withdrawn requests are not readable answers', async t => {
  const h = fixture(t); await h.conversation.seedSeen();
  const done = await h.answer(), queued = await h.ask();
  const before = h.state();
  await assert.rejects(h.conversation.markSeen(h.id, [done, queued]), { code: PROBLEM_CODE.invalidInput,
    reason: { kind: 'coordinator_seen_ids_must_be_completed_answers' } });
  assert.deepEqual(h.state(), before); assert.deepEqual(h.seen(), []);
  const joined = await h.ask(), store = new RunStore(h.root, { busyTimeoutMs: 1000 });
  try {
    const head = store.coordinatorRuns(h.id).find(run => run.requestId === done)!;
    const run = store.coordinatorRuns(h.id).find(run => run.requestId === joined)!;
    store.write(tx => tx.update({ ...run, state: 'joined', into: head.id, ended_at: new Date().toISOString() }));
  } finally { store.close(); }
  await assert.rejects(h.conversation.markSeen(h.id, [joined]), { code: PROBLEM_CODE.invalidInput });
  const provisional = await h.ask(), reviewing = new RunStore(h.root, { busyTimeoutMs: 1000 });
  try {
    const run = reviewing.coordinatorRuns(h.id).find(run => run.requestId === provisional)!;
    reviewing.write(tx => {
      const running = { ...run, state: 'running' as const, started_at: new Date().toISOString() };
      tx.update(running);
      tx.update({ ...running, state: 'needs_review', reason: 'manager_lost', ended_at: new Date().toISOString() });
    });
  } finally { reviewing.close(); }
  assert.equal(h.conversation.read().turns.find(turn => turn.id === provisional)!.answeredAt, null);
  await assert.rejects(h.conversation.markSeen(h.id, [provisional]), { code: PROBLEM_CODE.invalidInput });
  h.conversation.withdraw(h.id, queued);
  await assert.rejects(h.conversation.markSeen(h.id, [queued]), { code: PROBLEM_CODE.invalidInput });
  await assert.rejects(h.conversation.markSeen(h.id, [crypto.randomUUID()]), { code: PROBLEM_CODE.invalidInput });
  for (const batch of [[], Array(129).fill(done)])
    await assert.rejects(h.conversation.markSeen(h.id, batch), { code: PROBLEM_CODE.invalidInput });
  const warm = fixture(t); warm.conversation.warm(warm.id); const warmStore = new RunStore(warm.root, { busyTimeoutMs: 1000 });
  let warmId: string;
  try { warmId = warmStore.coordinatorRuns(warm.id)[0]!.requestId; } finally { warmStore.close(); }
  warm.complete(warmId);
  await assert.rejects(warm.conversation.markSeen(warm.id, [warmId]), { code: PROBLEM_CODE.invalidInput });
  assert.equal(warm.conversation.read().turns.length, 0);
});

test('seed is once, includes only completed visible replies, and does not acknowledge a later recovery answer', async t => {
  const h = fixture(t);
  const old = await h.answer(), failed = await h.answer(true), unfinished = await h.ask();
  await h.conversation.seedSeen(); assert.deepEqual(h.seen(), [old, failed]);
  const before = h.state(); h.complete(unfinished);
  await new CoordinatorConversation(h.root).seedSeen();
  assert.deepEqual(h.state(), before);
  assert.equal(h.conversation.read().turns.find(turn => turn.id === unfinished)!.seen, false);
  await h.conversation.markSeen(h.id, [unfinished]);
  assert.equal(new CoordinatorConversation(h.root).read().turns.every(turn => turn.seen), true);
});

test('serve seeds before its startup importer, and refuses a damaged initial read file', async t => {
  const h = fixture(t), old = await h.answer(), recovering = await h.ask();
  const original = RunEventImporter.prototype.pass;
  let recovered = false;
  const hook = t.mock.method(RunEventImporter.prototype, 'pass', function (this: RunEventImporter) {
    if (!recovered) {
      assert.deepEqual(h.state().value.seen, [old], 'seed has committed before startup recovery');
      h.complete(recovering); recovered = true;
    }
    return original.call(this);
  });
  const server = await startServer(h.root, 0); h.cleanup(() => server.close());
  assert.equal(recovered, true); assert.deepEqual(h.seen(), [old]);
  hook.mock.restore(); await server.close();
  writeFileSync(h.file, '{corrupt');
  await assert.rejects(startServer(h.root, 0), { code: PROBLEM_CODE.unavailable });
});

test('clear and a save waiting on the RAW lock cannot transfer observations into the new conversation', async t => {
  const h = fixture(t); await h.conversation.seedSeen();
  const old = await h.answer(), writer = new FileWriter(h.root);
  let pending: Promise<unknown> | undefined;
  try {
    await writer.locked(async () => {
      pending = h.conversation.markSeen(h.id, [old]);
      h.conversation.clear(h.id);
    });
    await assert.rejects(pending!, { code: PROBLEM_CODE.conflict });
  } finally { writer.close(); }
  const next = h.conversation.read().id;
  assert.notEqual(next, h.id); assert.deepEqual(h.seen(), []);
  const fresh = await h.answer();
  await h.conversation.seedSeen(); assert.deepEqual(h.seen(), [], 'an existing old-conversation file prevents reseeding');
  await assert.rejects(h.conversation.markSeen(h.id, [old]), { code: PROBLEM_CODE.conflict });
  await h.conversation.markSeen(next, [fresh]);
  assert.deepEqual(h.state().value, { conversationId: next, seen: [fresh] });
});

for (const afterRename of [false, true]) test(`save failure ${afterRename ? 'after' : 'before'} rename gives no ACK and retry reads actual saved state`, async t => {
  const h = fixture(t); await h.conversation.seedSeen(); const id = await h.answer();
  const saved = h.state(), original = fs.fsyncSync;
  const fault = t.mock.method(fs, 'fsyncSync', (fd: number) => {
    if (fs.fstatSync(fd).isDirectory() === afterRename) throw new Error('injected fsync failure');
    return original(fd);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(h.conversation.markSeen(h.id, [id]), { code: PROBLEM_CODE.saveUnconfirmed }); }
  finally { fault.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(h.seen(), afterRename ? [id] : []);
  assert.equal(h.notifications(), afterRename ? 1 : 0);
  if (!afterRename) assert.deepEqual(h.state(), saved);
  const beforeRetry = h.state();
  assert.deepEqual(await h.conversation.markSeen(h.id, [id]), { conversationId: h.id, seen: [id] });
  if (afterRename) assert.deepEqual(h.state(), beforeRetry);
});

test('corrupt and oversized files are rejected rather than read as empty or reseeded', async t => {
  const h = fixture(t); await h.conversation.seedSeen(); const id = await h.answer();
  for (const bytes of ['{bad', JSON.stringify({ version: 1, revision: 'bad', value: { conversationId: h.id, seen: [id, id] } }), ' '.repeat(1024 * 1024 + 1)]) {
    writeFileSync(h.file, bytes);
    assert.throws(() => h.conversation.read(), { code: PROBLEM_CODE.unavailable });
    await assert.rejects(h.conversation.seedSeen(), { code: PROBLEM_CODE.unavailable });
    await assert.rejects(h.conversation.markSeen(h.id, [id]), { code: PROBLEM_CODE.unavailable });
    assert.equal(readFileSync(h.file, 'utf8'), bytes);
  }
});

test('personal storage has a byte bound, accepts many observations and rejects an oversized write before replacement', async t => {
  const h = fixture(t), state = createCoordinatorReadState(h.root);
  const ids = Array.from({ length: 10_000 }, (_, n) => `request-${n}`);
  await state.change(() => ({ conversationId: h.id, seen: ids }));
  assert.equal(state.get()!.value.seen.length, 10_000);
  const before = h.state();
  await assert.rejects(state.change(() => ({ conversationId: h.id,
    seen: Array.from({ length: 6000 }, (_, n) => `${n}-` + 'x'.repeat(245)) })), { code: PROBLEM_CODE.tooLarge, reason: { kind: 'person_state_too_large' } });
  assert.deepEqual(h.state(), before);
});

test('the installed HTTP route authenticates, bounds batches and obeys mutation quiesce before saving', async t => {
  const h = fixture(t); await h.conversation.seedSeen(); const id = await h.answer();
  const server = await startServer(h.root, 0); h.cleanup(() => server.close());
  const post = (body: unknown, headers = {}) => fetch(new URL('/api/coordinator/read', server.url), { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  // A body left unread holds serve's close for four seconds.
  const status = async (answer: Promise<Response>) => { const read = await answer; await read.arrayBuffer(); return read.status; };
  assert.equal(await status(post({ conversationId: h.id, seen: [id] }, {
    'X-Alpacawork-Provider': 'codex', 'X-Alpacawork-Conversation': 'not-human' })), 403);
  assert.equal(await status(post({ conversationId: h.id, seen: Array(129).fill(id) })), 400);
  const unreadable = await post({ conversationId: h.id, seen: [crypto.randomUUID()] });
  assert.equal(unreadable.status, 400);
  assert.deepEqual((await unreadable.json()).error.reason, { kind: 'coordinator_seen_ids_must_be_completed_answers' });
  let admitted!: () => void;
  const admission = new Promise<void>(resolve => { admitted = resolve; });
  const original = CoordinatorConversation.prototype.markSeen;
  t.mock.method(CoordinatorConversation.prototype, 'markSeen', function (this: CoordinatorConversation,
    ...args: Parameters<CoordinatorConversation['markSeen']>) { admitted(); return original.apply(this, args); });
  const writer = new FileWriter(h.root);
  let accepted!: Promise<Response>, closing!: Promise<void>;
  try {
    await writer.locked(async () => {
      accepted = post({ conversationId: h.id, seen: [id, id] });
      await admission;
      closing = server.close();
      assert.equal(await status(post({ conversationId: h.id, seen: [id] })), 503);
    });
    const response = await accepted; assert.equal(response.status, 200);
    assert.deepEqual(coordinatorReadAckSchema.parse(await response.json()), { conversationId: h.id, seen: [id] });
    await closing;
    assert.deepEqual(new CoordinatorConversation(h.root).read().turns.filter(turn => turn.seen).map(turn => turn.id), [id]);
  } finally { writer.close(); }
});

test('serve publishes personal-only seen changes over SSE, ACK stays small, duplicate is quiet and restart retains facts', async t => {
  const h = fixture(t); await h.conversation.seedSeen(); const id = await h.answer();
  let server = await startServer(h.root, 0);
  const abort = new AbortController();
  h.cleanup(async () => { abort.abort(); await server.close(); });
  const stream = await openIndexStream(new URL('/api/events', server.url), abort.signal);
  const before = await stream.index();
  const post = (headers = {}) => fetch(new URL('/api/coordinator/read', server.url), { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ conversationId: h.id, seen: [id] }) });
  const refused = await post({ 'X-Alpacawork-Provider': 'codex', 'X-Alpacawork-Conversation': 'not-human' });
  assert.equal(refused.status, 403);
  const response = await post(); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { conversationId: h.id, seen: [id] });
  let changed = await stream.index();
  while (changed.person.coordinator?.revision === before.person.coordinator?.revision) changed = await stream.index();
  const read = coordinatorSnapshotSchema.parse(await (await fetch(new URL('/api/coordinator', server.url))).json()).conversation;
  assert.equal(read.turns.find(turn => turn.id === id)!.seen, true);
  await delay(100);
  const revision = h.state().revision, inode = statSync(h.file).ino;
  const published = JSON.parse(server.feed()!.index()).person.coordinator;
  let changes = 0;
  const feed = server.feed()!, update = feed.update.bind(feed);
  const hook = t.mock.method(feed, 'update', (...args: Parameters<typeof feed.update>) => {
    const result = update(...args); if (result) changes++; return result;
  });
  await (await post()).arrayBuffer(); await delay(150);
  assert.equal(h.state().revision, revision); assert.equal(statSync(h.file).ino, inode);
  assert.deepEqual(JSON.parse(feed.index()).person.coordinator, published); assert.equal(changes, 0);
  hook.mock.restore(); abort.abort(); await server.close();
  server = await startServer(h.root, 0);
  const restarted = coordinatorSnapshotSchema.parse(await (await fetch(new URL('/api/coordinator', server.url))).json()).conversation;
  assert.equal(restarted.turns.find(turn => turn.id === id)!.seen, true);
});
