import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutputActivityReader, readRunActivity } from '@alpacawork/backend/test-dist/runs/activity.js';
import { AGENT_RUNTIME_ADAPTERS } from '@alpacawork/backend/test-dist/agents/registry.js';
import { RUN_FILES, RUN_NOTE_LIMIT, RUN_STEP_LIMIT, RUN_STEP_TEXT_LIMIT, RUN_TOOL_ID_LIMIT, RUN_TOOL_NAME_LIMIT } from '@alpacawork/contract/run';

for (const agent of ['claude', 'codex'] as const) test(`${agent}: current work follows IDs, not the latest tool event`, t => {
  const folder = mkdtempSync(join(tmpdir(), 'run-work-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const at = '2026-11-24T01:00:00.000Z';
  const create = () => new OutputActivityReader(AGENT_RUNTIME_ADAPTERS[agent], () => Date.parse(at));
  const reader = create();
  const emit = (value: unknown) => {
    appendFileSync(join(folder, 'stdout.log'), JSON.stringify(value) + '\n');
    reader.poll(folder);
    return readRunActivity(folder);
  };
  const start = (id: string, command: string) => agent === 'claude'
    ? { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name: 'Bash',
      input: { command, description: 'Check the catalog' } }] } }
    : { type: 'item.started', item: { id, type: 'command_execution', command: "/bin/bash -lc '" + command + "'" } };
  const end = (id: string, failed = false) => {
    const text = failed ? 'Missing catalog\nTry another path' : 'Catalog found';
    return agent === 'claude'
      ? { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: failed,
        content: [{ type: 'text', text }] }] } }
      : { type: 'item.completed', item: { id, type: 'command_execution', aggregatedOutput: text, exitCode: failed ? 2 : 0 } };
  };
  const one = emit(start('one', 'alpacawork task new --title test'));
  assert.equal(one?.doing?.command, 'task.new');
  assert.deepEqual(one.steps[0], { id: 'one', at, tool: agent === 'claude' ? 'Bash' : 'command_execution',
    text: 'alpacawork task new --title test', more: 0, about: agent === 'claude' ? 'Check the catalog' : null, state: 'running', result: null });
  assert.equal(emit(start('two', 'alpacawork task update --task T1 --title changed'))?.doing?.command, 'task.update');
  const failed = emit(end('one', true));
  assert.equal(failed?.doing?.command, 'task.update');
  assert.deepEqual(failed.steps.map(({ id, state, result }) => ({ id, state, result })), [
    { id: 'one', state: 'failed', result: { text: 'Missing catalog', more: 1 } },
    { id: 'two', state: 'running', result: null },
  ]);
  const done = emit(end('two'));
  assert.equal(done?.doing, null);
  assert.deepEqual(done.steps[1]?.result, { text: 'Catalog found', more: 0 });
  emit(start('three', 'alpacawork task request --task T1 --instruction-file /tmp/brief'));
  if (agent === 'codex') {
    emit({ type: 'item.started', item: { id: 'web', type: 'web_search', query: '' } });
    assert.deepEqual(emit({ type: 'item.completed', item: { id: 'web', type: 'web_search', query: 'local catalog' } })?.steps.at(-1),
      { id: 'web', at, tool: 'web_search', text: 'local catalog', more: 0, about: null, state: 'done', result: null });
    const search = emit({ type: 'item.completed', item: { id: 'web-only', type: 'web_search', query: 'catalog tiles' } });
    assert.equal(search?.doing?.command, 'task.request');
    assert.equal(search.steps.at(-1)?.text, 'catalog tiles');
    assert.equal(search.steps.at(-1)?.state, 'done');
  } else {
    const read = emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'catalog.txt' } }] } });
    assert.equal(read?.steps.at(-1)?.text, 'catalog.txt');
    emit(end('read'));
  }
  assert.equal(emit(start('unknown', 'echo alpacawork task new'))?.doing?.command, null);
  assert.equal(emit(end('unknown'))?.doing?.command, 'task.request');
  const result = emit(agent === 'claude' ? { type: 'result' } : { type: 'turn.completed' });
  assert.equal(result?.doing, null);
  assert.equal(result.steps.find(step => step.id === 'three')?.state, 'done');
  emit(start('four', 'alpacawork task get --task T1'));
  appendFileSync(join(folder, 'stdout.log'), 'x'.repeat(2 * 1024 * 1024 + 1) + '\n');
  reader.poll(folder);
  assert.equal(readRunActivity(folder)?.doing, null, 'a skipped completion cannot leave a current operation behind');
  assert.ok(!readRunActivity(folder)?.steps.some(step => step.id === 'four'), 'a gap does not prove a tool finished successfully');
  emit(start('five', 'alpacawork task new --title test'));
  assert.equal(emit(end('unobserved'))?.doing?.command, 'task.new', 'an unmatched ID cannot settle a parallel tool');
  const error = emit(agent === 'claude' ? { type: 'result', is_error: true } : { type: 'turn.failed' });
  assert.equal(error?.steps.find(step => step.id === 'five')?.state, 'failed');
  assert.equal(error.doing, null);
  emit(start('six', 'alpacawork task new --title test'));
  emit(start('seven', 'alpacawork task list'));
  appendFileSync(join(folder, 'stdout.log'), JSON.stringify(end('seven')));
  reader.finish(folder, 'failed');
  const finished = readRunActivity(folder);
  assert.equal(finished?.doing, null, 'process exit clears work even without a result event');
  assert.equal(finished.steps.find(step => step.id === 'six')?.state, 'failed');
  assert.equal(finished.steps.at(-1)?.state, 'done', 'a final result without a newline still counts');
  const replay = create();
  replay.poll(folder);
  replay.finish(folder, 'failed');
  assert.deepEqual(readRunActivity(folder), finished, 're-reading stdout rebuilds the same settled steps');
});

test('bounded step previews survive long tool arguments, escaped JSON and oversized results', t => {
  const folder = mkdtempSync(join(tmpdir(), 'run-work-bounds-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const reader = new OutputActivityReader(AGENT_RUNTIME_ADAPTERS.claude);
  const raw = join(folder, RUN_FILES.stdout);
  const emit = (type: 'assistant' | 'user', ...content: unknown[]) =>
    appendFileSync(raw, JSON.stringify({ type, parent_tool_use_id: null, message: { content } }) + '\n');
  const tool = (id: string, input: object, name = 'Bash') => ({ type: 'tool_use', id, name, input });
  const result = (id: string, content: string) => ({ type: 'tool_result', tool_use_id: id, content });
  const line = 'x'.repeat(RUN_STEP_TEXT_LIMIT - 1);
  const long = line + '😀' + 'x'.repeat(70 * 1024) + '\r\n\r\nsecond\rthird\r\n';
  emit('assistant', tool('large', { command: long, description: line + '😀' }));
  emit('user', result('large', long.repeat(12)));
  reader.poll(folder);
  const step = readRunActivity(folder)?.steps[0];
  assert.equal(step?.text, line);
  assert.equal(step.more, 3);
  assert.equal(step.about, line);
  assert.equal(step.result?.text, line);
  assert.equal(step.result.more, 47);

  const escaped = '\0'.repeat(RUN_STEP_TEXT_LIMIT);
  const ids = Array.from({ length: RUN_STEP_LIMIT + 1 }, (_, i) => i + '\0'.repeat(RUN_TOOL_ID_LIMIT - 1));
  emit('assistant', tool(ids[0]!, { command: 'long-running command' }));
  for (const id of ids.slice(1)) {
    emit('assistant', tool(id, { command: escaped, description: escaped }));
    emit('user', result(id, escaped));
  }
  emit('assistant', { type: 'text', text: '\0'.repeat(RUN_NOTE_LIMIT) });
  reader.poll(folder);
  const saved = readRunActivity(folder);
  assert.equal(saved?.note?.text.length, RUN_NOTE_LIMIT);
  assert.deepEqual(saved.steps.map(item => item.id), ids.slice(1));
  assert.equal(saved.steps.at(-1)?.result?.text, escaped);
  assert.ok(statSync(join(folder, RUN_FILES.activity)).size < 64 * 1024);
  emit('user', result(ids[0]!, 'Finished after eviction'));
  reader.poll(folder);
  assert.deepEqual(readRunActivity(folder)?.steps, saved.steps);

  emit('assistant', tool('skipped', { command: 'read large output' }));
  emit('user', result('skipped', 'x'.repeat(2 * 1024 * 1024)));
  emit('assistant', tool('recover', {}, 'n'.repeat(RUN_TOOL_NAME_LIMIT - 1) + '😀'));
  reader.poll(folder);
  const recovered = readRunActivity(folder);
  assert.ok(recovered?.steps.every(item => item.id !== 'skipped'));
  assert.equal(recovered.steps.at(-1)?.tool, 'n'.repeat(RUN_TOOL_NAME_LIMIT - 1));
});
