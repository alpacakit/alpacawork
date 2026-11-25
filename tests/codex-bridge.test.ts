import { AGENT_RUNTIME_ADAPTERS } from '@alpacawork/backend/test-dist/agents/registry.js';
import { RunStepIndex } from '@alpacawork/backend/test-dist/runs/run-steps.js';
import { BRIDGE_LINE_BYTES } from '@alpacawork/contract/agent-bridge';
import { RUN_FILES } from '@alpacawork/contract/run';
import { processIdentity } from '@alpacawork/core';
/** alpacawork-agent speaks `codex exec` to alpacawork and app-server to Codex; a fake app-server only. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnBridge } from './helpers/bridge-process.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertInputOutcomes } from './fixtures/input-outcomes.ts';

const bridge = join(import.meta.dirname, '../apps/agent-cli/test-dist/cli.js');

function setup(t: TestContext) {
  const area = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-agent-')));
  t.after(() => rmSync(area, { recursive: true, force: true }));
  const logPath = join(area, 'server.jsonl');
  /** Start the bridge; `send` writes one instruction line, `events` is its stdout so far. */
  const start = (args: string[], env: NodeJS.ProcessEnv = {}) => {
    const { child, exited, events, until, stderr, send } = spawnBridge(t, [bridge, 'codex', '--command', process.execPath, ...args], { cwd: area,
      env: { ...process.env, CODEX_HOME: join(area, 'explicit-codex'), PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${new URL("./fixtures/codex-app-server-loader.mjs",import.meta.url).href}`,
        FAKE_CODEX_LOG: logPath, ...env } });

    return { child, exited, events, until, stderr,
      send };
  };
  const server = () => existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { area, start, server, gate: (name: string) => join(area, name) };
}

test('exec options, JSONL, result file and exit; an instruction during a turn is steered into it', async t => {
  const h = setup(t);
  const result = join(h.area, 'result.txt');
  const b = h.start(['-m', 'gpt-test', '-c', 'model_reasoning_effort=low', '-c', 'service_tier=fast', '-s', 'danger-full-access',
    '--skip-git-repo-check', '--json', '-o', result]);
  t.diagnostic(`bridge identity: ${JSON.stringify(processIdentity(b.child.pid!))}`);
  b.send('in-1', JSON.stringify({ gate: h.gate('turn') }));
  await b.until(events => events.some(event => event.type === 'input.taken' && event.id === 'in-1'), 'first taken');
  b.send('in-2', 'also this');
  await b.until(events => events.some(event => event.type === 'input.taken' && event.id === 'in-2'), 'steer taken');
  writeFileSync(h.gate('turn'), 'go');
  await b.until(events => events.some(event => event.type === 'turn.completed'), 'turn completed');
  b.child.stdin.end();
  assert.equal(await b.exited, 0);
  assertInputOutcomes(b.events(), { 'in-1': 'taken', 'in-2': 'taken' });
  assert.deepEqual(b.events().filter(event => event.type !== 'input.accepted').map(event => event.type),
    ['thread.started', 'turn.started', 'input.taken', 'input.taken', 'item.started', 'item.completed', 'turn.completed']);
  assert.deepEqual(b.events()[0], { type: 'thread.started', thread_id: 'thread-new' });
  for (const id of ['in-1', 'in-2']) {
    const inputEvents = b.events().filter(event => event.id === id).map(event => event.type);
    assert.deepEqual(inputEvents, ['input.accepted', 'input.taken']);
  }
  assert.deepEqual(b.events().find(event => event.type === 'item.completed').item,
    { type: 'agent_message', id: 'm-turn-1', text: 'reply turn-1' });
  // Only the fields a step is read by cross the boundary, each bounded (boundaryItem): one oversized line voids the Run.
  assert.deepEqual(b.events().find(event => event.type === 'item.started').item,
    { type: 'command_execution', id: 'c-turn-1', command: 'true', aggregatedOutput: 'provider output' });
  assert.deepEqual(b.events().find(event => event.type === 'turn.completed').usage,
    { scope: 'conversation', counters: { input: 5, cacheRead: 4, cacheWrite: 1, output: 2 } });
  assert.equal(readFileSync(result, 'utf8'), 'reply turn-1');
  writeFileSync(join(h.area, RUN_FILES.stdout), b.events().map(event => JSON.stringify(event)).join('\n') + '\n');
  writeFileSync(join(h.area, RUN_FILES.resultTemp), readFileSync(result));
  const read = AGENT_RUNTIME_ADAPTERS.codex.read({ mode: 'start', session: null }, h.area, { code: 0, signal: null });
  assert.deepEqual(read.outcome, { state: 'succeeded', session: 'thread-new', result: 'reply turn-1' });
  assert.deepEqual(read.usage, b.events().find(event => event.type === 'turn.completed').usage);

  const requests = h.server();
  assert.deepEqual(requests[0].argv, ['app-server', '-c', 'model_reasoning_effort=low', '-c', 'service_tier=fast']);
  assert.deepEqual(requests.find(item => item.method === 'thread/start').params,
    { model: 'gpt-test', sandbox: 'danger-full-access', approvalPolicy: 'never', cwd: h.area });
  const steer = requests.find(item => item.method === 'turn/steer').params;
  assert.deepEqual({ ...steer, input: steer.input[0].text }, { threadId: 'thread-new', expectedTurnId: 'turn-1',
    clientUserMessageId: 'in-2', input: 'also this' });
});

test('a saved image line reaches Codex as localImage beside the unchanged instruction text', async t => {
  const h = setup(t);
  const image = join(h.area, 'shot.png');
  writeFileSync(image, Buffer.from([137, 80, 78, 71]));
  const b = h.start(['-o', join(h.area, 'result.txt')]);
  const instruction = `Please review\n\n![shot.png](${image})`;
  b.send('image-1', instruction);
  await b.until(events => events.some(event => event.type === 'turn.completed'), 'image turn completed');
  b.child.stdin.end();
  assert.equal(await b.exited, 0);
  assert.deepEqual(h.server().find(item => item.method === 'turn/start').params.input,
    [{ type: 'text', text: instruction, text_elements: [] }, { type: 'localImage', path: image }]);
});

test('a sub-agent thread does not start, steer, answer or end the turn of the thread it serves', async t => {
  const h = setup(t);
  const result = join(h.area, 'result.txt');
  const b = h.start(['--json', '-o', result]);
  b.send('in-1', JSON.stringify({ child: true, gate: h.gate('turn') }));
  await b.until(() => h.server().some(item => item.child === 'done'), 'child turn over');
  b.send('in-2', 'while the child is done');
  await b.until(events => events.some(event => event.type === 'input.taken' && event.id === 'in-2'), 'steer taken');
  b.child.stdin.end();
  await delay(100);
  assert.equal(b.events().some(event => event.type === 'turn.completed'), false);
  writeFileSync(h.gate('turn'), 'go');
  assert.equal(await b.exited, 0);
  assertInputOutcomes(b.events(), { 'in-1': 'taken', 'in-2': 'taken' });
  assert.deepEqual(b.events().filter(event => event.type.startsWith('turn.')).map(event => event.type), ['turn.started', 'turn.completed']);
  assert.equal(b.events().some(event => event.item?.id === 'm-child-turn-1'), false);
  assert.equal(b.events().find(event => event.type === 'turn.completed').usage.counters.input, 5);
  assert.equal(readFileSync(result, 'utf8'), 'reply turn-1');
  assert.equal(h.server().find(item => item.method === 'turn/steer').params.expectedTurnId, 'turn-1');
});

test('resume continues the session, a refused steer is reported, and an instruction between turns starts the next', async t => {
  const h = setup(t);
  const b = h.start(['-s', 'danger-full-access', 'resume', '--skip-git-repo-check', '--json', '-o', join(h.area, 'r.txt'), '--', 'thread-old']);
  b.send('in-1', JSON.stringify({ gate: h.gate('one') }));
  await b.until(events => events.some(event => event.type === 'input.taken'), 'first taken');
  b.send('in-2', 'please refuse');
  await b.until(events => events.some(event => event.type === 'input.uncertain'), 'uncertain');
  assert.deepEqual(b.events().find(event => event.type === 'input.uncertain'), { type: 'input.uncertain', id: 'in-2', message: 'steer refused' });
  writeFileSync(h.gate('one'), 'go');
  await b.until(events => events.some(event => event.type === 'turn.completed'), 'first turn completed');
  b.send('in-3', JSON.stringify({ fail: 'usageLimitExceeded' }));
  await b.until(events => events.some(event => event.type === 'turn.failed'), 'second turn failed');
  b.child.stdin.end();
  // The last turn decides the exit, as `codex exec` fails with a failed turn.
  assert.equal(await b.exited, 1);
  assertInputOutcomes(b.events(), { 'in-1': 'taken', 'in-2': 'uncertain', 'in-3': 'taken' });
  assert.equal(h.server().find(item => item.method === 'thread/resume').params.threadId, 'thread-old');
  // A spent plan is told as the cause the next AI takes over on.
  assert.deepEqual(b.events().find(event => event.type === 'turn.failed'), { type: 'turn.failed', error: { message: 'fake failure', cause: 'session_limit' } });
  assert.deepEqual(b.events().filter(event => event.type === 'thread.started'), [{ type: 'thread.started', thread_id: 'thread-old' }]);
});

test('an unknown option or a missing session is refused before Codex starts', async t => {
  const h = setup(t);
  for (const args of [['--color', 'never'], ['resume'], ['resume', 'a', 'b']]) {
    const b = h.start(args);
    b.child.stdin.end();
    assert.equal(await b.exited, 1, args.join(' '));
    assert.match(b.stderr(), /alpacawork-agent: .*\nUsage: alpacawork-agent/);
  }
  assert.deepEqual(h.server(), []);
});

test('agent selection is required and unknown agents do not start Codex', async t => {
  const h = setup(t);
  for (const args of [[], ['unknown']]) {
    const { child, exited, stderr } = spawnBridge(t, [bridge, ...args], { cwd: h.area });
    child.stdin.end();
    assert.equal(await exited, 1);
    assert.match(stderr(), /Usage: alpacawork-agent <agent>/);
  }
  assert.deepEqual(h.server(), []);
});

test('closing stdin without an instruction fails after opening the thread', async t => {
  const h = setup(t);
  const b = h.start([]);
  await b.until(events => events.some(event => event.type === 'thread.started'), 'thread started');
  b.child.stdin.end();
  assert.equal(await b.exited, 1);
  assert.match(b.stderr(), /no instruction arrived on stdin/);
});

test('default home shares inputs but opens and resumes threads only in the dedicated home', async t => {
  const h = setup(t);
  const source = join(h.area, '.codex'), target = join(h.area, '.codex-alpacawork');
  mkdirSync(source);
  writeFileSync(join(source, 'auth.json'), '{}');
  writeFileSync(join(source, 'config.toml'), 'model_reasoning_effort="high"');
  const env = { HOME: h.area, CODEX_HOME: undefined, CODEX_SQLITE_HOME: join(h.area, 'external-db') };
  for (const args of [[], ['resume', 'thread-new']]) {
    const b = h.start(args, env);
    b.send('one', 'hello');
    b.child.stdin.end();
    assert.equal(await b.exited, 0, b.stderr());
  }
  const rows = h.server();
  assert.deepEqual(rows.filter(x => x.argv).map(x => x.codexHome), [source, target, source, target]);
  for (const opened of rows.filter(x => x.argv && x.codexHome === target)) {
    assert.equal(opened.sqliteHome, target);
    assert.ok(opened.argv.includes(`sqlite_home=${JSON.stringify(target)}`));
  }
  let activeHome;
  for (const row of rows) {
    if (row.argv) activeHome = row.codexHome;
    if (row.method === 'thread/start' || row.method === 'thread/resume') assert.equal(activeHome, target);
  }
  assert.equal(realpathSync(join(target, 'auth.json')), join(source, 'auth.json'));
  assert.equal(readFileSync(join(target, 'config.toml'), 'utf8'), 'model_reasoning_effort="high"');
  assert.equal(rows.filter(x => x.method === 'thread/start').length, 1);
  assert.equal(rows.filter(x => x.method === 'thread/resume').length, 1);
});

test('default isolation refuses unsupported auth and missing accounts before opening any thread', async t => {
  for (const config of [{ cli_auth_credentials_store: 'keyring' }, {}]) {
    const h = setup(t);
    mkdirSync(join(h.area, '.codex'));
    writeFileSync(join(h.area, '.codex/auth.json'), '{}');
    const b = h.start([], { HOME: h.area, CODEX_HOME: undefined, FAKE_CODEX_CONFIG: JSON.stringify(config), FAKE_CODEX_NO_ACCOUNT: '1' });
    b.child.stdin.end();
    assert.equal(await b.exited, 1);
    assert.match(b.stderr(), /authentication|CODEX_HOME/);
    assert.equal(h.server().some(x => x.method === 'thread/start' || x.method === 'thread/resume'), false);
  }
});

test('a specifically requested pre-isolation rollout is resumed in place, without a new thread', async t => {
  const h = setup(t), source = join(h.area, '.codex');
  mkdirSync(join(source, 'sessions'), { recursive: true });
  writeFileSync(join(source, 'auth.json'), '{}');
  const id = '0199e4ba-1111-7111-8111-111111111111';
  const path = join(source, 'sessions', `rollout-old-${id}.jsonl`);
  writeFileSync(path, 'keep original');
  const b = h.start(['resume', id], { HOME: h.area, CODEX_HOME: undefined });
  b.send('one', 'hello'); b.child.stdin.end();
  assert.equal(await b.exited, 0, b.stderr());
  assert.equal(h.server().some(x => x.method === 'thread/start'), false);
  assert.equal(h.server().find(x => x.argv).codexHome, source);
  assert.equal(h.server().find(x => x.method === 'thread/resume').params.threadId, id);
  assert.match(b.stderr(), /existing conversation in its original Codex home/);
  assert.equal(readFileSync(path, 'utf8'), 'keep original');
});

for (const phase of ['initial','continuation']) for (const fault of ['disconnect_before_reply','error_then_exit'])
  test(`provider transfer ${phase}: ${fault} preserves uncertainty without resending`, async t => {
    const h=setup(t), b=h.start([]), gate=h.gate('fault-turn');
    if(phase==='continuation') { b.send('first',JSON.stringify({gate})); await b.until(rows=>rows.some(r=>r.type==='input.taken'&&r.id==='first')); }
    b.send('lost',JSON.stringify({[fault]:true}));
    await b.until(rows=>rows.some(r=>r.type==='input.uncertain'&&r.id==='lost'));
    b.child.stdin.end(); assert.equal(await b.exited,1);
    assertInputOutcomes(b.events(),{lost:'uncertain'});
    assert.equal(h.server().filter(row=>row.processedInput==='lost').length,1,'the provider subject processed one transfer');
    assert.equal(b.events().some(row=>row.type==='input.not_sent'&&row.id==='lost'),false);
  });
for (const phase of ['initial','continuation']) test(`a delayed ${phase} provider start resolves uncertainty and duplicate input does not deliver again`,async t=>{
  const h=setup(t),b=h.start([]),gate=h.gate('delayed');
  if(phase==='continuation'){b.send('first',JSON.stringify({gate}));await b.until(rows=>rows.some(r=>r.type==='input.taken'&&r.id==='first'));}
  const text=JSON.stringify({gate,delayed_taken:true});b.send('late',text);
  await b.until(rows=>rows.some(r=>r.type==='input.uncertain'&&r.id==='late'));
  b.send('late',text);
  await b.until(rows=>rows.some(r=>r.type==='input.taken'&&r.id==='late'));
  writeFileSync(gate,'go');await b.until(rows=>rows.some(r=>r.type==='turn.completed'));b.child.stdin.end();assert.equal(await b.exited,0);
  assertInputOutcomes(b.events(),{late:'taken'});
  assert.equal(h.server().filter(row=>row.processedInput==='late').length,1);
});
test('same input ID with different content is fatal and never reaches the provider a second time',async t=>{
 const h=setup(t),b=h.start([]),gate=h.gate('identity-hold');b.send('one',JSON.stringify({gate}));await b.until(rows=>rows.some(r=>r.type==='input.taken'&&r.id==='one'));b.send('one','different content');assert.equal(await b.exited,1);assert.match(b.stderr(),/Input ID reused with different content/);assert.equal(h.server().filter(row=>row.processedInput==='one').length,1);assert.equal(h.server().filter(row=>row.method==='turn/steer').length,0);
});

test('an ordinary start needs no skill receipt and preserves caller skill settings', async t => {
  const h = setup(t);
  const b = h.start(['-c', 'skills.config=[{name="x",enabled=false}]']);
  b.send('one', 'hello'); b.child.stdin.end();
  assert.equal(await b.exited, 0, b.stderr());
  const rows = h.server();
  assert.deepEqual(rows[0].argv, ['app-server', '-c', 'skills.config=[{name="x",enabled=false}]']);
  assert.equal(rows[0].codexHome, join(h.area, 'explicit-codex'));
  assert.deepEqual(rows.filter(row => row.method).map(row => row.method), ['initialize', 'initialized', 'thread/start', 'turn/start']);
});

test('a failure during initialize records a seen input not_sent', async t => {
  const h = setup(t), gate = h.gate('initialize-gate');
  const b = h.start([], { FAKE_CODEX_INITIALIZE_GATE: gate, FAKE_CODEX_INITIALIZE_EXIT: '1' });
  b.send('one', 'hello'); b.child.stdin.write('marker\n');
  for (let at = Date.now(); !b.stderr().includes('ignored an input line'); await delay(5)) assert.ok(Date.now() - at < 10_000);
  writeFileSync(gate, '');
  assert.equal(await b.exited, 1);
  assertInputOutcomes(b.events(), { one: 'not_sent' });
  assert.equal(b.events().find(row => row.type === 'input.not_sent').evidence, 'transfer_not_started');
  assert.equal(h.server().some(row => row.method === 'turn/start'), false);
});

test('a close while the probe server stops does not start the thread server', async t => {
  const h = setup(t), source = join(h.area, '.codex');
  mkdirSync(source); writeFileSync(join(source, 'auth.json'), '{}');
  const b = h.start([], { HOME: h.area, CODEX_HOME: undefined, FAKE_CODEX_TERM_DELAY_MS: '1500' });
  for (let at = Date.now(); !h.server().some(row => row.term); await delay(5)) assert.ok(Date.now() - at < 10_000, 'probe stopping');
  b.send('one', 'first'); b.send('one', 'other');
  assert.equal(await b.exited, 1);
  assert.match(b.stderr(), /Input ID reused with different content/);
  assert.equal(h.server().filter(row => row.argv).length, 1, 'no second server');
  assertInputOutcomes(b.events(), { one: 'not_sent' });
});


test('a later successful turn without a fresh usage observation remains unmeasured', async t => {
  const h = setup(t), b = h.start([]);
  b.send('known', 'synthetic first');
  await b.until(rows => rows.filter(row => row.type === 'turn.completed').length === 1);
  assert.ok(b.events().find(row => row.type === 'turn.completed').usage);
  b.send('unknown', JSON.stringify({ noUsage: true }));
  await b.until(rows => rows.filter(row => row.type === 'turn.completed').length === 2);
  b.child.stdin.end(); assert.equal(await b.exited, 0);
  assert.equal(b.events().filter(row => row.type === 'turn.completed')[1].usage, null);
});

for (const failure of [null, 'synthetic compaction failure']) test(`a compaction ${failure ? 'that fails is told and still' : 'before the first instruction then'} lets it run as its own turn`, async t => {
  const h = setup(t), result = join(h.area, 'result.txt');
  const b = h.start(['-o', result, 'resume', 'thread-old'], failure ? { FAKE_CODEX_COMPACT_FAIL: failure } : {});
  b.child.stdin.write(`${JSON.stringify({ id: 'one', text: 'after compaction', compact: { instructions: null } })}\n`);
  await b.until(events => events.some(event => event.type === 'turn.completed'), 'instruction turn completed');
  b.child.stdin.end();
  assert.equal(await b.exited, 0, b.stderr());
  assert.deepEqual(h.server().filter(row => ['thread/compact/start', 'turn/start'].includes(row.method)).map(row => row.method),
    ['thread/compact/start', 'turn/start']);
  const types = b.events().map(event => event.type).filter(type => type.startsWith('compaction.') || type.startsWith('turn.'));
  assert.deepEqual(types, [failure ? 'compaction.failed' : 'compaction.completed', 'turn.started', 'turn.completed']);
  if (failure) assert.match(b.events().find(event => event.type === 'compaction.failed').message, new RegExp(failure));
  assertInputOutcomes(b.events(), { one: 'taken' });
  assert.equal(readFileSync(result, 'utf8'), 'reply turn-1');
  assert.equal(b.events().some(event => event.item?.type === 'context_compaction'), false);
});

test('a structured result past the outcome reader\'s line limit leaves the Run succeeded, its step read with what was left out said', async t => {
  const h = setup(t);
  const result = join(h.area, 'result.txt');
  const b = h.start(['--json', '-o', result]);
  b.send('big', JSON.stringify({ bigResult: true }));
  await b.until(events => events.some(event => event.type === 'turn.completed'), 'turn completed');
  b.child.stdin.end();
  assert.equal(await b.exited, 0);
  const lines = b.events().map(event => JSON.stringify(event));
  assert.ok(lines.every(line => Buffer.byteLength(line) <= BRIDGE_LINE_BYTES));
  writeFileSync(join(h.area, RUN_FILES.stdout), lines.join('\n') + '\n');
  writeFileSync(join(h.area, RUN_FILES.resultTemp), readFileSync(result));
  const read = AGENT_RUNTIME_ADAPTERS.codex.read({ mode: 'start', session: null }, h.area, { code: 0, signal: null });
  assert.equal(read.outcome.state, 'succeeded');
  const index = new RunStepIndex(h.area, AGENT_RUNTIME_ADAPTERS.codex);
  await index.update();
  const step = index.range(undefined, 12).steps.find(each => each.tool === 'db.rows')!;
  assert.equal(step.state, 'done');
  const detail = await index.detail(step.n);
  // Each text in the result was cut until the line fit; the structured result is read as its JSON.
  assert.ok(detail!.output!.text.startsWith('[\n  {\n    "id": 0,'));
  assert.ok(detail!.output!.omitted > 0);
});

test('a result nested 2,800 arrays deep leaves the Run succeeded with its reply, and its step read with what was left out', async t => {
  const h = setup(t);
  const result = join(h.area, 'result.txt');
  const b = h.start(['--json', '-o', result]);
  b.send('deep', JSON.stringify({ deepResult: true }));
  await b.until(events => events.some(event => event.type === 'turn.completed'), 'turn completed');
  b.child.stdin.end();
  assert.equal(await b.exited, 0, b.stderr());
  const lines = b.events().map(event => JSON.stringify(event));
  assert.ok(lines.every(line => Buffer.byteLength(line) <= BRIDGE_LINE_BYTES));
  assert.equal(readFileSync(result, 'utf8'), 'reply turn-1');
  writeFileSync(join(h.area, RUN_FILES.stdout), lines.join('\n') + '\n');
  writeFileSync(join(h.area, RUN_FILES.resultTemp), readFileSync(result));
  assert.deepEqual(AGENT_RUNTIME_ADAPTERS.codex.read({ mode: 'start', session: null }, h.area, { code: 0, signal: null }).outcome,
    { state: 'succeeded', session: 'thread-new', result: 'reply turn-1' });
  const index = new RunStepIndex(h.area, AGENT_RUNTIME_ADAPTERS.codex);
  await index.update();
  const step = index.range(undefined, 12).steps.find(each => each.tool === 'db.tree')!;
  assert.equal(step.state, 'done');
  const detail = await index.detail(step.n);
  assert.ok(detail!.output!.text.startsWith('[\n  [\n'));
  assert.ok(detail!.output!.omitted > 0);
});

test('an edit of sixty thousand files leaves the Run succeeded, and opens to its first files and how many more there are', async t => {
  const h = setup(t);
  const result = join(h.area, 'result.txt');
  const b = h.start(['--json', '-o', result]);
  b.send('huge', JSON.stringify({ hugeEdit: true }));
  await b.until(events => events.some(event => event.type === 'turn.completed'), 'turn completed');
  b.child.stdin.end();
  assert.equal(await b.exited, 0, b.stderr());
  const lines = b.events().map(event => JSON.stringify(event));
  assert.ok(lines.every(line => Buffer.byteLength(line) <= BRIDGE_LINE_BYTES));
  writeFileSync(join(h.area, RUN_FILES.stdout), lines.join('\n') + '\n');
  writeFileSync(join(h.area, RUN_FILES.resultTemp), readFileSync(result));
  assert.equal(AGENT_RUNTIME_ADAPTERS.codex.read({ mode: 'start', session: null }, h.area, { code: 0, signal: null }).outcome.state, 'succeeded');
  const index = new RunStepIndex(h.area, AGENT_RUNTIME_ADAPTERS.codex);
  await index.update();
  const step = index.range(undefined, 12).steps.find(each => each.kind === 'edit')!;
  assert.equal(step.state, 'done');
  const detail = await index.detail(step.n);
  assert.ok(detail!.input.text.startsWith('add: /src/packages/module-0/file-0.ts\n+export const v0 = 0;'));
  assert.ok(detail!.input.omittedFiles! > 0);
});

test('a call to sixty thousand threads with a large diagnostic leaves the Run succeeded, its step saying its details could not be kept', async t => {
  const h = setup(t);
  const result = join(h.area, 'result.txt');
  const b = h.start(['--json', '-o', result]);
  b.send('many', JSON.stringify({ manyReceivers: true }));
  await b.until(events => events.some(event => event.type === 'turn.completed'), 'turn completed');
  b.child.stdin.end();
  assert.equal(await b.exited, 0, b.stderr());
  const lines = b.events().map(event => JSON.stringify(event));
  assert.ok(lines.every(line => Buffer.byteLength(line) <= BRIDGE_LINE_BYTES));
  writeFileSync(join(h.area, RUN_FILES.stdout), lines.join('\n') + '\n');
  writeFileSync(join(h.area, RUN_FILES.resultTemp), readFileSync(result));
  assert.equal(AGENT_RUNTIME_ADAPTERS.codex.read({ mode: 'start', session: null }, h.area, { code: 0, signal: null }).outcome.state, 'succeeded');
  const index = new RunStepIndex(h.area, AGENT_RUNTIME_ADAPTERS.codex);
  await index.update();
  const step = index.range(undefined, 12).steps.find(each => each.id === 'r-turn-1')!;
  assert.equal((await index.detail(step.n))?.detailsDropped, true);
});
