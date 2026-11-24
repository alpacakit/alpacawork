/** Compacting a conversation is the third way the next conversation starts: asked with a request, or prepared by a report. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Problem } from '@alpacawork/core';
import { runFolder } from '@alpacawork/contract/run';
import { taskReportInput, taskRequestInput } from '@alpacawork/contract/inputs';
import { handlingFixture } from './return-handling.fixture.ts';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { readTaskView } from '@alpacawork/backend/test-dist/control/task-views.js';
import { readControl } from '@alpacawork/backend/test-dist/control/task-store.js';
import { assertCompactable, latestCompactions } from '@alpacawork/backend/test-dist/runs/compactions.js';

type Fixture = Awaited<ReturnType<typeof handlingFixture>>;
const person = { kind: 'human' } as const;
const compaction = (h: Fixture) => readControl(h.root, db => latestCompactions(db, [h.owner.id]).get(h.owner.id));
const compact = async (h: Fixture, extra: object = {}) => new TaskRequestService(h.root).request({ task: h.task.id,
  body: 'Next step', compact: true, opId: randomUUID(), expectedTaskHash: (await h.current()).hash,
  expectedPlacementRevision: h.owner.revision, expectedHeadRun: h.store.conversationHead(h.owner.id)?.id ?? 'R1', ...extra }, person, person);
const refusal = async (work: Promise<unknown>) => { try { await work; } catch (error) { return (error as Problem).reason?.kind; } };
const accepted = (result: Awaited<ReturnType<typeof compact>>) => {
  if (result.outcome.kind !== 'request_accepted') throw new Error('Expected an accepted Request');
  return result.outcome.request;
};

test('--compact continues the conversation, compacted first, and is refused where a new conversation would be', async t => {
  const h = await handlingFixture(t);
  assert.equal(await refusal(compact(h)), 'compaction_without_conversation', 'a first request has nothing to compact');
  const first = await h.human(); await h.start(first.runId);
  assert.equal(await refusal(compact(h)), 'cannot_compact_while_run_unfinished', 'no reservation for after a Run ends');
  h.end(first.runId);
  const next = accepted(await compact(h, { compactFocus: 'Keep the agreed API' }));
  assert.equal(h.store.get(next.runId)!.resumes, first.runId, 'the same conversation goes on');
  assert.deepEqual([compaction(h)?.run, compaction(h)?.state, compaction(h)?.focus], [next.runId, 'pending', 'Keep the agreed API']);
  h.store.write(tx => tx.abortRequest(tx.get(next.runId)!, next.requestId));
  assert.equal(compaction(h)?.state, 'dropped', 'a Run that ended before it started compacted nothing');
  for (const [input, path] of [[{ newConversation: true }, 'compact'], [{ compact: undefined, compactFocus: 'x' }, 'compactFocus'],
    [{ expectedHeadRun: undefined }, 'expectedHeadRun']] as const) {
    const parsed = taskRequestInput.safeParse({ task: 'T1', instruction: 'x', compact: true, expectedHeadRun: 'R1',
      expectedTaskHash: 'a'.repeat(64), expectedPlacementRevision: 1, ...input });
    assert.ok(!parsed.success && parsed.error.issues.some(issue => issue.path[0] === path), path);
  }
});

test('a report prepares a compacted next conversation, and an instruction after the save cancels it', async t => {
  const h = await handlingFixture(t), caller = (runId: string) => ({ kind: 'run' as const, runId, placementId: h.owner.id,
    taskId: h.task.id, role: 'owner' as const, responsible: true });
  const report = async (runId: string) => new TaskReportService(h.root).report({ task: h.task.id, state: 'doing',
    title: 'Saved', values: { conclusion: 'Kept' }, nextConversation: 'compact', compactFocus: 'Keep the failed tests',
    opId: randomUUID(), expectedTaskHash: (await h.current()).hash }, { kind: 'placement', placementId: h.owner.id }, caller(runId));
  const first = await h.human(); await h.start(first.runId);
  await report(first.runId); h.end(first.runId);
  const next = await h.human();
  assert.equal(h.store.get(next.runId)!.resumes, first.runId);
  assert.deepEqual([compaction(h)?.state, compaction(h)?.focus], ['pending', 'Keep the failed tests']);
  await h.start(next.runId);
  await report(next.runId);
  const late = await h.human(); // arrives after the save, while the Run works
  h.end(next.runId); await h.start(late.runId); h.end(late.runId);
  const after = await h.human();
  assert.equal(h.store.get(after.runId)!.resumes, late.runId, 'the conversation goes on');
  const compacted = readControl(h.root, db => db.prepare('SELECT run_no FROM compactions').all().map(row => `R${row.run_no}`));
  assert.deepEqual(compacted, [next.runId], 'the intent saved before the later instruction compacts nothing after it');
  assert.ok(!taskReportInput.safeParse({ state: 'doing', compactFocus: 'x', expectedTaskHash: 'a'.repeat(64) }).success,
    'a focus belongs to a compacted next conversation');
});

test('task get shows how full each conversation last was, after its Run ended', async t => {
  const h = await handlingFixture(t);
  const first = await h.human(); await h.start(first.runId);
  const folder = runFolder(h.root, first.runId);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'activity.json'), JSON.stringify({ at: '2026-11-24T00:00:00Z', kind: 'result', toolName: null,
    doing: null, note: null, context: { usedTokens: 412000, compacted: false, observedAt: '2026-11-24T00:00:00Z' } }));
  h.end(first.runId);
  const view = await readTaskView(h.root, h.task.id, { include: ['agents'] }, null);
  const owner = view.agents.find(agent => agent.id === h.owner.id);
  assert.equal(owner?.context?.usedTokens, 412000);
});

test('an agent that cannot compact as asked is refused with its reason', () => {
  const kind = (adapter: string, values: Record<string, string>, focus: string | null) => {
    try { assertCompactable({ adapter, values }, focus); return null; } catch (error) { return (error as Problem).reason?.kind; } };
  assert.equal(kind('codex', {}, 'Keep the plan'), 'compaction_instructions_unsupported');
  assert.equal(kind('grok', {}, 'Keep the plan'), 'compaction_instructions_unsupported');
  assert.equal(kind('copilot', {}, null), 'compaction_needs_model', 'Copilot on Auto has no model to compact with');
  assert.equal(kind('copilot', { model: 'gpt-4.1' }, 'Keep the plan'), null);
  assert.equal(kind('claude', {}, 'Keep the plan'), null);
});
