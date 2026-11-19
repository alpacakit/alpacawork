import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutputActivityReader } from '@alpacawork/backend/test-dist/runs/activity.js';
import { readRecentWork } from '@alpacawork/backend/test-dist/runs/recent-work.js';
import { AGENT_RUNTIME_ADAPTERS } from '@alpacawork/backend/test-dist/agents/registry.js';

test('short compound commands survive one stdout poll, count within an episode, expire in quiet, and reset for the next work', t => {
  const folder = mkdtempSync(join(tmpdir(), 'recent-work-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const epoch = Date.parse('2026-11-11T00:00:00Z');
  let now = epoch;
  const reader = new OutputActivityReader(AGENT_RUNTIME_ADAPTERS.claude, () => now);
  const emit = (value: unknown) => appendFileSync(join(folder, 'stdout.log'), JSON.stringify(value) + '\n');
  const start = (id: string, tool = 'Bash') => emit({ type: 'assistant', parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id, name: tool, input: { command: 'alpacawork task list | head; echo private-argument' } }] } });
  const end = (id: string) => emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } });
  const poll = (ms: number) => { now = epoch + ms; reader.poll(folder); return readRecentWork(folder); };
  start('one'); end('one');
  assert.deepEqual(poll(300), { name: 'command', count: 1 });
  assert.deepEqual(poll(2000), { name: 'command', count: 1 });
  start('two'); end('two');
  assert.deepEqual(poll(2200), { name: 'command', count: 2 });
  assert.deepEqual(poll(4000), { name: 'command', count: 2 });
  emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Still working' }] } });
  assert.deepEqual(poll(8199), { name: 'command', count: 2 });
  assert.equal(poll(8200), null, 'expiry needs no new stdout');
  start('three');
  assert.deepEqual(poll(9000), { name: 'command', count: 1 });
  assert.deepEqual(poll(10200), { name: 'command', count: 1 }, 'a quiet pause starts a new count');
  assert.deepEqual(poll(25000), { name: 'command', count: 1 }, 'long work remains named');
  end('three'); start('four', 'Read'); end('four');
  assert.deepEqual(poll(26000), { name: 'file', count: 1 });
  assert.doesNotMatch(readFileSync(join(folder, 'recent-work.json'), 'utf8'), /private-argument|task list|Bash/);
  reader.finish(folder);
  assert.equal(readRecentWork(folder), null, 'completion bypasses the minimum display time');
});
