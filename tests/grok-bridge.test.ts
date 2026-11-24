import { AGENT_RUNTIME_ADAPTERS } from '@alpacawork/backend/test-dist/agents/registry.js';
import { OutputActivityReader, readRunActivity } from '@alpacawork/backend/test-dist/runs/activity.js';
import { RUN_FILES } from '@alpacawork/contract/run';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnBridge } from './helpers/bridge-process.ts';
import { assertInputOutcomes } from './fixtures/input-outcomes.ts';

const entry = join(import.meta.dirname, '../apps/agent-cli/dist/cli.js');
function setup(t: TestContext, session?: string, options: string[] = []) {
  const area = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-grok-test-')));
  const binary = join(area, 'grok');
  copyFileSync(join(import.meta.dirname, 'fixtures/fake-grok.mjs'), binary);
  chmodSync(binary, 0o755);
  const log = join(area, 'invocations'), release = join(area, 'release'), ready = join(area, 'ready');
  const bridge = spawnBridge(t, [entry, 'grok', '-o', join(area, 'result'), '--model', 'test-model',
    ...(session ? ['--session', session] : []), ...options], {
    cwd: area, env: { ...process.env, PATH: `${area}${delimiter}${process.env.PATH}`,
      FAKE_GROK_LOG: log, FAKE_GROK_RELEASE: release, FAKE_GROK_READY: ready },
  });
  t.after(() => rmSync(area, { recursive: true, force: true }));
  return { ...bridge, area, ready, finish: () => writeFileSync(release, ''),
    invocations: (): any[] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(row => JSON.parse(row)) : [] };
}

test('Grok queues inputs, resumes exactly the same session, and removes private prompt files', async t => {
  const h = setup(t);
  h.send('one', 'hold');
  await h.until(() => h.invocations().length === 1);
  h.send('two', 'next');
  await h.until(rows => rows.some(row => row.type === 'input.accepted' && row.id === 'two'));
  assert.equal(h.events().some(row => row.type === 'input.taken'), false);
  assert.equal(h.invocations().length, 1);
  h.finish();
  await h.until(rows => rows.filter(row => row.type === 'turn.completed').length === 2);
  h.child.stdin.end();
  assert.equal(await h.exited, 0, h.stderr());
  assertInputOutcomes(h.events(), { one: 'taken', two: 'taken' });
  writeFileSync(join(h.area, RUN_FILES.stdout), h.events().map(event => JSON.stringify(event)).join('\n') + '\n');
  new OutputActivityReader(AGENT_RUNTIME_ADAPTERS.grok).poll(h.area);
  const step = readRunActivity(h.area)?.steps.at(-1);
  assert.equal(step?.tool, 'read_file');
  assert.equal(step.kind, 'file');
  assert.equal(step.text, 'catalog.txt');
  assert.equal(step.state, 'done');
  assert.deepEqual(step.result, { text: 'Catalog found', more: 1 });
  writeFileSync(join(h.area, RUN_FILES.resultTemp), readFileSync(join(h.area, 'result')));
  const read = AGENT_RUNTIME_ADAPTERS.grok.read({ mode: 'start', session: null }, h.area, { code: 0, signal: null });
  assert.equal(read.outcome.state, 'succeeded');
  assert.equal(read.session, h.events().find(event => event.type === 'thread.started').thread_id);
  assert.equal(read.usage, null); // These native fixtures supply no cache counts; never invent zeros.
  const [first, second] = h.invocations();
  assert.ok(first.args.includes('--session-id'));
  assert.ok(second.args.includes('--resume'));
  assert.equal(first.session, second.session);
  assert.equal(first.args.includes('hold'), false);
  assert.equal(first.args[first.args.indexOf('--model') + 1], 'test-model');
  assert.equal(h.events().filter(row => row.type === 'thread.started').length, 1);
  assert.equal(readFileSync(join(h.area, 'result'), 'utf8'), 'answer next');
  for (const call of h.invocations()) assert.equal(existsSync(call.promptFile), false);
});

test('Grok forwards reasoning effort with the model on new and resumed native turns', async t => {
  const h = setup(t, undefined, ['--effort', 'xhigh']);
  h.send('one', 'first');
  await h.until(rows => rows.some(row => row.type === 'turn.completed'));
  h.send('two', 'second'); h.child.stdin.end();
  assert.equal(await h.exited, 0, h.stderr());
  assert.equal(h.invocations().length, 2);
  for (const call of h.invocations()) {
    assert.equal(call.args[call.args.indexOf('--model') + 1], 'test-model');
    assert.equal(call.args[call.args.indexOf('--reasoning-effort') + 1], 'xhigh');
  }
  assert.ok(h.invocations()[1].args.includes('--resume'));
});

test('Grok resumes a supplied conversation without starting a replacement', async t => {
  const session = '12345678-1234-1234-1234-123456789abc';
  const h = setup(t, session);
  h.send('one', 'hello'); h.child.stdin.end();
  assert.equal(await h.exited, 0, h.stderr());
  assert.ok(h.invocations()[0].args.includes('--resume'));
  assert.equal(h.events().find(row => row.type === 'thread.started').thread_id, session);
});

for (const prompt of ['auth', 'malformed', 'disconnect', 'no-end', 'truncated', 'wrong-session', 'false-success', 'refused', 'after-end']) {
  test(`Grok fails on ${prompt} without saving an answer`, async t => {
    const h = setup(t); h.send('one', prompt); h.child.stdin.end();
    assert.equal(await h.exited, 1, h.stderr());
    assert.equal(h.events().some(row => row.type === 'turn.completed'), false);
    assert.equal(existsSync(join(h.area, 'result')), false);
    assertInputOutcomes(h.events(), { one: ['auth', 'malformed'].includes(prompt) ? 'uncertain' : 'taken' });
    for (const call of h.invocations()) assert.equal(existsSync(call.promptFile), false);
    if (prompt === 'auth') assert.match(JSON.stringify(h.events()), /grok login|XAI_API_KEY/);
  });
}

for (const prompt of ['preempt', 'interrupt']) test(`Grok interruption during ${prompt} settles inputs and cleans prompts`, async t => {
  const h = setup(t); h.send('one', prompt);
  await h.until(() => prompt === 'preempt' ? h.invocations().length === 1 : existsSync(h.ready));
  h.send('two', 'queued');
  await h.until(rows => rows.some(row => row.type === 'input.accepted' && row.id === 'two'));
  h.child.kill('SIGTERM');
  assert.equal(await h.exited, 143);
  assertInputOutcomes(h.events(), { one: prompt === 'preempt' ? 'uncertain' : 'taken', two: 'uncertain' });
  assert.equal(h.invocations().length, 1);
  for (const call of h.invocations()) assert.equal(existsSync(call.promptFile), false);
});
