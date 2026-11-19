import { fixtureAgentSetting } from './helpers/agent-stub.ts';
/** Configured readers, activity and measured usage across real fake-agent invocations. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { randomUUID } from 'node:crypto';
import { AGENTS_TEMPLATE, parseAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { RequestService } from '@alpacawork/backend/test-dist/control/requests.js';
import { readControlTree } from './helpers/control-tree.ts';
import { fake, setup, until } from './runs-runtime.fixture.ts';

test('manager stores normalized conversation and Run token counts across resumed fake agents', async t => {
  const h = await setup(t, {}, '/alpacawork-fake-only');
  const claude = h.create('claude', { usage: { inputTokens: 100, cacheReadInputTokens: 20,
    cacheCreationInputTokens: 5, outputTokens: 30 } });
  const codex = h.create('codex', { usage: { input_tokens: 120, cached_input_tokens: 25,
    cache_write_input_tokens: 5, output_tokens: 40 } },
    { role: 'worker', placementId: h.memberPlacementId });
  for (const run of [claude, codex]) {
    assert.ok(run.launch.path.startsWith(h.root + '/agent-bin:'));
    assert.equal(run.cwd, h.root);
  }
  await h.tick();
  await Promise.all([h.waitState(claude, 'succeeded'), h.waitState(codex, 'succeeded')]);
  assert.deepEqual(h.store.get(claude.id)!.usage?.run,
    { input: 100, cacheRead: 20, cacheWrite: 5, output: 30 },
    readFileSync(join(h.store.folder(claude.id), 'manager.log'), 'utf8'));
  assert.deepEqual(h.store.get(codex.id)!.usage?.run,
    { input: 90, cacheRead: 25, cacheWrite: 5, output: 40 });

  const resumed = h.create('claude', { usage: { inputTokens: 130, cacheReadInputTokens: 30,
    cacheCreationInputTokens: 7, outputTokens: 50 } },
    { resumes: claude.id, session: claude.session });
  await h.tick(); await h.waitState(resumed, 'succeeded');
  assert.deepEqual(h.store.get(resumed.id)!.usage?.run,
    { input: 30, cacheRead: 10, cacheWrite: 2, output: 20 });
  assert.equal(h.store.get(resumed.id)!.usage?.includesEarlier, false);
});

test('an alias reads its fake CLI output through its explicit built-in adapter', async t => {
  const h = await setup(t, {}, '/alpacawork-fake-only');
  const config = JSON.parse(JSON.stringify(h.config));
  config.agents.novel = fixtureAgentSetting('claude');
  writeFileSync(join(h.root, 'config.yaml'), stringify(config));
  const run = h.create('novel', { output: 'new profile reply', usage: { inputTokens: 3,
    cacheReadInputTokens: 1, cacheCreationInputTokens: 0, outputTokens: 2 } },
  { session: { provider: 'novel', id: 'novel-session' } });
  await h.tick(); await h.waitState(run, 'succeeded');
  assert.equal(h.store.getText(run.id)?.result, 'new profile reply');
  assert.deepEqual(h.store.get(run.id)?.session, { provider: 'novel', id: 'novel-session' });
  assert.deepEqual(h.store.get(run.id)?.usage?.run, { input: 3, cacheRead: 1, cacheWrite: 0, output: 2 });
});

for (const mismatch of [false, true]) test(`admitted assigned session ${mismatch ? 'rejects a different output ID' : 'runs through the manager'}`, async t => {
  const h = await setup(t, {}, '/alpacawork-fake-only');
  const tree = await readControlTree(h.root);
  const receipt = await new RequestService(h.root).request({ taskId: h.taskId, mode: 'new',
    body: JSON.stringify({ mismatch, output: 'candidate reply' }), requestId: randomUUID(), expectedTaskHash: tree.tasks.find(task => task.id === h.taskId)!.hash,
    expectedPlacementRevision: 1 }, { purpose: 'instruction', actor: { kind: 'human' } });
  const run = h.store.get(receipt.runId)!;
  assert.ok(run.session, 'admission must supply the launch candidate');
  await h.tick();
  const ended = await until(() => {
    const latest = h.store.get(run.id); return latest?.ended_at ? latest : null;
  }, 'candidate Run finishes');
  assert.equal(ended.state, mismatch ? 'failed' : 'succeeded');
  assert.equal(ended.reason, mismatch ? 'output' : null);
  assert.deepEqual(ended.session, run.session, 'the emitted ID cannot replace a launch candidate');
  if (!mismatch) assert.equal(h.store.getText(run.id)?.result, 'candidate reply');
});

test('manager accumulates declared per-Run usage and keeps a missing predecessor unknown', async t => {
  const h = await setup(t, {}, '/alpacawork-fake-only');
  const first = h.create('codex', { usage: { scope: 'run', counters: { input: 10, cacheRead: 2, cacheWrite: 1, output: 3 } } });
  await h.tick(); await h.waitState(first, 'succeeded');
  assert.deepEqual(h.store.get(first.id)!.usage, { conversation: { input: 10, cacheRead: 2, cacheWrite: 1, output: 3 },
    run: { input: 10, cacheRead: 2, cacheWrite: 1, output: 3 }, includesEarlier: false });

  const second = h.create('codex', { usage: { scope: 'run', counters: { input: 4, cacheRead: 1, cacheWrite: 0, output: 2 } } },
  { resumes: first.id, session: first.session });
  await h.tick(); await h.waitState(second, 'succeeded');
  assert.deepEqual(h.store.get(second.id)!.usage, { conversation: { input: 14, cacheRead: 3, cacheWrite: 1, output: 5 },
    run: { input: 4, cacheRead: 1, cacheWrite: 0, output: 2 }, includesEarlier: false });

  const missing = h.create('codex', {}, { resumes: second.id, session: second.session });
  await h.tick(); await h.waitState(missing, 'succeeded');
  const afterMissing = h.create('codex', { usage: { scope: 'run', counters: { input: 2, cacheRead: 0, cacheWrite: 0, output: 1 } } },
  { resumes: missing.id, session: missing.session });
  await h.tick(); await h.waitState(afterMissing, 'succeeded');
  assert.deepEqual(h.store.get(afterMissing.id)!.usage, { conversation: null,
    run: { input: 2, cacheRead: 0, cacheWrite: 0, output: 1 }, includesEarlier: false });
});

test('manager handles unavailable, damaged-line, decreased, and stopped fake usage', async t => {
  const h = await setup(t, {}, '/alpacawork-fake-only');
  const empty = h.create('claude');
  const broken = h.create('claude', { brokenLine: true, usage: { inputTokens: 1, cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0, outputTokens: 1 } });
  await h.tick();
  await Promise.all([h.waitState(empty, 'succeeded'), h.waitState(broken, 'succeeded')]);
  assert.equal(h.store.get(empty.id)!.usage, null);
  assert.deepEqual(h.store.get(broken.id)!.usage?.run, { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 });

  const afterMissing = h.create('claude', { usage: { inputTokens: 10, cacheReadInputTokens: 1,
    cacheCreationInputTokens: 0, outputTokens: 2 } },
    { resumes: empty.id, session: empty.session });
  await h.tick(); await h.waitState(afterMissing, 'succeeded');
  assert.deepEqual(h.store.get(afterMissing.id)!.usage?.run,
    { input: 10, cacheRead: 1, cacheWrite: 0, output: 2 });
  assert.equal(h.store.get(afterMissing.id)!.usage?.includesEarlier, true);

  const decreased = h.create('claude', { usage: { inputTokens: 9, cacheReadInputTokens: 2,
    cacheCreationInputTokens: 0, outputTokens: 3 } },
    { resumes: afterMissing.id, session: afterMissing.session });
  await h.tick(); await h.waitState(decreased, 'succeeded');
  assert.equal(h.store.get(decreased.id)!.usage?.run, null);

  const stopped = h.create('claude', { gate: h.gate('never-usage') });
  await h.tick(); await h.ready(stopped);
  h.store.write(tx => tx.update({ ...tx.get(stopped.id)!, stop_requested: true }));
  await h.waitState(stopped, 'cancelled');
  assert.equal(h.store.get(stopped.id)!.usage, null);
});

test('manager leaves fake usage unknown when timeout precedes the final result', async t => {
  const h = await setup(t, { run_minutes: 0.03 }, '/alpacawork-fake-only'), clock = h.clock();
  const run = h.create('claude', { gate: h.gate('never-before-usage'), usage: {
    inputTokens: 10, cacheReadInputTokens: 1, cacheCreationInputTokens: 0, outputTokens: 2 } });
  assert.ok(run.launch.path.startsWith(h.root + '/agent-bin:'));
  assert.equal(run.cwd, h.root);
  await h.tick(); await h.ready(run);
  await clock.advanceTo(1800);
  const ended = await h.waitState(run, 'failed');
  assert.equal(ended.reason, 'timeout');
  assert.equal(ended.usage, null);
});

for (const reason of ['stopped', 'timeout'] as const) test(`manager retains final fake usage before ${reason}`, async t => {
  const h = await setup(t, reason === 'timeout' ? { run_minutes: 0.03 } : {}, '/alpacawork-fake-only'), clock = h.clock();
  const run = h.create('claude', { usage: { inputTokens: 10, cacheReadInputTokens: 1,
    cacheCreationInputTokens: 0, outputTokens: 2 }, afterResultGate: h.gate('never-after-usage') });
  assert.ok(run.launch.path.startsWith(h.root + '/agent-bin:'));
  assert.equal(run.cwd, h.root);
  await h.tick();
  await until(() => {
    const path = join(h.store.folder(run.id), 'stdout.log');
    return existsSync(path) && readFileSync(path, 'utf8').includes('"modelUsage"');
  }, 'final fake usage line before termination');
  if (reason === 'stopped') h.store.write(tx => tx.update({ ...tx.get(run.id)!, stop_requested: true }));
  else await clock.advanceTo(1800);
  const ended = await h.waitState(run, reason === 'stopped' ? 'cancelled' : 'failed');
  assert.equal(ended.reason, reason);
  assert.deepEqual(ended.usage?.run, { input: 10, cacheRead: 1, cacheWrite: 0, output: 2 });
});

test('Codex usage skips broken JSONL lines and rejects overlapping input classes', async t => {
  const h = await setup(t, {}, '/alpacawork-fake-only');
  const damaged = h.create('codex', { brokenLine: true, usage: { input_tokens: 20,
    cached_input_tokens: 5, cache_write_input_tokens: 2, output_tokens: 3 } });
  const overlap = h.create('codex', { usage: { input_tokens: 4,
    cached_input_tokens: 5, cache_write_input_tokens: 0, output_tokens: 3 } });
  await h.tick();
  await Promise.all([h.waitState(damaged, 'succeeded'), h.waitState(overlap, 'succeeded')]);
  assert.deepEqual(h.store.get(damaged.id)!.usage?.run,
    { input: 13, cacheRead: 5, cacheWrite: 2, output: 3 });
  assert.equal(h.store.get(overlap.id)!.usage, null);
});

test('an unwritable activity projection does not change the agent result', async t => {
  const h = await setup(t), run = h.create('claude', { activity: true, output: 'result' });
  mkdirSync(join(h.store.folder(run.id), 'activity.json'));
  await h.tick();
  await h.waitState(run, 'succeeded');
  assert.equal(h.store.getText(run.id)?.result, 'result');
});
