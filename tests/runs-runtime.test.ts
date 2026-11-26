import { fixtureAgentSetting } from './helpers/agent-stub.ts';
/**
 * Manager admission, sessions, output, environment and timeout policy, and how the execution layer runs the screen's
 * coordinator: its Runs beside the Task Runs, their reservation, what they take in, and what a recovery joins.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parse, stringify } from 'yaml';
import { bootIdentity, digestBytes, platform, tryLock } from '@alpacawork/core';
import { isUnfinished, usesSlot } from '@alpacawork/runs';
import { DELIVERY_STATE } from '@alpacawork/contract/control';
import { runNumber, type CoordinatorRunRecord } from '@alpacawork/contract/run';
import type { RunEvent } from '@alpacawork/contract/run-protocol';
import { coordinatorLaunchSnapshot, launchSnapshot, readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { agentEnvironment } from '@alpacawork/backend/test-dist/runs/env.js';
import { isProcessUnit, processUnit } from '@alpacawork/backend/test-dist/runs/launch-agent.js';
import { closeLaunches, launch, settleTransaction } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { openRunFile } from '@alpacawork/backend/test-dist/runs/files.js';
import { manageRun } from '@alpacawork/backend/test-dist/runs/manager.js';
import { readRunActivity } from '@alpacawork/backend/test-dist/runs/activity.js';
import { attemptOf, blockedInvocations, coordinatorCwd, inspectExecution, planInputs,
  resolveUncertainInputs } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { EventJournal, executionFolder, identityOf, names } from '@alpacawork/backend/test-dist/runs/execution-files.js';
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { recoverExecution } from '@alpacawork/backend/test-dist/runs/recovery.js';
import { reconcileCompletedRunFiles } from '@alpacawork/backend/test-dist/runs/gc.js';
import { deliveredMessages, dialoguesOf } from '@alpacawork/backend/test-dist/coordinator/messages.js';
import { readControlTree } from './helpers/control-tree.ts';
import { issueRunCredential } from '@alpacawork/backend/test-dist/control/credentials.js';
import { alive, fake, now, receipts, setup, until } from './runs-runtime.fixture.ts';

test('(c) codex conversation_busy requires review and keeps its parent waiting', async t => {
  const h = await setup(t), parent = h.create('claude'); h.finish(parent);
  const original = h.create('codex', {}, { session: { provider: 'codex', id: 'busy-thread' } }); h.finish(original);
  const child = h.create('codex', { busy: true }, { resumes: original.id, session: original.session, caller: { run: parent.id } });
  await h.tick(); const review = await h.waitState(child, 'needs_review'); await h.tick();
  assert.equal(review.reason, 'conversation_busy'); assert.equal(review.exit!.code, 1);
  assert.equal(h.continuations(parent).length, 0);
});

test('(e) manager keeps the snapshotted deadline when config becomes invalid after reservation', async t => {
  const h = await setup(t), run = h.create('plain', { gate: h.gate('finish') });
  await h.tick(); await h.ready(run);
  writeFileSync(join(h.root, 'config.yaml'), 'agents: [broken');
  h.release('finish');
  assert.equal((await h.waitState(run, 'succeeded')).state, 'succeeded');
});

test('(f) fractional run_minutes expires and removes the whole group', async t => {
  const h = await setup(t, { run_minutes: 0.02 }), clock = h.clock(), run = h.create('plain', { group: true });
  await h.tick(); const agent = await h.ready(run);
  await until(() => receipts(h.root).length === 3, 'timeout group ready');
  await clock.advanceTo(1199);
  // The decision precedes the final DB write; observe it before asynchronous cleanup.
  assert.doesNotMatch(readFileSync(join(h.store.folder(run.id), 'manager.log'), 'utf8'),
    /Terminating agent processes/, 'fractional deadline has not yet expired');
  await clock.advanceTo(1200);
  const ended = await h.waitState(run, 'failed'); assert.equal(ended.reason, 'timeout');
  await until(() => !alive(agent.pid, true) && receipts(h.root).every(r => !alive(r.pid)), 'timeout group gone');
});

test('(g) without limits in config.yaml a run has no time limit', async t => {
  const h = await setup(t);
  const config = parse(readFileSync(join(h.root, 'config.yaml'), 'utf8')) as { limits?: unknown };
  delete config.limits;
  writeFileSync(join(h.root, 'config.yaml'), stringify(config));
  const clock = h.clock(), run = h.create('plain', { gate: h.gate('finish') });
  await h.tick(); await h.ready(run);
  // With no limit the manager never reads the clock, so advanceTo would wait for an answer that never comes:
  // set it a day on and let two of its one-second checks pass.
  clock.set(24 * 60 * 60_000); await delay(2500);
  assert.doesNotMatch(readFileSync(join(h.store.folder(run.id), 'manager.log'), 'utf8'),
    /Terminating agent processes/, 'a day passes without a deadline');
  assert.equal(h.store.get(run.id)!.state, 'running');
  h.release('finish');
  const ended = await h.waitState(run, 'succeeded'); assert.equal(ended.reason, null);
});

test('(h) nonexistent agent executable becomes failed(launch)', async t => {
  const h = await setup(t);
  const run = h.create('missing'); await h.tick();
  const failed = await h.waitState(run, 'failed'); assert.equal(failed.reason, 'launch');
  assert.match(readFileSync(join(h.store.folder(run.id), 'manager.log'), 'utf8'), /Invocation launch failed/);
});
test('(h) missing manager entry becomes failed(launch) with one bounded recovery pass', async t => {
  const h = await setup(t, { parallel: 1 });
  const runs = [h.create(), h.create(), h.create()];
  const decision = await settleTransaction(h.store, readAgentsSettings(h.root));
  const summary = await launch(h.store, decision, { script: join(h.root, 'missing-manager.js') });
  assert.deepEqual(summary.failed, [runs[0].id, runs[1].id]);
  for (const run of runs.slice(0, 2)) { assert.equal(h.store.get(run.id)!.state, 'failed'); assert.equal(h.store.get(run.id)!.reason, 'launch'); }
  assert.equal(h.store.get(runs[2].id)!.state, 'queued');
  const fd = openRunFile(h.store.folder(runs[0].id), 'manager.lock', constants.O_RDWR);
  try { assert.equal(tryLock(fd), true); } finally { closeSync(fd); }
});

test('(i) queued Requests respect parallel slots and serialize one conversation', async t => {
  const h = await setup(t, { parallel: 2 });
  const old = h.create('plain', {}, { session: { provider: null, id: 'same' } }); h.finish(old);
  const regular = h.create('plain', { gate: h.gate('regular') },
    { role: 'worker', placementId: h.memberPlacementId });
  const same = h.create('plain', { session: old.session!.id, gate: h.gate('same') }, { session: old.session });
  const secondSame = h.create('plain', { session: old.session!.id, gate: h.gate('second') }, { session: old.session });
  const summary = await h.tick(); assert.deepEqual(summary.launched, [regular.id, same.id]);
  await Promise.all([h.ready(regular), h.ready(same)]);
  assert.equal(h.store.read().filter(usesSlot).length, 2); assert.equal(h.store.get(secondSame.id)!.state, 'queued');
  h.release('regular'); await h.waitState(regular, 'succeeded'); await h.tick();
  assert.equal(h.store.get(secondSame.id)!.state, 'queued');
  h.release('same'); await h.waitState(same, 'succeeded'); await h.ready(secondSame);
  assert.equal(h.store.read().filter(usesSlot).length, 1);
  h.release('second'); await h.waitState(secondSame, 'succeeded');
});

test('(j) codex first stdout line records the session before agent exit', async t => {
  const h = await setup(t), run = h.create('codex', { session: 'captured-running', gate: h.gate('finish') });
  await h.tick(); await h.ready(run);
  const current = await until(() => { const r = h.store.get(run.id)!; return r.session && r; }, 'live codex session');
  assert.equal(current.state, 'running'); assert.deepEqual(current.session, { provider: 'codex', id: 'captured-running' });
  h.release('finish'); await h.waitState(run, 'succeeded');
});

test('fake Claude and Codex stdout update running activity without hook observations', async t => {
  const h = await setup(t);
  const claude = h.create('claude', { activity: true, gate: h.gate('claude-output'), output: 'done' });
  const codex = h.create('codex', { activity: true, gate: h.gate('codex-output'), output: 'done' },
    { placementId: h.memberPlacementId, role: 'worker' });
  await h.tick();
  await Promise.all([h.ready(claude), h.ready(codex)]);
  const claudeActivity = await until(() => {
    const value = readRunActivity(h.store.folder(claude.id));
    return value?.kind === 'tool_start' ? value : null;
  }, 'Claude tool activity');
  const codexActivity = await until(() => {
    const value = readRunActivity(h.store.folder(codex.id));
    return value?.kind === 'tool_start' ? value : null;
  }, 'Codex tool activity');
  assert.equal(claudeActivity.toolName, 'Bash');
  assert.equal(codexActivity.toolName, 'command_execution');
  for (const activity of [claudeActivity, codexActivity]) assert.equal(activity.steps[0]?.state, 'running');
  const tree = await readControlTree(h.root);
  const owner = tree.placements.find(item => item.id === h.ownerPlacementId)!.runtime;
  const member = tree.placements.find(item => item.id === h.memberPlacementId)!.runtime;
  assert.deepEqual([owner.displayState, owner.activityKind, owner.toolName], ['running', 'tool_start', 'Bash']);
  assert.deepEqual([member.displayState, member.activityKind, member.toolName], ['running', 'tool_start', 'command_execution']);
  assert.ok(owner.lastOutputAt && member.lastOutputAt);
  h.release('claude-output'); h.release('codex-output');
  await Promise.all([h.waitState(claude, 'succeeded'), h.waitState(codex, 'succeeded')]);
  assert.equal(h.store.getText(claude.id)?.result, 'done');
});

test('(k) adapter results, literal output, session mismatch, and missing codex result', async t => {
  const h = await setup(t, { parallel: 8 });
  const claude = h.createIndependent('claude', { output: 'Claude の返答\n次の行' });
  const plain = h.createIndependent('plain', { output: '-plain {session} $(echo untouched)' });
  const mismatch = h.createIndependent('claude', { mismatch: true });
  const missing = h.createIndependent('codex', { noResult: true });
  const own = h.createIndependent('own', { output: 'agent wrote this' });
  const noOwn = h.createIndependent('own', { noResult: true });
  const large = h.createIndependent('plain', { bytes: 1024 * 1024 + 100 });
  const corrupt = h.createIndependent('own', { invalidUtf8: true });
  await h.tick();
  for (const r of [claude, plain, own]) await h.waitState(r, 'succeeded');
  for (const r of [mismatch, missing, noOwn, large, corrupt]) assert.equal((await h.waitState(r, 'failed')).reason, 'output');
  assert.equal(h.store.getText(claude.id)?.result, 'Claude の返答\n次の行');
  assert.equal(h.store.getText(plain.id)?.result, '-plain {session} $(echo untouched)');
  assert.equal(h.store.getText(own.id)?.result, 'agent wrote this');
  assert.equal(h.store.getText(noOwn.id)?.resultState, 'missing');
  assert.equal(h.store.getText(large.id)?.resultState, 'too_large');
  assert.equal(h.store.getText(corrupt.id)?.resultState, 'unreadable');
  for (const r of [claude, plain, own, noOwn]) {
    await h.waitExchangeCleanup(r);
    assert.equal(existsSync(join(h.store.folder(r.id), 'result.tmp')), false);
  }
  await h.waitExchangeCleanup(large);
  assert.equal(existsSync(join(h.store.folder(large.id), 'result.tmp')), true);
  await h.waitExchangeCleanup(corrupt);
  assert.equal(existsSync(join(h.store.folder(corrupt.id), 'result.tmp')), true);
});

function assertEnvironment(actual: Record<string, string>, expected: Record<string, string>) {
  // A clean Node 24 process on Darwin adds this itself (even with env={PATH: ...}).
  // It is not passed to spawn; assert every other variable exactly.
  if (process.platform === 'darwin') {
    assert.match(actual.__CF_USER_TEXT_ENCODING, /^0x[0-9A-Fa-f]+:0x[0-9A-Fa-f]+:0x[0-9A-Fa-f]+$/);
    delete actual.__CF_USER_TEXT_ENCODING;
  }
  assert.deepEqual(actual, expected);
}

test('(l) manager and agent inherit only allowlisted environment and agent uses snapshot PATH', async t => {
  const h = await setup(t), names = ['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'CODEX_THREAD_ID', 'UNRELATED_B2_TEST', 'LC_B2_TEST', '__CF_USER_TEXT_ENCODING', 'ALPACAWORK_UNIT'];
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = 'test-host-value';
    const run = h.create('plain', { environment: true }, { launch: { adapter: 'codex', env: [],
      argv: [basename(process.execPath), fake, '--format', 'codex', '--root', h.root, '--result={result}'],
      path: h.path, values: {} } });
    const expected = agentEnvironment(process.env, h.path, undefined, run.launch.env);
    assert.equal(expected.ALPACAWORK_UNIT, undefined, 'a host unit identity is never inherited');
    const script = join(h.root, 'fake-manager-env.mjs');
    writeFileSync(script, `import {readFileSync, writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(join(h.root, 'manager-env.json'))}, JSON.stringify({ env: process.env, scope: process.platform === 'linux' ? readFileSync('/proc/self/cgroup', 'utf8') : null }));\nawait import(${JSON.stringify(new URL('../apps/backend/dist/run-manager.js', import.meta.url).href)});\n`);
    await launch(h.store, await settleTransaction(h.store, readAgentsSettings(h.root)), { script });
    await h.waitState(run, 'succeeded');
    // The agent alone receives its Run identity and scoped writer credential.
    const env = JSON.parse(h.store.getText(run.id)!.result!);
    assertEnvironment(env, { ...expected, ALPACAWORK_WORKSPACE: h.root,
      ALPACAWORK_RUN: run.id, ALPACAWORK_RUN_TOKEN: issueRunCredential(h.root, run.id) });
    const manager: { env: Record<string, string>; scope: string | null } = JSON.parse(readFileSync(join(h.root, 'manager-env.json'), 'utf8'));
    // Linux adds a fresh unit identity only when the manager starts in its own scope. Derive it from the actual
    // cgroup, not from the environment under test; a host identity must reach neither the manager nor its agent.
    const unit = /^0::.*\/([^/\n]+)\.scope$/m.exec(manager.scope ?? '')?.[1];
    const ownUnit = unit && isProcessUnit(h.root, run.id, unit) ? { ALPACAWORK_UNIT: unit } : {};
    assertEnvironment(manager.env, { ...agentEnvironment(process.env, process.env.PATH ?? '', undefined, []), ...ownUnit });
  } finally { for (const name of names) if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; }
});

type Runtime = Awaited<ReturnType<typeof setup>>;
/** A coordinator Run as the execution layer reads it now. */
function coordinatorRun(h: Runtime, id: string): CoordinatorRunRecord {
  const run = h.store.runtimeGet(id);
  if (run?.role !== 'coordinator') throw new Error(`${id} is not a coordinator Run`);
  return run;
}
/**
 * The next message of `previous`'s conversation, which goes on from it in its session as the screen's conversation
 * queues one: `body` is what the person said, and the agent is given it as it is.
 */
function continueAfter(h: Runtime, previous: CoordinatorRunRecord, body: string): CoordinatorRunRecord {
  const settings = readAgentsSettings(h.root); assert.equal(settings.ok, true);
  if (!settings.ok) throw settings.error;
  const latest = coordinatorRun(h, previous.id);
  const resume = coordinatorLaunchSnapshot(settings.config, latest.agent, 'resume', h.path, {}, latest.launch);
  if (!resume.ok) throw new Error(resume.code);
  const requestId = randomUUID();
  const run = h.store.write(tx => {
    tx.insertConversationRequest({ id: requestId, conversationId: latest.conversationId, headRunId: latest.id, mode: 'continue',
      body, coordinatorInput: { text: body, language: '' }, submittedAt: now(), deliveryState: latest.session === null ? DELIVERY_STATE.waiting_for_session
        : isUnfinished(latest) ? DELIVERY_STATE.waiting_for_run : DELIVERY_STATE.queued });
    return tx.createCoordinatorRun({ conversationId: latest.conversationId, requestId, agent: latest.agent, resumes: latest.id,
      session: latest.session, cwd: coordinatorCwd(h.root), launch: resume.launch,
      message: { context: null, attachments: [], intent: null } }, body);
  });
  h.store.prepareFolder(run.id);
  return run;
}
/** Reserves what the scheduler would launch now, and launches nothing. */
async function reserve(h: Runtime) {
  const decision = await settleTransaction(h.store, readAgentsSettings(h.root));
  closeLaunches(decision.launches);
  return decision.summary;
}
/** Adds `stdin`, an agent that takes the screen's messages on its standard input, as a coordinator one can send to now. */
function addInputAgent(h: Runtime): void {
  const path = join(h.root, 'config.yaml'), config = parse(readFileSync(path, 'utf8')) as { agents: Record<string, unknown> };
  config.agents.stdin = fixtureAgentSetting('codex');
  Object.assign(config, { coordinatorAiStack: [{ agent: 'stdin', values: {} }] });
  writeFileSync(path, stringify(config));
}
/**
 * A coordinator Run on `stdin` whose manager reported it started in a session, having taken its first message: what a
 * working coordinator one can send to now looks like to serve. No process runs; the journal is its manager's, for the
 * test to go on with.
 */
async function workingCoordinator(h: Runtime) {
  addInputAgent(h);
  const created = h.createCoordinator({}, 'stdin');
  await reserve(h);
  const launch = attemptOf(h.store, created.id)!;
  const journal = new EventJournal(executionFolder(h.root, created.id, launch.attemptId), identityOf(launch));
  journal.append('claimed', { managerPid: process.pid, managerStarted: 'fixture', bootId: bootIdentity() });
  journal.append('spawn_intent', { initialInputId: launch.initialInputId });
  journal.append('started', { pid: 2147483647, started: 'fixture', bootId: bootIdentity(), group: 2147483647, scope: null });
  journal.append('session', { id: 'coordinator-session' });
  journal.append('input_attempt', { inputId: launch.initialInputId, instructionRunId: created.id, contentDigest: digestBytes(launch.prompt) });
  journal.append('input_taken', { inputId: launch.initialInputId, receipt: { evidence: 'fixture' } });
  new RunEventImporter(h.store).pass();
  const run = coordinatorRun(h, created.id);
  assert.equal(run.state, 'running'); assert.deepEqual(run.session, { provider: 'stdin', id: 'coordinator-session' });
  return { run, journal };
}
/** The Runs whose instructions were reserved as input to a Run already working (not a Run's own first message). */
const handedOver = (h: Runtime) => h.store.connection.prepare('SELECT instruction_run_no FROM run_inputs WHERE initial = 0 ORDER BY rowid')
  .all().map(row => `R${row.instruction_run_no}`);

test('a coordinator Run takes no parallel slot: it starts while the slots are full, and Task Runs start beside it', async t => {
  const h = await setup(t, { parallel: 1 });
  const owner = h.create('plain', { gate: h.gate('owner') });
  assert.deepEqual((await h.tick()).launched, [owner.id]);
  await h.ready(owner);
  const coordinator = h.createCoordinator({ gate: h.gate('coordinator') });
  const worker = h.create('plain', { gate: h.gate('worker') }, { role: 'worker', placementId: h.memberPlacementId });
  assert.deepEqual((await h.tick()).launched, [coordinator.id], 'the one slot is the owner\'s, and the coordinator does not wait for it');
  await h.ready(coordinator);
  assert.equal(h.store.runtimeGet(worker.id)!.state, 'queued', 'the slot still bounds Task Runs');
  h.release('owner'); await h.waitState(owner, 'succeeded');
  await h.ready(worker);
  assert.equal(h.store.runtimeGet(coordinator.id)!.state, 'running', 'the worker took the slot the coordinator Run never held');
  h.release('coordinator'); h.release('worker');
  await Promise.all([h.waitState(coordinator, 'succeeded'), h.waitState(worker, 'succeeded')]);
});

test('coordinator Runs start only while their conversation is open, and one at a time within it', async t => {
  const h = await setup(t);
  const late = h.createCoordinator({ output: 'late' });
  h.store.connection.prepare('UPDATE coordinator_conversations SET cleared_at = ? WHERE id = ?').run(now(), late.conversationId);
  const skipped = await h.tick();
  assert.deepEqual(skipped.launched, []);
  assert.deepEqual(skipped.skipped, [{ run: late.id, reason: 'conversation was cleared after request admission' }]);
  assert.equal(h.store.runtimeGet(late.id)!.state, 'queued');
  // The next message opens a new conversation, where its Runs answer in order.
  const first = h.createCoordinator({ gate: h.gate('first') }), second = h.createCoordinator({ output: 'second' });
  assert.notEqual(first.conversationId, late.conversationId); assert.equal(second.conversationId, first.conversationId);
  assert.deepEqual((await h.tick()).launched, [first.id]);
  await h.ready(first);
  assert.equal(h.store.runtimeGet(second.id)!.state, 'queued', 'a message waits for the one before it in its conversation');
  h.release('first'); await h.waitState(first, 'succeeded');
  await h.waitState(second, 'succeeded');
  assert.equal(h.store.runtimeGet(late.id)!.state, 'queued', 'a cleared conversation never starts');
});

test('a message going on from a first launch that failed without a session starts the conversation anew', async t => {
  const h = await setup(t);
  const failed = h.createCoordinator(); h.finish(failed, 'failed');
  assert.equal(coordinatorRun(h, failed.id).session, null);
  const words = 'go on from where it stopped';
  const next = continueAfter(h, failed, words);
  assert.equal(next.resumes, failed.id);
  const summary = await h.tick();
  assert.deepEqual(summary.launched, [next.id], 'it does not wait for a session that never comes');
  const settings = readAgentsSettings(h.root); assert.equal(settings.ok, true);
  if (!settings.ok) throw settings.error;
  const start = launchSnapshot(settings.config, 'plain', 'start', h.path);
  if (!start.ok) throw new Error(start.code);
  const invocation = attemptOf(h.store, next.id)!.invocation;
  assert.equal(invocation.mode, 'start'); assert.deepEqual(invocation.launch.argv, start.launch.argv);
  assert.equal(String(h.store.connection.prepare('SELECT delivery_state FROM requests WHERE id = ?').get(next.requestId)!.delivery_state),
    DELIVERY_STATE.queued, 'its Request no longer waits for a session');
  await h.waitState(next, 'succeeded');
  const receipt = receipts(h.root).find(item => item.prompt.endsWith(words));
  assert.ok(receipt, 'the agent started anew reads the admitted text unchanged');
  assert.match(receipt.prompt, /Read the alpacawork skill and its coordinator reference/);
});

test('a coordinator Run is reserved without a credential or callers, in its own empty folder, for one coordinator turn', async t => {
  const h = await setup(t, { run_minutes: 0, coordinator_run_minutes: 7 }); h.pauseProjection();
  const cwd = coordinatorCwd(h.root);
  rmSync(cwd, { recursive: true, force: true });
  const message = h.createCoordinator();
  await reserve(h);
  const launch = attemptOf(h.store, message.id)!;
  assert.equal(launch.credential, null); assert.deepEqual(launch.ancestors, []);
  assert.equal(launch.cwd, cwd); assert.equal(launch.runMinutes, 7, 'a coordinator turn ends whatever run_minutes says');
  assert.equal(statSync(cwd).mode & 0o777, 0o700); assert.deepEqual(readdirSync(cwd), []);
});

test('a coordinator agent gets the workspace but no Run identity or credential, and works in its own folder', async t => {
  const h = await setup(t);
  const message = h.createCoordinator({ environment: true });
  const expected = agentEnvironment(process.env, h.path, undefined, message.launch.env);
  await h.tick(); await h.waitState(message, 'succeeded');
  assertEnvironment(JSON.parse(h.store.getText(message.id)!.result!), { ...expected, PWD: coordinatorCwd(h.root), ALPACAWORK_WORKSPACE: h.root });
  const receipt = receipts(h.root).find(item => item.prompt.endsWith(JSON.stringify({ environment: true })));
  assert.equal(receipt?.cwd, coordinatorCwd(h.root));
});

test('a coordinator Run ends at limits.coordinator_run_minutes with its whole process group, whatever run_minutes says', async t => {
  const h = await setup(t, { run_minutes: 0, coordinator_run_minutes: 1 }), clock = h.clock();
  const message = h.createCoordinator({ group: true });
  await h.tick(); const agent = await h.ready(message);
  await until(() => receipts(h.root).length === 3, 'coordinator group ready');
  const stops = () => {
    const launch = attemptOf(h.store, message.id)!, events = join(executionFolder(h.root, message.id, launch.attemptId), 'events');
    return names(events).map(name => JSON.parse(readFileSync(join(events, name), 'utf8')) as RunEvent)
      .filter(event => event.type === 'stop_observed');
  };
  await clock.advanceTo(59_999);
  assert.deepEqual(stops(), [], 'a minute has not passed');
  await clock.advanceTo(60_000);
  const ended = await h.waitState(message, 'failed'); assert.equal(ended.reason, 'timeout');
  await until(() => !alive(agent.pid, true) && receipts(h.root).every(r => !alive(r.pid)), 'coordinator group gone');
});

test('a working coordinator takes in only the messages sent now, a later one before an earlier one that waits', async t => {
  const h = await setup(t); h.pauseProjection();
  const { run: parent } = await workingCoordinator(h);
  const waiting = continueAfter(h, parent, 'waits its turn'), sent = continueAfter(h, parent, 'sent now');
  planInputs(h.store);
  assert.deepEqual(handedOver(h), [], 'a message is not sent to the working agent by itself');
  h.store.write(tx => tx.setJoinRequested(sent.id));
  planInputs(h.store);
  assert.deepEqual(handedOver(h), [sent.id]);
  planInputs(h.store);
  assert.deepEqual(handedOver(h), [sent.id], 'a message is handed over once');
  assert.equal(coordinatorRun(h, waiting.id).state, 'queued');
});

test('a message taken in while serve recovers a lost manager retains its Request relationship without a clock', async t => {
  const h = await setup(t); h.pauseProjection();
  const { run: parent, journal } = await workingCoordinator(h);
  const words = 'この内容で進めてください';
  const message = continueAfter(h, parent, words);
  h.store.write(tx => tx.setJoinRequested(message.id));
  planInputs(h.store);
  const input = String(h.store.connection.prepare('SELECT input_id FROM run_inputs WHERE instruction_run_no = ?')
    .get(runNumber(message.id))!.input_id);
  journal.append('input_attempt', { inputId: input, instructionRunId: message.id, contentDigest: digestBytes(words) });
  new RunEventImporter(h.store).pass();
  // The agent took the message in, as its output says, and its manager was lost before it reported so.
  writeFileSync(join(h.store.folder(parent.id), 'stdout.log'), `${JSON.stringify({ type: 'input.taken', id: input })}\n`, { mode: 0o600 });
  h.store.write(tx => tx.update({ ...tx.runtimeGet(parent.id)!, state: 'needs_review', reason: 'manager_lost' }));
  await recoverExecution(h.store);
  const joined = coordinatorRun(h, message.id);
  assert.equal(joined.state, 'joined'); assert.equal(joined.into, parent.id);
  assert.ok(deliveredMessages(h.store.connection, parent.id).includes(message.requestId));
  const body = h.store.connection.prepare('SELECT body FROM requests WHERE id=?').get(message.requestId)!.body;
  assert.equal(body, words, 'the original Request keeps the recovered input');
});

test('recovery ends a lost coordinator turn as its manager would: its group gone, then nothing left in its manager\'s unit', async t => {
  const h = await setup(t); h.pauseProjection();
  const { run } = await workingCoordinator(h);
  // What the agent's start recorded of the scope systemd placed its manager in (its group, pid 2147483647, is gone).
  const unit = processUnit(h.root, run.id), scope = `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}.scope`;
  h.store.connection.prepare("UPDATE run_attempts SET started_json = json_set(started_json, '$.scope', ?) WHERE attempt_id = ?")
    .run(scope, attemptOf(h.store, run.id)!.attemptId);
  h.store.write(tx => tx.update({ ...tx.runtimeGet(run.id)!, state: 'needs_review', reason: 'manager_lost', stop_requested: true }));
  const stopUnit = platform.run.stopUnitOthers, asked: NonNullable<Parameters<typeof stopUnit>[0]>[] = [];
  let left = true;
  platform.run.stopUnitOthers = async recorded => { if (recorded) asked.push(recorded); if (left) throw new Error('Unit keeps PID 4242 after SIGKILL'); return false; };
  t.after(() => { platform.run.stopUnitOthers = stopUnit; });
  await recoverExecution(h.store);
  assert.equal(coordinatorRun(h, run.id).state, 'needs_review', 'a unit that keeps a process leaves the end unconfirmed');
  left = false;
  await recoverExecution(h.store);
  const ended = coordinatorRun(h, run.id);
  assert.equal(ended.state, 'cancelled'); assert.equal(ended.reason, 'stopped');
  assert.equal(asked.length, 2);
  const recorded = asked[1]!;
  assert.equal(recorded.scope, scope, 'recovery stops the unit the agent ran in');
  assert.equal(recorded.ours(unit), true);
  assert.equal(recorded.ours(processUnit(h.root, 'R999999')), false, 'another Run\'s unit is not this Run\'s');
  assert.equal(recorded.ours('session-3'), false, 'nor a unit alpacawork did not start (serve\'s terminal, say)');
});

test('lost-manager recovery releases the execution contract once the recorded group is gone', async t => {
  const h = await setup(t); h.pauseProjection();
  const { run } = await workingCoordinator(h);
  const scope = processUnit(h.root, run.id);
  h.store.connection.prepare('UPDATE run_attempts SET started_json = ? WHERE run_no = ?')
    .run(JSON.stringify({ pid: 999_999_998, started: 'gone', bootId: bootIdentity(), group: 999_999_998, scope }), runNumber(run.id));
  h.store.write(tx => tx.update({ ...tx.runtimeGet(run.id)!, state: 'needs_review', reason: 'manager_lost', stop_requested: true }));
  const stopUnit = platform.run.stopUnitOthers;
  platform.run.stopUnitOthers = async () => false;
  t.after(() => { platform.run.stopUnitOthers = stopUnit; });
  assert.deepEqual(inspectExecution(h.store).contractUsers.map(user => user.runId), [run.id]);
  await recoverExecution(h.store);
  assert.equal(coordinatorRun(h, run.id).state, 'cancelled');
  assert.equal(h.store.connection.prepare('SELECT completed_digest FROM run_attempts WHERE run_no = ?')
    .get(runNumber(run.id))!.completed_digest !== null, true, 'recovery publishes its observation through the same completion importer');
  assert.deepEqual(inspectExecution(h.store).contractUsers, []);
  await recoverExecution(h.store);
  assert.deepEqual(inspectExecution(h.store).contractUsers, [], 'restart needs no additional repair');
});

test('an input a person dealt with (resolved) holds no Run, reservation, contract user or exchange file', async t => {
  const h = await setup(t); h.pauseProjection();
  const run = h.create(), n = runNumber(run.id);
  await reserve(h);
  const launch = attemptOf(h.store, run.id)!;
  // Its manager ended without a receipt for the instruction it attempted; the reply is committed, its exchange file left.
  h.store.connection.prepare("UPDATE run_inputs SET state = 'uncertain' WHERE attempt_id = ?").run(launch.attemptId);
  h.store.connection.prepare('UPDATE run_attempts SET completed_digest = ? WHERE attempt_id = ?').run('0'.repeat(64), launch.attemptId);
  h.finish(run);
  writeFileSync(join(h.store.folder(run.id), 'result.tmp'), 'fixture reply', { mode: 0o600 });
  const holds = () => {
    reconcileCompletedRunFiles(h.store, h.store.runtimeGet(run.id)!);
    return { blocked: blockedInvocations(h.store, [run.id]).has(n), reserved: !!h.store.connection.prepare("SELECT 1 FROM run_inputs WHERE instruction_run_no=? AND state NOT IN ('not_sent','resolved')").get(n),
      contract: inspectExecution(h.store).contractUsers.some(user => user.runId === run.id),
      file: existsSync(join(h.store.folder(run.id), 'result.tmp')) };
  };
  assert.deepEqual(holds(), { blocked: true, reserved: true, contract: true, file: true });
  h.store.write(tx => resolveUncertainInputs(h.store.connection, tx, h.ownerPlacementId));
  assert.equal(String(h.store.connection.prepare('SELECT state FROM run_inputs WHERE attempt_id = ?').get(launch.attemptId)!.state), 'resolved');
  assert.deepEqual(holds(), { blocked: false, reserved: false, contract: false, file: false });
});
