/** Lost-manager orderings with a real manager and an agent that outlives it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setup, until, alive, receipts } from './runs-runtime.fixture.ts';
import { settle, settleTransaction, closeLaunches } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { attemptOf, StopDeliveryOwner } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { recoverExecution } from '@alpacawork/backend/test-dist/runs/recovery.js';
import { reconcileCompletedRunFiles } from '@alpacawork/backend/test-dist/runs/gc.js';
import { requestStop } from '@alpacawork/backend/test-dist/runs/entry.js';
import { digestBytes, platform } from '@alpacawork/core';
import { EventJournal, executionFolder, identityOf } from '@alpacawork/backend/test-dist/runs/execution-files.js';

for (const cause of ['natural', 'stop', 'timeout'] as const) test(`lost manager preserves a late result on ${cause} completion through the Importer`, async t => {
  const h = await setup(t, { run_minutes: 1 }); h.pauseProjection();
  const text = `late reply after manager death (${cause})`;
  const run = h.create('codex', { gate: h.gate('write-result'), output: text,
    ...(cause === 'natural' ? {} : { afterResultGate: h.gate('stay-running') }) });
  await h.tick();
  const pids = await until(() => {
    new RunEventImporter(h.store).pass();
    const current = h.store.get(run.id)!;
    return current.pids.agent && current.pids.manager && receipts(h.root).length && current.pids;
  }, 'actual agent and manager ready');
  process.kill(pids.manager!, 'SIGKILL');
  await until(() => !alive(pids.manager!), 'killed manager gone');
  await settle(h.store);
  assert.equal(h.store.get(run.id)!.reason, 'manager_lost');
  assert.equal(h.store.getText(run.id)!.resultState, 'pending');
  h.release('write-result');
  const result = join(h.store.folder(run.id), 'result.tmp');
  await until(() => existsSync(result) && readFileSync(result, 'utf8') === text, 'orphan writes late result');
  if (cause === 'natural') await until(() => !platform.run.signalGroup(pids.agent!, 0), 'orphan exits naturally');
  else if (cause === 'stop') {
    requestStop(h.root, { run: run.id }); new StopDeliveryOwner(h.store).gate();
  } else h.store.write(tx => tx.update({ ...tx.get(run.id)!, started_at: '2020-01-01T00:00:00.000Z' }));
  const summary = await settle(h.store);
  assert.ok(summary.closed.includes(run.id), 'the recovered completion follows normal cleanup');
  assert.equal(h.store.get(run.id)!.state, cause === 'stop' ? 'cancelled' : 'failed');
  assert.equal(h.store.get(run.id)!.reason, cause === 'natural' ? 'exit' : cause === 'stop' ? 'stopped' : 'timeout');
  assert.equal(h.store.get(run.id)!.exit, null, 'unknown exit status is never invented');
  assert.equal(h.store.getText(run.id)!.result, text);
  assert.equal(platform.run.signalGroup(pids.agent!, 0), false);
  const attempt = attemptOf(h.store, run.id)!;
  assert.ok(h.store.connection.prepare('SELECT completed_digest FROM run_attempts WHERE attempt_id=?').get(attempt.attemptId)!.completed_digest);
  assert.equal(h.store.connection.prepare("SELECT count(*) n FROM run_inputs WHERE attempt_id=? AND state IN ('reserved','attempted','uncertain')").get(attempt.attemptId)!.n, 0);
  assert.equal(reconcileCompletedRunFiles(h.store, h.store.get(run.id)!).state, 'normal');
  assert.equal(existsSync(result), false);
  const before = JSON.stringify(h.store.getText(run.id));
  await recoverExecution(h.store); new RunEventImporter(h.store).pass();
  assert.equal(JSON.stringify(h.store.getText(run.id)), before, 'replay does not change the committed reply');
});

test('recovered completion releases an unsent reserved instruction through the same Importer rule', async t => {
  const h = await setup(t); h.pauseProjection();
  const run = h.create();
  const decision = await settleTransaction(h.store, readAgentsSettings(h.root)); closeLaunches(decision.launches);
  const launch = attemptOf(h.store, run.id)!;
  const next = h.create('plain', { output: 'work after recovered reservation' });
  const input = randomUUID();
  h.store.connection.prepare("INSERT INTO run_inputs(input_id,attempt_id,instruction_run_no,content_digest,state,initial) VALUES(?,?,?,?,'reserved',0)")
    .run(input, launch.attemptId, Number(next.id.slice(1)), digestBytes('reserved instruction'));
  h.store.connection.prepare('UPDATE run_attempts SET started_json=? WHERE attempt_id=?')
    .run(JSON.stringify({ pid: 2147483647, started: 'gone', group: 2147483647, bootId: 'past-boot', scope: null }), launch.attemptId);
  h.store.write(tx => tx.update({ ...tx.get(run.id)!, state: 'needs_review', reason: 'manager_lost', stop_requested: true }));
  await recoverExecution(h.store);
  assert.equal(h.store.connection.prepare('SELECT state FROM run_inputs WHERE input_id=?').get(input)!.state, 'not_sent');
  await h.tick();
  await until(() => { new RunEventImporter(h.store).pass(); return h.store.get(next.id)!.state === 'succeeded'; }, 'previously reserved instruction starts');
});

test('a missing lost-manager folder is visible and does not prevent independent work', async t => {
  const { RunReviewState } = await import('@alpacawork/backend/test-dist/runs/reviews.js');
  const h = await setup(t); h.pauseProjection();
  const run = h.create();
  const decision = await settleTransaction(h.store, readAgentsSettings(h.root)); closeLaunches(decision.launches);
  h.store.write(tx => tx.update({ ...tx.get(run.id)!, state: 'needs_review', reason: 'manager_lost' }));
  rmSync(h.store.folder(run.id), { recursive: true });
  const independent = h.createIndependent('plain', { output: 'unaffected' });
  const reviews = new RunReviewState();
  await settle(h.store, undefined, undefined, reviews);
  assert.equal(h.store.get(run.id)!.state, 'needs_review');
  assert.equal(reviews.issues.filter(issue => issue.path.endsWith(`/${run.id}`)).length, 1);
  await until(() => { new RunEventImporter(h.store).pass(); return h.store.get(independent.id)!.state === 'succeeded'; }, 'independent Run completes');
  await settle(h.store, undefined, undefined, reviews);
  assert.equal(reviews.issues.filter(issue => issue.path.endsWith(`/${run.id}`)).length, 1, 'fault does not accumulate duplicates');
});

test('an unchanged recovered receipt is not new progress, while a delayed taken receipt advances once', async t => {
  const h = await setup(t); h.pauseProjection();
  const run = h.create('plain', {}, { launch: { argv: [process.execPath, '-e', ''], adapter: 'codex', env: [], path: h.path, values: {} } });
  const decision = await settleTransaction(h.store, readAgentsSettings(h.root)); closeLaunches(decision.launches);
  const launch = attemptOf(h.store, run.id)!;
  const journal = new EventJournal(executionFolder(h.root, run.id, launch.attemptId), identityOf(launch));
  journal.append('claimed', { managerPid: process.pid, managerStarted: 'receipt-review', bootId: 'fixture-boot' });
  journal.append('spawn_intent', { initialInputId: launch.initialInputId });
  journal.append('input_attempt', { inputId: launch.initialInputId, instructionRunId: run.id, contentDigest: digestBytes(launch.prompt) });
  new RunEventImporter(h.store).pass();
  h.store.write(tx => tx.update({ ...tx.get(run.id)!, state: 'needs_review', reason: 'manager_lost' }));
  const stdout = join(h.store.folder(run.id), 'stdout.log');
  writeFileSync(stdout, JSON.stringify({ type: 'input.uncertain', id: launch.initialInputId }) + '\n');
  const cursor = () => Number(h.store.connection.prepare('SELECT next_seq FROM run_attempts WHERE attempt_id=?').get(launch.attemptId)!.next_seq);
  await recoverExecution(h.store); const uncertain = cursor();
  await recoverExecution(h.store); await recoverExecution(h.store);
  assert.equal(cursor(), uncertain, 'repeated uncertain output produces no new journal, ack or DB progress');
  appendFileSync(stdout, JSON.stringify({ type: 'input.taken', id: launch.initialInputId }) + '\n');
  await recoverExecution(h.store);
  assert.equal(cursor(), uncertain + 1);
  assert.equal(h.store.connection.prepare('SELECT state FROM run_inputs WHERE input_id=?').get(launch.initialInputId)!.state, 'taken');
  await recoverExecution(h.store); assert.equal(cursor(), uncertain + 1);
});
