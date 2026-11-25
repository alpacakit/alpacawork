/** Every step of a Run, read from its output when the screen opens them: listed a page at a time, each read in full. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStepIndex } from '@alpacawork/backend/test-dist/runs/run-steps.js';
import { AGENT_RUNTIME_ADAPTERS } from '@alpacawork/backend/test-dist/agents/registry.js';
import { RUN_STEP_FULL_TEXT_LIMIT, runStepsPageSchema, runStepDetailSchema } from '@alpacawork/contract/run';

function folder(t: TestContext) {
  const path = mkdtempSync(join(tmpdir(), 'run-steps-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
const write = (path: string, rows: readonly unknown[]) =>
  appendFileSync(join(path, 'stdout.log'), rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n');
const claudeStart = (id: string, input: Record<string, unknown>, name = 'Bash') => ({ type: 'assistant', parent_tool_use_id: null,
  message: { content: [{ type: 'tool_use', id, name, input }] } });
const bash = (id: string, command: string) => claudeStart(id, { command, description: 'Run the tests' });
const claudeEnd = (id: string, text: string, failed = false) => ({ type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: failed, content: [{ type: 'text', text }] }] } });
async function read(path: string, agent: keyof typeof AGENT_RUNTIME_ADAPTERS = 'claude') {
  const index = new RunStepIndex(path, AGENT_RUNTIME_ADAPTERS[agent]);
  await index.update();
  return index;
}

test('claude: a step opens to what it ran and got back as written, an edit to its old and new text', async t => {
  const path = folder(t);
  const script = 'pnpm build\n  && pnpm test --filter web';
  write(path, [bash('one', script), '{"type": "assist', claudeEnd('one', 'FAIL amount.test.ts\n  expected 2', true),
    claudeStart('two', { file_path: '/src/format.ts', old_string: 'Math.floor(x)\n', new_string: 'Math.round(x)\n' }, 'Edit')]);
  const index = await read(path);
  const page = index.page(undefined, 12, null);
  assert.equal(runStepsPageSchema.safeParse(page).success, true);
  assert.deepEqual(page.steps.map(({ n, tool, text, more, state }) => ({ n, tool, text, more, state })), [
    { n: 0, tool: 'Bash', text: 'pnpm build', more: 1, state: 'failed' },
    { n: 1, tool: 'Edit', text: '/src/format.ts', more: 0, state: 'running' },
  ]);
  assert.deepEqual(await index.detail(0), { input: { text: script, omitted: 0 }, output: { text: 'FAIL amount.test.ts\n  expected 2', omitted: 0 } });
  assert.deepEqual(await index.detail(1), { input: { text: '/src/format.ts\n\nold_string:\nMath.floor(x)\n\nnew_string:\nMath.round(x)\n', omitted: 0 }, output: null });
  // Once the Run has ended, what its output left running ended with it.
  assert.equal(index.page(undefined, 12, 'failed').steps[1]?.state, 'failed');
});

test('codex: the command inside its login shell, all of its lines, and a non-zero exit as failed', async t => {
  const path = folder(t);
  const command = "/bin/bash -lc 'ls -la\necho done'";
  write(path, [{ type: 'item.started', item: { id: 'c1', type: 'command_execution', command } },
    { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command, aggregatedOutput: 'no such file', exitCode: 2 } }]);
  const index = await read(path, 'codex');
  assert.equal(index.page(undefined, 12, null).steps[0]?.state, 'failed');
  assert.deepEqual(await index.detail(0), { input: { text: 'ls -la\necho done', omitted: 0 }, output: { text: 'no such file', omitted: 0 } });
});

for (const agent of ['pi', 'grok', 'copilot'] as const) test(`${agent}: a bridge's step keeps every line it ran and got back`, async t => {
  const path = folder(t);
  write(path, [{ type: 'tool.started', id: 't1', tool: 'command_execution', name: 'bash', detail: { text: 'cd app', more: 1 }, about: null,
    input: { text: 'cd app\npnpm test', omitted: 0 } },
  { type: 'tool.completed', id: 't1', tool: 'command_execution', name: 'bash', result: { text: 'ok', more: 1 }, failed: false,
    output: { text: 'ok\n12 passed', omitted: 0 } }]);
  const index = await read(path, agent);
  assert.deepEqual(await index.detail(0), { input: { text: 'cd app\npnpm test', omitted: 0 }, output: { text: 'ok\n12 passed', omitted: 0 } });
});

test('every step can be reached a page at a time, and output read again goes on from where it stopped', async t => {
  const path = folder(t);
  const rows: unknown[] = [];
  for (let n = 0; n < 250; n++) rows.push(bash(`s${n}`, `echo ${n}`), claudeEnd(`s${n}`, 'ok'));
  write(path, rows);
  const index = await read(path);
  const latest = index.page(undefined, 12, null);
  assert.deepEqual([latest.from, latest.total, latest.steps.length, latest.steps[0]?.text], [238, 250, 12, 'echo 238']);
  const first = index.page(0, 24, null);
  assert.deepEqual([first.from, first.steps.length, first.steps[0]?.text], [0, 24, 'echo 0']);
  // What the output gains later is added; what was read stays where it is.
  write(path, [bash('late', 'echo late')]);
  appendFileSync(join(path, 'stdout.log'), '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"cut"');
  await index.update();
  assert.deepEqual(index.page(250, 12, null).steps.map(step => step.text), ['echo late']);
  appendFileSync(join(path, 'stdout.log'), ',"name":"Bash","input":{"command":"echo whole"}}]}}\n');
  await index.update();
  assert.deepEqual(index.page(250, 12, null).steps.map(step => step.text), ['echo late', 'echo whole']);
});

test('steps going at once each keep their own state: an earlier one failing is said while a later one runs', async t => {
  const path = folder(t);
  write(path, [bash('a', 'pnpm test'), bash('b', 'pnpm lint'), claudeEnd('a', 'FAIL', true)]);
  const index = await read(path);
  assert.deepEqual(index.page(undefined, 12, null).steps.map(step => [step.id, step.state]), [['a', 'failed'], ['b', 'running']]);
});

test('a text past the limit says how much was left out; no output reads as no steps', async t => {
  const path = folder(t);
  assert.deepEqual((await read(path)).page(undefined, 12, null), { steps: [], from: 0, total: 0 });
  write(path, [bash('big', 'cat big.log'), claudeEnd('big', 'x'.repeat(RUN_STEP_FULL_TEXT_LIMIT + 10))]);
  const detail = await (await read(path)).detail(0);
  assert.equal(runStepDetailSchema.safeParse(detail).success, true);
  assert.equal(detail?.output?.text.length, RUN_STEP_FULL_TEXT_LIMIT);
  assert.equal(detail?.output?.omitted, 10);
  writeFileSync(join(path, 'stdout.log'), '');
  assert.equal((await read(path)).total, 0);
});
