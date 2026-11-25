/** Every step of a Run, read from its output when the screen opens them. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRunSteps } from '@alpacawork/backend/test-dist/runs/run-steps.js';
import { AGENT_RUNTIME_ADAPTERS } from '@alpacawork/backend/test-dist/agents/registry.js';
import { RUN_STEPS_READ_LIMIT, RUN_STEP_FULL_TEXT_LIMIT, runStepsReadSchema } from '@alpacawork/contract/run';

function folder(t: import('node:test').TestContext) {
  const path = mkdtempSync(join(tmpdir(), 'run-steps-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
const write = (path: string, rows: readonly unknown[]) =>
  appendFileSync(join(path, 'stdout.log'), rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n');
const claudeStart = (id: string, command: string) => ({ type: 'assistant', parent_tool_use_id: null,
  message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command, description: 'Run the tests' } }] } });
const claudeEnd = (id: string, text: string, failed = false) => ({ type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: failed, content: [{ type: 'text', text }] }] } });

test('claude: each step keeps what it ran and got back as written, and a broken line is passed over', t => {
  const path = folder(t);
  const script = 'pnpm build\n  && pnpm test --filter web';
  write(path, [claudeStart('one', script), '{"type": "assist', claudeEnd('one', 'FAIL amount.test.ts\n  expected 2', true),
    claudeStart('two', 'git status')]);
  const read = readRunSteps(path, AGENT_RUNTIME_ADAPTERS.claude, null);
  assert.equal(runStepsReadSchema.safeParse(read).success, true);
  assert.deepEqual(read, { older: 0, unread: false, steps: [
    { id: 'one', tool: 'Bash', kind: 'command', about: 'Run the tests', state: 'failed', input: { text: script, cut: false },
      output: { text: 'FAIL amount.test.ts\n  expected 2', cut: false } },
    { id: 'two', tool: 'Bash', kind: 'command', about: 'Run the tests', state: 'running', input: { text: 'git status', cut: false }, output: null },
  ] });
  // Once the Run has ended, what its output left running ended with it.
  assert.equal(readRunSteps(path, AGENT_RUNTIME_ADAPTERS.claude, 'failed').steps[1]?.state, 'failed');
});

test('codex: the command inside its login shell, and a non-zero exit as failed', t => {
  const path = folder(t);
  write(path, [{ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: "/bin/bash -lc 'ls -la\necho done'" } },
    { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: "/bin/bash -lc 'ls -la\necho done'", aggregatedOutput: 'no such file', exitCode: 2 } },
    { type: 'turn.completed' }]);
  const [step] = readRunSteps(path, AGENT_RUNTIME_ADAPTERS.codex, null).steps;
  assert.deepEqual(step, { id: 'c1', tool: 'command_execution', kind: 'command', about: null, state: 'failed',
    input: { text: 'ls -la\necho done', cut: false }, output: { text: 'no such file', cut: false } });
});

test('a long result is cut at the limit, and only the latest steps are given, counting the rest', t => {
  const path = folder(t);
  const rows: unknown[] = [];
  for (let index = 0; index < RUN_STEPS_READ_LIMIT + 5; index++) rows.push(claudeStart(`s${index}`, `echo ${index}`), claudeEnd(`s${index}`, 'ok'));
  rows.push(claudeStart('big', 'cat big.log'), claudeEnd('big', 'x'.repeat(RUN_STEP_FULL_TEXT_LIMIT + 10)));
  write(path, rows);
  const read = readRunSteps(path, AGENT_RUNTIME_ADAPTERS.claude, 'done');
  assert.equal(read.steps.length, RUN_STEPS_READ_LIMIT);
  assert.equal(read.older, 6);
  assert.equal(read.steps[0]?.id, 's6');
  assert.deepEqual(read.steps.at(-1)?.output, { text: 'x'.repeat(RUN_STEP_FULL_TEXT_LIMIT), cut: true });
  assert.equal(runStepsReadSchema.safeParse(read).success, true);
});

test('no output reads as no steps; output too long to read says so', t => {
  const path = folder(t);
  assert.deepEqual(readRunSteps(path, AGENT_RUNTIME_ADAPTERS.claude, null), { steps: [], older: 0, unread: false });
  writeFileSync(join(path, 'stdout.log'), '');
  write(path, [claudeStart('early', 'echo early'), claudeStart('late', 'echo late')]);
  const read = readRunSteps(path, AGENT_RUNTIME_ADAPTERS.claude, null, JSON.stringify(claudeStart('late', 'echo late')).length + 10);
  assert.deepEqual(read.steps.map(step => step.id), ['late']);
  assert.equal(read.unread, true);
});
