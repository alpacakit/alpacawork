/** Compacting a conversation is the third way the next conversation starts: asked with a request, or prepared by a report. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { Problem } from '@alpacawork/core';
import { runFolder } from '@alpacawork/contract/run';
import { taskGetPlacementSchema } from '@alpacawork/contract/control';
import { taskReportInput, taskRequestInput } from '@alpacawork/contract/inputs';
import { handlingFixture } from './return-handling.fixture.ts';
import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { readTaskView } from '@alpacawork/backend/test-dist/control/task-views.js';
import { readControl } from '@alpacawork/backend/test-dist/control/task-store.js';
import { assertCompactable, latestCompactions } from '@alpacawork/backend/test-dist/runs/compactions.js';
import { recordReportedContext } from '@alpacawork/backend/test-dist/agents/context-reported.js';

type Fixture = Awaited<ReturnType<typeof handlingFixture>>;
const person = { kind: 'human' } as const;
const compaction = (h: Fixture) => readControl(h.root, db => latestCompactions(db, [h.owner.id]).get(h.owner.id));
const launchSetting = { ...fixtureAgentSetting('claude'), params: { model: ['opus', 'sonnet'], effort: ['medium', 'high'] } };
const setLaunchChoices = (h: Fixture, setting = launchSetting) => writeFileSync(join(h.root, 'config.yaml'), stringify({
  agents: { fake: setting, other: setting },
  aiStack: [{ agent: 'fake', values: { model: 'opus' } }],
}, { aliasDuplicateObjects: false }));
const request = async (h: Fixture, extra: object = {}) => new TaskRequestService(h.root).request({ task: h.task.id,
  body: 'Next step', opId: randomUUID(), expectedTaskHash: (await h.current()).hash,
  expectedPlacementRevision: h.owner.revision, ...extra }, person, person);
const compact = (h: Fixture, extra: object = {}) => request(h, {
  compact: true, expectedHeadRun: h.store.conversationHead(h.owner.id)?.id ?? 'R1', ...extra });
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
  setLaunchChoices(h);
  const first = accepted(await request(h, { selected: { effort: 'high' } }));
  await h.start(first.runId);
  await report(first.runId); h.end(first.runId);
  const next = await h.human();
  assert.equal(h.store.get(next.runId)!.resumes, first.runId);
  assert.equal(h.store.get(next.runId)!.launch.values.effort, 'medium');
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

test('task requests continue and compact the same session across one-request launch choices', async t => {
  const h = await handlingFixture(t);
  setLaunchChoices(h);
  const override = accepted(await request(h, { selected: { effort: 'high' } }));
  const first = h.store.get(override.runId)!;
  assert.equal(first.launch.values.effort, 'high');
  await h.start(first.id); h.end(first.id);

  const ordinary = h.store.get((await h.human()).runId)!;
  assert.equal(ordinary.resumes, first.id);
  assert.deepEqual(ordinary.session, first.session);
  assert.deepEqual(ordinary.launch.values, { model: 'opus', effort: 'medium' });
  await h.start(ordinary.id); h.end(ordinary.id);

  const named = h.store.get(accepted(await request(h, {
    aiStack: [{ agent: 'fake', values: { model: 'sonnet', effort: 'high' } }],
    selected: { effort: 'medium' },
  })).runId)!;
  assert.equal(named.resumes, ordinary.id);
  assert.deepEqual(named.session, first.session);
  assert.deepEqual(named.launch.values, { model: 'sonnet', effort: 'medium' });
  await h.start(named.id); h.end(named.id);

  assert.equal(await refusal(compact(h, { aiStack: [{ agent: 'other', values: { model: 'opus' } }] })),
    'compaction_with_new_conversation');
  const next = h.store.get(accepted(await compact(h)).runId)!;
  assert.equal(next.resumes, named.id);
  assert.deepEqual(next.session, first.session);
  assert.deepEqual(next.launch.values, ordinary.launch.values);
  assert.deepEqual([compaction(h)?.run, compaction(h)?.state], [next.id, 'pending']);
});

test('an outside launch choice requires a fresh conversation when the resume command cannot apply it', async t => {
  const h = await handlingFixture(t);
  const start = '--session-id {session} --model {model} [--effort {effort}]';
  const modelAtStart = fixtureAgentSetting('claude', { start, resume: '--resume {session} [--effort {effort}]' });
  const without = { opus: ['effort'] };
  setLaunchChoices(h, { ...launchSetting, options: modelAtStart.options, without });
  const first = await h.human(); await h.start(first.runId); h.end(first.runId);
  const chooseModel = { aiStack: [{ agent: 'fake', values: { model: 'sonnet' } }] };
  const requiresFresh = (key: string) => (error: unknown) => {
    const reason = (error as Problem).reason;
    return reason?.kind === 'selection_required' &&
      reason.problems.some(problem => problem.key === key && problem.recovery === 'new_conversation');
  };
  await assert.rejects(request(h, chooseModel), requiresFresh('model'));

  const noEffort = fixtureAgentSetting('claude', { start: '--session-id {session} --model {model}',
    resume: '--resume {session} --model {model}' });
  setLaunchChoices(h, { ...launchSetting, options: noEffort.options });
  await assert.rejects(request(h, chooseModel), requiresFresh('effort'));

  const effortAtStart = fixtureAgentSetting('claude', { start, resume: '--resume {session} --model {model}' });
  setLaunchChoices(h, { ...launchSetting, options: effortAtStart.options, without });
  await assert.rejects(request(h, chooseModel), requiresFresh('effort'));
  setLaunchChoices(h, { ...launchSetting, options: effortAtStart.options });
  await assert.rejects(request(h, chooseModel), requiresFresh('effort'));

  const fresh = accepted(await request(h, { ...chooseModel, newConversation: true }));
  assert.equal(h.store.get(fresh.runId)!.launch.values.model, 'sonnet');
  assert.equal(h.store.get(fresh.runId)!.resumes, null);
  await h.start(fresh.runId); h.end(fresh.runId);
  const resumed = accepted(await request(h, chooseModel));
  assert.equal(h.store.get(resumed.runId)!.resumes, fresh.runId);
  await h.start(resumed.runId); h.end(resumed.runId);
  const again = accepted(await request(h, chooseModel));
  assert.equal(h.store.get(again.runId)!.resumes, resumed.runId);
  await h.start(again.runId); h.end(again.runId);
  await assert.rejects(request(h, { aiStack: [{ agent: 'fake', values: { model: 'opus' } }] }), requiresFresh('effort'));
});

test('a return wakes the owner on the configured model when the resume command cannot change models', async t => {
  const h = await handlingFixture(t);
  const modelAtStart = fixtureAgentSetting('claude', {
    start: '--session-id {session} --model {model}', resume: '--resume {session}',
  });
  setLaunchChoices(h, { ...launchSetting, options: modelAtStart.options });
  const first = accepted(await request(h, { aiStack: [{ agent: 'fake', values: { model: 'sonnet' } }] }));
  await h.start(first.runId);
  const work = await h.delegate(first.runId);
  await h.start(work.runId);
  h.end(first.runId);
  await h.pass();
  h.end(work.runId);
  const wake = await h.pass();
  assert.equal(wake.acceptedRequestIds.length, 1);
  const resumed = h.store.get(h.runOf(wake.acceptedRequestIds[0]!))!;
  assert.equal(resumed.launch.values.model, 'opus');
  assert.equal(resumed.resumes, null);
  assert.deepEqual(resumed.newConversation, { because: 'unresumable' });
});

test('task get shows the last conversation fill and its percentage when the window is known', async t => {
  const h = await handlingFixture(t);
  writeFileSync(join(h.root, 'config.yaml'), stringify({
    agents: { fake: { ...launchSetting, params: { ...launchSetting.params, model: ['fixture-model'] } } },
  }));
  const first = await h.human(); await h.start(first.runId);
  const folder = runFolder(h.root, first.runId);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'activity.json'), JSON.stringify({ at: '2026-11-24T00:00:00Z', kind: 'result', toolName: null,
    doing: null, note: null, steps: [], context: { usedTokens: 420_000, compacted: false, observedAt: '2026-11-24T00:00:00Z' } }));
  h.end(first.runId);
  const context = async () => {
    const view = await readTaskView(h.root, h.task.id, {}, null);
    return taskGetPlacementSchema.parse(view.agents.find(agent => agent.id === h.owner.id)).context!;
  };
  const unknown = await context();
  assert.equal(unknown.usedTokens, 420_000);
  assert.equal(unknown.windowTokens, null);
  assert.equal(Object.hasOwn(unknown, 'usedPercent'), false);
  recordReportedContext(h.root, 'claude', 'fixture-model', { windowTokens: 500_000 });
  assert.equal((await context()).usedPercent, 84);
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
