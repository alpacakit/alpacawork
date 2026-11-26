import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AGENT_RUNTIME_ADAPTERS } from '@alpacawork/backend/test-dist/agents/registry.js';
import { OutputActivityReader, readRunActivity } from '@alpacawork/backend/test-dist/runs/activity.js';
import { RUN_FILES, runActivityViewSchema, runOutputSpeed } from '@alpacawork/contract/run';

test('Claude replaces split assistant usage, counts subagents, and keeps only recent output in activity', t => {
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
  const model = (id: string, tokens: number | undefined, parent: string | null = null) => ({
    type: 'assistant', parent_tool_use_id: parent, message: { id, usage: { output_tokens: tokens } },
  });
  const output = () => readRunActivity(folder)?.output;

  append(100, { type: 'command_lifecycle', state: 'started' });
  append(101, model('unmeasured', undefined));
  assert.equal(output(), undefined);
  append(103, model('root', 8));
  append(104, model('child', 3, 'tool'));
  append(105, model('root', 12));
  append(106, model('root', 12));
  assert.deepEqual(output(), {
    buckets: [[100, 2], [101, 2], [102, 2], [103, 3], [104, 4], [105, 2]], lastActivityAt: 105,
  });

  append(109, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'done' }] } });
  assert.equal(output()?.lastActivityAt, 109);
  append(110, model('after-tool', 6));
  assert.deepEqual(output()?.buckets.slice(-2), [[109, 3], [110, 3]]);

  const beforeIdle = statSync(activityFile, { bigint: true });
  second = 170;
  reader.poll(folder);
  assert.equal(statSync(activityFile, { bigint: true }).ino, beforeIdle.ino);
  assert.equal(statSync(activityFile, { bigint: true }).mtimeNs, beforeIdle.mtimeNs);
  append(175, model('after-idle', 60));
  assert.deepEqual(output()?.buckets, Array.from({ length: 60 }, (_, index) => [116 + index, 1]));

  reader.finish(folder, 'done');
  assert.equal(output(), undefined);
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
});
