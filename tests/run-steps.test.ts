/** Every step of a Run, read from its output when the screen opens them: listed a page at a time, each read in full. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStepIndex, RUN_STEPS_LINE_LIMIT } from '@alpacawork/backend/test-dist/runs/run-steps.js';
import { OutputActivityReader, readRunActivity } from '@alpacawork/backend/test-dist/runs/activity.js';
import { stepFingerprint } from '@alpacawork/backend/test-dist/runs/step-journal.js';
import { AGENT_RUNTIME_ADAPTERS } from '@alpacawork/backend/test-dist/agents/registry.js';
import { BRIDGE_LINE_BYTES, OUTCOME_LINE_BYTES, boundBridgeEvent, boundaryItem, clippedUnder } from '@alpacawork/contract/agent-bridge';
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
  assert.deepEqual(Object.keys(item).sort(), ['aggregatedOutput', 'command', 'cwd', 'exitCode', 'id', 'status', 'type']);
  const line = JSON.stringify(boundBridgeEvent({ type: 'item.completed', item }));
  assert.ok(Buffer.byteLength(line) <= BRIDGE_LINE_BYTES);
  const edit = boundBridgeEvent({ type: 'item.completed', item: boundaryItem('file_change', { id: 'f1',
    changes: [{ path: '/a.ts', kind: { type: 'update', move_path: null }, diff }] }) });
  writeFileSync(join(path, 'stdout.log'), line + '\n' + JSON.stringify(edit) + '\n');
  const index = await read(path, 'codex'), [run, change] = [await index.detail(0), await index.detail(1)];
  assert.equal(index.range(undefined, 12).steps[0]?.state, 'failed');
  assert.equal(run!.output!.text.length + run!.output!.omitted, output.length);
  assert.ok(run!.output!.omitted > 0);
  assert.ok(change!.input.text.startsWith('update: /a.ts\n+++'));
  assert.ok(change!.input.omitted > 0);
});

test('a bridge tool event of any text stays within the line limit, saying what it left out', () => {
  // Control characters take six bytes each once written: the step's own text limit alone would pass the line limit.
  const text = '\u0001'.repeat(256 * 1024);
  const event = boundBridgeEvent({ type: 'tool.completed', id: 't1', tool: 'command_execution', name: 'bash',
    result: { text: '', more: 0 }, failed: false, output: { text, omitted: 5 } });
  assert.ok(Buffer.byteLength(JSON.stringify(event)) <= BRIDGE_LINE_BYTES);
  const output = (event as { output: { text: string; omitted: number } }).output;
  assert.equal(output.text.length + output.omitted, text.length + 5);
});

test('what was left out of an input is counted from the record each field was taken from', async t => {
  const path = folder(t);
  const long = 'echo ' + 'x'.repeat(300 * 1024);
  const started = boundBridgeEvent({ type: 'item.started', item: boundaryItem('command_execution', { id: 'c1', command: long, cwd: '/src' }) });
  const ended = boundBridgeEvent({ type: 'item.completed', item: boundaryItem('command_execution', { id: 'c1', command: 'echo short', aggregatedOutput: 'ok', exitCode: 0 }) });
  writeFileSync(join(path, 'stdout.log'), [started, ended].map(row => JSON.stringify(row)).join('\n') + '\n');
  assert.deepEqual((await (await read(path, 'codex')).detail(0))?.input, { text: 'echo short\n\ncwd: /src', omitted: 0 });
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

test('a structured result too long for the line is said as the text a step shows, cut, its cut count with it alone', () => {
  const numbers = Array.from({ length: 300_000 }, (_, n) => 10_000 + n);
  const event = boundBridgeEvent({ type: 'item.completed', item: boundaryItem('mcp_tool_call', { id: 't1', server: 'db', tool: 'rows', status: 'completed',
    result: { content: [], structuredContent: numbers } }) }) as { item: Record<string, unknown> };
  assert.ok(Buffer.byteLength(JSON.stringify(event)) <= BRIDGE_LINE_BYTES);
  assert.equal(typeof event.item.result, 'string');
  assert.equal((event.item.result as string).length + clippedUnder(event.item, ['result']), JSON.stringify(numbers, null, 2).length);
});

test('a structure nested past what a writer that calls itself takes is said as its JSON text without failing', () => {
  let deep: unknown = 'end';
  for (let level = 0; level < 200_000; level++) deep = [deep];
  const event = boundBridgeEvent({ type: 'item.completed', item: { type: 'mcp_tool_call', id: 't1', status: 'completed',
    result: { content: [], structuredContent: deep } } }) as { item: Record<string, unknown> };
  assert.ok(Buffer.byteLength(JSON.stringify(event)) <= BRIDGE_LINE_BYTES);
  assert.ok((event.item.result as string).startsWith('[[[['));
  assert.ok(clippedUnder(event.item, ['result']) > 0);
});

test('an edit of eleven thousand files keeps every path and kind, and opens to the first files and their diffs, its cut count on its text', async t => {
  const path = folder(t);
  const changes = Array.from({ length: 11_000 }, (_, n) => ({ path: `/src/file-${n}.ts`, kind: { type: 'update', move_path: null },
    diff: `@@ -1 +1 @@\n-old ${n}\n+new ${n}\n` + 'x'.repeat(120) }));
  const event = boundBridgeEvent({ type: 'item.completed', item: boundaryItem('file_change', { id: 'f1', changes, status: 'completed' }) }) as
    { item: Record<string, unknown> };
  assert.ok(Buffer.byteLength(JSON.stringify(event)) <= BRIDGE_LINE_BYTES);
  assert.deepEqual((event.item.changes as unknown[]).length, 11_000);
  assert.deepEqual((event.item.changes as unknown[])[10_999], { path: '/src/file-10999.ts', kind: { type: 'update', move_path: null } });
  writeFileSync(join(path, 'stdout.log'), JSON.stringify(event) + '\n');
  const index = await read(path, 'codex'), detail = await index.detail(0);
  assert.ok(detail!.input.text.startsWith('update: /src/file-0.ts\n@@ -1 +1 @@\n-old 0\n+new 0'));
  assert.equal(detail!.input.omitted, clippedUnder(event.item, ['changesText']));
  assert.ok(detail!.input.omitted > 0);
});

test('a long step ID, a failure told by isError alone, and a short error beside a cut field each stay as they were', async t => {
  const path = folder(t);
  const id = 'call_' + 'a'.repeat(105);
  const huge = { table: 'x'.repeat(2 * 1024 * 1024) };
  const started = boundBridgeEvent({ type: 'item.started', item: boundaryItem('mcp_tool_call', { id, server: 'db', tool: 'rows', status: 'inProgress', arguments: huge }) });
  const ended = boundBridgeEvent({ type: 'item.completed', item: boundaryItem('mcp_tool_call', { id, server: 'db', tool: 'rows', status: 'completed',
    arguments: huge, error: { message: 'short failure' }, result: { isError: true, content: [], structuredContent: null } }) });
  writeFileSync(join(path, 'stdout.log'), [started, ended].map(row => JSON.stringify(row)).join('\n') + '\n');
  const index = await read(path, 'codex'), steps = index.range(undefined, 12).steps;
  assert.deepEqual(steps.map(step => [step.id, step.state]), [[id, 'failed']]);
  const detail = await index.detail(0);
  assert.deepEqual(detail!.output, { text: 'short failure', omitted: 0 });
  assert.ok(detail!.input.omitted > 0);
});

test('an edit whose file list alone passes the line keeps the files that fit from its start and tells how many more', async t => {
  const path = folder(t);
  const changes = Array.from({ length: 60_000 }, (_, n) => ({ path: `/src/packages/module-${n}/components/generated/file-${n}.ts`,
    kind: { type: 'add' }, diff: `+export const value${n} = ${n};` }));
  const event = boundBridgeEvent({ type: 'item.completed', item: boundaryItem('file_change', { id: 'f1', changes, status: 'completed' }) }) as
    { item: Record<string, unknown> };
  assert.ok(Buffer.byteLength(JSON.stringify(event)) <= BRIDGE_LINE_BYTES);
  const kept = (event.item.changes as unknown[]).length;
  assert.deepEqual([event.item.id, event.item.status, event.item.changeCount], ['f1', 'completed', 60_000]);
  assert.ok(kept < 60_000);
  writeFileSync(join(path, 'stdout.log'), JSON.stringify(event) + '\n');
  const index = await read(path, 'codex'), detail = await index.detail(0);
  assert.equal(index.range(undefined, 12).steps[0]?.state, 'done');
  assert.ok(detail!.input.text.startsWith('add: /src/packages/module-0/components/generated/file-0.ts\n+export const value0 = 0;'));
  const headings = detail!.input.text.split('\n').filter(line => /^add: \/src\/packages\/module-\d+\/components\/generated\/file-\d+\.ts$/.test(line)).length;
  assert.equal(detail!.input.omittedFiles, 60_000 - headings);
});

test('a line still too long once its readable fields are cut is written as main writes it, marked, and fits', () => {
  // A diagnostic that is no readable field, and a list of IDs that says who a call went to.
  const diagnostic = boundBridgeEvent({ type: 'error', message: 'retry diagnostic '.repeat(130_000) } as never) as Record<string, unknown>;
  assert.ok(Buffer.byteLength(JSON.stringify(diagnostic)) <= BRIDGE_LINE_BYTES);
  assert.equal(diagnostic.type, 'error');
  assert.ok((diagnostic.message as string).startsWith('retry diagnostic'));
  const call = boundBridgeEvent({ type: 'item.completed', item: boundaryItem('collab_agent_tool_call', { id: 'r1', status: 'completed', prompt: 'check in',
    receiverThreadIds: Array.from({ length: 60_000 }, (_, n) => `thread-${n}-0123456789`) }) }) as { item: Record<string, unknown> };
  assert.ok(Buffer.byteLength(JSON.stringify(call)) <= BRIDGE_LINE_BYTES);
  assert.deepEqual(call.item, { type: 'collab_agent_tool_call', id: 'r1', status: 'completed', prompt: 'check in', detailsDropped: true });
});

test('an edit is taken whole from its end when the end gives one, none of its start mixed in', async t => {
  const path = folder(t);
  const big = Array.from({ length: 60_000 }, (_, n) => ({ path: `/src/packages/module-${n}/file-${n}.ts`, kind: { type: 'add' }, diff: `+export const v${n} = ${n};` }));
  const started = boundBridgeEvent({ type: 'item.started', item: boundaryItem('file_change', { id: 'f1', changes: big, status: 'inProgress' }) });
  const ended = boundBridgeEvent({ type: 'item.completed', item: boundaryItem('file_change', { id: 'f1', status: 'completed',
    changes: [{ path: '/src/only.ts', kind: { type: 'update', move_path: null }, diff: '-a\n+b' }] }) });
  writeFileSync(join(path, 'stdout.log'), [started, ended].map(row => JSON.stringify(row)).join('\n') + '\n');
  const detail = await (await read(path, 'codex')).detail(0);
  assert.deepEqual(detail!.input, { text: 'update: /src/only.ts\n-a\n+b', omitted: 0 });
});

test('"and N more files" counts every file whose heading the text does not show', async t => {
  const path = folder(t);
  const changes = Array.from({ length: 60_000 }, (_, n) => ({ path: `/src/packages/module-${n}/file-${n}.ts`, kind: { type: 'add' }, diff: `+export const v${n} = ${n};` }));
  const event = boundBridgeEvent({ type: 'item.completed', item: boundaryItem('file_change', { id: 'f1', changes, status: 'completed' }) });
  writeFileSync(join(path, 'stdout.log'), JSON.stringify(event) + '\n');
  const detail = await (await read(path, 'codex')).detail(0);
  // A heading cut in the middle of its path does not show that file.
  const headings = detail!.input.text.split('\n').filter(line => /^add: \/src\/packages\/module-\d+\/file-\d+\.ts$/.test(line)).length;
  assert.equal(detail!.input.omittedFiles, 60_000 - headings);
});

test('a bash command cut short by the bridge still shows the script inside it', async t => {
  const path = folder(t);
  const script = "printf 'a'\n" + 'echo line\n'.repeat(150_000);
  const event = boundBridgeEvent({ type: 'item.started', item: boundaryItem('command_execution', { id: 'c1', command: `/bin/bash -lc '${script.replaceAll("'", "'\\''")}'` }) });
  writeFileSync(join(path, 'stdout.log'), JSON.stringify(event) + '\n');
  const detail = await (await read(path, 'codex')).detail(0);
  assert.ok(detail!.input.text.startsWith("printf 'a'\necho line\n"));
  assert.ok(detail!.input.omitted > 0);
});

test('the last guard always fits: an ID near the outcome reader\'s limit is written as main would, and marked while that fits', () => {
  for (const length of [1_500_000, 2 * 1024 * 1024 - 80]) {
    const event = boundBridgeEvent({ type: 'item.completed', item: boundaryItem('command_execution', { id: 'x'.repeat(length), command: 'echo hi',
      aggregatedOutput: 'y'.repeat(600_000), status: 'completed' }) }) as { item: Record<string, unknown> };
    const main = { type: 'item.completed', item: { type: 'command_execution', id: 'x'.repeat(length), command: 'echo hi' } };
    assert.ok(Buffer.byteLength(JSON.stringify(event)) <= Math.max(OUTCOME_LINE_BYTES, Buffer.byteLength(JSON.stringify(main))));
    if (length === 1_500_000) assert.equal(event.item.detailsDropped, true);
  }
});

test('a step whose details the last guard dropped keeps how it went, or says that is not known', async t => {
  const path = folder(t);
  const receivers = Array.from({ length: 60_000 }, (_, n) => `thread-${n}-0123456789`);
  const failed = boundBridgeEvent({ type: 'item.completed', item: boundaryItem('collab_agent_tool_call', { id: 'r1', status: 'failed', receiverThreadIds: receivers }) });
  const silent = boundBridgeEvent({ type: 'item.completed', item: boundaryItem('collab_agent_tool_call', { id: 'r2', receiverThreadIds: receivers }) });
  writeFileSync(join(path, 'stdout.log'), [failed, silent].map(row => JSON.stringify(row)).join('\n') + '\n');
  assert.deepEqual((await read(path, 'codex')).range(undefined, 12).steps.map(step => [step.id, step.state]), [['r1', 'failed'], ['r2', 'unknown']]);
});

test('"and N more files" counts the files the opened text hides even when the line was never cut', async t => {
  const path = folder(t);
  const changes = [{ path: '/big.ts', kind: { type: 'add' }, diff: '+' + 'x'.repeat(270_000) },
    { path: '/b.ts', kind: { type: 'add' }, diff: '+b' }, { path: '/c.ts', kind: { type: 'add' }, diff: '+c' }];
  write(path, [{ type: 'item.completed', item: { id: 'f1', type: 'file_change', changes, status: 'completed' } }]);
  const detail = await (await read(path, 'codex')).detail(0);
  assert.ok(detail!.input.text.startsWith('add: /big.ts'));
  assert.equal(detail!.input.omittedFiles, 2);
});

test('the last guard keeps a failure\'s short fields, as its reason, and cuts its long ones', () => {
  const event = boundBridgeEvent({ type: 'turn.failed', error: { message: 'capacity '.repeat(140_000), cause: 'model_capacity' } }) as
    { type: string; error: { message: string; cause: string } };
  assert.ok(Buffer.byteLength(JSON.stringify(event)) <= BRIDGE_LINE_BYTES);
  assert.equal(event.type, 'turn.failed');
  assert.equal(event.error.cause, 'model_capacity');
  assert.ok(event.error.message.startsWith('capacity'));
});

test('a bash command quoted whole with more after it is shown as it was written', async t => {
  const path = folder(t);
  const command = "/bin/bash -lc 'echo a' runner";
  write(path, [{ type: 'item.started', item: { id: 'c1', type: 'command_execution', command } }]);
  assert.equal((await (await read(path, 'codex')).detail(0))?.input.text, command);
});

test('the last guard keeps a long ID by name, so a failure there stays the failure of the step it ended', async t => {
  const path = folder(t);
  const id = '作業'.repeat(55);
  const started = boundBridgeEvent({ type: 'item.started', item: boundaryItem('collab_agent_tool_call', { id, prompt: 'check in' }) });
  const ended = boundBridgeEvent({ type: 'item.completed', item: boundaryItem('collab_agent_tool_call', { id, status: 'failed',
    receiverThreadIds: Array.from({ length: 60_000 }, (_, n) => `thread-${n}-0123456789`) }) }) as { item: Record<string, unknown> };
  assert.ok(Buffer.byteLength(JSON.stringify(ended)) <= BRIDGE_LINE_BYTES);
  assert.equal(ended.item.id, id);
  writeFileSync(join(path, 'stdout.log'), [started, ended].map(row => JSON.stringify(row)).join('\n') + '\n');
  const index = await read(path, 'codex');
  await index.update('done');
  assert.deepEqual(index.range(undefined, 12).steps.map(step => [step.id, step.state]), [[id, 'failed']]);
});

test('a diff that reads like the next file\'s heading does not make a file shown count as hidden', async t => {
  const path = folder(t);
  const changes = [{ path: '/a.ts', kind: { type: 'update', move_path: null }, diff: '+// see\nupdate: /b.ts\n' },
    { path: '/b.ts', kind: { type: 'update', move_path: null }, diff: '+b' }, { path: '/c.ts', kind: { type: 'add' }, diff: '+c' }];
  write(path, [{ type: 'item.completed', item: { id: 'f1', type: 'file_change', changes, status: 'completed' } }]);
  const detail = await (await read(path, 'codex')).detail(0);
  assert.equal(detail!.input.omittedFiles, undefined);
});

test('a bash script followed by a quoted argument is shown as written, not taken as reaching the last quote', async t => {
  const path = folder(t);
  const command = "/bin/bash -lc 'echo a' 'runner'";
  write(path, [{ type: 'item.started', item: { id: 'c1', type: 'command_execution', command } },
    { type: 'item.started', item: { id: 'c2', type: 'command_execution', command: "/bin/bash -lc 'echo '\\''quoted'\\'' done'" } }]);
  const index = await read(path, 'codex');
  assert.equal((await index.detail(0))?.input.text, command);
  assert.equal((await index.detail(1))?.input.text, "echo 'quoted' done");
});

test('a bash command whose closing quote is not its last character is shown as written; one ending in it, or cut, shows its script', async t => {
  const path = folder(t);
  const redirected = "/bin/bash -lc 'cd /tmp; pwd'>out.txt";
  write(path, [{ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: redirected } },
    { type: 'item.started', item: { id: 'c2', type: 'command_execution', command: "/bin/bash -lc 'cd /tmp; pwd'" } }]);
  const cut = boundBridgeEvent({ type: 'item.started', item: boundaryItem('command_execution', { id: 'c3',
    command: "/bin/bash -lc 'echo start\n" + 'echo line\n'.repeat(150_000) + "'" }) });
  appendFileSync(join(path, 'stdout.log'), JSON.stringify(cut) + '\n');
  const index = await read(path, 'codex');
  assert.equal((await index.detail(0))?.input.text, redirected);
  assert.equal((await index.detail(1))?.input.text, 'cd /tmp; pwd');
  assert.ok((await index.detail(2))!.input.text.startsWith('echo start\necho line\n'));
});

test('a file whose name holds a line break, its heading cut partway, counts as hidden', async t => {
  const path = folder(t);
  const first = 'add: /a.ts\n', second = 'add: /dir\nname-long.ts';
  // The first diff ends where the opened text, cut at its limit, stops inside the second heading after its line break.
  const diff = '+' + 'x'.repeat(RUN_STEP_FULL_TEXT_LIMIT - first.length - 2 - 'add: /dir\nna'.length - 1);
  const changes = [{ path: '/a.ts', kind: { type: 'add' }, diff }, { path: '/dir\nname-long.ts', kind: { type: 'add' }, diff: '+b' }];
  write(path, [{ type: 'item.completed', item: { id: 'f1', type: 'file_change', changes, status: 'completed' } }]);
  const detail = await (await read(path, 'codex')).detail(0);
  assert.ok(detail!.input.text.endsWith('add: /dir\nna'));
  assert.ok(!detail!.input.text.includes(second));
  assert.equal(detail!.input.omittedFiles, 1);
});

test('step times: kept as each step starts and ends, never replaced when the output is read again, and listed with the steps', async t => {
  const path = folder(t);
  let clock = Date.parse('2026-11-26T01:00:00.000Z');
  const live = new OutputActivityReader(AGENT_RUNTIME_ADAPTERS.claude, () => clock);
  write(path, [bash('one', 'cat <<EOF > /tmp/a.txt\nhello\nEOF')]);
  live.poll(path);
  clock += 4000;
  write(path, [claudeEnd('one', 'ok'), { ...claudeStart('sub', { prompt: 'look' }, 'Task') },
    { ...bash('inner', 'ls'), parent_tool_use_id: 'sub' }, { ...claudeEnd('inner', 'a'), timestamp: '2026-11-26T01:00:05.500Z' }]);
  live.poll(path);
  // The same output read again from its start, later (a new manager): nothing it already kept changes.
  clock += 60_000;
  new OutputActivityReader(AGENT_RUNTIME_ADAPTERS.claude, () => clock).finish(path, 'done');
  const steps = (await read(path)).range(undefined, 12).steps;
  assert.equal(runStepsPageSchema.safeParse({ steps, total: 3, version: 0, complete: true, generation: 0 }).success, true);
  assert.deepEqual(steps.map(({ id, startedAt, startSource, endedAt, endSource, parent, subagentSteps }) =>
    ({ id, startedAt, startSource, endedAt, endSource, parent, subagentSteps })), [
    { id: 'one', startedAt: '2026-11-26T01:00:00.000Z', startSource: 'read', endedAt: '2026-11-26T01:00:04.000Z', endSource: 'read', parent: null, subagentSteps: 0 },
    { id: 'sub', startedAt: '2026-11-26T01:00:04.000Z', startSource: 'read', endedAt: '2026-11-26T01:01:04.000Z', endSource: 'read', parent: null, subagentSteps: 1 },
    { id: 'inner', startedAt: '2026-11-26T01:00:04.000Z', startSource: 'read', endedAt: '2026-11-26T01:00:05.500Z', endSource: 'row', parent: 'sub', subagentSteps: 0 },
  ]);
  assert.deepEqual(steps[0]?.fingerprint, { line: 'cat <<EOF > <path>', body: steps[0]?.fingerprint?.body });
  assert.match(steps[0]?.fingerprint?.body ?? '', /^[0-9a-f]{16}$/);
  assert.equal(steps[0]?.output?.chars, 2);
});

test('step fingerprint: the same command with other paths, IDs and numbers reads as one; another body does not', () => {
  const one = stepFingerprint('alpacawork task get --task T1093 --runs 3 > /tmp/x-1.json');
  assert.deepEqual(one, stepFingerprint('alpacawork task get --task T42 --runs 10 > /home/a/out.json'));
  assert.deepEqual(stepFingerprint('git show 3485f2a36:README.md'), { line: 'git show <hash>:README.md', body: null });
  assert.notDeepEqual(stepFingerprint('python3 - <<EOF\nprint(1)\nEOF'), stepFingerprint('python3 - <<EOF\nprint(2)\nEOF'));
});

test('a step time written after the index read its line comes with the next since, and a torn journal line loses nothing after it', async t => {
  const path = folder(t);
  write(path, [bash('one', 'ls')]);
  const index = await read(path);
  const first = index.range(undefined, 12);
  assert.equal(first.steps[0]?.startedAt, null);
  // The manager's journal ends in a line a crash cut short; the next entry still lands whole.
  appendFileSync(join(path, 'steps.jsonl'), '{"event":"start","li');
  new OutputActivityReader(AGENT_RUNTIME_ADAPTERS.claude, () => Date.parse('2026-11-26T02:00:00.000Z')).poll(path);
  await index.update();
  assert.deepEqual(index.since(first.version).steps.map(step => [step.id, step.startedAt]), [['one', '2026-11-26T02:00:00.000Z']]);
});
