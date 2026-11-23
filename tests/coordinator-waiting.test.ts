import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { stringify } from 'yaml';
import { managerScript } from '@alpacawork/backend/test-dist/runs/scheduler.js';
/** The public conversation projection consumes the scheduler's turn-order facts, without starting an agent. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore, laneAhead } from '@alpacawork/runs';
import type { CoordinatorRunRecord } from '@alpacawork/contract/run';
import { CoordinatorConversation } from '@alpacawork/backend/test-dist/coordinator/conversation.js';
import { reserveAttempt, blockedInvocations, queuedInputReservations } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { initializeControlFixture } from './helpers/control-fixture.ts';
// The fixture never starts a process, so the admission supplies the session.
const config = stringify({ agents: { "fake": fixtureAgentSetting('claude') }, coordinatorAiStack: [{ agent: 'fake', values: {} }] });
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'coordinator-waiting-')));
  initializeControlFixture(root); writeFileSync(join(root, 'config.yaml'), config);
  const conversation = new CoordinatorConversation(root), id = conversation.read().id;
  const store = new RunStore(root, { busyTimeoutMs: 1000 });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const ask = () => { const request = randomUUID(); conversation.ask({ conversationId: id, id: request, text: request, attachments: [] }); return request; };
  const run = (request: string, tx?: import("@alpacawork/runs").RunTransaction) => (tx ? tx.coordinatorRuns(id) : store.coordinatorRuns(id)).find(run => run.requestId === request)!;
  const running = (request: string) => store.write(tx => tx.update({ ...run(request, tx), state: 'running', started_at: new Date().toISOString() }));
  return { root, conversation, id, store, ask, run, running, read: () => conversation.read() };
}
test('accepted queued is a starting chat turn; only subsequent queued turns wait, and withdrawing promotes the next', t => {
  const f = fixture(t); assert.equal(f.read().busy, false);
  const first = f.ask(), second = f.ask(), third = f.ask();
  assert.deepEqual(f.read().turns.map(turn => [turn.id, turn.status, turn.waiting]), [[first, 'queued', false], [second, 'queued', true], [third, 'queued', true]]);
  assert.equal(f.read().busy, true);
  f.conversation.withdraw(f.id, first);
  assert.deepEqual(f.read().turns.map(turn => [turn.id, turn.waiting]), [[second, false], [third, true]]);
  f.conversation.withdraw(f.id, third); f.conversation.withdraw(f.id, second);
  assert.equal(f.read().busy, false); assert.deepEqual(f.read().turns, []);
});
test('a running predecessor, including needs_review holding execution, blocks the next; conversation_busy does not', t => {
  const f = fixture(t), first = f.ask(); f.running(first); const next = f.ask();
  assert.equal(f.read().turns.find(turn => turn.id === next)!.waiting, true);
  f.store.write(tx => tx.update({ ...f.run(first, tx), state: 'needs_review', reason: 'manager_lost' }));
  assert.equal(f.read().turns.find(turn => turn.id === next)!.waiting, true);
  f.store.write(tx => tx.update({ ...f.run(first, tx), reason: 'conversation_busy' }));
  assert.equal(f.read().turns.find(turn => turn.id === next)!.waiting, false);
});
test('hidden warm-up uses the same lane order; waiting is withdrawable and warming is not counted as a chat message', t => {
  const f = fixture(t); f.conversation.warm(f.id);
  assert.equal(f.read().busy, true); const message = f.ask();
  assert.equal(f.read().warm, 'preparing'); assert.equal(f.read().turns.length, 1);
  assert.equal(f.read().turns[0]!.waiting, true);
  f.conversation.withdraw(f.id, message); assert.deepEqual(f.read().turns, []);
});
test('the warm-up says how far it has come: none, preparing while queued or running, then ready or failed', t => {
  for (const [state, reason, said] of [['succeeded', null, 'ready'], ['failed', 'exit', 'failed'], ['cancelled', 'stopped', 'failed']] as const) {
    const f = fixture(t); assert.equal(f.read().warm, 'none');
    f.conversation.warm(f.id); assert.equal(f.read().warm, 'preparing');
    const warm = (tx: import('@alpacawork/runs').RunTransaction) => tx.coordinatorRuns(f.id)[0]!;
    f.store.write(tx => tx.update({ ...warm(tx), state: 'running', started_at: new Date().toISOString() }));
    assert.equal(f.read().warm, 'preparing');
    f.store.write(tx => tx.finish({ ...warm(tx), state, reason, ended_at: new Date().toISOString() }, { state: 'present', text: 'ready' }));
    assert.equal(f.read().warm, said); assert.deepEqual(f.read().turns, []);
  }
});
test('a successful predecessor with uncertain input holds the next until its receipt settles, even without running work', t => {
  const f = fixture(t), first = f.ask();
  f.store.write(tx => { const run = f.run(first, tx); reserveAttempt(f.store, tx, run, managerScript, { run_minutes: 5, coordinator_run_minutes: 5, coordinator_command_seconds: 10 }); tx.update({ ...run, state: 'running', started_at: new Date().toISOString() }); });
  const firstRun = f.run(first);
  f.store.write(tx => { tx.finish({ ...f.run(first, tx), state: 'succeeded', ended_at: new Date().toISOString() }, { state: 'present', text: 'Done' }); f.store.connection.prepare("UPDATE run_inputs SET state='uncertain' WHERE instruction_run_no=?").run(Number(firstRun.id.slice(1))); });
  assert.equal(f.read().busy, true, 'a new send predicts the same receipt hold before any successor is admitted');
  const next = f.ask();
  assert.equal(f.read().turns.find(turn => turn.id === next)!.waiting, true);
  f.store.write(() => { f.store.connection.prepare("UPDATE run_inputs SET state='taken' WHERE instruction_run_no=?").run(Number(firstRun.id.slice(1))); });
  assert.equal(f.read().turns.find(turn => turn.id === next)!.waiting, false);
});
test('the shared order helper ignores other lanes, preserves delivery priority and distinguishes a new message from the queued head', t => {
  const f = fixture(t), a = f.ask(), b = f.ask(), first = f.run(a), next = f.run(b), none = new Set<number>();
  assert.equal(laneAhead([first, next], first, none, none), null);
  assert.deepEqual(laneAhead([first, next], next, none, none), { kind: 'turn', run: first.id });
  assert.equal(laneAhead([first], { role: 'coordinator', conversationId: randomUUID() }, none, none), null);
  assert.deepEqual(laneAhead([first, next], first, none, new Set([Number(first.id.slice(1))])), { kind: 'delivery', run: first.id });
  // A live receipt holds the whole lane, even if its Run number is later than the current queued instruction.
  assert.deepEqual(laneAhead([first, next], first, new Set([Number(next.id.slice(1))]), none), { kind: 'delivery', run: next.id });
});

test('send-now is visible while queued, then the unsettled input owns the projection and cancellation boundary', t => {
  const f = fixture(t), first = f.ask();
  f.store.write(tx => { const run = f.run(first, tx); reserveAttempt(f.store, tx, run, managerScript, { run_minutes: 5, coordinator_run_minutes: 5, coordinator_command_seconds: 10 }); tx.update({ ...run, state: 'running', started_at: new Date().toISOString() }); });
  const next = f.ask();
  assert.equal(f.read().turns.find(turn => turn.id === next)!.joinRequested, undefined);
  const requested = f.conversation.sendNow(f.id, next).turns.find(turn => turn.id === next)!;
  assert.equal(requested.status, 'queued'); assert.equal(requested.joinRequested, true);
  f.store.write(tx => f.store.connection.prepare(`INSERT INTO run_inputs(input_id,attempt_id,instruction_run_no,initial,state,content_digest)
    SELECT ?,attempt_id,?,0,'reserved','fixture' FROM run_attempts WHERE run_no=?`).run(randomUUID(), Number(f.run(next, tx).id.slice(1)), Number(f.run(first, tx).id.slice(1))));
  const handing = f.read().turns.find(turn => turn.id === next)!;
  assert.equal(handing.status, 'sending'); assert.equal(handing.joinRequested, undefined);
  assert.throws(() => f.conversation.withdraw(f.id, next), (error: any) => error.reason?.kind === 'message_has_already_been_sent');
});

test('send-now before reservation can be cancelled, and neither send-now nor late ask revives that ID', t => {
  const f = fixture(t), first = f.ask(); f.running(first); const next = f.ask();
  f.conversation.sendNow(f.id, next);
  assert.deepEqual(f.conversation.withdraw(f.id, next).cancelled, [next]);
  assert.throws(() => f.conversation.sendNow(f.id, next), (error: any) => error.reason?.kind === 'message_has_already_left_queue');
  assert.deepEqual(f.conversation.ask({ conversationId: f.id, id: next, text: 'late words', attachments: [] }).cancelled, [next]);
  assert.equal(f.store.connection.prepare('SELECT count(*) AS n FROM runs WHERE request_id=?').get(next)!.n, 1);
});

test('the conversation snapshot retains shared-session holds without reading unrelated unfinished runs', t => {
  const f = fixture(t), message = f.ask(), own = f.run(message), other = randomUUID(), request = randomUUID();
  const shared = { ...own, id: 'R1000' as const, requestId: request, conversationId: other,
    session: { provider: 'fake', id: 'shared-session' } };
  f.store.write(tx => {
    const db = f.store.connection, at = new Date().toISOString();
    db.prepare('INSERT INTO coordinator_conversations(id,started_at,cleared_at) VALUES (?,?,?)').run(other, at, at);
    tx.insertConversationRequest({ id: request, conversationId: other, headRunId: null, mode: 'new', body: 'Other lane', submittedAt: at, deliveryState: 'queued' });
    db.prepare('INSERT INTO runs(id,record,prompt) VALUES (1000,?,?)').run(JSON.stringify(shared), 'Other lane');
    reserveAttempt(f.store, tx, shared, managerScript, { run_minutes: 5, coordinator_run_minutes: 5, coordinator_command_seconds: 10 });
    db.prepare("UPDATE run_inputs SET state='uncertain' WHERE instruction_run_no=1000").run();
    tx.update({ ...own, session: shared.session });
  });
  const scoped = f.store.readForSettle(f.id), global = f.store.readForSettle();
  assert.deepEqual(scoped.map(run => run.id), global.map(run => run.id));
  const blocked = blockedInvocations(f.store, scoped.map(run => run.id));
  assert.deepEqual(laneAhead(scoped, f.run(message), blocked, queuedInputReservations(f.store, scoped.map(run => run.id))), { kind: 'delivery', run: shared.id });
  assert.deepEqual(queuedInputReservations(f.store, scoped.map(run => run.id)), queuedInputReservations(f.store));
  assert.deepEqual(queuedInputReservations(f.store, []), new Set());
  assert.equal(f.read().turns[0]!.waiting, true);
  f.store.write(tx => tx.update({ ...f.run(message, tx), session: null }));
  assert.deepEqual(f.store.readForSettle(f.id).map(run => run.id), [own.id]);
  assert.equal(f.read().turns[0]!.waiting, false);
});
test('a failed message is sent again once: the server marks it, keeps its ID readable, and refuses a second copy', t => {
  const f = fixture(t), first = f.ask();
  const reasons = { failed: 'exit', cancelled: 'stopped', needs_review: 'manager_lost' } as const;
  const fail = (request: string, state: keyof typeof reasons = 'failed') => { f.running(request);
    f.store.write(tx => tx.update({ ...f.run(request, tx), state, reason: reasons[state], ...state === 'needs_review' ? {} : { ended_at: new Date().toISOString() } })); };
  const again = (retryOf: string) => { const request = randomUUID(); f.conversation.ask({ conversationId: f.id, id: request, retryOf, text: first, attachments: [] }); return request; };
  fail(first, 'needs_review');
  const second = again(first);
  assert.deepEqual(f.read().turns.map(turn => [turn.id, turn.sentAgain ?? false]), [[first, true], [second, false]]);
  assert.throws(() => again(first), (error: any) => error.reason?.kind === 'message_already_sent_again');
  // A stopped message is drawn as failed, so it can be sent again too.
  fail(second, 'cancelled');
  const third = again(second);
  assert.deepEqual(f.read().turns.map(turn => [turn.id, turn.status, turn.sentAgain ?? false, turn.seen]), [[first, 'failed', true, false], [second, 'failed', true, true], [third, 'queued', false, false]]);
  assert.equal(f.store.coordinatorRuns(f.id).filter(run => run.state === 'queued').length, 1);
  // One that answers after all, as a Run back from review does, is not hidden.
  f.store.write(tx => tx.finish({ ...f.run(first, tx), state: 'succeeded', reason: null, ended_at: new Date().toISOString() }, { state: 'present', text: 'Late answer' }));
  assert.equal(f.read().turns.find(turn => turn.id === first)!.sentAgain, undefined);
});
