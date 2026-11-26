import { stringify } from 'yaml';
import { fixtureAgentSetting, installAgentStub } from './helpers/agent-stub.ts';
import { coordinatorMessageResponseSchema, coordinatorSnapshotSchema } from '@alpacawork/contract/coordinator';
/**
 * How a message ends before it went (withdraw, clear) through the installed HTTP API: what the control database keeps,
 * that a failed write commits and acknowledges nothing, that cancelled files survive recovery and cleared files are swept, and a fresh
 * serve.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { RunStore } from '@alpacawork/runs';
import { CoordinatorConversation } from '@alpacawork/backend/test-dist/coordinator/conversation.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { initializeControlFixture } from './helpers/control-fixture.ts';
const fake = new URL('./fixtures/fake-coordinator-agent.mjs', import.meta.url).pathname;
const config = stringify({ agents: { fake: fixtureAgentSetting('claude') } });

/** Polls `check` until it holds: serve sweeps files on its own passes. */
async function eventually(check: () => boolean, message: string, timeout = 20_000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error(`Deadline: ${message}`);
    await delay(50);
  }
}
/** Runs `work` on the control database outside serve: to read what it recorded, or to make its writes fail. */
function control<T>(root: string, work: (store: RunStore) => T): T {
  const store = new RunStore(root, { busyTimeoutMs: 1000 });
  try { return work(store); } finally { store.close(); }
}
/** The conversation's messages as recorded (excluding the test's blocking message), oldest first: each Request's delivery state and its Run's state. */
const recorded = (root: string, conversationId: string, blocker: string) => control(root, store => store.connection.prepare(`SELECT q.id,
  q.delivery_state, json_extract(r.record, '$.state') AS run FROM requests q LEFT JOIN runs r ON r.request_id = q.id
  WHERE q.conversation_id = ? AND q.id <> ?
  ORDER BY q.submitted_at, q.rowid`).all(conversationId, blocker)
  .map(row => ({ id: String(row.id), delivery: String(row.delivery_state), run: row.run === null ? null : String(row.run) })));
/** A write that SQLite refuses while it stands, as a failed disk write would be: the transaction holding it rolls back. */
function refuse(root: string, name: string, trigger: string): () => void {
  control(root, store => store.write(() => store.connection.exec(`CREATE TRIGGER ${name} ${trigger} BEGIN SELECT RAISE(ABORT, '${name}'); END`)));
  return () => control(root, store => store.write(() => store.connection.exec(`DROP TRIGGER ${name}`)));
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }, attached = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'coordinator-terminal-')));
  initializeControlFixture(root);
  process.env.PATH = installAgentStub(root, 'claude', [process.execPath, fake]);
  writeFileSync(join(root, 'config.yaml'), config);
  const marks = join(root, '.alpacawork/coordinator'); mkdirSync(marks, { recursive: true });
  const gate = join(marks, 'release'), blocker = crypto.randomUUID();
  let server = await startServer(root);
  const post = (path: string, body: unknown) => fetch(new URL('/api/coordinator/' + path, server.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const snapshot = async () => coordinatorSnapshotSchema.parse(await (await fetch(new URL('/api/coordinator', server.url))).json()).conversation;
  const get = async () => {
    const view = await snapshot();
    return { ...view, turns: view.turns.filter(turn => turn.id !== blocker) };
  };
  const status = async (id: string) => (await (await fetch(new URL(`/api/coordinator/messages/${id}/status`, server.url))).json()).status;
  const conversationId = (await get()).id;
  const file = (id: string, name = 'notes.txt') => fetch(new URL(`/api/coordinator/file?requestId=${id}&name=${name}`, server.url));
  const upload = (id: string, name: string, body = 'attachment retained for input recovery') => fetch(new URL(`/api/coordinator/attachments?conversationId=${conversationId}&requestId=${id}&name=${name}`, server.url), {
    method: 'POST', headers: { 'X-Alpacawork-Op-Id': crypto.randomUUID() }, body,
  });
  assert.equal((await post('messages', { conversationId, id: blocker, text: `wait:${gate}`, attachments: [] })).status, 200);
  t.after(async () => {
    if (existsSync(marks)) writeFileSync(gate, 'release');
    for (let n = 0; n < 100 && ['queued', 'running'].includes(await status(blocker)); n++) await delay(30);
    await server.close(); rmSync(root, { recursive: true, force: true });
  });
  const id = crypto.randomUUID();
  if (attached) {
    assert.equal((await upload(id, 'notes.txt')).status, 200);
  }
  const input = { conversationId, id, text: 'raw instruction', attachments: attached ? ['notes.txt'] : [] as string[] };
  assert.equal((await post('messages', input)).status, 200);
  assert.equal((await get()).turns.find(turn => turn.id === id)?.status, 'queued');
  return { root, folder: join(marks, conversationId), conversationId, id, input, post, get, upload, file, status,
    records: () => recorded(root, conversationId, blocker),
    restart: async () => { await server.close(); server = await startServer(root); } };
}
test('withdraw reply loss and late asks stay cancelled across restart while their files remain recoverable', async t => {
  const h = await fixture(t, true);
  const other = crypto.randomUUID(); assert.equal((await h.post('messages', { ...h.input, id: other, attachments: [] })).status, 200);
  await (await h.post('messages/withdraw', { conversationId: h.conversationId, id: h.id })).arrayBuffer(); // Drop its answer.
  const read = await h.get(); assert.equal(await h.status(h.id), 'withdrawn'); assert.equal(read.turns.some(turn => turn.id === h.id), false);
  assert.equal(read.turns.find(turn => turn.id === other)?.status, 'queued');
  assert.deepEqual(h.records(), [{ id: h.id, delivery: 'aborted', run: 'cancelled' }, { id: other, delivery: 'waiting_for_run', run: 'queued' }],
    'the withdrawal is its Request\'s and its Run\'s, and no second record of it');
  new CoordinatorConversation(h.root).sweepAttachments();
  assert.equal(await (await h.file(h.id)).text(), 'attachment retained for input recovery');
  assert.equal((await h.post('messages/withdraw', { conversationId: h.conversationId, id: h.id })).status, 200);
  assert.equal((await h.post('messages', h.input)).status, 200);
  const delayed = coordinatorMessageResponseSchema.parse(await (await h.post('messages', { ...h.input, text: 'different' })).json());
  assert.equal(delayed.message.status, 'withdrawn');
  assert.equal(delayed.conversation.turns.some(turn => turn.id === h.id), false);
  assert.equal(control(h.root, store => store.connection.prepare('SELECT body FROM requests WHERE id = ?').get(h.id)!.body), h.input.text);
  await h.restart();
  assert.equal(await h.status(h.id), 'withdrawn');
  const replay = coordinatorMessageResponseSchema.parse(await (await h.post('messages', h.input)).json());
  assert.equal(replay.message.status, 'withdrawn');
  assert.equal(replay.conversation.turns.some(turn => turn.id === h.id), false);
});
test('a withdraw whose write fails leaves the message queued and acknowledges no cancellation', async t => {
  const h = await fixture(t);
  const restore = refuse(h.root, 'withdraw_fault', "BEFORE UPDATE OF delivery_state ON requests WHEN NEW.delivery_state = 'aborted'");
  try {
    assert.ok((await h.post('messages/withdraw', { conversationId: h.conversationId, id: h.id })).status >= 500);
    const read = await h.get(); assert.equal(read.turns.find(turn => turn.id === h.id)?.status, 'queued'); assert.equal(await h.status(h.id), 'queued');
    assert.deepEqual(h.records(), [{ id: h.id, delivery: 'waiting_for_run', run: 'queued' }], 'neither the Request nor its Run moved');
  } finally { restore(); }
  assert.equal((await h.post('messages/withdraw', { conversationId: h.conversationId, id: h.id })).status, 200);
  assert.equal(await h.status(h.id), 'withdrawn');
});
test('cancelled files survive maintenance and restart, can be copied to a new send, and clear removes the old conversation', async t => {
  const h = await fixture(t, true);
  assert.equal((await h.post('messages/withdraw', { conversationId: h.conversationId, id: h.id })).status, 200);
  new CoordinatorConversation(h.root).sweepAttachments();
  const saved = await h.file(h.id);
  assert.equal(saved.status, 200);
  const bytes = await saved.text();
  assert.equal(bytes, 'attachment retained for input recovery');
  const next = crypto.randomUUID();
  assert.equal((await h.upload(next, 'notes.txt', bytes)).status, 200);
  assert.equal((await h.post('messages', { ...h.input, id: next })).status, 200);
  assert.equal((await h.get()).turns.find(turn => turn.id === next)?.status, 'queued');
  assert.equal((await h.post('messages/withdraw', { conversationId: h.conversationId, id: next })).status, 200);
  await h.restart();
  new CoordinatorConversation(h.root).sweepAttachments();
  assert.equal(await (await h.file(h.id)).text(), bytes);
  assert.equal(await (await h.file(next)).text(), bytes);
  for (const id of [h.id, next]) assert.equal(await h.status(id), 'withdrawn');
  assert.equal((await h.post('clear', { conversationId: h.conversationId })).status, 200);
  assert.equal((await h.file(h.id)).status, 404, 'cleared conversation files are no longer readable');
  await eventually(() => !existsSync(h.folder), 'serve sweeps files after the conversation is cleared');
});
test('clear commits its replacement despite an attachment cleanup fault; the stale conversation stays closed and a restart cleans up', async t => {
  t.mock.method(console, 'error', () => {});
  const h = await fixture(t, true), path = join(h.folder, 'attachments', h.id);
  chmodSync(path, 0o500);
  try {
    const cleared = await h.post('clear', { conversationId: h.conversationId });
    assert.equal(cleared.status, 200);
    const next = (coordinatorSnapshotSchema.parse(await cleared.json()).conversation );
    assert.notEqual(next.id, h.conversationId);
    assert.deepEqual(h.records(), [{ id: h.id, delivery: 'aborted', run: 'cancelled' }]);
    assert.equal((await h.post('messages', h.input)).status, 409);
    assert.equal((await h.post('messages/withdraw', { conversationId: h.conversationId, id: h.id })).status, 409);
    await delay(500);
    assert.ok(existsSync(path), 'what cannot be removed stays for a later pass');
    await h.restart(); assert.equal((await h.get()).id, next.id);
  } finally { chmodSync(path, 0o700); }
  await h.restart();
  await eventually(() => !existsSync(h.folder), 'the cleared conversation\'s files are swept');
});
test('clear reply loss and stale same-request retries cannot clear or queue the replacement conversation', async t => {
  const h = await fixture(t);
  const next = (coordinatorSnapshotSchema.parse(await (await h.post('clear', { conversationId: h.conversationId })).json()).conversation );
  assert.notEqual(next.id, h.conversationId);
  for (const [path, input] of [['messages', h.input], ['messages/withdraw', { conversationId: h.conversationId, id: h.id }], ['clear', { conversationId: h.conversationId }]] as const)
    assert.equal((await h.post(path, input)).status, 409);
  assert.equal((await h.get()).id, next.id); assert.deepEqual((await h.get()).turns, []);
});
test('a clear whose write fails keeps the current conversation and all its queued messages', async t => {
  const h = await fixture(t);
  const restore = refuse(h.root, 'clear_fault', 'BEFORE UPDATE OF cleared_at ON coordinator_conversations');
  try {
    assert.ok((await h.post('clear', { conversationId: h.conversationId })).status >= 500);
    const read = await h.get(); assert.equal(read.id, h.conversationId); assert.equal(read.turns.find(turn => turn.id === h.id)?.status, 'queued');
    assert.deepEqual(h.records(), [{ id: h.id, delivery: 'waiting_for_run', run: 'queued' }], 'its withdrawals rolled back with it');
  } finally { restore(); }
});
test('64 queued messages converge to hidden durable cancellations and replay after restart without requeue', async t => {
  const h = await fixture(t), inputs = [h.input, ...Array.from({ length: 63 }, (_, n) => ({ ...h.input, id: crypto.randomUUID(), text: `instruction ${n}` }))];
  for (const input of inputs.slice(1)) assert.equal((await h.post('messages', input)).status, 200);
  assert.equal((await h.get()).turns.length, 64);
  for (const input of inputs) assert.equal((await h.post('messages/withdraw', { conversationId: input.conversationId, id: input.id })).status, 200);
  await h.restart();
  for (const input of inputs) {
    const replay = await h.post('messages', input);
    assert.equal(replay.status, 200);
    assert.equal(coordinatorMessageResponseSchema.parse(await replay.json()).message.status, 'withdrawn');
  }
  assert.deepEqual((await h.get()).turns, []);
  const records = h.records();
  assert.equal(records.length, 64, 'a replay adds no Request');
  assert.ok(records.every(record => record.delivery === 'aborted' && record.run === 'cancelled'));
});
test('an ask whose write fails admits neither its Request nor its Run, and the same ID is accepted afterwards', async t => {
  const h = await fixture(t);
  const input = { ...h.input, id: crypto.randomUUID(), text: 'save must commit before acceptance' };
  const restore = refuse(h.root, 'ask_fault', "BEFORE INSERT ON runs WHEN json_extract(NEW.record, '$.role') = 'coordinator'");
  try {
    assert.ok((await h.post('messages', input)).status >= 500);
    assert.equal((await h.get()).turns.some(turn => turn.id === input.id), false);
    assert.equal(h.records().some(record => record.id === input.id), false, 'the Request rolled back with its Run');
  } finally { restore(); }
  assert.equal((await h.post('messages', input)).status, 200);
  assert.deepEqual(h.records().find(record => record.id === input.id), { id: input.id, delivery: 'waiting_for_run', run: 'queued' });
  assert.equal((await h.post('messages/withdraw', { conversationId: h.conversationId, id: input.id })).status, 200);
});
