import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutputActivityReader, readRunActivity } from '@alpacawork/backend/test-dist/runs/activity.js';
import { AGENT_RUNTIME_ADAPTERS } from '@alpacawork/backend/test-dist/agents/registry.js';

for (const agent of ['claude', 'codex'] as const) test(`${agent}: current work follows IDs, not the latest tool event`, t => {
  const folder = mkdtempSync(join(tmpdir(), 'run-work-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const reader = new OutputActivityReader(AGENT_RUNTIME_ADAPTERS[agent]);
  const emit = (value: unknown) => {
    appendFileSync(join(folder, 'stdout.log'), JSON.stringify(value) + '\n');
    reader.poll(folder);
    return readRunActivity(folder);
  };
  const start = (id: string, command: string) => agent === 'claude'
    ? { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } }
    : { type: 'item.started', item: { id, type: 'command_execution', command } };
  const end = (id: string) => agent === 'claude'
    ? { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } }
    : { type: 'item.completed', item: { id, type: 'command_execution' } };
  assert.equal(emit(start('one', 'alpacawork task new --title test'))?.doing?.command, 'task.new');
  assert.equal(emit(start('two', 'alpacawork task update --task T1 --title changed'))?.doing?.command, 'task.update');
  assert.equal(emit(end('one'))?.doing?.command, 'task.update');
  assert.equal(emit(end('two'))?.doing, null);
  emit(start('three', 'alpacawork task request --task T1 --instruction-file /tmp/brief'));
  assert.equal(emit(start('unknown', 'echo alpacawork task new'))?.doing?.command, null);
  assert.equal(emit(end('unknown'))?.doing?.command, 'task.request');
  assert.equal(emit(agent === 'claude' ? { type: 'result' } : { type: 'turn.completed' })?.doing, null);
  emit(start('four', 'alpacawork task get --task T1'));
  appendFileSync(join(folder, 'stdout.log'), 'x'.repeat(2 * 1024 * 1024 + 1) + '\n');
  reader.poll(folder);
  assert.equal(readRunActivity(folder)?.doing, null, 'a skipped completion cannot leave a current operation behind');
  emit(start('five', 'alpacawork task new --title test'));
  assert.equal(emit(end('unobserved'))?.doing, null, 'an unmatched completion discards uncertain current work');
  emit(start('six', 'alpacawork task new --title test'));
  reader.finish(folder);
  assert.equal(readRunActivity(folder)?.doing, null, 'process exit clears work even without a result event');
});
