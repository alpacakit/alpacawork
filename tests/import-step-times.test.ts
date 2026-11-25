/** Step times of past Runs, read afterwards from the agents' own conversation records and listed with their steps. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importRunSteps, transcriptReaders, type ImportedRun } from '@alpacawork/backend/test-dist/runs/import-step-times.js';
import { RunStepIndex } from '@alpacawork/backend/test-dist/runs/run-steps.js';
import { AGENT_RUNTIME_ADAPTERS } from '@alpacawork/backend/test-dist/agents/registry.js';

function home(t: TestContext) {
  const path = mkdtempSync(join(tmpdir(), 'import-step-times-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return { path, homes: { claude: join(path, 'claude'), codex: [join(path, 'codex-alpacawork'), join(path, 'codex')] } };
}
const lines = (file: string, rows: readonly unknown[]) => {
  mkdirSync(join(file, '..'), { recursive: true });
  appendFileSync(file, rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n');
};
const run = (id: string, agent: string, session: string | null, started: string, ended: string): ImportedRun => ({ id: id as ImportedRun['id'], task: 'T1' as ImportedRun['task'],
  state: 'succeeded', session: session ? { provider: null, id: session } : null, created_at: started, started_at: started, ended_at: ended, launch: { adapter: agent } });
const times = async (folder: string, agent: 'claude' | 'codex') => {
  const index = new RunStepIndex(folder, AGENT_RUNTIME_ADAPTERS[agent]);
  await index.update('done');
  return index.range(0, 50).steps.map(({ id, startedAt, startSource, endedAt, endSource }) => ({ id, startedAt, startSource, endedAt, endSource }));
};

const claudeStart = (id: string, parent: string | null = null, name = 'Bash') => ({ type: 'assistant', parent_tool_use_id: parent,
  message: { content: [{ type: 'tool_use', id, name, input: { command: `echo ${id}` } }] } });
const claudeEnd = (id: string, parent: string | null = null) => ({ type: 'user', parent_tool_use_id: parent,
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'ok' }] }] } });
const said = (at: string, block: object) => ({ timestamp: at, message: { content: [block] } });

test('claude: each Run of a shared conversation takes its own calls, its sub-agent\'s too, and a step timed as it happened is left as it is', async t => {
  const { path, homes } = home(t);
  const session = '11111111-2222-4333-8444-555555555555', project = join(homes.claude, 'projects', '-work');
  // One conversation across two Runs; the second Run's sub-agent keeps its own file.
  lines(join(project, `${session}.jsonl`), [
    said('2026-11-20T01:00:01.000Z', { type: 'tool_use', id: 'a' }), said('2026-11-20T01:00:03.000Z', { type: 'tool_result', tool_use_id: 'a' }),
    'not json', said('2026-11-20T02:00:00.000Z', { type: 'tool_use', id: 'b' }), said('2026-11-20T02:00:10.000Z', { type: 'tool_result', tool_use_id: 'b' }),
    said('2026-11-20T02:00:02.000Z', { type: 'tool_use', id: 'c' }), said('2026-11-20T02:00:05.000Z', { type: 'tool_result', tool_use_id: 'c' })]);
  lines(join(project, session, 'subagents', 'agent-x.jsonl'), [
    said('2026-11-20T02:00:03.000Z', { type: 'tool_use', id: 'inner' }), said('2026-11-20T02:00:04.000Z', { type: 'tool_result', tool_use_id: 'inner' })]);
  const first = join(path, 'R1'), second = join(path, 'R2');
  lines(join(first, 'stdout.log'), [claudeStart('a'), claudeEnd('a')]);
  // The second Run's output also names `a` (a call the record has in the first Run's time): it gets no time here.
  lines(join(second, 'stdout.log'), [claudeStart('b', null, 'Task'), claudeStart('inner', 'b'), claudeEnd('inner', 'b'), claudeEnd('b'),
    claudeStart('c'), claudeEnd('c'), claudeStart('a'), claudeEnd('a')]);
  // The second Run's manager already kept `c`'s start as it happened.
  writeFileSync(join(second, 'steps.jsonl'), JSON.stringify({ event: 'start', line: 4, id: 'c', at: '2026-11-20T02:00:02.400Z', source: 'observed', fingerprint: null, parentId: null }) + '\n');
  const readers = transcriptReaders(homes);
  assert.deepEqual(await importRunSteps(first, run('R1', 'claude', session, '2026-11-20T01:00:00.000Z', '2026-11-20T01:01:00.000Z'), readers, true),
    { run: 'R1', task: 'T1', agent: 'claude', steps: 1, timed: 1, added: 2, reason: null });
  const imported = await importRunSteps(second, run('R2', 'claude', session, '2026-11-20T02:00:00.000Z', '2026-11-20T02:01:00.000Z'), readers, true);
  assert.deepEqual({ steps: imported.steps, timed: imported.timed, reason: imported.reason }, { steps: 4, timed: 2, reason: null });
  const transcript = (start: string, end: string) => ({ startedAt: start, startSource: 'transcript', endedAt: end, endSource: 'transcript' });
  assert.deepEqual(await times(first, 'claude'), [{ id: 'a', ...transcript('2026-11-20T01:00:01.000Z', '2026-11-20T01:00:03.000Z') }]);
  assert.deepEqual(await times(second, 'claude'), [
    { id: 'b', ...transcript('2026-11-20T02:00:00.000Z', '2026-11-20T02:00:10.000Z') },
    { id: 'inner', ...transcript('2026-11-20T02:00:03.000Z', '2026-11-20T02:00:04.000Z') },
    { id: 'c', startedAt: '2026-11-20T02:00:02.400Z', startSource: 'observed', endedAt: null, endSource: null },
    { id: 'a', startedAt: null, startSource: null, endedAt: null, endSource: null },
  ]);
  // Importing again adds nothing.
  assert.equal((await importRunSteps(second, run('R2', 'claude', session, '2026-11-20T02:00:00.000Z', '2026-11-20T02:01:00.000Z'), transcriptReaders(homes), true)).added, 0);
});

test('codex: a command starts as long before its end as it took, an item that says only its end keeps its start unknown, an end the output lost comes from the record, and a trial writes nothing', async t => {
  const { path, homes } = home(t);
  const thread = '01a21267-eba8-7c40-b2b8-c86b52f773eb';
  const completed = (at: string, item: object) => ({ timestamp: at, type: 'event_msg', payload: { type: 'item_completed', item } });
  // The thread began in the person's own Codex and went on in alpacawork's.
  lines(join(homes.codex[1]!, 'sessions/2026/11/19', `rollout-2026-11-19T10-00-00-${thread}.jsonl`), [{ timestamp: '2026-11-19T01:00:00.000Z', type: 'session_meta', payload: {} }]);
  lines(join(homes.codex[0]!, 'sessions/2026/11/20', `rollout-2026-11-20T10-00-00-${thread}.jsonl`), [
    completed('2026-11-20T01:00:46.500Z', { type: 'CommandExecution', id: 'exec-1', duration: { secs: 46, nanos: 500_000_000 } }),
    completed('2026-11-20T01:00:50.000Z', { type: 'FileChange', id: 'f1' }),
    completed('2026-11-20T01:01:30.000Z', { type: 'CommandExecution', id: 'exec-2', duration: { secs: 10, nanos: 0 } })]);
  const folder = join(path, 'R3'), command = "/bin/bash -lc 'pnpm test'";
  lines(join(folder, 'stdout.log'), [{ type: 'item.started', item: { id: 'exec-1', type: 'command_execution', command } },
    { type: 'item.completed', item: { id: 'exec-1', type: 'command_execution', command, exitCode: 0 } },
    { type: 'item.started', item: { id: 'f1', type: 'file_change', changes: [], status: 'inProgress' } },
    { type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [], status: 'completed' } },
    { type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [], status: 'completed' } },
    // The output stops before this command's end; the record has it.
    { type: 'item.started', item: { id: 'exec-2', type: 'command_execution', command } }]);
  const record = run('R3', 'codex', thread, '2026-11-20T01:00:00.000Z', '2026-11-20T01:02:00.000Z');
  assert.deepEqual(await importRunSteps(folder, record, transcriptReaders(homes), false),
    { run: 'R3', task: 'T1', agent: 'codex', steps: 3, timed: 3, added: 5, reason: null });
  assert.equal((await times(folder, 'codex'))[0]!.startedAt, null);
  await importRunSteps(folder, record, transcriptReaders(homes), true);
  assert.deepEqual(await times(folder, 'codex'), [
    { id: 'exec-1', startedAt: '2026-11-20T01:00:00.000Z', startSource: 'transcript', endedAt: '2026-11-20T01:00:46.500Z', endSource: 'transcript' },
    { id: 'f1', startedAt: null, startSource: null, endedAt: '2026-11-20T01:00:50.000Z', endSource: 'transcript' },
    { id: 'exec-2', startedAt: '2026-11-20T01:01:20.000Z', startSource: 'transcript', endedAt: '2026-11-20T01:01:30.000Z', endSource: 'transcript' },
  ]);
});

test('a Run that gets no times says why', async t => {
  const { path, homes } = home(t);
  const folder = join(path, 'R4'), at = '2026-11-20T01:00:00.000Z';
  // Readers list the records once, so each case reads anew.
  const reason = async (record: ImportedRun) => (await importRunSteps(folder, record, transcriptReaders(homes), false)).reason;
  assert.equal(await reason({ ...run('R4', 'claude', 's', at, at), state: 'running', ended_at: null }), 'running');
  assert.equal(await reason({ ...run('R4', 'claude', 's', at, at), state: 'needs_review', ended_at: null }), 'running');
  assert.equal(await reason(run('R4', 'pi', 's', at, at)), 'agent_not_read');
  assert.equal(await reason(run('R4', 'codex', null, at, at)), 'no_conversation');
  assert.equal(await reason(run('R4', 'claude', 'gone', at, at)), 'no_output');
  lines(join(folder, 'stdout.log'), ['{"type": "assist']);
  lines(join(homes.claude, 'projects', '-work', 'read.jsonl'), [said(at, { type: 'tool_use', id: 'a' })]);
  assert.equal(await reason(run('R4', 'claude', 'read', at, at)), 'output_unreadable');
  rmSync(join(folder, 'stdout.log'));
  lines(join(folder, 'stdout.log'), [claudeStart('a'), claudeEnd('a')]);
  assert.equal(await reason(run('R4', 'claude', 'gone', at, at)), 'transcript_missing');
  // A compressed record that breaks partway is unreadable, and the import goes on.
  const thread = '01a21267-eba8-7c40-b2b8-c86b52f773eb';
  lines(join(homes.codex[0]!, 'sessions/2026/11/20', `rollout-2026-11-20T10-00-00-${thread}.jsonl.zst`), ['not zstd']);
  assert.equal(await reason(run('R4', 'codex', thread, at, at)), 'transcript_unreadable');
  // A record whose lines no longer read as this reader expects (the agent changed its form).
  lines(join(homes.claude, 'projects', '-work', 'changed.jsonl'), [{ ts: at, body: { blocks: [] } }]);
  assert.equal(await reason(run('R4', 'claude', 'changed', at, at)), 'transcript_unreadable');
  lines(join(homes.claude, 'projects', '-work', 'other.jsonl'), [said(at, { type: 'tool_use', id: 'z' })]);
  assert.equal(await reason(run('R4', 'claude', 'other', at, at)), 'no_matching_calls');
});
