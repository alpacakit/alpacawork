import { coordinatorRunFor } from './helpers/coordinator-run.ts';
import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { stringify } from 'yaml';
import { managerScript } from '@alpacawork/backend/test-dist/runs/scheduler.js';
/** Cancellation and admission share the requests primary key, without a schema change. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '@alpacawork/runs';
import { CoordinatorConversation } from '@alpacawork/backend/test-dist/coordinator/conversation.js';
import { saveCoordinatorAttachment, coordinatorFilePath } from '@alpacawork/backend/test-dist/coordinator/files.js';
import { reserveAttempt } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { FileJournal } from '@alpacawork/backend/test-dist/control/file-journal.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { initializeControlFixture } from './helpers/control-fixture.ts';
const config = stringify({ agents: { "fake": fixtureAgentSetting('codex') } });
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'coordinator-cancel-')));
  initializeControlFixture(root); writeFileSync(join(root, 'config.yaml'), config);
  const conversation = new CoordinatorConversation(root), cid = conversation.read().id;
  const store = new RunStore(root, { busyTimeoutMs: 1000 }), db = store.connection;
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const ask = (id = randomUUID(), text = 'words') => conversation.ask({ conversationId: cid, id, text, attachments: [] });
  const rows = () => db.prepare('SELECT * FROM requests WHERE conversation_id = ? ORDER BY rowid').all(cid);
  const run = (id: string, tx?: import('@alpacawork/runs').RunTransaction) => coordinatorRunFor(store, id, tx);
  return { root, conversation, cid, store, db, ask, rows, run };
}
const reason = (kind: string) => (error: any) => error.reason?.kind === kind;
test('unreceived withdraw stores one aborted Request, no Run, and projects cancelled without a turn', t => {
  const f = fixture(t), id = randomUUID();
  const view = f.conversation.withdraw(f.cid, id);
  assert.equal(f.conversation.messageStatus(id).status, 'withdrawn'); assert.deepEqual(view.turns, []);
  assert.equal(f.rows().length, 1); assert.equal(f.rows()[0]!.delivery_state, 'aborted');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM runs').get()!.n, 0);
});
test('cancellation wins over late admission', t => {
  const f = fixture(t), id = randomUUID(); f.conversation.withdraw(f.cid, id);
  const before = f.rows(); const next = f.ask(id, 'different words');
  assert.equal(f.conversation.messageStatus(id).status, 'withdrawn'); assert.deepEqual(next.turns, []); assert.deepEqual(f.rows(), before);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM runs').get()!.n, 0);
});
test('duplicate unreceived withdraw is durable and leaves its timestamp and single row unchanged', t => {
  const f = fixture(t), id = randomUUID(); f.conversation.withdraw(f.cid, id); const before = f.rows();
  f.conversation.withdraw(f.cid, id); assert.deepEqual(f.rows(), before);
  assert.equal(new CoordinatorConversation(f.root).messageStatus(id).status, 'withdrawn');
});
test('admission first: queued withdrawal aborts its Run, and changed-payload replay stays cancelled', t => {
  const f = fixture(t), id = randomUUID(); f.ask(id); const run = f.run(id);
  f.conversation.withdraw(f.cid, id); f.ask(id, 'changed');
  assert.equal(f.conversation.messageStatus(id).status, 'withdrawn');
  assert.equal(f.store.runtimeGet(run.id)!.state, 'cancelled');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM runs').get()!.n, 1);
});
test('running first: withdrawal refuses already sent without writing', t => {
  const f = fixture(t), id = randomUUID(); f.ask(id);
  f.store.write(tx => tx.update({ ...f.run(id, tx), state: 'running', started_at: new Date().toISOString() }));
  const rows = f.rows(), run = f.run(id);
  assert.throws(() => f.conversation.withdraw(f.cid, id), reason('message_has_already_been_sent'));
  assert.deepEqual(f.rows(), rows); assert.deepEqual(f.run(id), run);
});
for (const state of ['reserved', 'attempted', 'uncertain']) test(`handover ${state} first: withdrawal refuses without an aborted record`, t => {
  const f = fixture(t), working = randomUUID(), id = randomUUID(); f.ask(working);
  f.store.write(tx => { reserveAttempt(f.store, tx, f.run(working, tx), managerScript, { run_minutes: 5, coordinator_run_minutes: 5, coordinator_command_seconds: 10 }); tx.update({ ...f.run(working, tx), state: 'running', started_at: new Date().toISOString() }); });
  f.ask(id);
  f.store.write(tx => { f.db.prepare(`INSERT INTO run_inputs(input_id, attempt_id, instruction_run_no, initial, state, content_digest)
    SELECT ?, attempt_id, ?, 0, ?, 'fixture-digest' FROM run_attempts WHERE run_no = ?`).run(randomUUID(), Number(f.run(id, tx).id.slice(1)), state, Number(f.run(working, tx).id.slice(1))); });
  const before = f.rows();
  assert.throws(() => f.conversation.withdraw(f.cid, id), reason('message_has_already_been_sent'));
  assert.deepEqual(f.rows(), before);
});
test('other conversation IDs, closed conversations and invalid IDs never write cancellations', t => {
  const f = fixture(t), prior = randomUUID();
  f.ask(prior);
  const before = f.rows();
  for (const id of ['bad', '../escape', '']) { assert.throws(() => f.conversation.withdraw(f.cid, id), reason('invalid_coordinator_request_id')); assert.deepEqual(f.rows(), before); }
  f.conversation.clear(f.cid); const next = f.conversation.read().id;
  const count = f.db.prepare('SELECT count(*) AS n FROM requests').get()!.n;
  assert.throws(() => f.conversation.withdraw(next, prior), reason('coordinator_message_not_conversation'));
  assert.throws(() => f.conversation.withdraw(f.cid, randomUUID()), reason('conversation_has_changed'));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM requests').get()!.n, count);
});
for (const accepted of [false, true]) test(`${accepted ? 'queued' : 'unreceived'} cancelled files remain readable and survive sweep until clear`, t => {
  const f = fixture(t), id = randomUUID(), name = 'note.txt';
  f.conversation.attachments(f.cid, [id], cid => saveCoordinatorAttachment(f.root, cid, id, name, Buffer.from('keep'), randomUUID()));
  if (accepted) {
    f.ask(id);
    assert.throws(()=>f.conversation.attachments(f.cid,[id],()=>assert.fail('sent files are owned')),reason('sent_attachments_cannot_changed'));
  }
  f.conversation.withdraw(f.cid, id); f.conversation.sweepAttachments();
  assert.equal(f.conversation.readAttachment(id, cid => new FileJournal(f.root).readManagedFile(coordinatorFilePath(cid, id, name))).toString(), 'keep');
  assert.equal(f.conversation.attachments(f.cid,[id],()=> 'draft-owned'),'draft-owned','withdrawal returns attachment ownership to the draft');
  assert.equal(f.conversation.attachments(f.cid,[randomUUID(),id],()=> 'movable'),'movable');
  f.conversation.clear(f.cid); f.conversation.sweepAttachments();
  assert.equal(existsSync(join(f.root, coordinatorFilePath(f.cid, id, name))), false);
});
test('mixed ask/withdraw/clear keeps every conversation Request backed by a Run or aborted without one', t => {
  const f = fixture(t); f.ask(); f.conversation.withdraw(f.cid, randomUUID()); f.conversation.withdraw(f.cid, randomUUID()); f.conversation.clear(f.cid);
  const invalid = f.db.prepare(`SELECT q.id FROM requests q LEFT JOIN runs r ON r.request_id=q.id
    WHERE q.conversation_id IS NOT NULL AND r.id IS NULL AND q.delivery_state <> 'aborted'`).all();
  assert.deepEqual(invalid, []);
});
test('HTTP lost cancellation answer is recovered by GET and duplicate withdraw, and a delayed POST never launches', async t => {
  const f = fixture(t), server = await startServer(f.root);
  try {
  const post = (path: string, body: unknown) => fetch(new URL(`/api/coordinator/${path}`, server.url), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Alpacawork-Op-Id':randomUUID() }, body: JSON.stringify(body) });
  const id = randomUUID(), input = { conversationId: f.cid, id };
  const upload = await fetch(new URL(`/api/coordinator/attachments?conversationId=${f.cid}&requestId=${id}&name=note.txt`, server.url), { method: 'POST', headers: { 'X-Alpacawork-Op-Id': randomUUID() }, body: 'keep' }); assert.equal(upload.status, 200);
  const lost = await post('messages/withdraw', input); await lost.arrayBuffer(); assert.equal(lost.status, 200);
  assert.deepEqual(await (await fetch(new URL(`/api/coordinator/messages/${id}/status`, server.url))).json(), { id, status: 'withdrawn' });
  assert.equal((await post('messages/withdraw', input)).status, 200);
  const late = await post('messages', { ...input, text: 'delayed', attachments: [] });
  assert.equal(late.status, 200); assert.deepEqual((await late.json() as any).conversation.turns, []);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM runs').get()!.n, 0);
  f.conversation.sweepAttachments();
  const file = await fetch(new URL(`/api/coordinator/file?requestId=${id}&name=note.txt`, server.url)); assert.equal(file.status, 200); assert.equal(await file.text(), 'keep');
  const recovered=randomUUID();
  const moved=await post('attachments/move',{conversationId:f.cid,from:id,to:recovered});await moved.arrayBuffer();assert.equal(moved.status,200);
  const recoveredFile=await fetch(new URL(`/api/coordinator/file?requestId=${recovered}&name=note.txt`,server.url));
  assert.equal(recoveredFile.status,200);assert.equal(await recoveredFile.text(),'keep','recovery retains the stored attachment');
  const returned=await post('attachments/move',{conversationId:f.cid,from:recovered,to:id});await returned.arrayBuffer();assert.equal(returned.status,200);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM runs').get()!.n,0,'moving draft files never launches a turn');
  assert.equal((await post('messages/withdraw', { conversationId: f.cid, id: 'invalid' })).status, 400);
  } finally { await server.close(); }
});
