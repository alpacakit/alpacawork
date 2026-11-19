/** The protocol's invariants are tested at durable bytes and the actual importer boundary. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digestBytes, publishImmutable, readImmutable, strictJson } from '@alpacawork/core';
import { ServeLifecycle } from '@alpacawork/backend/test-dist/receiver/lifecycle.js';
import { setup } from './runs-runtime.fixture.ts';
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { attemptOf, enqueueCommand, publishCommands } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { EventJournal, executionFolder, identityOf } from '@alpacawork/backend/test-dist/runs/execution-files.js';
import { settle, settleTransaction, closeLaunches } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';

test('immutable publication is durable, bounded and no-overwrite; invalid JSON fails', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'protocol-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, 'messages');
  publishImmutable(folder, 'one.json', '{"x":1}'); publishImmutable(folder, 'one.json', '{"x":1}');
  assert.equal(readImmutable(folder, 'one.json', 100).toString(), '{"x":1}');
  assert.throws(() => publishImmutable(folder, 'one.json', '{"x":2}'), /conflict/);
  assert.throws(() => readImmutable(folder, 'one.json', 2), /Oversized/);
  assert.throws(() => strictJson(Buffer.from('{"x":1,"\\u0078":2}')), /Duplicate/);
  assert.throws(() => strictJson(Buffer.from([0xff])), /encoded/);

});

test('immutable publication follows ordinary directory aliases and preserves conflicts', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'protocol-path-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const actual = join(root, 'actual'), alias = join(root, 'alias');
  mkdirSync(actual, { mode: 0o700 }); symlinkSync(actual, alias, 'dir');
  const folder = join(alias, 'messages');
  publishImmutable(folder, 'one.json', '{}');
  assert.equal(readImmutable(join(actual, 'messages'), 'one.json', 100).toString(), '{}');
  assert.equal(readImmutable(folder, 'one.json', 100).toString(), '{}');
  assert.throws(() => publishImmutable(join(actual, 'messages'), 'one.json', '{"changed":true}'), /conflict/);
});

test('quiesce closes admission immediately, waits in-flight writes and publishes stops before issuing a token', async () => {
  let finish!: () => void, published = false;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const owner = new ServeLifecycle('/test', 'generation', () => pending, () => { published = true; });
  let drained = false; const result = owner.quiesce().then(token => { drained = true; return token; });
  assert.throws(() => owner.admit(), /not admitted/);
  await Promise.resolve(); assert.equal(drained, false); assert.equal(published, false);
  finish(); const token = await result;
  assert.equal(published, true); assert.equal(token.state, 'drained'); assert.equal(owner.state, 'drained');
  assert.deepEqual(await owner.quiesce(), token);
});

test('failed stop publication never grants a drained token and can be repaired without reopening admission', async () => {
  let fail = true;
  const owner = new ServeLifecycle('/test', 'g', async () => {}, () => { if (fail) throw new Error('disk fault'); });
  await assert.rejects(owner.quiesce(), /disk fault/);
  assert.equal(owner.state, 'quiescing'); assert.throws(() => owner.admit());
  fail = false; assert.equal((await owner.quiesce()).state, 'drained');
});

test('import cursor and input receipt commit together, cancellation stays cancelled, replay is harmless and a later taken resolves uncertainty', async t => {
  const h = await setup(t), run = h.create('plain', { gate: h.gate('unused') });
  const decision = await settleTransaction(h.store, readAgentsSettings(h.root)); closeLaunches(decision.launches);
  const launch = attemptOf(h.store, run.id)!;
  const folder = executionFolder(h.root, run.id, launch.attemptId), journal = new EventJournal(folder, identityOf(launch));
  journal.append('claimed', { managerPid: process.pid, managerStarted: 'test', bootId: 'test' });
  journal.append('spawn_intent', { initialInputId: launch.initialInputId });
  journal.append('input_attempt', { inputId: launch.initialInputId, instructionRunId: run.id, contentDigest: h.store.connection.prepare('SELECT content_digest FROM run_inputs WHERE input_id=?').get(launch.initialInputId)!.content_digest as string });
  journal.append('input_uncertain', { inputId: launch.initialInputId, receipt: { type: 'disconnect' } });
  new RunEventImporter(h.store).pass();
  assert.equal(h.store.connection.prepare('SELECT state FROM run_inputs WHERE input_id=?').get(launch.initialInputId)!.state, 'uncertain');
  // An old verified prefix is no longer an input to each pass; the last committed event still anchors the tail.
  rmSync(join(folder, 'events', '000000000001.json'));
  journal.append('input_taken', { inputId: launch.initialInputId, receipt: { type: 'provider_started', id: launch.initialInputId } });
  new RunEventImporter(h.store).pass(); new RunEventImporter(h.store).pass();
  assert.equal(h.store.connection.prepare('SELECT state FROM run_inputs WHERE input_id=?').get(launch.initialInputId)!.state, 'taken');
  const cursor = h.store.connection.prepare('SELECT next_seq,last_digest FROM run_attempts WHERE attempt_id=?').get(launch.attemptId)!;
  assert.equal(cursor.next_seq, 6);
  assert.ok(readFileSync(join(folder, 'acks', `5-${cursor.last_digest}.json`)));
  // The verified prefix is owned by the cursor; its boundary must still match before a new tail is admitted.
  writeFileSync(join(folder, 'events', '000000000005.json'), '{broken');
  new RunEventImporter(h.store).pass();
  const held = h.store.connection.prepare('SELECT diagnostic,next_seq FROM run_attempts WHERE attempt_id=?').get(launch.attemptId)!;
  assert.equal(held.next_seq, 6); assert.match(String(held.diagnostic), /execution_fault/);
});

test('a manager that provably never spawned releases only its untransferred initial input', async t => {
  const h=await setup(t),run=h.create();
  const {launch}=await import('@alpacawork/backend/test-dist/runs/scheduler.js');
  const {inspectExecution}=await import('@alpacawork/backend/test-dist/runs/execution-control.js');
  const decision=await settleTransaction(h.store,readAgentsSettings(h.root));
  await launch(h.store,decision,{script:join(h.root,'absent-manager.js')});
  const input=h.store.connection.prepare('SELECT state,receipt_json FROM run_inputs WHERE instruction_run_no=?').get(Number(run.id.slice(1)))!;
  assert.equal(h.store.get(run.id)!.state,'failed');assert.equal(input.state,'not_sent');assert.equal(JSON.parse(String(input.receipt_json)).evidence,'manager_spawn_failed_before_transfer');assert.deepEqual(inspectExecution(h.store).contractUsers,[]);
});


test('outbox publishes once and a committed completion with an unpublished ack recovers after restart', async t => {
  const h = await setup(t), run = h.create(); h.pauseProjection();
  const decision = await settleTransaction(h.store, readAgentsSettings(h.root)); closeLaunches(decision.launches);
  const launch = attemptOf(h.store, run.id)!, db = h.store.connection;
  const saved = JSON.parse(String(db.prepare('SELECT launch_json FROM run_attempts WHERE run_no=?').get(Number(run.id.slice(1)))!.launch_json));
  assert.equal(Object.hasOwn(saved, 'prompt'), false, 'the prompt has one durable DB source');
  assert.equal(attemptOf(h.store, run.id)!.prompt, launch.prompt);
  h.store.write(() => enqueueCommand(h.store, launch, { type: 'stop' }));
  publishCommands(h.store);
  // Publication of an already sent command would fail against these deliberately unavailable bytes.
  const folder = executionFolder(h.root, run.id, launch.attemptId);
  rmSync(join(folder, 'commands'), { recursive: true });
  writeFileSync(join(folder, 'commands'), 'unavailable');
  publishCommands(h.store);
  assert.equal(db.prepare('SELECT published FROM run_commands WHERE attempt_id=?').get(launch.attemptId)!.published, 1);
  const journal = new EventJournal(folder, identityOf(launch));
  journal.append('claimed', { managerPid: process.pid, managerStarted: 'test', bootId: 'test' });
  journal.append('completed', { outcome: { state: 'failed', reason: 'launch' }, session: null, measuredUsage: null,
    exit: { code: 1, signal: null }, result: { state: 'missing', digest: null, size: 0 } });
  writeFileSync(join(folder, 'acks'), 'disk unavailable');
  new RunEventImporter(h.store).pass();
  const pending = db.prepare('SELECT next_seq,acked_seq,completed_digest,diagnostic FROM run_attempts WHERE attempt_id=?').get(launch.attemptId)!;
  assert.equal(pending.next_seq, 3); assert.equal(pending.acked_seq, 0); assert.ok(pending.completed_digest); assert.ok(pending.diagnostic);
  rmSync(join(folder, 'acks'));
  const resumed = new RunEventImporter(h.store);
  assert.deepEqual(resumed.pass(), [run.id], 'ack recovery also revisits completed exchange-file cleanup');
  const done = db.prepare('SELECT acked_seq,diagnostic FROM run_attempts WHERE attempt_id=?').get(launch.attemptId)!;
  assert.equal(done.acked_seq, 2); assert.equal(done.diagnostic, null);
  assert.ok(readFileSync(join(folder, 'acks', `2-${pending.completed_digest}.json`)));
  // A terminal acknowledged attempt is outside the next incremental pass.
  rmSync(join(folder, 'events'), { recursive: true });
  assert.deepEqual(resumed.pass(), []);
  assert.equal(db.prepare('SELECT diagnostic FROM run_attempts WHERE attempt_id=?').get(launch.attemptId)!.diagnostic, null);
});


for (const coordinator of [false, true]) test(`a completion published after import wins over manager loss (${coordinator ? 'coordinator' : 'task'})`, async t => {
  const h = await setup(t); h.pauseProjection();
  const run = coordinator ? h.createCoordinator() : h.create();
  const decision = await settleTransaction(h.store, readAgentsSettings(h.root));
  t.after(() => closeLaunches(decision.launches));
  const launch = attemptOf(h.store, run.id)!;
  const folder = executionFolder(h.root, run.id, launch.attemptId);
  const journal = new EventJournal(folder, identityOf(launch));
  journal.append('claimed', { managerPid: process.pid, managerStarted: 'test', bootId: 'test' });
  journal.append('spawn_intent', { initialInputId: launch.initialInputId });
  journal.append('input_attempt', { inputId: launch.initialInputId, instructionRunId: run.id, contentDigest: digestBytes(launch.prompt) });
  journal.append('input_taken', { inputId: launch.initialInputId, receipt: { evidence: 'invocation_completed' } });
  new RunEventImporter(h.store).pass();
  const original = RunEventImporter.prototype.pass;
  let published = false;
  t.mock.method(RunEventImporter.prototype, 'pass', function(this: RunEventImporter, ...args: Parameters<RunEventImporter['pass']>) {
    const imported = Reflect.apply(original, this, args);
    if (!published) {
      published = true;
      // The manager publishes a valid end and exits in the exact gap after the first import's snapshot.
      const bytes = Buffer.from('reply from the completed invocation');
      const digest = digestBytes(bytes);
      publishImmutable(join(folder, 'results'), `${digest}.bin`, bytes);
      journal.append('completed', { outcome: { state: 'succeeded', reason: null },
        session: launch.invocation.session?.id ?? null, measuredUsage: null, exit: { code: 0, signal: null },
        result: { state: 'present', digest, size: bytes.length } });
      closeLaunches(decision.launches);
    }
    return imported;
  });
  const result = await settle(h.store);
  assert.equal(published, true);
  assert.equal(h.store.runtimeGet(run.id)!.state, 'succeeded');
  assert.equal(h.store.getText(run.id)!.result, 'reply from the completed invocation');
  assert.deepEqual(result.lost, []);
  assert.ok(result.closed.includes(run.id));
});

test('unmanaged journal preflight releases its exclusion on rollback and still detects a real incomplete end', async t => {
  const h = await setup(t); h.pauseProjection();
  const run = h.create();
  const reserved = await settleTransaction(h.store, readAgentsSettings(h.root));
  closeLaunches(reserved.launches);
  const launch = attemptOf(h.store, run.id)!;
  const journal = new EventJournal(executionFolder(h.root, run.id, launch.attemptId), identityOf(launch));
  journal.append('claimed', { managerPid: process.pid, managerStarted: 'test', bootId: 'test' });
  await assert.rejects(settleTransaction(h.store, readAgentsSettings(h.root), () => { throw new Error('decision rollback'); }), /decision rollback/);
  const { constants, openSync } = await import('node:fs');
  const { tryLock } = await import('@alpacawork/core');
  const fd = openSync(join(h.store.folder(run.id), 'manager.lock'), constants.O_RDWR);
  try { assert.equal(tryLock(fd), true, 'rollback releases the stable journal lock'); }
  finally { closeSync(fd); }
  const lost = await settleTransaction(h.store, readAgentsSettings(h.root));
  try {
    assert.deepEqual(lost.summary.lost, [run.id]);
    assert.equal(h.store.runtimeGet(run.id)!.reason, 'manager_lost');
    assert.equal(h.store.getText(run.id)!.result, null, 'absence never proves successful completion');
  } finally { closeLaunches(lost.launches); }
});
