/** Agent replies stay independent of process outcome, including large output and termination. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readRunFiles } from '@alpacawork/backend/test-dist/runs/view.js';
import { alive, setup, until } from './runs-runtime.fixture.ts';

test('Runs that read more than 16 MiB of images end by their final event and keep their reply', async t => {
  const h = await setup(t, { parallel: 8 });
  const imageBytes = 17 * 1024 * 1024, output = 'Final reply after reading images.';
  const claude = h.createIndependent('claude', { imageBytes, output, usage: { inputTokens: 1, cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0, outputTokens: 1 } });
  const codex = h.createIndependent('codex', { imageBytes, output });
  const claudeError = h.createIndependent('claude', { imageBytes, output, isError: true });
  const codexWithoutReply = h.createIndependent('codex', { imageBytes, noResult: true });
  await h.tick();
  for (const run of [claude, codex]) {
    await h.waitState(run, 'succeeded');
    assert.ok(statSync(join(h.store.folder(run.id), 'stdout.log')).size > imageBytes);
    assert.equal(readRunFiles(h.root, run.id, 'result').files[0]?.text, output);
  }
  assert.deepEqual(h.store.get(claude.id)!.usage?.run, { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 });
  assert.equal((await h.waitState(claudeError, 'failed')).reason, 'output');
  assert.equal(h.store.getText(claudeError.id)?.result, output);
  assert.equal((await h.waitState(codexWithoutReply, 'failed')).reason, 'output');
  assert.equal(h.store.getText(codexWithoutReply.id)?.resultState, 'missing');
});

test('corrupt and oversized Claude final output are distinct failed results in DB', async t => {
  const h = await setup(t);
  const corrupt = h.createIndependent('claude', { invalidUtf8: true });
  const large = h.createIndependent('claude', { bytes: 3 * 1024 * 1024 });
  await h.tick();
  for (const run of [corrupt, large]) assert.equal((await h.waitState(run, 'failed')).reason, 'output');
  assert.equal(h.store.getText(corrupt.id)?.resultState, 'unreadable');
  assert.equal(h.store.getText(large.id)?.resultState, 'too_large');
  assert.equal(h.store.getText(corrupt.id)?.result, null);
  assert.equal(h.store.getText(large.id)?.result, null);
});

for (const scenario of [
  { name: 'failed file reply', agent: 'own', plan: { exitAfterResult: 1, resultOnly: true }, reason: 'exit', result: 'present' },
  { name: 'failed codex reply', agent: 'codex', plan: { exitAfterResult: 1 }, reason: 'exit', result: 'present' },
  { name: 'codex reply after an oversized output line', agent: 'codex', plan: { oversizedLine: true }, reason: 'output', result: 'present' },
  { name: 'failed without reply', agent: 'own', plan: { exitAfterResult: 1, noResult: true, resultOnly: true }, reason: 'exit', result: 'missing' },
  { name: 'successful exit without reply', agent: 'own', plan: { noResult: true, resultOnly: true }, reason: 'output', result: 'missing' },
  { name: 'failed unreadable reply', agent: 'own', plan: { exitAfterResult: 1, invalidUtf8: true, resultOnly: true }, reason: 'exit', result: 'unreadable' },
  { name: 'failed oversized reply', agent: 'own', plan: { exitAfterResult: 1, bytes: 1024 * 1024 + 1, resultOnly: true }, reason: 'exit', result: 'too_large' },
  { name: 'failed Claude reply', agent: 'claude', plan: { exitAfterResult: 1, isError: true }, reason: 'exit', result: 'present' },
  { name: 'Claude error reply', agent: 'claude', plan: { isError: true }, reason: 'output', result: 'present' },
] as const) test(`Run outcome and reply are independent: ${scenario.name}`, async t => {
  const h = await setup(t), output = 'The work failed after producing this explanation.';
  const run = h.create(scenario.agent, { ...scenario.plan, output });
  await h.tick();
  const ended = await h.waitState(run, 'failed');
  await h.waitExchangeCleanup(run);
  assert.equal(ended.reason, scenario.reason);
  const text = h.store.getText(run.id)!;
  assert.equal(text.resultState, scenario.result);
  assert.equal(text.result, scenario.result === 'present' ? output : null);
  assert.equal(readRunFiles(h.root, run.id, 'result').files[0]!.state, scenario.result);
  const temp = join(h.store.folder(run.id), 'result.tmp');
  // Serve reconciles committed exchange files asynchronously after importing the
  // manager's final event; manager exit alone does not mean reconciliation ran.
  if (scenario.result === 'present') await until(() => !existsSync(temp), 'serve removes the committed reply');
  assert.equal(existsSync(temp), ['too_large', 'unreadable'].includes(scenario.result), 'only committed bytes may be deleted');
});

for (const reason of ['stopped', 'timeout'] as const) test(`Run keeps a written reply after ${reason}`, async t => {
  const h = await setup(t, reason === 'timeout' ? { run_minutes: 0.02 } : {}), clock = h.clock();
  const output = 'Partial result before termination.';
  const run = h.create('own', { output, resultOnly: true, afterResultGate: h.gate('never-opened') });
  await h.tick();
  const temp = join(h.store.folder(run.id), 'result.tmp');
  await until(() => existsSync(temp), 'reply written before termination');
  if (reason === 'stopped') h.store.write(tx => tx.update({ ...tx.get(run.id)!, stop_requested: true }));
  else await clock.advanceTo(1200);
  const ended = await h.waitState(run, reason === 'stopped' ? 'cancelled' : 'failed');
  await h.waitExchangeCleanup(run);
  assert.equal(ended.reason, reason);
  assert.equal(h.store.getText(run.id)?.result, output);
  assert.equal(h.store.getText(run.id)?.resultState, 'present');
  await until(() => !existsSync(temp), 'serve removes the committed reply after termination');
  assert.equal(existsSync(temp), false);
});
