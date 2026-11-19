import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ControlStore } from '@alpacawork/db';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FileJournal, fileDigest } from '@alpacawork/backend/test-dist/control/file-journal.js';
import { CoordinatorConversation } from '@alpacawork/backend/test-dist/coordinator/conversation.js';
import { coordinatorFilePath, saveCoordinatorAttachment } from '@alpacawork/backend/test-dist/coordinator/files.js';
import { callerWorkspace } from './coordinator-caller.fixture.ts';

type State = 'pending' | 'needs_review';
type Kind = 'put' | 'delete' | 'move';
const bytes = Buffer.from('saved bytes');
const attachment = (id: string, name: string) => ({ path: `attachments/${id}/${name}`,
  absolutePath: `/api/coordinator/file?requestId=${id}&name=${name}`, size: bytes.length });
function control<T>(root: string, work: (db: DatabaseSync) => T, write = false): T {
  const store = new ControlStore(root, { busyTimeoutMs: 10_000 }, !write);
  try { return write ? store.write(work) : store.read(work); } finally { store.close(); }
}
function interrupted(t: TestContext, kind: Kind, state: State, layout: 'existing' | 'new' | 'collision' = 'existing') {
  const w = callerWorkspace(t), conversation = new CoordinatorConversation(w.root).read().id;
  const requestId = randomUUID(), to = randomUUID(), name = 'own.txt';
  const chosen = layout === 'collision' ? 'own-2.txt' : name;
  if (kind !== 'put' || layout === 'existing') saveCoordinatorAttachment(w.root, conversation, requestId, name, bytes, randomUUID());
  if (layout === 'collision') saveCoordinatorAttachment(w.root, conversation, requestId, name, Buffer.from('different existing bytes'), randomUUID());
  const path = coordinatorFilePath(conversation, requestId, chosen), source = dirname(path);
  const opId = randomUUID(), journal = new FileJournal(w.root);
  const fault = new FileJournal(w.root, phase => { if (phase === 'reserved') throw new Error('injected after reservation'); });
  assert.throws(() => kind === 'put'
    ? fault.putManagedFile({ path, opId, bytes, expectedDigest: layout === 'existing' ? fileDigest(bytes) : null,
      result: attachment(requestId, chosen), fingerprintKey: ['attachment', requestId, name] })
    : kind === 'delete'
      ? fault.deleteManagedFile({ path, opId, digest: fileDigest(bytes), result: { removed: true }, fingerprintKey: ['attachment', requestId, name] })
      : fault.moveManagedFolder({ source, destination: dirname(coordinatorFilePath(conversation, to, name)), opId,
        result: [attachment(to, name)] }), /injected after reservation/);
  if (state === 'needs_review') {
    if (kind === 'put') {
      const stage = control(w.root, db => String(db.prepare('SELECT stage_path FROM file_operations WHERE op_id=?').get(opId)!.stage_path));
      writeFileSync(join(w.root, stage), 'corrupt stage');
    } else rmSync(join(w.root, kind === 'move' ? source : path), { recursive: true });
    assert.equal(journal.recover().needsReview, 1);
  }
  assert.equal(journal.operationGet(opId).state, state);
  // Keep the real reserved/needs_review intent fixed through serve's recovery passes, as in the independent proof.
  t.mock.method(FileJournal.prototype, 'recover', () => ({ published: 0, needsReview: 0 }));
  const snapshot = () => control(w.root, db => ({
    operations: db.prepare('SELECT * FROM file_operations ORDER BY rowid').all(),
    reservations: db.prepare('SELECT * FROM file_path_reservations ORDER BY rowid').all(),
    receipts: db.prepare('SELECT * FROM cli_operations ORDER BY rowid').all(),
  }));
  return { w, conversation, requestId, to, name, chosen, opId, path, snapshot };
}
async function send(origin: string, input: { conversation: string; requestId: string; to: string; name: string; opId: string },
  kind: Kind, changes: Partial<typeof input> & { bytes?: Buffer } = {}) {
  const request = { ...input, ...changes };
  const query = new URLSearchParams({ conversationId: request.conversation, requestId: request.requestId, name: request.name });
  const response = await fetch(new URL(kind === 'move' ? '/api/coordinator/attachments/move' : `/api/coordinator/attachments?${query}`, origin), {
    method: kind === 'delete' ? 'DELETE' : 'POST', headers: { 'X-Alpacawork-Op-Id': request.opId, ...(kind === 'move' ? { 'Content-Type': 'application/json' } : {}) },
    ...(kind === 'delete' ? {} : { body: kind === 'put' ? Uint8Array.from(changes.bytes ?? bytes)
      : JSON.stringify({ conversationId: request.conversation, from: request.requestId, to: request.to }) }),
  });
  return { status: response.status, body: await response.json() };
}
for (const state of ['pending', 'needs_review'] as const) {
  for (const kind of ['put', 'delete', 'move'] as const) {
    const layouts = kind === 'put' ? ['existing', 'new', 'collision'] as const : ['existing'] as const;
    for (const layout of layouts) test(`coordinator attachment own ${kind} ${state} (${layout}) is check before filesystem reads`, async t => {
      const h = interrupted(t, kind, state, layout), before = h.snapshot(), origin = await h.w.start();
      const response = await send(origin, h, kind);
      assert.equal(response.status, 503, JSON.stringify(response.body));
      assert.equal(response.body.error.code, state === 'pending' ? 'publication_pending' : 'publication_needs_review');
      assert.equal(response.body.error.retry, 'check');
      assert.deepEqual(h.snapshot(), before, 'replay neither changes the saved intent nor writes a receipt');
      for (const changes of [{ requestId: randomUUID() }, { name: 'other.txt' }, ...(kind === 'put' ? [{ bytes: Buffer.from('other bytes') }] : []),
        ...(kind === 'move' ? [{ to: randomUUID() }] : [])]) {
        // A move has no name input: only its source/destination bind its identity.
        if (kind === 'move' && 'name' in changes) continue;
        const mismatch = await send(origin, h, kind, changes);
        assert.equal(mismatch.status, 409, JSON.stringify(mismatch.body));
        assert.equal(mismatch.body.error.code, 'idempotency_conflict');
      }
      for (const other of ['put', 'delete', 'move'] as const) if (other !== kind) {
        const mismatch = await send(origin, h, other);
        assert.equal(mismatch.status, 409, JSON.stringify(mismatch.body));
        assert.equal(mismatch.body.error.code, 'idempotency_conflict');
      }
      assert.deepEqual(h.snapshot(), before);
      if (layout === 'existing' && kind !== 'move') {
        const other = await send(origin, h, kind, { opId: randomUUID() });
        assert.equal(other.status, 409);
        assert.equal(other.body.error.code, 'busy');
        assert.equal(other.body.error.retry, 'later');
        assert.deepEqual(h.snapshot(), before, 'another ID cannot take the reservation');
      }
    });
  }
}
for (const state of ['pending', 'needs_review'] as const) test(`coordinator attachment ${state} ID cannot be reused in a new conversation`, async t => {
  const h = interrupted(t, 'put', state);
  const conversation = new CoordinatorConversation(h.w.root).clear(h.conversation).id;
  const origin = await h.w.start();
  const response = await send(origin, h, 'put', { conversation });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'idempotency_conflict');
});

test('coordinator attachment HTTP put/delete/move replay keeps the chosen path and original receipts', async t => {
  const w = callerWorkspace(t), conversation = new CoordinatorConversation(w.root).read().id, origin = await w.start();
  const h = { conversation, requestId: randomUUID(), to: randomUUID(), name: 'own.txt', opId: randomUUID() };
  const first = await send(origin, h, 'put', { bytes: Buffer.from('first bytes') });
  assert.equal(first.status, 200);
  const collisionId = randomUUID(), collision = await send(origin, h, 'put', { opId: collisionId });
  assert.equal(collision.status, 200);
  assert.equal(collision.body.path, `attachments/${h.requestId}/own-2.txt`);
  const journal = new FileJournal(w.root);
  const receipts = () => control(w.root, db => db.prepare('SELECT * FROM cli_operations ORDER BY rowid').all());
  const before = receipts();
  // A published replay must not inspect today's conflicting names or the saved file's bytes.
  writeFileSync(join(w.root, coordinatorFilePath(conversation, h.requestId, 'own-2.txt')), 'changed after success');
  assert.deepEqual(await send(origin, h, 'put', { opId: collisionId }), collision);
  assert.deepEqual(receipts(), before);
  assert.equal((await send(origin, h, 'put', { opId: collisionId, bytes: Buffer.from('other') })).status, 409);
  const moved = await send(origin, h, 'move', { opId: randomUUID() });
  assert.equal(moved.status, 200);
  const moveId = control(w.root, db => String(db.prepare("SELECT op_id FROM file_operations WHERE kind='move'").get()!.op_id));
  assert.deepEqual(await send(origin, h, 'move', { opId: moveId }), moved);
  assert.deepEqual(await send(origin, h, 'put', { opId: collisionId }), collision, 'put replay precedes moved-request refusal');
  const deletion = { ...h, requestId: h.to, name: 'own-2.txt', opId: randomUUID() };
  const removed = await send(origin, deletion, 'delete');
  assert.equal(removed.status, 200);
  const afterDelete = receipts();
  assert.deepEqual(await send(origin, deletion, 'delete'), removed);
  assert.deepEqual(receipts(), afterDelete);
  for (const kind of ['put', 'delete', 'move'] as const) {
    const mismatch = await send(origin, { ...h, opId: collisionId }, kind, kind === 'put' ? { name: 'other.txt' } : {});
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.error.code, 'idempotency_conflict');
  }
  assert.equal(journal.operationGet(collisionId).state, 'committed');
  assert.equal(readFileSync(join(w.root, coordinatorFilePath(conversation, h.to, 'own.txt'))).toString(), 'first bytes');
  const next = new CoordinatorConversation(w.root).clear(conversation).id;
  const differentConversation = await send(origin, h, 'put', { conversation: next, opId: collisionId });
  assert.equal(differentConversation.status, 409);
  assert.equal(differentConversation.body.error.code, 'idempotency_conflict');
});

test('coordinator attachment rejects a non-file operation ID before current-file inspection', async t => {
  const h = interrupted(t, 'put', 'pending');
  const opId = randomUUID();
  control(h.w.root, db => db.prepare('INSERT INTO cli_operations VALUES(?,?,?,?,?,?)')
    .run(opId, 'other.operation', 'other-fingerprint', 200, '{}', new Date().toISOString()), true);
  const origin = await h.w.start();
  for (const kind of ['put', 'delete', 'move'] as const) {
    const response = await send(origin, h, kind, { opId });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'idempotency_conflict');
  }
});
