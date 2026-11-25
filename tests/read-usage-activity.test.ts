import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_RUNTIME_ADAPTERS } from '@alpacawork/backend/test-dist/agents/registry.js';
import { OutputActivityReader, readRunActivity } from '@alpacawork/backend/test-dist/runs/activity.js';
test('activity maps tool result to the original tool', t => {
  const folder = mkdtempSync(join(tmpdir(), 'read-activity-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const stdout = (lines: unknown[]) => writeFileSync(join(folder, 'stdout.log'), lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  const activity = new OutputActivityReader(AGENT_RUNTIME_ADAPTERS.claude);
  stdout([{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'shell' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } }]);
  activity.poll(folder);
  const saved = readRunActivity(folder);
  assert.equal(saved?.toolName, 'shell');
  assert.equal(saved.kind, 'tool_end');
  assert.equal(saved.doing, null);
  assert.equal(saved.note, null);
  assert.equal(saved.context, null);
  assert.equal(saved.steps[0]?.state, 'done');
});

test('the latest direct words survive tool activity and helper output', t => {
  const folder = mkdtempSync(join(tmpdir(), 'read-note-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const activity = new OutputActivityReader(AGENT_RUNTIME_ADAPTERS.claude);
  writeFileSync(join(folder, 'stdout.log'), [
    { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Summarizing the\ninvestigation results.' }] } },
    { type: 'assistant', parent_tool_use_id: 'helper1', message: { content: [{ type: 'text', text: 'helper says' }] } },
    { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: 'shell' }] } },
  ].map(line => JSON.stringify(line)).join('\n') + '\n');
  activity.poll(folder);
  assert.equal(readRunActivity(folder)?.kind, 'tool_start');
  assert.equal(readRunActivity(folder)?.note?.text, 'Summarizing the\ninvestigation results.');
});

test('short Claude progress updates survive empty, long and nested thinking blocks', t => {
  const folder = mkdtempSync(join(tmpdir(), 'read-progress-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const activity = new OutputActivityReader(AGENT_RUNTIME_ADAPTERS.claude);
  const thinking = (text: string) => ({ type: 'thinking', thinking: text, signature: 'opaque' });
  const emit = (parent: string | null, ...content: unknown[]) => {
    appendFileSync(join(folder, 'stdout.log'), JSON.stringify({ type: 'assistant', parent_tool_use_id: parent, message: { content } }) + '\n');
    activity.poll(folder);
  };
  emit(null, thinking('Checking the catalog.'));
  emit(null, thinking('  '), thinking('long reasoning '.repeat(100)));
  emit('helper', thinking('Nested progress'));
  assert.equal(readRunActivity(folder)?.note?.text, 'Checking the catalog.');
  emit(null, { type: 'text', text: 'I found the catalog.' }, thinking('Checking again.'));
  assert.equal(readRunActivity(folder)?.note?.text, 'I found the catalog.');
});

test('activity note stays within the contract limit without splitting an emoji', t => {
  const folder = mkdtempSync(join(tmpdir(), 'read-note-limit-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  writeFileSync(join(folder, 'stdout.log'), JSON.stringify({ type: 'assistant', parent_tool_use_id: null,
    message: { content: [{ type: 'text', text: `${'a'.repeat(499)}😀` }] } }) + '\n');
  new OutputActivityReader(AGENT_RUNTIME_ADAPTERS.claude).poll(folder);
  assert.equal(readRunActivity(folder)?.note?.text, 'a'.repeat(499));
});

test('the default Codex reader keeps agent_message text through the next tool', t => {
  const folder = mkdtempSync(join(tmpdir(), 'read-codex-note-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  writeFileSync(join(folder, 'stdout.log'), [
    { type: 'item.completed', item: { type: 'agent_message', text: 'I have checked the first result.' } },
    { type: 'item.started', item: { type: 'command_execution' } },
  ].map(line => JSON.stringify(line)).join('\n') + '\n');
  new OutputActivityReader(AGENT_RUNTIME_ADAPTERS.codex).poll(folder);
  assert.equal(readRunActivity(folder)?.kind, 'tool_start');
  assert.equal(readRunActivity(folder)?.note?.text, 'I have checked the first result.');
});


test('activity preserves Markdown lines and never cuts inside code, emphasis or a file link', t => {
  const folder = mkdtempSync(join(tmpdir(), 'read-note-markdown-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const head = '- **Checked** `model`\n- [Plan](plan.md)\n';
  for (const suffix of ['`long code here`', '**long emphasis here**', '[Long plan](notes/plan.md)']) {
    const prefix = head + 'x'.repeat(490 - head.length) + ' ';
    writeFileSync(join(folder, 'stdout.log'), JSON.stringify({ type: 'item.completed',
      item: { type: 'agent_message', text: prefix + suffix } }) + '\n');
    new OutputActivityReader(AGENT_RUNTIME_ADAPTERS.codex).poll(folder);
    assert.equal(readRunActivity(folder)?.note?.text, prefix.trimEnd());
  }
});
