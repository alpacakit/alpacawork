/** Every step of a Run, read from its output when the screen opens them: listed a page at a time, each read in full. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStepIndex, RUN_STEPS_LINE_LIMIT } from '@alpacawork/backend/test-dist/runs/run-steps.js';
import { OutputActivityReader, readRunActivity } from '@alpacawork/backend/test-dist/runs/activity.js';
import { AGENT_RUNTIME_ADAPTERS } from '@alpacawork/backend/test-dist/agents/registry.js';
import { BRIDGE_ITEM_BYTES, boundaryItem } from '@alpacawork/contract/agent-bridge';
import { RUN_STEP_FULL_TEXT_LIMIT, fullRunText, runStepsPageSchema, runStepDetailSchema, toolInputDocument, tookSteps } from '@alpacawork/contract/run';

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
  const page = index.range(undefined, 12);
  assert.equal(runStepsPageSchema.safeParse(page).success, true);
  assert.deepEqual(page.steps.map(({ n, tool, text, more, state }) => ({ n, tool, text, more, state })), [
    { n: 0, tool: 'Bash', text: 'pnpm build', more: 1, state: 'failed' },
    { n: 1, tool: 'Edit', text: '/src/format.ts', more: 0, state: 'running' },
  ]);
  const read0 = await index.detail(0), read1 = await index.detail(1);
  assert.deepEqual([read0?.input, read0?.output], [{ text: script, omitted: 0 }, { text: 'FAIL amount.test.ts\n  expected 2', omitted: 0 }]);
  assert.deepEqual([read1?.input, read1?.output], [{ text: '/src/format.ts\n\nold_string:\nMath.floor(x)\n\nnew_string:\nMath.round(x)\n', omitted: 0 }, null]);
  // Once the Run has ended, what its output left running ended with it.
  await index.update('failed');
  assert.equal(index.range(undefined, 12).steps[1]?.state, 'failed');
});

test('codex: the command inside its login shell, all of its lines, and a non-zero exit as failed', async t => {
  const path = folder(t);
  const command = "/bin/bash -lc 'ls -la\necho done'";
  write(path, [{ type: 'item.started', item: { id: 'c1', type: 'command_execution', command } },
    { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command, aggregatedOutput: 'no such file', exitCode: 2 } }]);
  const index = await read(path, 'codex');
  assert.equal(index.range(undefined, 12).steps[0]?.state, 'failed');
  const detail = await index.detail(0);
  assert.deepEqual([detail?.input, detail?.output], [{ text: 'ls -la\necho done', omitted: 0 }, { text: 'no such file', omitted: 0 }]);
});

for (const agent of ['pi', 'grok', 'copilot'] as const) test(`${agent}: a bridge's step keeps every line it ran and got back`, async t => {
  const path = folder(t);
  write(path, [{ type: 'tool.started', id: 't1', tool: 'command_execution', name: 'bash', detail: { text: 'cd app', more: 1 }, about: null,
    input: { text: 'cd app\npnpm test', omitted: 0 } },
  { type: 'tool.completed', id: 't1', tool: 'command_execution', name: 'bash', result: { text: 'ok', more: 1 }, failed: false,
    output: { text: 'ok\n12 passed', omitted: 0 } }]);
  const detail = await (await read(path, agent)).detail(0);
  assert.deepEqual([detail?.input, detail?.output], [{ text: 'cd app\npnpm test', omitted: 0 }, { text: 'ok\n12 passed', omitted: 0 }]);
});

test('every step can be reached a page at a time, and output read again goes on from where it stopped', async t => {
  const path = folder(t);
  const rows: unknown[] = [];
  for (let n = 0; n < 250; n++) rows.push(bash(`s${n}`, `echo ${n}`), claudeEnd(`s${n}`, 'ok'));
  write(path, rows);
  const index = await read(path);
  const latest = index.range(undefined, 12);
  assert.deepEqual([latest.steps[0]?.n, latest.total, latest.steps.length, latest.steps[0]?.text], [238, 250, 12, 'echo 238']);
  const first = index.range(0, 24);
  assert.deepEqual([first.steps[0]?.n, first.steps.length, first.steps[0]?.text], [0, 24, 'echo 0']);
  // What the output gains later is added; what was read stays where it is.
  write(path, [bash('late', 'echo late')]);
  appendFileSync(join(path, 'stdout.log'), '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"cut"');
  await index.update();
  assert.deepEqual(index.range(250, 12).steps.map(step => step.text), ['echo late']);
  appendFileSync(join(path, 'stdout.log'), ',"name":"Bash","input":{"command":"echo whole"}}]}}\n');
  await index.update();
  assert.deepEqual(index.range(250, 12).steps.map(step => step.text), ['echo late', 'echo whole']);
});

test('a list asks only for what changed after its version: a step far back failing while eight run, and new ones', async t => {
  const path = folder(t);
  const rows: unknown[] = [];
  for (let n = 0; n < 40; n++) rows.push(bash(`old${n}`, `echo ${n}`), claudeEnd(`old${n}`, 'ok'));
  for (let n = 0; n < 8; n++) rows.push(bash(`p${n}`, `pnpm test ${n}`));
  write(path, rows);
  const index = await read(path), held = index.range(undefined, 12);
  write(path, [claudeEnd('p0', 'FAIL', true), bash('new', 'echo new')]);
  await index.update();
  const changed = index.since(held.version);
  assert.deepEqual(changed.steps.map(step => [step.n, step.id, step.state]), [[40, 'p0', 'failed'], [48, 'new', 'running']]);
  assert.deepEqual([changed.total, changed.complete], [49, true]);
  assert.deepEqual(index.since(changed.version).steps, []);
  // The live activity counts every step's start and end, not only the six it keeps, so the change is told.
  const live = new OutputActivityReader(AGENT_RUNTIME_ADAPTERS.claude);
  writeFileSync(join(path, 'stdout.log'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  live.poll(path);
  const before = readRunActivity(path)?.stepEvents;
  appendFileSync(join(path, 'stdout.log'), JSON.stringify(claudeEnd('p0', 'FAIL', true)) + '\n');
  live.poll(path);
  assert.equal(readRunActivity(path)?.stepEvents, before! + 1);
  assert.equal(readRunActivity(path)?.steps.some(step => step.id === 'p0'), false);
});

test('a step running when a line could not be read, and never said to end later, ends unknown rather than done', async t => {
  const path = folder(t);
  write(path, [bash('lost', 'pnpm test'), bash('seen', 'pnpm lint'), '{"type":"user","message":{"content":[{"type":"tool_res',
    claudeEnd('seen', 'ok'), { type: 'result', is_error: false }]);
  const index = await read(path);
  assert.deepEqual(index.range(undefined, 12).steps.map(step => [step.id, step.state]), [['lost', 'unknown'], ['seen', 'done']]);
  assert.equal((await index.detail(0))?.output, null);
});

test('a line too long to read counts as unreadable, its steps not shown done', async t => {
  const path = folder(t);
  write(path, [bash('big', 'cat huge.log')]);
  appendFileSync(join(path, 'stdout.log'), '{"type":"user","x":"' + 'x'.repeat(RUN_STEPS_LINE_LIMIT) + '"}\n');
  write(path, [{ type: 'result', is_error: false }]);
  assert.equal((await read(path)).range(undefined, 12).steps[0]?.state, 'unknown');
});

test('codex: a file change opens to what was done to each file and its diff, said when it ended', async t => {
  const path = folder(t);
  const changes = [{ path: '/src/format.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-Math.floor(x)\n+Math.round(x)' },
    { path: '/src/new.ts', kind: { type: 'add' }, diff: '+export {}' }];
  // It starts with no changes yet; they and their diffs come with its end.
  write(path, [{ type: 'item.started', item: { id: 'f1', type: 'file_change', changes: [], status: 'inProgress' } },
    { type: 'item.completed', item: { id: 'f1', type: 'file_change', changes, status: 'completed' } }]);
  const index = await read(path, 'codex');
  assert.equal(index.range(undefined, 12).steps[0]?.text, '/src/format.ts  /src/new.ts');
  assert.deepEqual((await index.detail(0))?.input,
    { text: 'update: /src/format.ts\n@@ -1 +1 @@\n-Math.floor(x)\n+Math.round(x)\n\nadd: /src/new.ts\n+export {}', omitted: 0 });
});

test('an input field given an empty value is said as given', () => {
  assert.equal(toolInputDocument('mcp__db__update', { id: 7, note: null, tags: [], title: '' }), 'id: 7\nnote: null\ntags: []\ntitle: ""');
});

test('once the Run has ended, a last line with no line end is read: its failure is not taken for done', async t => {
  const path = folder(t);
  write(path, [bash('last', 'pnpm test')]);
  appendFileSync(join(path, 'stdout.log'), JSON.stringify(claudeEnd('last', 'FAIL', true)));
  const index = await read(path);
  assert.equal(index.range(undefined, 12).steps[0]?.state, 'running');
  await index.update('done');
  assert.equal(index.range(undefined, 12).steps[0]?.state, 'failed');
});

test('many changes at once come a page at a time, each change once', async t => {
  const path = folder(t);
  const rows: unknown[] = [];
  for (let n = 0; n < 400; n++) rows.push(bash(`s${n}`, `echo ${n}`));
  write(path, rows);
  const index = await read(path), held = index.range(undefined, 12).version;
  write(path, Array.from({ length: 400 }, (_, at) => claudeEnd(`s${399 - at}`, 'ok')));
  await index.update();
  const seen: number[] = [];
  let answers = 0;
  for (let since = held; ;) {
    const page = index.since(since);
    answers++;
    seen.push(...page.steps.map(step => step.n));
    since = page.version;
    if (page.complete) break;
  }
  assert.equal(answers, 2);
  assert.equal(seen.length, 400);
  assert.equal(new Set(seen).size, 400);
});

test('an output replaced by another is read again as the next generation', async t => {
  const path = folder(t);
  write(path, [bash('a', 'echo a'), bash('b', 'echo b')]);
  const index = await read(path), first = index.range(undefined, 12).generation;
  writeFileSync(join(path, 'stdout.log'), JSON.stringify(bash('c', 'echo c')) + '\n');
  await index.update();
  const page = index.range(undefined, 12);
  assert.notEqual(page.generation, first);
  assert.deepEqual(page.steps.map(step => step.id), ['c']);
});

test('what is left out is counted in characters as people count them', () => {
  assert.equal(fullRunText('x'.repeat(RUN_STEP_FULL_TEXT_LIMIT) + '😀end').omitted, 4);
});

test('a text past the limit says how much was left out; no output reads as no steps', async t => {
  const path = folder(t);
  assert.deepEqual((await read(path)).range(undefined, 12), { steps: [], total: 0, version: 0, complete: true, generation: 0 });
  write(path, [bash('big', 'cat big.log'), claudeEnd('big', 'x'.repeat(RUN_STEP_FULL_TEXT_LIMIT + 10))]);
  const detail = await (await read(path)).detail(0);
  assert.equal(runStepDetailSchema.safeParse(detail).success, true);
  assert.equal(detail?.output?.text.length, RUN_STEP_FULL_TEXT_LIMIT);
  assert.equal(detail?.output?.omitted, 10);
  writeFileSync(join(path, 'stdout.log'), '');
  assert.equal((await read(path)).total, 0);
});

test('an index let go and read anew never answers with a generation an earlier reading had', async t => {
  const path = folder(t);
  write(path, [bash('a', 'echo a')]);
  const first = (await read(path)).range(undefined, 12).generation;
  // The same output read by a new index (as after the index cache let the old one go): another generation.
  assert.notEqual((await read(path)).range(undefined, 12).generation, first);
});

test('an input is put together field by field from its start and end: where a command ran, said only at its start, stays', async t => {
  const path = folder(t);
  write(path, [{ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'pnpm test', cwd: '/src/app' } },
    { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'pnpm test', aggregatedOutput: 'ok', exitCode: 0 } }]);
  assert.deepEqual((await (await read(path, 'codex')).detail(0))?.input, { text: 'pnpm test\n\ncwd: /src/app', omitted: 0 });
});

test('a main argument given empty is said as given', () => {
  assert.equal(toolInputDocument('Grep', { pattern: '', path: '/src' }), '/src\n\npattern: ""');
});

test('only a step that began counts as the Run having steps: an end alone, or the Run\'s end, does not', t => {
  const path = folder(t);
  const reader = new OutputActivityReader(AGENT_RUNTIME_ADAPTERS.claude);
  write(path, [claudeEnd('stray', 'ok'), { type: 'result', is_error: false }]);
  reader.poll(path);
  assert.equal(tookSteps(readRunActivity(path)), false);
  write(path, [bash('one', 'pnpm test'), '{"type":"user","message":{"content":[{"type":"tool_res']);
  reader.poll(path);
  const after = readRunActivity(path);
  assert.deepEqual([after?.steps.length, after?.stepsStarted, tookSteps(after)], [0, 1, true]);
});

test('a search whose fields are said on one line is put together field by field from its start and end', async t => {
  const path = folder(t);
  const call = (type: string, args: Record<string, unknown>) => ({ type, item: { id: 'g1', type: 'mcp_tool_call', server: 'fs', tool: 'grep', arguments: args, status: 'completed' } });
  write(path, [call('item.started', { pattern: 'floor', path: '/src' }), call('item.completed', { pattern: 'round' })]);
  assert.equal((await (await read(path, 'codex')).detail(0))?.input.text, toolInputDocument('grep', { pattern: 'round', path: '/src' }));
  writeFileSync(join(path, 'stdout.log'), '');
  write(path, [call('item.started', { pattern: 'floor', path: '/src' }), call('item.completed', { pattern: '' })]);
  assert.equal((await (await read(path, 'codex')).detail(0))?.input.text, toolInputDocument('grep', { pattern: '', path: '/src' }));
});

test('a codex item crosses the bridge with what its step is read by, its line bounded, and what was cut said', async t => {
  const path = folder(t);
  const output = 'x'.repeat(3 * 1024 * 1024), diff = '+'.repeat(2 * 1024 * 1024);
  const item = boundaryItem('command_execution', { id: 'c1', type: 'commandExecution', command: 'cat big.log', cwd: '/src',
    aggregatedOutput: output, exitCode: 1, status: 'failed', processId: 'p1', commandActions: [{ type: 'read' }], durationMs: 9 });
  const line = JSON.stringify({ type: 'item.completed', item });
  assert.ok(Buffer.byteLength(line) <= BRIDGE_ITEM_BYTES);
  assert.deepEqual(Object.keys(item).sort(), ['aggregatedOutput', 'clipped', 'command', 'cwd', 'exitCode', 'id', 'status', 'type']);
  const edit = boundaryItem('file_change', { id: 'f1', changes: [{ path: '/a.ts', kind: { type: 'update', move_path: null }, diff }] });
  writeFileSync(join(path, 'stdout.log'), line + '\n' + JSON.stringify({ type: 'item.completed', item: edit }) + '\n');
  const index = await read(path, 'codex'), [run, change] = [await index.detail(0), await index.detail(1)];
  assert.equal(index.range(undefined, 12).steps[0]?.state, 'failed');
  assert.equal(run!.output!.text.length + run!.output!.omitted, output.length);
  assert.ok(run!.output!.omitted > 0);
  assert.ok(change!.input.text.startsWith('update: /a.ts\n+++'));
  assert.ok(change!.input.omitted > 0);
});

for (const extra of [0, 1]) test(`a start line ${extra ? 'one byte past' : 'of exactly'} the outcome reader's 2 MiB counts and lists the same step`, async t => {
  const path = folder(t);
  const head = JSON.stringify(bash('long', '')).length;
  const command = 'x'.repeat(2 * 1024 * 1024 - head + extra);
  write(path, [bash('long', command)]);
  assert.equal(Buffer.byteLength(JSON.stringify(bash('long', command))), 2 * 1024 * 1024 + extra);
  const live = new OutputActivityReader(AGENT_RUNTIME_ADAPTERS.claude);
  live.poll(path); live.poll(path);
  const activity = readRunActivity(path);
  assert.deepEqual([activity?.stepsStarted, tookSteps(activity), (await read(path)).total], [1, true, 1]);
});

test('a Run of words alone counts no step and lists none', async t => {
  const path = folder(t);
  write(path, [{ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Hello' }] } }, { type: 'result', is_error: false }]);
  const live = new OutputActivityReader(AGENT_RUNTIME_ADAPTERS.claude);
  live.poll(path);
  assert.deepEqual([tookSteps(readRunActivity(path)), (await read(path)).total], [false, 0]);
});
