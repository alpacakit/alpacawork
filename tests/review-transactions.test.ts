import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { stringify } from 'yaml';
import { taskFlow } from './task-flow.fixture.ts';
import { commandFetch as fetch } from './helpers/command-fetch.ts';
import { assignResponsible } from './helpers/control-fixture.ts';
import { createFixtureRun } from './helpers/run-fixture.ts';
import { taskHistoryWindowSchema } from '@alpacawork/contract/control';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ControlStore } from '@alpacawork/db';
import { openQuestions } from '@alpacawork/raw';
import { RunStore } from '@alpacawork/runs';
import { authorize } from '@alpacawork/backend/test-dist/control/authorize.js';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { readTaskView } from '@alpacawork/backend/test-dist/control/task-views.js';
import { readControlTree } from './helpers/control-tree.ts';
import { writeDescription, reportViaCli, setupReview } from './review.fixture.ts';

/** The user's proxy, as authorize decides it for a person: the actor and the caller. */
const human = { kind: 'human' } as const;
type Review = Awaited<ReturnType<typeof setupReview>>;
const refusedWith = (code: string) => (error: { code: string }) => error.code === code;
/** A Run that is not the one under review. */
const otherRun = 'R999999';

/** The user's confirmation (task report --state done --about-run) on the versions the review showed them. */
const confirmation = (h: Review) => ({ task: h.task.id, state: 'done' as const, aboutRun: h.reviewRun,
  opId: randomUUID(), expectedTaskHash: h.expectedTaskHash, expectedPlacementRevision: h.expectedPlacementRevision });
/** Work after review is an ordinary request on the versions read, in a new conversation. */
const sendBack = (h: Review, body: string) => ({ task: h.task.id, body, newConversation: true,
  opId: randomUUID(), expectedTaskHash: h.expectedTaskHash, expectedPlacementRevision: h.expectedPlacementRevision });

/** The review's server, with an agent that never launches: no test here means to start a Run's process. */
function serve(h: Review) {
  writeFileSync(join(h.root, 'config.yaml'),
    stringify({ agents: { "claude": fixtureAgentSetting('claude') } }));
  return h.start();
}

/** The Run the user is shown to decide on: the ball's (a review of the user's) and task get's. */
async function shownReview(root: string, taskId: string) {
  const ball = (await readControlTree(root)).balls[taskId];
  return { ball: ball?.holder === 'user' && ball.reason === 'review' ? ball.aboutRunId : null,
    taskGet: (await readTaskView(root, taskId, {}, null)).reviewRun };
}

test('the user confirms a review once: a retry changes nothing and other words under its ID are refused', async t => {
  const h = await setupReview(t, { userRequested: true }), reports = new TaskReportService(h.root);
  const input = { ...confirmation(h), title: 'Approved with a reason' };
  const first = await reports.report(input, human, human);
  assert.deepEqual(await reports.report(input, human, human), first);
  assert.deepEqual([first.task.state, first.outcome.kind], ['done', 'accepted']);
  await assert.rejects(reports.report({ ...input, title: 'Different decision' }, human, human),
    refusedWith('idempotency_conflict'));
  const task = (await readControlTree(h.root)).tasks.find(item => item.id === h.task.id)!;
  assert.equal(task.log.filter(entry => entry.id === input.opId).length, 1);
  assert.deepEqual([task.log.at(-1)?.kind, task.log.at(-1)?.actor, task.log.at(-1)?.runId],
    ['review_approved', human, h.reviewRun]);
  assert.equal(task.log.at(-1)?.title, 'Approved with a reason');
  assert.equal(task.log.at(-1)?.description, null);
});

test('a confirmation ID is workspace-wide: another Task\'s review takes a fresh one', async t => {
  const h = await setupReview(t, { userRequested: true }), reports = new TaskReportService(h.root);
  const first = confirmation(h);
  const firstReceipt = await reports.report(first, human, human);
  // A second Task the user asked for, whose responsible's Run reports done and ends: it waits for the user's review.
  const created = (await h.commands.create({ parentId: h.project, userRequested: true,
    tasks: [{ title: 'Second review target' }] })).tasks[0];
  const placement = await assignResponsible(h.root, created, 'claude');
  const { outcome: { request } } = await new TaskRequestService(h.root).request({ task: created.id,
    body: 'Second review', opId: randomUUID(), expectedTaskHash: (await new ControlTaskStore(h.root).get(created.id)).hash,
    expectedPlacementRevision: placement.revision }, human, human);
  const runId = request.runId;
  const started = new RunStore(h.root, { busyTimeoutMs: 0 });
  try { started.write(tx => tx.update({ ...tx.get(runId)!, state: 'running', started_at: new Date().toISOString() })); }
  finally { started.close(); }
  const waiting = (await reports.report({ task: created.id, state: 'done', title: 'Review second', description: 'The result is ready for review.', opId: randomUUID(),
    expectedTaskHash: (await new ControlTaskStore(h.root).get(created.id)).hash },
  { kind: 'placement', placementId: placement.id },
  { kind: 'run', runId, placementId: placement.id, taskId: created.id, role: 'owner', responsible: true })).task;
  const ended = new RunStore(h.root, { busyTimeoutMs: 0 });
  try { ended.write(tx => tx.finish({ ...tx.get(runId)!, state: 'succeeded', ended_at: new Date().toISOString() },
    { state: 'present', text: 'fixture reply' })); }
  finally { ended.close(); }
  assert.equal(waiting.state, 'waiting');
  const second = { ...first, task: created.id, aboutRun: runId, expectedTaskHash: waiting.hash,
    expectedPlacementRevision: placement.revision };
  const before = await readControlTree(h.root);
  await assert.rejects(reports.report(second, human, human), refusedWith('idempotency_conflict'));
  assert.deepEqual(await readControlTree(h.root), before);
  assert.deepEqual(await reports.report(first, human, human), firstReceipt);
  assert.deepEqual(await readControlTree(h.root), before);
  const freshId = randomUUID();
  assert.equal((await reports.report({ ...second, opId: freshId }, human, human)).task.state, 'done');
  const tree = await readControlTree(h.root);
  assert.deepEqual(tree.tasks.flatMap(task => task.log.filter(entry => entry.id === first.opId)
    .map(entry => [task.id, entry.kind])), [[h.task.id, 'review_approved']]);
  assert.deepEqual(tree.tasks.flatMap(task => task.log.filter(entry => entry.id === freshId)
    .map(entry => [task.id, entry.kind])), [[created.id, 'review_approved']]);
});

test('a confirmation ID cannot become a Request on another Task', async t => {
  const h = await setupReview(t, { userRequested: true });
  const input = confirmation(h);
  await new TaskReportService(h.root).report(input, human, human);
  const created = (await h.commands.create({ parentId: h.project, userRequested: false,
    tasks: [{ title: 'Other request target' }] })).tasks[0];
  const placement = await assignResponsible(h.root, created, 'claude');
  const before = await readControlTree(h.root);
  await assert.rejects(new TaskRequestService(h.root).request({ task: created.id, body: 'Different operation',
    opId: input.opId, expectedTaskHash: (await new ControlTaskStore(h.root).get(created.id)).hash,
    expectedPlacementRevision: placement.revision }, human, human), refusedWith('idempotency_conflict'));
  assert.deepEqual(await readControlTree(h.root), before);
});

test('a confirmation names the reviewed Run and the responsible\'s revision, never filled in', async t => {
  const h = await setupReview(t, { userRequested: true }), reports = new TaskReportService(h.root);
  const { aboutRun, expectedPlacementRevision, ...base } = confirmation(h);
  await assert.rejects(reports.report({ ...base, aboutRun }, human, human),
    (error: { code: string; message: string }) =>
      error.code === 'invalid_input' && error.message.includes('--expected-placement-revision'));
  await assert.rejects(reports.report({ ...base, expectedPlacementRevision }, human, human),
    (error: { code: string; message: string }) =>
      error.code === 'invalid_input' && error.message.includes('--about-run'));
});

test('a confirmation has the same Task report outcome through HTTP and CLI', async t => {
  const h = await setupReview(t, { userRequested: true });
  const server = await serve(h);
  const report = { ...confirmation(h), title: 'Accept review', description: 'The result is checked.' };
  const response = await fetch(new URL('/api/commands/task/report', server.url), { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
  assert.equal(response.status, 200);
  const http = await response.json();
  const cliResult = await reportViaCli(h.root, server.url, '--task', report.task, '--state', 'done',
    '--title', report.title, '--description-file', writeDescription(h.root, report.description),
    '--op-id', report.opId, '--expected-task-hash', report.expectedTaskHash,
    '--expected-placement-revision', String(report.expectedPlacementRevision), '--about-run', report.aboutRun) as {
      task: Record<string, unknown>; [key: string]: unknown };
  assert.deepEqual(cliResult, http);
});

test('a send-back is one Request with its decision record, from the user', async t => {
  const h = await setupReview(t, { userRequested: true });
  const input = sendBack(h, 'Please revise the result');
  const { task, outcome: { request } } = await new TaskRequestService(h.root).request(input, human, human);
  assert.deepEqual([task.state, request.deliveryState], ['doing', 'queued']);
  const tree = await readControlTree(h.root), saved = tree.tasks.find(item => item.id === h.task.id)!;
  assert.deepEqual(saved.log.filter(entry => entry.id === input.opId).map(entry => [entry.kind, entry.actor, entry.runId]),
    [['request_accepted', human, undefined]]);
  assert.deepEqual(tree.requests.filter(item => item.id === input.opId).map(item =>
    [item.purpose, item.author.kind, item.body, item.runId, item.deliveryState]),
  [['instruction', 'human', input.body, request.runId, 'queued']]);
  const server = await serve(h);
  const url = new URL(`/api/task/history?task=${h.task.id}&mode=latest`, server.url);
  const historyResponse = await fetch(url);
  assert.equal(historyResponse.status, 200);
  const history = taskHistoryWindowSchema.parse(await historyResponse.json());
  assert.deepEqual(history.events.filter(event => event.id === input.opId).map(({ kind, title, summary }) =>
    ({ kind, title, summary })), [{ kind: 'request', title: input.body, summary: input.body }]);
  const again = taskHistoryWindowSchema.parse(await (await fetch(url)).json());
  assert.deepEqual(again.events, history.events, 'a fresh read has the same single instruction');
  assert.equal(again.oldestKey, history.oldestKey);
  assert.equal(again.hasOlder, history.hasOlder);
});

test('a retried send-back returns the same Request; other input under its ID is refused', async t => {
  const h = await setupReview(t, { userRequested: true }), requests = new TaskRequestService(h.root);
  const input = sendBack(h, 'Retry this revision');
  const first = await requests.request(input, human, human);
  await assert.rejects(requests.request({ ...input, body: 'Another revision' }, human, human),
    refusedWith('idempotency_conflict'));
  assert.deepEqual(await requests.request(input, human, human), first);
  const tree = await readControlTree(h.root);
  assert.equal(tree.tasks.find(item => item.id === h.task.id)?.log.filter(entry => entry.id === input.opId).length, 1);
  assert.equal(tree.requests.filter(request => request.id === input.opId).length, 1);
  assert.equal(tree.runs.filter(run => run.id === first.outcome.request.runId).length, 1);
});

test('a retried send-back survives a later Task body edit', async t => {
  const h = await setupReview(t, { userRequested: true }), requests = new TaskRequestService(h.root);
  const input = sendBack(h, 'Revision after edit');
  const committed = await requests.request(input, human, human);
  await h.commands.update({ id: h.task.id, values: { notes: 'Additional notes' }, expectedTaskHash: committed.task.hash });
  const result = await requests.request(input, human, human);
  assert.equal(result.outcome.request.runId, committed.outcome.request.runId);
  assert.equal(result.outcome.request.deliveryState, 'queued');
  assert.equal((await readControlTree(h.root)).tasks.find(item => item.id === h.task.id)?.log
    .filter(entry => entry.id === input.opId).length, 1);
});

test('a send-back without a conversation choice continues the reviewed Run when it has a session', async t => {
  const h = await setupReview(t, { userRequested: true });
  const { newConversation: _, ...input } = sendBack(h, 'Please revise');
  const result = await new TaskRequestService(h.root).request(input, human, human);
  assert.equal(result.outcome.kind, 'request_accepted');
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  try { assert.equal(store.readRequests().find(request => request.id === input.opId)?.mode, 'continue'); }
  finally { store.close(); }
});

test('a send-back starts the next Run with the launch choices it carries', async t => {
  const h = await setupReview(t, { userRequested: true });
  // Use the current setting with its high and max effort choices.
  writeFileSync(join(h.root, 'config.yaml'), stringify({ agents: { claude: fixtureAgentSetting('claude') } }));
  const { newConversation: _, ...input } = sendBack(h, 'Please revise');
  const result = await new TaskRequestService(h.root).request({ ...input, selected: { effort: 'max' } }, human, human);
  assert.equal(result.outcome.kind, 'request_accepted');
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  try {
    const runId = store.readRequests().find(request => request.id === input.opId)?.runId;
    assert.equal(store.read().find(run => run.id === runId)?.launch.values.effort, 'max');
  } finally { store.close(); }
});

for (const table of ['requests', 'task_log'] as const) test(`a send-back rolls back when ${table} insertion fails and retries cleanly`, async t => {
  const h = await setupReview(t, { userRequested: true }), requests = new TaskRequestService(h.root);
  const input = sendBack(h, 'Draft');
  const before = await readControlTree(h.root);
  const db = new DatabaseSync(join(h.root, '.alpacawork', 'alpacawork.sqlite'));
  try {
    db.exec(`CREATE TRIGGER fail_atomic BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    await assert.rejects(requests.request(input, human, human));
    assert.deepEqual(await readControlTree(h.root), before);
    db.exec('DROP TRIGGER fail_atomic');
    const receipt = await requests.request(input, human, human);
    assert.equal(receipt.outcome.request.deliveryState, 'queued');
    assert.deepEqual(await requests.request(input, human, human), receipt);
    const after = await readControlTree(h.root);
    assert.equal(after.requests.filter(request => request.id === input.opId).length, 1);
    assert.equal(after.tasks.find(item => item.id === h.task.id)?.log.filter(entry => entry.id === input.opId).length, 1);
  } finally { db.close(); }
});

test('a done Task\'s work is sent back as an instruction naming the Run it sends back', async t => {
  const h = await setupReview(t, { userRequested: false }), requests = new TaskRequestService(h.root);
  const input = { task: h.task.id, body: 'Redo this part', expectedHeadRun: h.reviewRun, opId: randomUUID(),
    expectedTaskHash: h.expectedTaskHash, expectedPlacementRevision: h.expectedPlacementRevision };
  await assert.rejects(requests.request({ ...input, opId: randomUUID(), expectedHeadRun: otherRun }, human, human),
    refusedWith('conflict'));
  const { outcome: { request } } = await requests.request(input, human, human);
  assert.equal(request.conversationRef.headRunId, h.reviewRun);
  const tree = await readControlTree(h.root);
  assert.deepEqual(tree.requests.filter(item => item.id === input.opId).map(item => [item.purpose, item.runId]),
    [['instruction', request.runId]]);
  assert.deepEqual(tree.tasks.find(item => item.id === h.task.id)?.log.filter(entry => entry.id === input.opId)
    .map(entry => entry.kind), ['request_accepted']);
});

for (const decision of ['confirmation', 'send-back'] as const) test(`a ${decision} on a Task, responsible or Run other than the one shown is refused without a write`, async t => {
  const h = await setupReview(t, { userRequested: true });
  const decide = (shown: { expectedTaskHash?: string; expectedPlacementRevision?: number; aboutRun?: string; expectedHeadRun?: string },
    opId: string) => decision === 'confirmation'
    ? new TaskReportService(h.root).report({ ...confirmation(h), ...shown, opId }, human, human)
    : new TaskRequestService(h.root).request({ ...sendBack(h, 'Rework this'), ...shown, opId }, human, human);
  const edited = (await h.commands.update({ id: h.task.id, values: { notes: 'Changed while reviewing' },
    expectedTaskHash: h.expectedTaskHash })).task;
  const refused = [randomUUID(), randomUUID(), randomUUID()];
  await assert.rejects(decide({}, refused[0]), refusedWith('conflict'));
  await assert.rejects(decide({ expectedTaskHash: edited.hash, expectedPlacementRevision: h.expectedPlacementRevision + 1 },
    refused[1]), refusedWith('conflict'));
  await assert.rejects(decide({ expectedTaskHash: edited.hash, ...(decision === 'confirmation'
    ? { aboutRun: otherRun } : { expectedHeadRun: otherRun }) }, refused[2]), refusedWith('conflict'));
  const tree = await readControlTree(h.root);
  assert.equal(tree.requests.some(request => (refused as readonly string[]).includes(request.id)), false);
  assert.equal(tree.tasks.some(task => task.log.some(entry => (refused as readonly string[]).includes(entry.id))), false);
  const decided = await decide({ expectedTaskHash: edited.hash }, randomUUID());
  assert.equal(decided.task.state, decision === 'confirmation' ? 'done' : 'doing');
});

test('HTTP send-back rejects a stale Task hash without saving a Request', async t => {
  const h = await setupReview(t, { userRequested: true }), server = await serve(h);
  const { body: instruction, ...input } = sendBack(h, 'Please revise');
  await h.commands.update({ id: h.task.id, values: { notes: 'Concurrent change' }, expectedTaskHash: h.expectedTaskHash });
  const response = await fetch(new URL('/api/commands/task/request', server.url), { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, instruction }) });
  assert.equal(response.status, 409);
  const error = await response.json() as { error: { code: string } };
  assert.equal(error.error.code, 'conflict');
  const tree = await readControlTree(h.root);
  assert.equal(tree.requests.some(request => request.id === input.opId), false);
  assert.equal(tree.tasks.find(item => item.id === h.task.id)?.log.some(entry => entry.id === input.opId), false);
});

test('the ball, task get and the check keep the submitted Run and never replace it with a later head', async t => {
  const h = await setupReview(t, { userRequested: true }), reports = new TaskReportService(h.root);
  assert.deepEqual(await shownReview(h.root, h.task.id), { ball: h.reviewRun, taskGet: h.reviewRun });
  // A later Run of the responsible's conversation: until it finishes there is nothing to decide on.
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  t.after(() => store.close());
  const later = store.write(tx => createFixtureRun(store, tx, { task: h.task.id, placementId: h.placement.id,
    requestId: randomUUID(), agent: 'claude', role: 'owner', resumes: null, continues: false, session: null,
    caller: null, cwd: h.root, launch: { adapter: 'codex', env: [], argv: ['never-launched'],
      path: '/bin', values: {} } }, 'record only')).id;
  assert.deepEqual(await shownReview(h.root, h.task.id), { ball: null, taskGet: null });
  await assert.rejects(reports.report(confirmation(h), human, human), refusedWith('handoff_pending'));
  // Stopped before it started, it ends as the head while the report that began the review still names the first Run.
  store.write(tx => tx.update({ ...tx.get(later)!, state: 'cancelled', reason: 'stopped', ended_at: new Date().toISOString() }));
  const task = (await readControlTree(h.root)).tasks.find(item => item.id === h.task.id)!;
  assert.equal(task.log.find(entry => entry.toState === 'waiting')?.runId, h.reviewRun);
  assert.deepEqual(await shownReview(h.root, h.task.id), { ball: null, taskGet: null });
  await assert.rejects(reports.report(confirmation(h), human, human), refusedWith('conflict'));
  await assert.rejects(reports.report({ ...confirmation(h), aboutRun: later }, human, human), refusedWith('conflict'));
});

test('the reviewed Run is the seat\'s latest owner Run, as the ball reads it: a worker Run of its placement is not it', async t => {
  const h = await setupReview(t, { userRequested: true }), reports = new TaskReportService(h.root);
  // A worker Run of the responsible's placement after the reviewed one, as one it ran before it took the seat.
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  t.after(() => store.close());
  store.write(tx => {
    const worker = createFixtureRun(store, tx, { task: h.task.id, placementId: h.placement.id, requestId: randomUUID(),
      agent: 'claude', role: 'worker', resumes: null, continues: false, session: null, caller: null, cwd: h.root,
      launch: { adapter: 'codex', env: [], argv: ['never-launched'], path: '/bin', values: {} } },
    'record only');
    const at = new Date().toISOString();
    tx.update({ ...worker, state: 'running', started_at: at });
    tx.finish({ ...tx.get(worker.id)!, state: 'succeeded', ended_at: at }, { state: 'present', text: 'worker reply' });
  });
  assert.deepEqual(await shownReview(h.root, h.task.id), { ball: h.reviewRun, taskGet: h.reviewRun });
  assert.equal((await reports.report(confirmation(h), human, human)).task.state, 'done');
});

test('over HTTP a review leaves waiting only by its confirmation or send-back', async t => {
  const h = await setupReview(t, { userRequested: true }), server = await serve(h);
  const post = async (body: Record<string, unknown>) => {
    const response = await fetch(new URL('/api/commands/task/report', server.url), { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return [response.status, (await response.json() as { error: { code: string } }).error.code];
  };
  const base = { task: h.task.id, expectedTaskHash: h.expectedTaskHash };
  const refused = [randomUUID(), randomUUID(), randomUUID()];
  assert.deepEqual(await post({ ...base, state: 'waiting', title: 'Clear wait',
    description: 'Try to clear the review reason.', opId: refused[0] }), [409, 'conflict']);
  assert.deepEqual(await post({ ...base, state: 'doing', opId: refused[1] }), [403, 'forbidden']);
  assert.deepEqual(await post({ ...base, state: 'done', title: 'Done', description: 'The result is ready for review.', opId: refused[2] }), [400, 'invalid_input']);
  const task = (await readControlTree(h.root)).tasks.find(item => item.id === h.task.id)!;
  assert.equal(task.state, 'waiting');
  assert.equal(task.log.some(entry => (refused as readonly string[]).includes(entry.id)), false);
});

for (const decision of ['confirmation', 'send-back'] as const) test(`a retitled review refuses reparenting but still takes its ${decision}`, async t => {
  const h = await setupReview(t, { userRequested: true }), requests = new TaskRequestService(h.root);
  const titled = (await h.commands.update({ id: h.task.id, title: 'Retitled while waiting',
    expectedTaskHash: h.expectedTaskHash })).task;
  const parent = (await h.commands.create({ parentId: h.project, userRequested: false,
    tasks: [{ title: 'New parent' }] })).tasks[0];
  await assignResponsible(h.root, parent, 'claude');
  await assert.rejects(h.commands.move({ id: titled.id, parentId: parent.id, expectedTaskHash: titled.hash }), { code: 'conflict' });
  const result = decision === 'confirmation'
    ? await new TaskReportService(h.root).report({ ...confirmation(h), expectedTaskHash: titled.hash }, human, human)
    : await requests.request({ ...sendBack(h, 'Please revise'), expectedTaskHash: titled.hash }, human, human);
  assert.equal(result.task.state, decision === 'confirmation' ? 'done' : 'doing');
  const last = (await new ControlTaskStore(h.root).get(titled.id)).meta.log.at(-1);
  assert.deepEqual([last?.kind, last?.title],
    [decision === 'confirmation' ? 'review_approved' : 'request_accepted', null]);
});

test('another task’s responsible cannot instruct, confirm or stop a project-level review', async t => {
  const h = await setupReview(t, { userRequested: true });
  const created = (await h.commands.create({ parentId: h.project, userRequested: false,
    tasks: [{ title: 'Parent' }] })).tasks[0];
  const owner = await assignResponsible(h.root, created, 'claude');
  const { outcome: { request } } = await new TaskRequestService(h.root).request({ task: created.id,
    body: 'Lead the child', opId: randomUUID(), expectedTaskHash: (await new ControlTaskStore(h.root).get(created.id)).hash,
    expectedPlacementRevision: owner.revision }, human, human);
  const child = h.task;
  // The parent's responsible as a caller of the write entries, and the decisions as they ask authorize for them.
  const parentRun = { kind: 'run', runId: request.runId, placementId: owner.id, taskId: created.id, role: 'owner',
    responsible: true } as const;
  const decisions = [{ name: 'task.report', state: 'done' },
    { name: 'task.report', state: 'stopped' }] as const;
  const control = new ControlStore(h.root, { busyTimeoutMs: 1_000 }, true);
  try {
    control.read(db => {
      assert.throws(() => authorize(db, parentRun, { name: 'task.request', worker: false }, { task: child.id, quote: null }), { code: 'forbidden' });
      for (const action of decisions) {
        assert.throws(() => authorize(db, parentRun, action, { task: child.id, quote: null }), { code: 'forbidden' });
        assert.deepEqual(authorize(db, human, action, { task: child.id, quote: null }).actor, human);
      }
    });
  } finally { control.close(); }
});

test('a change below a review sends it back to doing, so the review shown can no longer be decided', async t => {
  const h = await setupReview(t, { userRequested: true });
  await h.commands.create({ parentId: h.task.id, userRequested: false, tasks: [{ title: 'Found while reviewing' }] });
  const task = (await readControlTree(h.root)).tasks.find(item => item.id === h.task.id)!;
  assert.deepEqual([task.state, task.log.at(-1)?.kind], ['doing', 'linked']);
  assert.deepEqual(await shownReview(h.root, h.task.id), { ball: null, taskGet: null });
  await assert.rejects(new TaskReportService(h.root).report({ ...confirmation(h), expectedTaskHash: task.hash },
    human, human), refusedWith('conflict'));
  assert.equal((await new TaskRequestService(h.root).request({ ...sendBack(h, 'Please revise'),
    expectedTaskHash: task.hash }, human, human)).outcome.kind, 'request_accepted');
});

test('an accepted owner instruction supersedes a review even if its queued Run is cancelled', async t => {
  const h = await setupReview(t, { userRequested: true });
  const input = sendBack(h, 'Update the shared definition');
  const accepted = await new TaskRequestService(h.root).request(input, human, human);
  assert.equal(accepted.task.state, 'doing', 'acceptance invalidates review before execution');
  assert.equal((await new ControlTaskStore(h.root).get(h.task.id)).meta.log.at(-1)?.kind, 'request_accepted');
  assert.equal(accepted.task.allowedActions.includes('confirm'), false);
  assert.deepEqual(await shownReview(h.root, h.task.id), { ball: null, taskGet: null });
  const runs = new RunStore(h.root, { busyTimeoutMs: 0 });
  try {
    runs.write(tx => tx.finish({ ...tx.get(accepted.outcome.request.runId)!, state: 'cancelled', reason: 'stopped',
      ended_at: new Date().toISOString() }, { state: 'missing', text: null }));
  } finally { runs.close(); }
  assert.deepEqual(await shownReview(h.root, h.task.id), { ball: null, taskGet: null });
  const current = await new ControlTaskStore(h.root).get(h.task.id);
  await assert.rejects(new TaskReportService(h.root).report({ ...confirmation(h), expectedTaskHash: current.hash },
    human, human), refusedWith('conflict'));
});

test('owner report doing after its review tail restores normal execution, and can submit again on the same Run', async t => {
  const f = await taskFlow(t), task = await f.task('Joined input', { userRequested: true }), owner = await f.work(task);
  await f.report(owner, 'done');
  assert.ok((await readControlTree(f.root)).working!.includes(task.id));
  await f.report(owner, 'doing');
  assert.equal((await readControlTree(f.root)).tasks.find(row => row.id === task.id)!.baseState, 'doing');
  const submitted = await f.report(owner, 'done');
  assert.equal(submitted.task.state, 'waiting');
  assert.equal((await new ControlTaskStore(f.root).get(task.id)).meta.log.at(-1)?.kind, 'reported');
});

test('ordinary child instructions withdraw the original question at admission; delayed owner starts preserve its replacement', async t => {
  const f = await taskFlow(t), parent = await f.task('Ancestor'), parentRun = await f.work(parent),
    child = await f.task('Definition owner', { parentId: parent.id }), owner = await f.work(child, parentRun);
  const question = await f.ask(owner, 'user');
  const original = (await f.get(child.id)).meta.log.find(log => log.id === question)!;
  f.end(owner);
  const requested = await f.request(child, parentRun);
  const accepted = await f.get(child.id);
  assert.equal(accepted.meta.log.find(log => log.id === question)?.kind, 'asked');
  assert.deepEqual(accepted.meta.log.find(log => log.id === question), original, 'the original fixed question stays intact');
  assert.equal(accepted.meta.log.find(log => log.questionId === question && log.kind === 'question_withdrawn')?.originCauseId,
    f.run(requested).requestId);
  assert.equal(accepted.meta.log.some(log => log.questionId === question && log.kind === 'answered'), false);
  assert.equal(f.run(requested).state, 'queued');
  assert.equal(accepted.meta.baseState, 'doing');
  // The manager has started the resumed Run, but its start link has not arrived when the owner publishes a new question.
  f.store(runs => runs.write(tx => tx.update({ ...tx.get(requested.runId)!, state: 'running', started_at: new Date().toISOString() })));
  const newer = await f.ask(requested, 'user');
  f.reconcile(); f.reconcile();
  const log = (await f.get(child.id)).meta.log;
  assert.deepEqual(openQuestions(log).map(question => question.id), [newer]);
  assert.equal(log.filter(entry => entry.id === `LSTART${requested.runId}`).length, 1);
  assert.ok(log.findIndex(entry => entry.id === `LSTART${requested.runId}`) < log.findIndex(entry => entry.id === newer));
});
