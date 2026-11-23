import { tryLock } from '@alpacawork/core';
import { constants, closeSync } from 'node:fs';
import { RUN_FILES } from '@alpacawork/contract/run';
import { openRunFile } from '@alpacawork/backend/test-dist/runs/files.js';
import { randomUUID } from 'node:crypto';
import { RunStore } from '@alpacawork/runs';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { reconcileLinks } from './return-handling.fixture.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { setupReview } from './review.fixture.ts';
import { askUser, call, callerWorkspace, codexConversation, NO_AGENT_CONFIG, run } from './coordinator-caller.fixture.ts';

// The outside coordinator needs no hook registration. Optional quote text records the user's decision;
// the server separately retains question IDs, current review Run references, hashes and placement revisions.
const conversation = 'coordinator-authority';
const asCoordinator = codexConversation(conversation);
/** The quote on a Task's newest record, as stored; a write's receipt carries no History. */
const quoteOf = async (root: string, task: { id: string }) => (await new ControlTaskStore(root).get(task.id)).meta.log.at(-1)?.actor.quote;

const reviewActions = {
  stop: 'Stop it because it is no longer needed',
  revise: 'Add an explanation and revise it',
} as const;
for (const [action, words] of Object.entries(reviewActions)) {
  test(`the coordinator quoting the user can ${action} a review`, async t => {
    const h = await setupReview(t, { userRequested: true });
    // Never launch an installed agent in this authority check.
    writeFileSync(join(h.root, 'config.yaml'), NO_AGENT_CONFIG);
    const { url } = await h.start();

    const instruction = join(h.root, 'decision.md');
    writeFileSync(instruction, 'Coordinator decision');
    const versions = ['--expected-task-hash', h.expectedTaskHash,
      '--expected-placement-revision', String(h.expectedPlacementRevision)];
    const args = action === 'revise'
      ? ['task', 'request', '--task', h.task.id, '--instruction-file', instruction, '--new-conversation',
        ...versions]
      : ['task', 'report', '--task', h.task.id, '--state', 'stopped', '--expected-task-hash', h.expectedTaskHash];
    const result = await call(url, [...args, '--quote', words], asCoordinator);
    assert.deepEqual(await quoteOf(h.root, result.task), words);
    if (action === 'revise') assert.ok(result.outcome.request, JSON.stringify(result));
    else assert.equal((await call(url, ['task', 'get', '--task', h.task.id])).task.state, 'stopped');
  });
}

test('the coordinator quoting the user answers the user\'s question', async t => {
  const w = callerWorkspace(t);
  const asked = await askUser(w.root, w.project, 'codex');
  const url = await w.start();
  const words = 'I choose option A';

  const shown = await call(url, ['task', 'get', '--task', asked.task]);
  const owner = shown.agents.find((agent: { active: boolean; responsible: boolean }) => agent.active && agent.responsible);
  assert.ok(owner);
  const result = await call(url, ['task', 'request', '--task', asked.task, '--answers', asked.question,
    '--instruction-file', w.file('answer.md', 'Option A'), '--quote', words], asCoordinator);
  assert.equal(result.outcome.kind, 'answered');
  assert.deepEqual(await quoteOf(w.root, result.task), words);
  assert.deepEqual((await call(url, ['task', 'get', '--task', asked.task, '--include', 'closedQuestions'])).questions.map(q=>q.state), ['answered']);
});

// The same explicit confirmation must reach ReviewService before and after a newer Run starts.
test('a coordinator confirms the shown Run or receives a target conflict, never an owner-only done error', async t => {
  const h = await setupReview(t, { userRequested: true });
  writeFileSync(join(h.root, 'config.yaml'), NO_AGENT_CONFIG);
  let url: string;
  const words = 'Approve the result I saw';
  const confirm = (hash = h.expectedTaskHash, extra: string[] = []) => run(url, ['task', 'report', '--task', h.task.id,
    '--state', 'done', '--about-run', h.reviewRun, '--expected-task-hash', hash,
    '--expected-placement-revision', String(h.expectedPlacementRevision), ...extra], asCoordinator);
  const refused = async (hash: string, code: string, reason: string) => {
    const before = await call(url, ['task', 'get', '--task', h.task.id, '--log', '100']);
    const result = await confirm(hash, ['--quote', words]);
    assert.notEqual(result.code, 0);
    const error = JSON.parse(result.stderr).error;
    assert.deepEqual([error.code, error.reason.kind], [code, reason]);
    assert.deepEqual(await call(url, ['task', 'get', '--task', h.task.id, '--log', '100']), before);
  };
  // Accepted ordinary instruction, not started: the original submission is superseded already.
  const { outcome: { request } } = await new TaskRequestService(h.root).request({ task: h.task.id,
    body: 'Additional correction', opId: randomUUID(), newConversation: true,
    expectedTaskHash: h.expectedTaskHash, expectedPlacementRevision: h.expectedPlacementRevision },
  { kind: 'human' }, { kind: 'human' });
  const tasks = new ControlTaskStore(h.root);
  const direct = (hash: string) => new TaskReportService(h.root).report({ task: h.task.id, state: 'done',
    aboutRun: h.reviewRun, opId: randomUUID(), expectedTaskHash: hash,
    expectedPlacementRevision: h.expectedPlacementRevision }, { kind: 'human' }, { kind: 'human' });
  await assert.rejects(direct(h.expectedTaskHash), { code: 'conflict' });
  await assert.rejects(direct((await tasks.get(h.task.id)).hash), { code: 'conflict' });
  const store = new RunStore(h.root, { busyTimeoutMs: 1000 });
  store.prepareFolder(request.runId);
  const lock = openRunFile(store.folder(request.runId), RUN_FILES.managerLock, constants.O_RDWR | constants.O_CREAT);
  assert.equal(tryLock(lock), true);
  try {
    store.write(tx => tx.update({ ...tx.get(request.runId)!, state: 'running', started_at: new Date().toISOString() }));
    reconcileLinks(h.root, h.project);
    assert.equal((await tasks.get(h.task.id)).meta.state, 'doing');
    url = (await h.start()).url;

    await refused(h.expectedTaskHash, 'conflict', 'task_changed_reload_before_review');
    await refused((await tasks.get(h.task.id)).hash, 'conflict', 'task_not_waiting_for_review');
    const unquoted = await confirm();
    assert.equal(JSON.parse(unquoted.stderr).error.code, 'conflict', 'quote does not affect review version checks');
    const caller = { kind: 'run', runId: request.runId, placementId: h.placement.id,
      taskId: h.task.id, role: 'owner', responsible: true } as const;
    await new TaskReportService(h.root).report({ task: h.task.id, state: 'done', title: 'Corrected result', description: 'The correction is complete.', opId: randomUUID(),
      expectedTaskHash: (await tasks.get(h.task.id)).hash }, { kind: 'placement', placementId: h.placement.id }, caller);
    store.write(tx => tx.finish({ ...tx.get(request.runId)!, state: 'succeeded', ended_at: new Date().toISOString() },
      { state: 'present', text: 'Corrected result' }));
    reconcileLinks(h.root, h.project);
    await refused((await tasks.get(h.task.id)).hash, 'conflict', 'review_run_not_current_completed_head');
  } finally { closeSync(lock); store.close(); }
});

test('a confirmation stays idempotent over the real CLI after approval, while a fresh stale decision conflicts', async t => {
  const h = await setupReview(t, { userRequested: true });
  writeFileSync(join(h.root, 'config.yaml'), NO_AGENT_CONFIG);
  const { url } = await h.start();
  const words = 'Confirm this result';

  const args = ['task', 'report', '--task', h.task.id, '--state', 'done', '--about-run', h.reviewRun,
    '--expected-task-hash', h.expectedTaskHash, '--expected-placement-revision', String(h.expectedPlacementRevision),
    '--quote', words];
  const opId = randomUUID();
  const first = await call(url, [...args, '--op-id', opId], asCoordinator);
  assert.equal(first.task.state, 'done');
  assert.deepEqual(await quoteOf(h.root, first.task), words);
  assert.deepEqual(await call(url, [...args, '--op-id', opId], asCoordinator), first);
  const stale = await run(url, args, asCoordinator);
  assert.equal(JSON.parse(stale.stderr).error.code, 'conflict');
  // Holding a finished task cannot reinterpret an explicit old confirmation as restoring done.
  const held = await call(url, ['task', 'report', '--task', h.task.id, '--state', 'held',
    '--expected-task-hash', first.task.hash]);
  const result = await run(url, args.map(value => value === h.expectedTaskHash ? held.task.hash : value), asCoordinator);
  assert.equal(JSON.parse(result.stderr).error.reason.kind, 'task_not_waiting_for_review');
  assert.equal((await call(url, ['task', 'get', '--task', h.task.id])).task.state, 'held');
});
