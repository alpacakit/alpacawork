import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_RUNTIME_ADAPTERS } from '@alpacawork/backend/test-dist/agents/registry.js';

for (const agent of ['claude', 'codex'] as const) {
  test(`${agent} reads its final reply beyond 16 MiB of image events`, t => {
    const folder = mkdtempSync(join(tmpdir(), 'read-output-'));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    const image = JSON.stringify(agent === 'codex'
      ? { type: 'item.completed', item: { type: 'mcp_tool_call', result: { content: [{ type: 'image', data: 'A'.repeat(1024 * 1024) }] } } }
      : { type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'image', data: 'A'.repeat(1024 * 1024) }] }] } }) + '\n';
    const start = agent === 'codex' ? { type: 'thread.started', thread_id: 's1' } : { type: 'system', subtype: 'init', session_id: 's1' };
    const end = agent === 'codex' ? { type: 'turn.completed' } : { type: 'result', session_id: 's1', result: 'reply', is_error: false };
    writeFileSync(join(folder, 'stdout.log'), JSON.stringify(start) + '\n' + image.repeat(17) + JSON.stringify(end) + '\n');
    if (agent === 'codex') writeFileSync(join(folder, 'result.tmp'), 'reply');
    const result = AGENT_RUNTIME_ADAPTERS[agent].read({ mode: 'start', session: agent === 'claude' ? 's1' : null }, folder,
      { code: 0, signal: null });
    assert.deepEqual(result.outcome, { state: 'succeeded', result: 'reply', session: 's1' });
  });
}
