import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { platform } from '@alpacawork/core';
import { AGENT_RUNTIME_ADAPTERS } from '@alpacawork/backend/test-dist/agents/registry.js';
import { OutputActivityReader, readRunActivity } from '@alpacawork/backend/test-dist/runs/activity.js';
import { RUN_FILES } from '@alpacawork/contract/run';
import { spawnBridge } from './helpers/bridge-process.ts';
import { AgentInputChannel } from '@alpacawork/backend/test-dist/runs/input.js';
import { assertInputOutcomes } from './fixtures/input-outcomes.ts';
const entry = join(import.meta.dirname, '../apps/agent-cli/dist/cli.js');
function setup(t: TestContext, mode = 'normal', fixture = 'fake-pi.mjs') {
 const area = realpathSync(mkdtempSync(join(tmpdir(), 'pi-bridge-'))), log = join(area, 'rpc.jsonl'), release = join(area, 'release');
 t.after(() => rmSync(area, { recursive: true, force: true }));
 copyFileSync(join(import.meta.dirname, 'fixtures', fixture), join(area, 'pi')); chmodSync(join(area, 'pi'), 0o755);
 const calls = (): any[] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
 const start = (args: string[] = []) => spawnBridge(t, [entry, 'pi', '-o', join(area, RUN_FILES.resultTemp), ...args], {
  cwd: area, env: { ...process.env, PATH: area + delimiter + process.env.PATH, PI_STUB_MODE: mode, PI_STUB_LOG: log, PI_STUB_RELEASE: release,
   PI_CODING_AGENT_DIR: join(area, 'agent'), PI_CODING_AGENT_SESSION_DIR: area },
 });
 return { area, calls, start, release: () => writeFileSync(release, '') };
}
test('Pi new/resume preserves complete session, provider/model with slashes, off versus default, final text and stats totals', async t => {
 const h = setup(t), model = 'openrouter/openai/synthetic-model';
 const b = h.start(['--model', model, '--thinking', 'off']); b.send('one', 'literal synthetic input');
 await b.until(rows => rows.some(row => row.type === 'turn.completed'));
 b.child.stdin.end(); assert.equal(await b.exited, 0, b.stderr());
 assertInputOutcomes(b.events(), { one: 'taken' });
 const state = b.events().find(row => row.item?.type === 'agent_configuration').item;
 assert.deepEqual(state, { type: 'agent_configuration', model, requested_effort: 'off', effective_effort: 'low' });
 assert.match(b.stderr(), /requested=off, effective=low/);
 const id = b.events().find(row => row.type === 'thread.started').thread_id;
 assert.deepEqual(b.events().find(row => row.type === 'turn.completed').usage,
  { scope: 'conversation', counters: { input: 13, cacheRead: 4, cacheWrite: 1, output: 7 } });
 assert.equal(readFileSync(join(h.area, RUN_FILES.resultTemp), 'utf8'), 'synthetic reply 1\n\u2028\u2029😀');
 const resumed = h.start(['--session', id, '--model', model]); resumed.send('two', 'next exact input');
 await resumed.until(rows => rows.some(row => row.type === 'turn.completed')); resumed.child.stdin.end();
 assert.equal(await resumed.exited, 0, resumed.stderr());
 assert.equal(resumed.events().find(row => row.item?.type === 'agent_configuration').item.requested_effort, null);
 const argv = h.calls().filter(row => row.started).map(row => row.args);
 assert.ok(argv[1].includes(id)); assert.equal(argv[0].includes('--approve'), false);
 assert.deepEqual(h.calls().filter(row => row.type === 'prompt').map(row => row.message), ['literal synthetic input', 'next exact input']);
 writeFileSync(join(h.area, RUN_FILES.stdout), resumed.events().map(row => JSON.stringify(row)).join('\n') + '\n');
 new OutputActivityReader(AGENT_RUNTIME_ADAPTERS.pi).poll(h.area);
 const step = readRunActivity(h.area)?.steps.at(-1);
 assert.equal(step?.tool, 'bash');
 assert.equal(step.text, 'cat catalog.txt');
 assert.equal(step.state, 'failed');
 assert.deepEqual(step.result, { text: 'Catalog missing', more: 1 });
 const read = AGENT_RUNTIME_ADAPTERS.pi.read({ mode: 'resume', session: id }, h.area, { code: 0, signal: null });
 assert.equal(read.outcome.state, 'succeeded');
 assert.deepEqual(read.usage, { scope: 'conversation', counters: { input: 23, cacheRead: 8, cacheWrite: 2, output: 9 } });
});
for (const mode of ['missing', 'wrong-id', 'wrong-cwd', 'wrong-model', 'busy']) test(`Pi refuses ${mode} before transmitting input`, async t => {
 const h = setup(t, mode), b = h.start(['--session', 'complete-id', '--model', 'provider/model']);
 b.send('one', 'do not transmit'); b.child.stdin.end(); assert.equal(await b.exited, 1, b.stderr());
 assert.equal(b.events().some(row => row.type === 'error'), true);
 assert.equal(b.events().some(row => row.type === 'thread.started'), false);
 assert.equal(h.calls().some(row => row.type === 'prompt'), false); assertInputOutcomes(b.events(), { one: 'not_sent' });
});
for (const mode of ['response-only', 'agent-end-only', 'error', 'length', 'aborted', 'abort', 'toolUse', 'pending', 'deferred', 'no-text', 'transform', 'handled'])
 test(`Pi ${mode} cannot produce completion or a result file`, async t => {
  const h = setup(t, mode), b = h.start(); b.send('one', 'original input');
  if (['handled', 'response-only', 'agent-end-only'].includes(mode)) b.child.stdin.end();
  else { await b.until(rows => rows.some(row => row.type === 'turn.failed')); b.child.stdin.end(); }
  assert.equal(await b.exited, 1, b.stderr()); assert.equal(b.events().some(row => row.type === 'turn.completed'), false);
  assert.equal(existsSync(join(h.area, RUN_FILES.resultTemp)), false);
  const message = b.events().find(row => row.type === 'turn.failed')?.error.message;
  const expected: Record<string, RegExp> = { error: /structured synthetic failure/, length: /length limit/,
   aborted: /aborted/, abort: /aborted/, 'no-text': /final text/, transform: /input.*unconfirmed/ };
  if (expected[mode]) assert.match(message, expected[mode]!);
  if (mode === 'error') {
   assert.doesNotMatch(JSON.stringify(b.events()), /synthetic-secret-value/);
   assert.ok(message.length <= 2000);
   writeFileSync(join(h.area, RUN_FILES.stdout), b.events().map(row => JSON.stringify(row)).join('\n') + '\n');
   const read = AGENT_RUNTIME_ADAPTERS.pi.read({ mode: 'start', session: null }, h.area, { code: 1, signal: null });
   assert.match(read.failure!.message, /structured synthetic failure/);
   assert.doesNotMatch(read.failure!.message, /synthetic reply|synthetic-secret-value/);
  }
 });
test('Pi waits beyond agent_end/retry and takes only final settled normal text', async t => {
 const h = setup(t, 'retry'), b = h.start(); b.send('one', 'retry synthetic input');
 await b.until(rows => rows.some(row => row.type === 'turn.completed')); b.child.stdin.end(); assert.equal(await b.exited, 0, b.stderr());
 assert.equal(b.events().filter(row => row.type === 'turn.completed').length, 1);
 assert.doesNotMatch(readFileSync(join(h.area, RUN_FILES.resultTemp), 'utf8'), /thinking|intermediate/);
});
for (const mode of ['hold', 'cancel', 'duplicate']) test(`Pi steer ${mode} keeps receipt identity and sends each ID once`, async t => {
 const h = setup(t, mode), b = h.start(), same = mode === 'duplicate';
 b.send('one', 'first'); await b.until(rows => rows.some(row => row.type === 'input.taken' && row.id === 'one'));
 b.send('two', same ? 'first' : 'second'); b.send('two', same ? 'first' : 'second');
 await b.until(rows => rows.some(row => row.type === 'input.accepted' && row.id === 'two'));
 assert.equal(b.events().some(row => row.type === 'turn.completed'), false);
 h.release(); await b.until(rows => rows.some(row => row.type === (mode === 'hold' ? 'turn.completed' : 'turn.failed')));
 b.child.stdin.end(); assert.equal(await b.exited, mode === 'hold' ? 0 : 1, b.stderr());
 assertInputOutcomes(b.events(), { one: 'taken', two: mode === 'hold' ? 'taken' : 'uncertain' });
 assert.equal(h.calls().filter(row => row.type === 'prompt').length, 2);
});
for (const mode of ['unicode', 'backpressure']) test(`Pi LF framing and ${mode} preserve the complete Unicode instruction`, async t => {
 const h = setup(t, mode), b = h.start(), text = '😀\u2028\u2029\n'.repeat(mode === 'backpressure' ? 10000 : 1);
 b.send('one', text); await b.until(rows => rows.some(row => row.type === 'turn.completed'));
 b.child.stdin.end(); assert.equal(await b.exited, 0, b.stderr());
 assert.equal(h.calls().find(row => row.type === 'prompt').message, text);
 assertInputOutcomes(b.events(), { one: 'taken' });
});
test('Pi rejects extension interaction with cancellation and reaps its child', async t => {
 const h = setup(t, 'extension'), b = h.start(); b.send('one', 'dialog');
 assert.equal(await b.exited, 1, b.stderr());
 assert.equal(h.calls().some(row => row.cancelled === true), true);
 assert.equal(h.calls().some(row => row.confirmed === true), false);
 const pid = h.calls().find(row => row.started).started;
 assert.equal(platform.run.commandProcesses(pid, null).length, 0);
});
test('Pi bridge signal waits for child and descendant cleanup', async t => {
 const h = setup(t, 'descendant'), b = h.start(); b.send('one', 'held');
 await b.until(rows => rows.some(row => row.type === 'input.taken'));
 const pid = h.calls().find(row => row.descendant).descendant;
 await delay(30); b.child.kill('SIGTERM'); assert.equal(await b.exited, 143, b.stderr());
 assert.equal(platform.run.commandProcesses(pid, null).length, 0);
});
test('Pi advanced trust flags are explicit and unknown options never disappear', async t => {
 const h = setup(t);
 for (const trust of ['--approve', '--no-approve']) {
  const b = h.start([trust]); b.send(trust, 'separate input ' + trust);
  await b.until(rows => rows.some(row => row.type === 'turn.completed')); b.child.stdin.end(); assert.equal(await b.exited, 0, b.stderr());
  assert.ok(h.calls().filter(row => row.started).at(-1).args.includes(trust));
 }
 const before = h.calls().filter(row => row.started).length;
 const b = h.start(['--unknown']); b.child.stdin.end(); assert.equal(await b.exited, 1); assert.match(b.stderr(), /Unknown option/);
 assert.equal(h.calls().filter(row => row.started).length, before);
});

// This fixture is kept verbatim: settled precedes the late steer response.
test('Pi settled versus late steer keeps both replies and closes backend input receipts', async t => {
 const h = setup(t, 'normal', 'fake-pi-late-steer.mjs'), b = h.start();
 const channel = new AgentInputChannel<string>(b.child.stdin, AGENT_RUNTIME_ADAPTERS.pi.input);
 const poll = () => {
  writeFileSync(join(h.area, RUN_FILES.stdout), b.events().map(row => JSON.stringify(row)).join('\n') + '\n');
  return channel.poll(h.area, null);
 };
 assert.equal(channel.write('run-one', 'first instruction', 'one'), true);
 await b.until(rows => rows.some(row => row.type === 'input.taken' && row.id === 'one'));
 assert.deepEqual(poll().taken, ['run-one']);
 assert.equal(channel.write('run-two', 'follow-up instruction', 'two'), true);
 await b.until(rows => rows.some(row => row.type === 'turn.completed' || row.type === 'turn.failed'));
 assert.equal(b.events().some(row => row.type === 'turn.failed'), false);
 assert.deepEqual(poll().taken, ['run-two']);
 assert.equal(channel.open, false, 'backend closes stdin after every taken input has completed');
 assert.equal(await b.exited, 0, b.stderr());
 assertInputOutcomes(b.events(), { one: 'taken', two: 'taken' });
 assert.equal(readFileSync(join(h.area, RUN_FILES.resultTemp), 'utf8'), 'reply 1\n\nreply 2');
 assert.equal(h.calls().filter(row => row.type === 'prompt').length, 2);
});
test('Pi completed separate turns permit identical text with a different input ID', async t => {
 const h = setup(t), b = h.start();
 b.send('one', 'synthetic repeat');
 await b.until(rows => rows.some(row => row.type === 'turn.completed'));
 b.send('two', 'synthetic repeat');
 await b.until(rows => rows.filter(row => ['turn.completed', 'turn.failed'].includes(row.type)).length === 2);
 b.child.stdin.end(); assert.equal(await b.exited, 0, b.stderr());
 assert.equal(b.events().filter(row => row.type === 'turn.completed').length, 2);
 assertInputOutcomes(b.events(), { one: 'taken', two: 'taken' });
 assert.equal(h.calls().filter(row => row.type === 'prompt').length, 2);
});
for (const mode of ['tail-json', 'tail-utf8', 'tail-line']) test(`Pi ${mode} at close cannot turn RPC corruption into exit zero`, async t => {
 const h = setup(t, mode), b = h.start(); b.send('one', 'synthetic EOF');
 await b.until(rows => rows.some(row => row.type === 'turn.completed'));
 b.child.stdin.end(); assert.equal(await b.exited, 1, b.stderr());
 assert.match(b.stderr(), /Pi RPC/);
});
