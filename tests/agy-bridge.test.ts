import { AGENT_RUNTIME_ADAPTERS } from '@alpacawork/backend/test-dist/agents/registry.js';
import { RUN_FILES } from '@alpacawork/contract/run';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnBridge } from './helpers/bridge-process.ts';
import { assertInputOutcomes } from './fixtures/input-outcomes.ts';

const entry = join(import.meta.dirname, '../apps/agent-cli/dist/cli.js');
const fake = join(import.meta.dirname, 'fixtures/fake-agy.mjs');

function setup(t: TestContext, options: string[] = []) {
  const area = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-agy-')));
  const binary = join(area, 'agy');
  copyFileSync(fake, binary);
  chmodSync(binary, 0o755);
  const log = join(area, 'prompts');
  const argsLog = join(area, 'args');
  const release = join(area, 'release');
  const process = spawnBridge(t, [entry, 'agy', '-o', join(area, 'result'), ...options], {
    cwd: area, env: { ...globalThis.process.env, PATH: `${area}${delimiter}${globalThis.process.env.PATH}`,
      FAKE_AGY_LOG: log, FAKE_AGY_ARGS: argsLog, FAKE_AGY_RELEASE: release },
  });
  t.after(() => rmSync(area, { recursive: true, force: true }));
  return { area, release, ...process,
    prompts: (): string[] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
    invocations: (): string[][] => existsSync(argsLog) ? readFileSync(argsLog, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
    finish: () => writeFileSync(release, '') };
}

test('Antigravity queues instructions, streams input through stdin, and resumes the same session', async t => {
  const h = setup(t, ['--model', 'test-model']);
  h.send('one', 'hold');
  await h.until(() => h.prompts().includes('hold'));
  h.send('two', 'second\nline');
  await h.until(() => h.events().some(event => event.type === 'input.accepted' && event.id === 'two'));
  assert.deepEqual(h.prompts(), ['hold']);
  assert.equal(h.events().some(event => event.type === 'input.taken'), false);
  h.finish();
  await h.until(() => h.events().filter(event => event.type === 'turn.completed').length === 2);
  h.child.stdin.end();
  assert.equal(await h.exited, 0, h.stderr());
  assertInputOutcomes(h.events(), { one: 'taken', two: 'taken' });
  writeFileSync(join(h.area, RUN_FILES.stdout), h.events().map(event => JSON.stringify(event)).join('\n') + '\n');
  writeFileSync(join(h.area, RUN_FILES.resultTemp), readFileSync(join(h.area, 'result')));
  const read = AGENT_RUNTIME_ADAPTERS.agy.read({ mode: 'start', session: null }, h.area, { code: 0, signal: null });
  assert.equal(read.outcome.state, 'succeeded');
  assert.equal(read.session, h.events().find(event => event.type === 'thread.started').thread_id);
  assert.equal(read.usage, null); // These native fixtures supply no cache counts; never invent zeros.
  assert.deepEqual(h.prompts(), ['hold', 'second\nline']);
  assert.deepEqual(h.invocations(), [
    ['--input-format', 'stream-json', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--model', 'test-model'],
    ['--input-format', 'stream-json', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--model', 'test-model', '--conversation', 'A-parent'],
  ]);
  assert.equal(readFileSync(join(h.area, 'result'), 'utf8'), 'answer second\nline');
  assert.equal(h.events().filter(event => event.type === 'thread.started').length, 1);
  assert.ok(h.events().findIndex(event => event.type === 'input.taken' && event.id === 'two') >
    h.events().findIndex(event => event.type === 'turn.completed'));
});

test('Antigravity forwards model and reasoning effort on new and resumed native turns', async t => {
  const h = setup(t, ['--model', 'test-model', '--effort', 'high']);
  h.send('one', 'first');
  await h.until(() => h.events().some(event => event.type === 'turn.completed'));
  h.send('two', 'second'); h.child.stdin.end();
  assert.equal(await h.exited, 0, h.stderr());
  assert.equal(h.invocations().length, 2);
  for (const args of h.invocations()) {
    assert.equal(args[args.indexOf('--model') + 1], 'test-model');
    assert.equal(args[args.indexOf('--effort') + 1], 'high');
  }
  assert.ok(h.invocations()[1]!.includes('--conversation'));
});

test('Antigravity init and checkpoint alone do not prove processing', async t => {
  const h = setup(t);
  h.send('one', 'checkpoint');
  await h.until(() => h.prompts().includes('checkpoint'));
  await delay(50);
  assert.equal(h.events().some(event => event.type === 'input.taken'), false);
  h.finish();
  await h.until(() => h.events().some(event => event.type === 'turn.completed'));
  h.child.stdin.end();
  assert.equal(await h.exited, 0, h.stderr());
  assertInputOutcomes(h.events(), { one: 'taken' });
});

test('Antigravity accepts assistant, tool, and successful completion as processing evidence', async t => {
  for (const prompt of ['assistant-only', 'tool-only', 'completion-only']) {
    const h = setup(t);
    h.send('one', prompt);
    await h.until(() => h.events().some(event => event.type === 'turn.completed'));
    h.child.stdin.end();
    assert.equal(await h.exited, 0, `${prompt}: ${h.stderr()}`);
    assertInputOutcomes(h.events(), { one: 'taken' });
  }
});

test('Antigravity auth and early errors return failure without a processing receipt', async t => {
  for (const prompt of ['auth', 'early-error', 'disconnect']) {
    const h = setup(t);
    h.send('one', prompt);
    await h.until(() => h.events().some(event => event.type === 'turn.failed'));
    h.child.stdin.end();
    assert.equal(await h.exited, 1);
    assertInputOutcomes(h.events(), { one: 'uncertain' });
    assert.equal(h.events().some(event => event.type === 'turn.completed'), false);
    if (prompt === 'auth') assert.match(h.stderr(), /authentication required/);
  }
});

test('Antigravity requires successful terminal result and successful process exit', async t => {
  for (const prompt of ['error', 'false-success', 'cancelled', 'contradictory-success']) {
    const h = setup(t);
    h.send('one', prompt);
    await h.until(() => h.events().some(event => event.type === 'turn.failed'));
    h.child.stdin.end();
    assert.equal(await h.exited, 1);
    assertInputOutcomes(h.events(), { one: 'taken' });
    assert.equal(h.events().some(event => event.type === 'turn.completed'), false);
    assert.equal(existsSync(join(h.area, 'result')), false);
  }
});

test('Antigravity refuses malformed, incomplete, duplicate, missing, and wrong-session output', async t => {
  for (const prompt of ['malformed', 'truncated', 'no-result', 'duplicate-result', 'event-wrong-session', 'result-wrong-session', 'wrong-session', 'result-without-init', 'invalid-step', 'step-without-session', 'unknown-event', 'missing-response', 'invalid-result']) {
    const h = setup(t, ['--conversation', 'A-parent']);
    h.send('one', prompt);
    h.child.stdin.end();
    assert.equal(await h.exited, 1, `${prompt}: ${h.stderr()}`);
    assert.equal(h.events().some(event => event.type === 'turn.completed'), false, prompt);
    assertInputOutcomes(h.events(), { one: ['duplicate-result', 'event-wrong-session', 'result-wrong-session', 'missing-response', 'invalid-result'].includes(prompt) ? 'taken' : 'uncertain' });
  }
});

test('Antigravity prestart interruption keeps current and queued inputs uncertain', async t => {
  const h = setup(t);
  h.send('one', 'preempt');
  await h.until(() => h.prompts().includes('preempt'));
  h.send('two', 'queued');
  await h.until(() => h.events().some(event => event.type === 'input.accepted' && event.id === 'two'));
  h.child.kill('SIGTERM');
  assert.equal(await h.exited, 143);
  assertInputOutcomes(h.events(), { one: 'uncertain', two: 'uncertain' });
  assert.equal(h.events().some(event => event.type === 'turn.completed'), false);
  assert.deepEqual(h.prompts(), ['preempt']);
});
