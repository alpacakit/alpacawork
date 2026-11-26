import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AGENT_RUNTIME_ADAPTERS } from '@alpacawork/backend/test-dist/agents/registry.js';
import { TallyParser } from '@alpacawork/backend/test-dist/agents/adapters/tally.js';
import { OutputActivityReader, readRunActivity } from '@alpacawork/backend/test-dist/runs/activity.js';
import { AgentInputReceipts } from '@alpacawork/backend/test-dist/runs/input.js';
import { RunStepIndex } from '@alpacawork/backend/test-dist/runs/run-steps.js';
import { RUN_FILES, runActivityViewSchema, runOutputSpeed } from '@alpacawork/contract/run';

test('Claude measures model delta usage from message start and keeps only recent output in activity', t => {
  const folder = mkdtempSync(join(tmpdir(), 'alpacawork-output-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const stdout = join(folder, RUN_FILES.stdout), activityFile = join(folder, RUN_FILES.activity);
  writeFileSync(stdout, '');
  let second = 100;
  const reader = new OutputActivityReader(AGENT_RUNTIME_ADAPTERS.claude, () => second * 1000);
  const append = (at: number, row: object) => {
    second = at;
    appendFileSync(stdout, JSON.stringify(row) + '\n');
    reader.poll(folder);
  };
  const stream = (id: string, event: object, parent: string | null = null) => ({
    type: 'stream_event', event, session_id: 'synthetic', parent_tool_use_id: parent, api_message_id: id,
  });
  const start = (id: string, parent: string | null = null) => stream(id, { type: 'message_start', message: { id } }, parent);
  const delta = (id: string, tokens: number, parent: string | null = null) =>
    stream(id, { type: 'message_delta', usage: { output_tokens: tokens } }, parent);
  const output = () => readRunActivity(folder)?.output;

  append(100, { type: 'command_lifecycle', state: 'started' });
  append(101, { type: 'assistant', message: { id: 'root', usage: { output_tokens: 16 } } });
  assert.equal(output(), undefined);
  append(101, { ...start('root'), timestamp: new Date(100_000).toISOString() });
  append(102, start('child', 'tool'));
  append(103, delta('root', 8));
  append(104, delta('child', 3, 'tool'));
  append(104, stream('child', { type: 'message_stop' }, 'tool'));
  append(105, delta('root', 12));
  append(106, delta('root', 12));
  append(107, stream('root', { type: 'message_stop' }));
  append(108, delta('root', 90));
  assert.deepEqual(output(), {
    buckets: [[100, 2], [101, 2], [102, 3], [103, 3], [104, 3], [105, 2]], lastActivityAt: 105,
  });

  append(109, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'done' }] } });
  assert.equal(output()?.lastActivityAt, 109);
  append(109, start('after-tool'));
  append(110, delta('after-tool', 6));
  assert.deepEqual(output()?.buckets.slice(-2), [[109, 3], [110, 3]]);
  append(111, start('after-idle'));

  const beforeIdle = statSync(activityFile, { bigint: true });
  second = 170;
  reader.poll(folder);
  assert.equal(statSync(activityFile, { bigint: true }).ino, beforeIdle.ino);
  assert.equal(statSync(activityFile, { bigint: true }).mtimeNs, beforeIdle.mtimeNs);
  append(175, delta('after-idle', 60));
  assert.deepEqual(output()?.buckets, Array.from({ length: 60 }, (_, index) => [116 + index, 1]));

  reader.finish(folder, 'done');
  assert.equal(output(), undefined);
});

test('Claude partial stream leaves existing Run activity, receipts, outcome, steps and tally intact', async t => {
  const adapter = AGENT_RUNTIME_ADAPTERS.claude, session = 'synthetic';
  const events = [
    { type: 'command_lifecycle', state: 'started', command_uuid: 'input', session_id: session },
    { type: 'assistant', parent_tool_use_id: null, session_id: session, message: {
      usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2 },
      content: [{ type: 'text', text: 'Measuring catalog' }, { type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'cat catalog.txt' } }],
    } },
    { type: 'user', session_id: session, message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'Found' }] } },
    { type: 'result', session_id: session, is_error: true, result: "You've hit your weekly limit",
      modelUsage: { synthetic: { inputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 9 } } },
  ];
  const delta = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Synthetic' } };
  const noise = { type: 'stream_event', event: delta, session_id: session };
  const reordered = { event: delta, type: 'stream_event', session_id: session };
  const read = async (rows: object[]) => {
    const folder = mkdtempSync(join(tmpdir(), 'alpacawork-output-'));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    writeFileSync(join(folder, RUN_FILES.stdout), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    new OutputActivityReader(adapter, () => 100_000).poll(folder);
    const receipts = new AgentInputReceipts(adapter.input, adapter.skipOutputLine);
    receipts.watch('input', 'run');
    const inputs = receipts.poll(folder, session);
    const outcome = adapter.read({ mode: 'start', session, compaction: null }, folder, { code: 0, signal: null });
    const index = new RunStepIndex(folder, adapter);
    await index.update('failed');
    const tally = new TallyParser('claude', 'claude', session);
    for (const row of rows) tally.observe(row);
    return { activity: readRunActivity(folder), inputs, working: receipts.working, outcome, steps: index.since(0).steps, tally: tally.finish('complete') };
  };
  const before = await read(events);
  assert.equal(before.outcome.toolsSettled, true);
  assert.equal(before.steps[0]?.state, 'done');
  assert.deepEqual(await read(events.flatMap(row => [noise, row, reordered])), before);
});

test('bridge live output reaches the screen payload independently of the terminal total', t => {
  const folder = mkdtempSync(join(tmpdir(), 'alpacawork-output-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  writeFileSync(join(folder, RUN_FILES.stdout), [
    { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Measured reply' } },
    { type: 'model.output', tokens: 5 },
    { type: 'model.output', tokens: -1 },
    { type: 'turn.completed', usage: { scope: 'run', counters: { output: 40 } } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  new OutputActivityReader(AGENT_RUNTIME_ADAPTERS.codex, () => 100_000).poll(folder);
  const activity = runActivityViewSchema.parse(readRunActivity(folder));
  assert.equal(activity.note?.text, 'Measured reply');
  assert.deepEqual(activity.output, { buckets: [[100, 5]], lastActivityAt: 100 });
});

test('display sums Runs, ages out seconds on the clock, and distinguishes unknown and measured zero', () => {
  const first = { buckets: [[40, 1000], [41, 10], [95, 10], [96, 3], [100, 12], [101, 1000]] as [number, number][], lastActivityAt: 100 };
  const second = { buckets: [[98, 5]] as [number, number][], lastActivityAt: 99 };
  assert.equal(runOutputSpeed([undefined, null], 100), null);
  assert.deepEqual(runOutputSpeed([first, undefined, second], 100), {
    rate: 4, bars: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 4], idleSeconds: 0,
  });
  assert.deepEqual(runOutputSpeed([{ buckets: [[100, 5]], lastActivityAt: 100 }], 160), {
    rate: 0, bars: Array(12).fill(0), idleSeconds: 60,
  });
  // The latest measured 5 seconds hold while the next call runs, rather than reading 0 until it ends.
  assert.deepEqual(runOutputSpeed([{ buckets: [[86, 25], [90, 25]], lastActivityAt: 92 }], 100), {
    rate: 10, bars: [...Array(9).fill(0), 10, 0, 0], idleSeconds: 8,
  });
  // A reader whose clock is behind the server's still counts the newest seconds.
  assert.deepEqual(runOutputSpeed([{ buckets: [[105, 10]], lastActivityAt: 105 }], 100), {
    rate: 2, bars: [...Array(11).fill(0), 2], idleSeconds: 0,
  });
});
