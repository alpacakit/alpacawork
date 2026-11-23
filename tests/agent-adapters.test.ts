/** Synthetic streams through the real adapter and input owners. No real CLI. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { AGENT_RUNTIME_ADAPTERS as adapters } from '@alpacawork/backend/test-dist/agents/registry.js';
import { AgentInputChannel } from '@alpacawork/backend/test-dist/runs/input.js';
import { readEnd } from '@alpacawork/backend/test-dist/runs/result-observation.js';
import { agentEnvironment } from '@alpacawork/backend/test-dist/runs/env.js';
import { MAX_LINE } from '@alpacawork/backend/test-dist/runs/readers/jsonl.js';
import { RUN_FILES, RUN_RESULT_LIMIT } from '@alpacawork/contract/run';
import { compileAgentSetting, defaultAgentSetting, prepareAgentLaunch } from '@alpacawork/contract';
import { BUILTIN_ADAPTER_IDS } from '@alpacawork/contract/agent-adapters';
import { codexUsage } from '../apps/agent-cli/test-dist/codex.js';
import { tokenUsage } from '../apps/agent-cli/test-dist/usage.js';

const start = { mode: 'start', session: null } as const;
const resume = { mode: 'resume', session: 'session' } as const;
const exit = { code: 0, signal: null };
const counters = { input: 10, cacheRead: 4, cacheWrite: 1, output: 2 };
function fixture(t: TestContext) {
  const folder = mkdtempSync(join(tmpdir(), 'adapter-unit-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const stream = (...rows: unknown[]) => writeFileSync(join(folder, RUN_FILES.stdout), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const append = (...rows: unknown[]) => appendFileSync(join(folder, RUN_FILES.stdout), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  return { folder, stream, append, reply: (text: string | Buffer) => writeFileSync(join(folder, RUN_FILES.resultTemp), text) };
}

test('native assigned sessions, reply, usage and tool activity use only root structured events', t => {
  const f = fixture(t), native = adapters.claude;
  f.stream({ type: 'command_lifecycle', state: 'started', command_uuid: 'input' },
    { type: 'result', session_id: 'child', is_error: false, result: 'wrong' },
    { type: 'assistant', session_id: 'session', message: { content: [{ type: 'text', text: 'Selected model is at capacity. Please try a different model.' }] } },
    { type: 'result', session_id: 'session', is_error: false, result: 'synthetic reply', modelUsage: {
      first: { inputTokens: 7, cacheReadInputTokens: 3, cacheCreationInputTokens: 1, outputTokens: 1 },
      second: { inputTokens: 3, cacheReadInputTokens: 1, cacheCreationInputTokens: 0, outputTokens: 1 },
    } });
  const read = native.read(resume, f.folder, exit);
  assert.deepEqual(read.outcome, { state: 'succeeded', session: 'session', result: 'synthetic reply' });
  assert.deepEqual(read.usage, { scope: 'conversation', counters });
  assert.equal(read.failure, undefined);
  const stdin = new PassThrough(), channel = new AgentInputChannel<string>(stdin, native.input);
  let sent = ''; stdin.on('data', chunk => { sent += chunk; });
  assert.equal(channel.write('run', 'literal {session}\nquoted "words"', 'input'), true);
  assert.deepEqual(JSON.parse(sent), { type: 'user', uuid: 'input', parent_tool_use_id: null,
    message: { role: 'user', content: 'literal {session}\nquoted "words"' } });
  assert.deepEqual(channel.poll(f.folder, 'session').taken, ['run']);
  assert.equal(channel.open, false);
  assert.deepEqual(native.activity({ type: 'assistant', parent_tool_use_id: null, message: { content: [
    { type: 'tool_use', name: 'Bash', id: 'tool', input: { command: 'git status' } }] } }, '2026-01-01T00:00:00Z')
    .map(event => [event.kind, event.id, event.toolName]), [['tool_start', 'tool', 'Bash']]);
  f.append({ type: 'command_lifecycle', state: 'started', command_uuid: 'next' });
  const unfinished = native.read(resume, f.folder, exit);
  assert.equal(unfinished.outcome.state, 'failed');
  assert.equal(unfinished.usage, null);
});

test('all bridge IDs consume the common boundary after admission, keep continuation identity and require a completed turn', t => {
  const f = fixture(t);
  f.stream({ type: 'turn.started' }, { type: 'input.accepted', id: 'one' }, { type: 'thread.started', thread_id: 'session' },
    { type: 'input.taken', id: 'one' }, { type: 'turn.completed', usage: { scope: 'run', counters } });
  f.reply('bridge reply');
  for (const id of BUILTIN_ADAPTER_IDS.filter(id => id !== 'claude')) {
    assert.equal(adapters[id].earlySession(start, f.folder), 'session', id);
    for (const invocation of [start, resume]) {
      const read = adapters[id].read(invocation, f.folder, exit);
      assert.deepEqual(read.outcome, { state: 'succeeded', session: 'session', result: 'bridge reply' }, id);
      assert.deepEqual(read.usage, { scope: 'run', counters }, id);
    }
    const mismatch = adapters[id].read({ ...resume, session: 'other' }, f.folder, exit);
    assert.equal(mismatch.outcome.state, 'failed', id);
    assert.equal(mismatch.session, null, id); assert.equal(mismatch.usage, null, id);
    assert.equal(adapters[id].earlySession({ ...resume, session: 'other' }, f.folder), null, id);
  }
  f.append({ type: 'turn.started' });
  assert.equal(adapters.codex.read(resume, f.folder, exit).outcome.state, 'failed');
  f.append({ type: 'thread.started', thread_id: 'other' }, { type: 'turn.completed', usage: null });
  assert.equal(adapters.codex.read(resume, f.folder, exit).outcome.state, 'failed');
});

test('Codex overload cannot hand off an unfinished tool even when activity omits it', t => {
  const f = fixture(t), failed = { code: 1, signal: null };
  for (const type of ['dynamic_tool_call', 'collab_agent_tool_call']) {
    const item = { type, id: 'tool' };
    for (const finished of [false, true]) {
      f.stream({ type: 'thread.started', thread_id: 'session' },
        { type: 'item.started', item: { type: 'agent_message', id: 'message' } },
        { type: 'item.started', item },
        ...finished ? [{ type: 'item.completed', item }] : [],
        { type: 'turn.failed', error: { cause: 'model_capacity' } });
      const observed = adapters.codex.read(resume, f.folder, failed);
      const end = readEnd({ observed, outcome: observed.outcome, exit: failed, measured: true });
      assert.equal(end.availability?.cause, 'model_capacity');
      assert.equal(end.handoffSafe, finished ? true : undefined, type);
    }
  }
});

test('adapter receipts preserve uncertainty, delayed taken and the existing single-attempt owner', t => {
  const f = fixture(t), stdin = new PassThrough();
  const channel = new AgentInputChannel<string>(stdin, adapters.codex.input), sent: string[] = [];
  stdin.on('data', chunk => sent.push(String(chunk)));
  f.stream({ type: 'thread.started', thread_id: 'session' });
  channel.write('run', 'synthetic input', 'one');
  f.append({ type: 'input.accepted', id: 'one' }, { type: 'input.refused', id: 'one' });
  assert.deepEqual(channel.poll(f.folder, 'session').receipts, []);
  f.append({ type: 'input.not_sent', id: 'one' });
  assert.equal(channel.poll(f.folder, 'session').receipts[0]?.outcome, 'uncertain');
  f.append({ type: 'input.uncertain', id: 'one' });
  assert.deepEqual(channel.poll(f.folder, 'session').receipts, []);
  assert.throws(() => channel.write('run', 'same input', 'one'), /already attempted/);
  f.append({ type: 'input.taken', id: 'one' });
  assert.deepEqual(channel.poll(f.folder, 'session').taken, ['run']);
  assert.equal(sent.length, 1);
  f.append({ type: 'input.not_sent', id: 'one', evidence: 'transfer_not_started' });
  assert.throws(() => channel.poll(f.folder, 'session'), /Contradictory/);
  channel.close();
});

test('damaged and oversized lines do not hide later receipts or manufacture a successful result', t => {
  const f = fixture(t), stdin = new PassThrough(), channel = new AgentInputChannel<string>(stdin, adapters.codex.input);
  stdin.resume(); channel.write('run', 'synthetic', 'one');
  writeFileSync(join(f.folder, RUN_FILES.stdout), '{broken\n' + 'x'.repeat(MAX_LINE + 1) + '\n');
  f.append({ type: 'thread.started', thread_id: 'session' }, { type: 'input.taken', id: 'one' }, { type: 'turn.completed', usage: null });
  f.reply('present');
  assert.deepEqual(channel.poll(f.folder, 'session').taken, ['run']);
  assert.deepEqual(adapters.codex.read(start, f.folder, exit).outcome, { state: 'failed', reason: 'output', resultState: 'too_large' });
});

test('missing, oversized, invalid UTF-8 and non-file replies fail at the actual bounded file boundary', t => {
  const f = fixture(t);
  f.stream({ type: 'thread.started', thread_id: 'session' }, { type: 'turn.completed', usage: null });
  for (const [text, reason] of [[null, 'missing'], ['x'.repeat(RUN_RESULT_LIMIT + 1), 'too_large'], [Buffer.from([255]), 'unreadable']] as const) {
    if (text !== null) f.reply(text);
    assert.deepEqual(adapters.codex.read(start, f.folder, exit).outcome, { state: 'failed', reason: 'output', resultState: reason });
  }
  rmSync(join(f.folder, RUN_FILES.resultTemp)); mkdirSync(join(f.folder, RUN_FILES.resultTemp));
  assert.deepEqual(adapters.codex.read(start, f.folder, exit).outcome, { state: 'failed', reason: 'output', resultState: 'unreadable' });
});

test('diagnostics require the selected session and structured failure, reset after success, and redact credentials', t => {
  const f = fixture(t), capacity = 'Selected model is at capacity. Please try a different model.';
  f.stream({ type: 'thread.started', thread_id: 'session' }, { type: 'item.completed', item: { type: 'agent_message', text: capacity } },
    { type: 'turn.failed', error: { message: capacity } });
  assert.equal(adapters.codex.read(resume, f.folder, { code: 1, signal: null }).failure?.cause, 'model_capacity');
  f.append({ type: 'turn.completed', usage: null }); f.reply('done');
  assert.equal(adapters.codex.read(resume, f.folder, exit).failure, undefined);
  f.stream({ type: 'result', session_id: 'other', is_error: true, result: capacity });
  assert.equal(adapters.claude.read(resume, f.folder, exit).failure, undefined);
  f.stream({ type: 'result', session_id: 'session', is_error: true, result: 'Authorization: Bearer synthetic-secret-value' });
  assert.doesNotMatch(adapters.claude.read(resume, f.folder, exit).failure?.message ?? '', /synthetic-secret-value/);
});

test('provider usage preserves cumulative versus turn counts and never fills missing cache counts with zero', () => {
  assert.deepEqual(codexUsage({ inputTokens: 15, cachedInputTokens: 4, cacheWriteInputTokens: 1, outputTokens: 2 }),
    { scope: 'conversation', counters });
  assert.equal(codexUsage({ inputTokens: 15, cachedInputTokens: 4, outputTokens: 2 }), null);
  assert.equal(codexUsage({ inputTokens: 2, cachedInputTokens: 4, cacheWriteInputTokens: 1, outputTokens: 2 }), null);
  assert.equal(tokenUsage({ input_tokens: 10, output_tokens: 2 }), null);
  assert.deepEqual(tokenUsage({ input_tokens: 10, cache_read_input_tokens: 4, cache_creation_input_tokens: 1, output_tokens: 2 }),
    { scope: 'run', counters });
});

test('one environment builder preserves conversation and operational names across both process boundaries', () => {
  const names = prepareAgentLaunch(compileAgentSetting('codex', { ...defaultAgentSetting('codex'), env: ['CUSTOM_TOKEN'] }),
    { mode: 'start', path: '/synthetic/bin' }).launch.env;
  assert.deepEqual(names, ['CODEX_HOME', 'CUSTOM_TOKEN']);
  const source = { HOME: '/synthetic/home', CODEX_HOME: '/synthetic/codex', CUSTOM_TOKEN: 'synthetic-secret',
    ANTHROPIC_API_KEY: 'unselected', ALPACAWORK_RUN: 'forged', NODE_OPTIONS: 'forged', LC_ALL: 'C',
    XDG_RUNTIME_DIR: '/synthetic/runtime', DBUS_SESSION_BUS_ADDRESS: 'synthetic-bus', COREPACK_ENABLE_NETWORK: '0' };
  const manager = agentEnvironment(source, '/synthetic/bin', 'http://synthetic.invalid', names);
  const agent = agentEnvironment(manager, '/synthetic/bin', 'http://synthetic.invalid', names);
  assert.deepEqual(agent, manager);
  assert.equal(agent.CUSTOM_TOKEN, source.CUSTOM_TOKEN);
  assert.equal(agent.CODEX_HOME, source.CODEX_HOME);
  assert.equal(agent.XDG_RUNTIME_DIR, source.XDG_RUNTIME_DIR);
  assert.equal(agent.COREPACK_ENABLE_NETWORK, '0');
  assert.equal(agent.DBUS_SESSION_BUS_ADDRESS, source.DBUS_SESSION_BUS_ADDRESS);
  assert.equal(agent.ALPACAWORK_RUN, undefined); assert.equal(agent.NODE_OPTIONS, undefined);
  assert.equal(agent.ANTHROPIC_API_KEY, undefined);
  assert.doesNotMatch(JSON.stringify(names), /synthetic-secret/);

});

test('only a verified later completion supersedes a damaged JSONL line for outcome, not diagnostics', t => {
  const f = fixture(t), capacity = 'Selected model is at capacity. Please try a different model.';
  const json = (value: unknown) => JSON.stringify(value) + '\n';
  const stdout = join(f.folder, RUN_FILES.stdout);
  f.reply('bridge reply');
  const bridgeStart = json({ type: 'thread.started', thread_id: 'session' });
  const bridgeEnd = json({ type: 'turn.completed', usage: { scope: 'run', counters } });
  const nativeEnd = json({ type: 'result', session_id: 'session', is_error: false, result: 'native reply' });
  for (const [id, prefix, end] of [['claude', '', nativeEnd], ['codex', bridgeStart, bridgeEnd]] as const) {
    const read = () => adapters[id].read(resume, f.folder, exit);
    writeFileSync(stdout, prefix + '{broken\n' + end);
    assert.equal(read().outcome.state, 'succeeded', id);
    writeFileSync(stdout, prefix + end + '{broken\n' + json({ type: 'other' }));
    assert.equal(read().outcome.state, 'failed', `${id}: damaged tail`);
    writeFileSync(stdout, prefix + '{broken\n' + json({ type: 'other' }));
    assert.equal(read().outcome.state, 'failed', `${id}: no completion`);
    writeFileSync(stdout, prefix + 'x'.repeat(MAX_LINE + 1) + '\n{broken\n' + end);
    assert.deepEqual(read().outcome, { state: 'failed', reason: 'output', resultState: 'too_large' }, `${id}: oversized then damaged`);
  }
  writeFileSync(stdout, bridgeStart + bridgeEnd + '{broken\n' + json({ type: 'turn.completed', parent_tool_use_id: 'child' }));
  assert.equal(adapters.codex.read(resume, f.folder, exit).outcome.state, 'failed', 'a child completion cannot repair the root stream');
  writeFileSync(stdout, bridgeStart + bridgeEnd + '{broken\n' + json({ type: 'turn.completed', session_id: 'foreign' }));
  assert.equal(adapters.codex.read(resume, f.folder, exit).outcome.state, 'failed', 'a foreign completion cannot repair the selected session');
  writeFileSync(stdout, nativeEnd + '{broken\n' + json({ type: 'result', session_id: 'other', is_error: false, result: 'child' }));
  assert.equal(adapters.claude.read(resume, f.folder, exit).outcome.state, 'failed', 'a foreign native result cannot repair the selected session');
  writeFileSync(stdout, bridgeStart + '{broken\n' + json({ type: 'turn.failed', error: { message: capacity } }));
  assert.equal(adapters.codex.read(resume, f.folder, exit).outcome.state, 'failed');
  assert.equal(adapters.codex.read(resume, f.folder, exit).failure, undefined, 'damaged output cannot prove a diagnostic');
  writeFileSync(stdout, bridgeStart + '{broken\n' + bridgeEnd + json({ type: 'turn.started' }) + json({ type: 'turn.failed', error: { message: capacity } }));
  assert.equal(adapters.codex.read(resume, f.folder, exit).failure, undefined, 'a later failure cannot recover damaged diagnostic evidence');
  writeFileSync(stdout, '{broken\n' + json({ type: 'result', session_id: 'session', is_error: true, result: capacity }));
  assert.equal(adapters.claude.read(resume, f.folder, exit).outcome.state, 'failed');
  assert.equal(adapters.claude.read(resume, f.folder, exit).failure, undefined);
});
