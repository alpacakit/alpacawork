import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { judgeClaudeExecutable, runClaudeJudge } from '@alpacawork/backend/test-dist/agents/adapters/judge-claude.js';

test('the Claude judgment transport accepts thinking metadata and rejects tools or unknown output', async t => {
  const root = mkdtempSync(join(tmpdir(), 'alpacawork-judge-transport-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = { root, executable: join(root, 'judge-fixture.sh') };
  writeFileSync(f.executable, '', { mode: 0o700 });
  const savedState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = f.root;
  t.after(() => { if (savedState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = savedState; });
  const model = 'claude-haiku-synthetic';
  const init = { type: 'system', subtype: 'init', model, tools: [], mcp_servers: [], skills: [] };
  const assistant = { type: 'assistant', message: { model, content: [{ type: 'text', text: 'Synthetic' }] } };
  const thinking = { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 258, estimated_tokens_delta: 208,
    session_id: randomUUID(), uuid: randomUUID() };
  const result = { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: '{"pass":true,"reason":"Synthetic"}',
    total_cost_usd: 0.00021, modelUsage: { [model]: { inputTokens: 2, outputTokens: 3 } } };
  const emit = (rows: unknown[]) => {
    writeFileSync(f.executable, '#!/bin/sh\n/bin/cat >/dev/null\n/bin/cat <<\'END_OUTPUT\'\n' + rows.map(row => JSON.stringify(row)).join('\n') + '\nEND_OUTPUT\n');
  };
  emit([init, thinking, { type: 'assistant', message: { model, content: [{ type: 'thinking', thinking: 'Synthetic' }] } }, assistant,
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }, result]);
  const accepted = await runClaudeJudge(f.executable, '{}', AbortSignal.timeout(3000));
  assert.equal(accepted.kind, 'answer');
  assert.equal(accepted.usage?.costUsd, 0.00021);
  for (const terminal of [
    { ...result, subtype: 'error_during_execution', is_error: true },
    { ...result, subtype: 'new_result_format', is_error: undefined },
  ]) {
    emit([init, thinking, terminal]);
    const failed = await runClaudeJudge(f.executable, '{}', AbortSignal.timeout(3000));
    assert.equal(failed.kind, 'failed');
    assert.equal(failed.usage?.costUsd, 0.00021);
  }
  for (const rows of [
    [{ ...init, tools: ['Bash'] }, assistant, result],
    [init, { type: 'user', message: { content: [{ type: 'tool_result' }] } }, assistant, result],
    [init, thinking, { type: 'assistant', message: { model, content: [{ type: 'tool_use', name: 'Read' }] } }, assistant, result],
    [init, { ...thinking, unexpected: true }, assistant, result],
    [init, { ...thinking, session_id: [] }, assistant, result],
    [init, { type: 'system', subtype: 'future_event' }, assistant, result],
    [init, 42, assistant, result],
    [{ ...init, model: 'claude-sonnet-synthetic' }, assistant, result],
  ]) {
    emit(rows);
    assert.equal((await runClaudeJudge(f.executable, '{}', AbortSignal.timeout(3000))).kind, 'failed');
  }
  const observed = join(f.root, 'unsafe-material.txt');
  writeFileSync(f.executable, `#!/bin/sh
/bin/cat >> '${observed}'
printf '%s' '{"type":"system","subtype":"hook_started"}'
`);
  assert.equal((await runClaudeJudge(f.executable, 'first', AbortSignal.timeout(3000))).kind, 'failed');
  assert.equal((await runClaudeJudge(f.executable, 'second', AbortSignal.timeout(3000))).kind, 'failed');
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { runClaudeJudge } from '@alpacawork/backend/test-dist/agents/adapters/judge-claude.js';
    console.log((await runClaudeJudge(process.argv[1], 'after restart', AbortSignal.timeout(3000))).kind);
  `, f.executable], { encoding: 'utf8' }).trim(), 'failed');
  assert.equal(readFileSync(observed, 'utf8'), 'first');
  writeFileSync(f.executable, `#!/bin/sh
/bin/cat >> '${observed}'
printf '%s' '{"type":"tool_progress","tool_use_id":"synthetic","tool_name":"Bash"}'
`);
  assert.equal((await runClaudeJudge(f.executable, 'tool progress', AbortSignal.timeout(3000))).kind, 'failed');
  assert.equal((await runClaudeJudge(f.executable, 'repeated progress', AbortSignal.timeout(3000))).kind, 'failed');
  assert.equal(readFileSync(observed, 'utf8'), 'firsttool progress');
  const saved = process.env.CLAUDE_CONFIG_DIR;
  t.after(() => { if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved; });
  process.env.CLAUDE_CONFIG_DIR = join(f.root, 'managed-fixture');
  mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, 'managed-settings.json'), '{}');
  emit([init, assistant, result]);
  assert.equal(judgeClaudeExecutable(), null);
  assert.equal((await runClaudeJudge(f.executable, '{}', AbortSignal.timeout(3000))).kind, 'failed');
});
