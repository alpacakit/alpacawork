import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextPercent, resolveContextLimits } from '@alpacawork/contract/agent-context';
import { AGENT_ADAPTERS } from '@alpacawork/contract/agent-adapters';
import { agentSettingSchemaFor } from '@alpacawork/contract/agent-settings';
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { contextLimitsFor } from '@alpacawork/backend/test-dist/agents/context-limits.js';
import { recordReportedContext } from '@alpacawork/backend/test-dist/agents/context-reported.js';
import { OutputActivityReader, readRunActivity } from '@alpacawork/backend/test-dist/runs/activity.js';
import { AGENT_RUNTIME_ADAPTERS as adapters } from '@alpacawork/backend/test-dist/agents/registry.js';
import { codexContext } from '../apps/agent-cli/test-dist/codex.js';
import { copilotContext } from '../apps/agent-cli/test-dist/copilot.js';
import { piContext, piStatsContext } from '../apps/agent-cli/test-dist/pi.js';
import { grokContext } from '../apps/agent-cli/test-dist/grok.js';

function reader(t: TestContext, adapter: keyof typeof adapters) {
  const folder = mkdtempSync(join(tmpdir(), 'agent-context-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  // What the agent says of its model's window goes to the model's record; the Run keeps its fill.
  const said: { windowTokens?: number } = {};
  const activity = new OutputActivityReader(adapters[adapter], undefined, update => Object.assign(said, update));
  const emit = (...rows: unknown[]) => {
    for (const row of rows) appendFileSync(join(folder, 'stdout.log'), JSON.stringify(row) + '\n');
    activity.poll(folder);
    const context = readRunActivity(folder)?.context ?? null;
    return context && { ...context, windowTokens: said.windowTokens ?? null };
  };
  const shown = () => {
    const now = readRunActivity(folder);
    return now && { at: now.at, kind: now.kind, toolName: now.toolName, doing: now.doing, note: now.note, steps: now.steps };
  };
  return Object.assign(emit, { shown });
}

test('Claude: the main conversation\'s last call against the window its turn names; sub-agents and compactions apart', t => {
  const emit = reader(t, 'claude');
  const call = (input: number, parent: string | null = null) => ({ type: 'assistant', parent_tool_use_id: parent,
    message: { content: [], usage: { input_tokens: input, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 10 } } });
  const first = emit(call(2))!;
  assert.deepEqual([first.usedTokens, first.windowTokens, first.compacted], [1112, null, false]);
  // A sub-agent's call is its own conversation's.
  assert.equal(emit(call(900_000, 'tool-1'))!.usedTokens, 1112);
  const turn = emit({ type: 'result', modelUsage: { 'main-model': { contextWindow: 1_000_000 }, 'small-model': { contextWindow: 200_000 } } })!;
  assert.deepEqual([turn.usedTokens, turn.windowTokens], [1112, 1_000_000]);
  assert.ok(Math.abs(contextPercent(turn as never)! - 0.1112) < 1e-9);
  // A compaction says its own figure; the window stays.
  const compacted = emit({ type: 'system', subtype: 'compact_boundary', parent_tool_use_id: null, compact_metadata: { post_tokens: 30_000 } })!;
  assert.deepEqual([compacted.usedTokens, compacted.windowTokens, compacted.compacted], [30_000, 1_000_000, true]);
});

test('a bridge\'s context updates merge: a field one leaves out keeps its last value, and an unknown fill is unknown', t => {
  const emit = reader(t, 'codex');
  emit({ type: 'thread.started', thread_id: 'thread' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Checking the catalog.' } });
  emit({ type: 'item.started', item: { type: 'command_execution', id: 'c1', command: 'pnpm test' } });
  const step = emit.shown();
  assert.deepEqual([step?.kind, step?.toolName], ['tool_start', 'command_execution']);
  assert.ok(step?.doing);
  assert.equal(step.note?.text, 'Checking the catalog.');
  assert.equal(step.steps[0]?.text, 'pnpm test');
  const first = emit({ type: 'context.updated', context: codexContext({ last: { totalTokens: 17_311 }, total: { totalTokens: 34_550 }, modelContextWindow: 475_000 }) })!;
  assert.deepEqual([first.usedTokens, first.windowTokens], [17_311, 475_000]);
  assert.deepEqual(emit.shown(), step, 'the step shown stays while only the fill changes');
  const after = emit({ type: 'context.updated', context: { usedTokens: null, compacted: true } })!;
  assert.deepEqual([after.usedTokens, after.windowTokens, after.compacted], [null, 475_000, true]);
  assert.equal(contextPercent(after as never), null);
  // A malformed update says nothing.
  assert.deepEqual(emit({ type: 'context.updated', context: { usedTokens: -1 } }), after);
});

test('each bridge reads its agent\'s own report of the fill', () => {
  assert.deepEqual(copilotContext('session.usage_info', { currentTokens: 9644, tokenLimit: 922_000 }), { usedTokens: 9644, compacted: false, windowTokens: 922_000 });
  assert.deepEqual(copilotContext('session.compaction_complete', { success: true, postCompactionTokens: 4000 }), { usedTokens: 4000, compacted: true });
  // A failed compaction compacted nothing, so History does not count it.
  assert.equal(copilotContext('session.compaction_complete', { success: false, error: 'no model endpoints available' }), null);
  assert.equal(copilotContext('assistant.message', {}), null);
  assert.deepEqual(piContext({ type: 'message_end', message: { role: 'assistant', usage: { totalTokens: 3434 } } }), { usedTokens: 3434, compacted: false });
  assert.deepEqual(piContext({ type: 'compaction_end', result: { summary: 'Kept' }, aborted: false }), { usedTokens: null, compacted: true });
  assert.equal(piContext({ type: 'compaction_end', aborted: true }), null);
  assert.equal(piContext({ type: 'compaction_end', errorMessage: 'Nothing to compact', aborted: false }), null);
  assert.deepEqual(piStatsContext({ contextUsage: { tokens: 3434, contextWindow: 272_000, percent: 1.26 } }), { windowTokens: 272_000, usedTokens: 3434 });
  // Just after a compaction pi knows its window but not the fill.
  assert.deepEqual(piStatsContext({ contextUsage: { tokens: null, contextWindow: 272_000, percent: null } }), { windowTokens: 272_000 });
  assert.deepEqual(grokContext({ input_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 0, output_tokens: 5 }), { usedTokens: 215, compacted: false });
});

test('a model\'s window: what a person wrote, else what its agent reported, else what ships', () => {
  assert.deepEqual(resolveContextLimits({ setting: { window: 300_000 }, reported: { window: 475_000 }, default: { window: 1 } }),
    { windowTokens: 300_000, windowFrom: 'setting' });
  assert.deepEqual(resolveContextLimits({ setting: {}, reported: { window: 475_000 }, default: { window: 256_000 } }),
    { windowTokens: 475_000, windowFrom: 'reported' });
  assert.deepEqual(resolveContextLimits({ default: { window: 256_000 } }), { windowTokens: 256_000, windowFrom: 'default' });
  assert.deepEqual(resolveContextLimits({}), { windowTokens: null, windowFrom: null });
});

test('what an agent reported is kept per kind of agent and model, read for every profile of that kind, and a person\'s value wins', t => {
  const root = mkdtempSync(join(tmpdir(), 'context-limits-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.alpacawork'));
  writeFileSync(join(root, 'config.yaml'), 'agents:\n  codex:\n    params:\n      model: [gpt-6.1-sol]\n  mine:\n    adapter: codex\n    params:\n      model: [gpt-6.1-sol]\n    context:\n      gpt-6.1-sol:\n        window: 300000\n');
  const run = (agent: string) => ({ agent, launch: { adapter: 'codex', values: { model: 'gpt-6.1-sol' } } }) as never;
  recordReportedContext(root, 'codex', 'gpt-6.1-sol', { windowTokens: 475_000 });
  const record = join(root, '.alpacawork', 'context-reported.json'), written = statSync(record).mtimeMs;
  recordReportedContext(root, 'codex', 'gpt-6.1-sol', { windowTokens: 475_000, usedTokens: 10 });
  assert.equal(statSync(record).mtimeMs, written, 'a repeated figure writes nothing');
  assert.deepEqual(JSON.parse(readFileSync(record, 'utf8')), { codex: { 'gpt-6.1-sol': { window: 475_000 } } });
  assert.equal(contextLimitsFor(root, run('codex')).windowTokens, 475_000);
  assert.deepEqual([contextLimitsFor(root, run('mine')).windowTokens, contextLimitsFor(root, run('mine')).windowFrom], [300_000, 'setting']);
});

test('a window is written only for a model the agent lists, and what ships is for listed models', () => {
  const parse = (context: unknown) => agentSettingSchemaFor('codex').safeParse({ params: { model: ['gpt-6.2-sol'] }, context });
  assert.ok(parse({ 'gpt-6.2-sol': { window: 300_000 }, '-': { window: 200_000 } }).success);
  const stale = parse({ 'gpt-5': { window: 300_000 } });
  assert.ok(!stale.success && stale.error.issues.some(issue => issue.path.join('.') === 'context.gpt-5' && issue.message === 'Unknown model candidate'));
  for (const adapter of Object.values(AGENT_ADAPTERS))
    for (const model of Object.keys(adapter.contextDefaults)) assert.ok(adapter.defaultParams.model?.includes(model), `${adapter.id} ${model}`);
});
