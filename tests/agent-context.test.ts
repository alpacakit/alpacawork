import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextPercent } from '@alpacawork/contract/agent-context';
import { OutputActivityReader, readRunActivity } from '@alpacawork/backend/test-dist/runs/activity.js';
import { AGENT_RUNTIME_ADAPTERS as adapters } from '@alpacawork/backend/test-dist/agents/registry.js';
import { codexContext } from '../apps/agent-cli/test-dist/codex.js';
import { copilotContext } from '../apps/agent-cli/test-dist/copilot.js';
import { piContext, piStatsContext } from '../apps/agent-cli/test-dist/pi.js';
import { grokContext } from '../apps/agent-cli/test-dist/grok.js';

function reader(t: TestContext, adapter: keyof typeof adapters) {
  const folder = mkdtempSync(join(tmpdir(), 'agent-context-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const activity = new OutputActivityReader(adapters[adapter]);
  return (...rows: unknown[]) => {
    for (const row of rows) appendFileSync(join(folder, 'stdout.log'), JSON.stringify(row) + '\n');
    activity.poll(folder);
    return readRunActivity(folder)?.context ?? null;
  };
}

test('Claude: the main conversation\'s last call against the window its turn names; sub-agents and compactions apart', t => {
  const emit = reader(t, 'claude');
  const call = (input: number, parent: string | null = null) => ({ type: 'assistant', parent_tool_use_id: parent,
    message: { content: [], usage: { input_tokens: input, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 10 } } });
  const first = emit(call(2))!;
  assert.deepEqual([first.usedTokens, first.windowTokens, first.compacted], [1112, null, false]);
  assert.equal(contextPercent(first), null);
  // A sub-agent's call is its own conversation's.
  assert.equal(emit(call(900_000, 'tool-1'))!.usedTokens, 1112);
  const turn = emit({ type: 'result', modelUsage: { 'main-model': { contextWindow: 1_000_000 }, 'small-model': { contextWindow: 200_000 } } })!;
  assert.deepEqual([turn.usedTokens, turn.windowTokens], [1112, 1_000_000]);
  assert.ok(Math.abs(contextPercent(turn)! - 0.1112) < 1e-9);
  // A compaction says its own figure; the window stays.
  const compacted = emit({ type: 'system', subtype: 'compact_boundary', parent_tool_use_id: null, compact_metadata: { post_tokens: 30_000 } })!;
  assert.deepEqual([compacted.usedTokens, compacted.windowTokens, compacted.compacted], [30_000, 1_000_000, true]);
});

test('a bridge\'s context updates merge: a field one leaves out keeps its last value, and an unknown fill is unknown', t => {
  const emit = reader(t, 'codex');
  emit({ type: 'thread.started', thread_id: 'thread' });
  const first = emit({ type: 'context.updated', context: codexContext({ last: { totalTokens: 17_311 }, total: { totalTokens: 34_550 }, modelContextWindow: 475_000 }) })!;
  assert.deepEqual([first.usedTokens, first.windowTokens], [17_311, 475_000]);
  const after = emit({ type: 'context.updated', context: { usedTokens: null, compacted: true } })!;
  assert.deepEqual([after.usedTokens, after.windowTokens, after.compacted], [null, 475_000, true]);
  assert.equal(contextPercent(after), null);
  // A malformed update says nothing.
  assert.deepEqual(emit({ type: 'context.updated', context: { usedTokens: -1 } }), after);
});

test('each bridge reads its agent\'s own report of the fill', () => {
  assert.deepEqual(copilotContext('session.usage_info', { currentTokens: 9644, tokenLimit: 922_000 }), { usedTokens: 9644, compacted: false, windowTokens: 922_000 });
  assert.deepEqual(copilotContext('session.compaction_complete', { postCompactionTokens: 4000 }), { usedTokens: 4000, compacted: true });
  assert.equal(copilotContext('assistant.message', {}), null);
  assert.deepEqual(piContext({ type: 'message_end', message: { role: 'assistant', usage: { totalTokens: 3434 } } }), { usedTokens: 3434, compacted: false });
  assert.deepEqual(piContext({ type: 'compaction_end' }), { usedTokens: null, compacted: true });
  assert.deepEqual(piStatsContext({ contextUsage: { tokens: 3434, contextWindow: 272_000, percent: 1.26 } }), { windowTokens: 272_000, usedTokens: 3434 });
  // Just after a compaction pi knows its window but not the fill.
  assert.deepEqual(piStatsContext({ contextUsage: { tokens: null, contextWindow: 272_000, percent: null } }), { windowTokens: 272_000 });
  assert.deepEqual(grokContext({ input_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 0, output_tokens: 5 }), { usedTokens: 215, compacted: false });
});
