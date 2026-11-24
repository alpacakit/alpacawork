/** Claude compacts with its own `/compact` command before the instruction; the rows are as Claude 2.1.330 prints them. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_RUNTIME_ADAPTERS } from '@alpacawork/backend/test-dist/agents/registry.js';

const session = 's1', compaction = '22222222-2222-4222-8222-222222222222', instruction = '33333333-3333-4333-8333-333333333333';
const claude = AGENT_RUNTIME_ADAPTERS.claude;
const lifecycle = (id: string, state: string) => ({ type: 'command_lifecycle', state, command_uuid: id, session_id: session });
const said = (text: string) => ({ type: 'assistant', session_id: session, parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } });
const result = (text: string) => ({ type: 'result', subtype: 'success', session_id: session, result: text, is_error: false });
function read(rows: object[]) {
  const folder = mkdtempSync(join(tmpdir(), 'claude-compaction-'));
  try {
    writeFileSync(join(folder, 'stdout.log'), rows.map(row => `${JSON.stringify(row)}\n`).join(''));
    return claude.read({ mode: 'resume', session, compaction }, folder, { code: 0, signal: null });
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

test('Claude is asked to compact before the instruction, with the words to keep in focus', () => {
  const lines = claude.input.encode(instruction, 'Next step', { id: compaction, instructions: 'Keep the open decisions' }) as
    { uuid: string; message: { content: string } }[];
  assert.deepEqual(lines.map(line => [line.uuid, line.message.content]),
    [[compaction, '/compact Keep the open decisions'], [instruction, 'Next step']]);
  assert.equal(claude.input.encode(instruction, 'Next step', null).length, 1, 'no compaction, one instruction');
});

test('a compact boundary proves the compaction, and the Run still replies to its instruction', () => {
  const observed = read([lifecycle(compaction, 'started'),
    { type: 'system', subtype: 'status', status: 'compacting', session_id: session },
    { type: 'system', subtype: 'status', status: null, compact_result: 'success', session_id: session },
    { type: 'system', subtype: 'compact_boundary', session_id: session, compact_metadata: { trigger: 'manual', pre_tokens: 26141, post_tokens: 8336 } },
    result(''), lifecycle(compaction, 'completed'),
    lifecycle(instruction, 'started'), said('OTTER'), result('OTTER'), lifecycle(instruction, 'completed')]);
  assert.deepEqual(observed.compaction, { state: 'compacted', message: null });
  assert.deepEqual(observed.outcome, { state: 'succeeded', session, result: 'OTTER' });
});

test('a compaction Claude declines fails with its own words, and the instruction still runs', () => {
  const observed = read([lifecycle(compaction, 'started'), said('Error: No messages to compact'), result(''),
    lifecycle(compaction, 'completed'), lifecycle(instruction, 'started'), said('Done'), result('Done')]);
  assert.deepEqual(observed.compaction, { state: 'failed', message: 'Error: No messages to compact' });
  assert.deepEqual(observed.outcome, { state: 'succeeded', session, result: 'Done' });
});
