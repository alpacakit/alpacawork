import { decideValues, seedValues } from './helpers/task-values.ts';
import { stringify } from 'yaml';
import { fixtureAgentSetting } from './helpers/agent-stub.ts';
/**
 * The wake rules W0–W3 end to end: a seat's Requests, their wait cycle, the returns and notices they make, and the
 * one Request that wakes the seat with them (ReturnRouter, RequestService). No agent runs: a Run starts and ends in the
 * store, as its manager writes it, and its agent takes what the Run carried once it started (its PIDs).
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ControlTaskStore, TaskRepository } from '@alpacawork/backend/test-dist/control/task-store.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { PlacementCommands } from '@alpacawork/backend/test-dist/control/placement-commands.js';
import { RequestService } from '@alpacawork/backend/test-dist/control/requests.js';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { comment as recordComment } from '@alpacawork/backend/test-dist/control/task-questions.js';
import { ReturnLifecycle, returnDisposition, returnReceipt, unknownReceipts } from '@alpacawork/backend/test-dist/control/return-lifecycle.js';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import { TaskTransition } from '@alpacawork/backend/test-dist/control/task-transition.js';
import { seatSourceIn } from '@alpacawork/backend/test-dist/control/wake.js';
import { seatFactsOf } from '@alpacawork/backend/test-dist/control/wake.js';
import { reconcileStateLinks } from '@alpacawork/backend/test-dist/control/task-reports.js';
import { readControlTree } from './helpers/control-tree.ts';
import { DatabaseSync } from 'node:sqlite';
import { RunStore } from '@alpacawork/runs';
import { questionText, userTurn } from '@alpacawork/contract';
import { runNumber } from '@alpacawork/contract/run';
import { ControlStore, currentControlConnection, type ChangeSeq } from '@alpacawork/db';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { initializeControlFixture } from './helpers/control-fixture.ts';
import { createFixtureRun } from './helpers/run-fixture.ts';
import { fields } from './runs-fixtures.ts';

// fake has not discovered its bridge session while working; steer has an assigned session and open input.
const config = stringify({ limits: { automatic_per_placement: 20 }, agents: {
  fake: fixtureAgentSetting('codex'), steer: fixtureAgentSetting('claude'),
} });
/** A question asks its Task's decide value. */
const decide = { decide: [{ decide_question: 'Please decide' }] };
type Placement = { id: string; revision: number };
type Receipt = { requestId: string; runId: string };

/**
 * The Task Parent in the fixture's project, with its responsible (`profile`), a worker, and `children` Tasks below it,
 * each with its own responsible. Everyone acts through the services, as authorize's actor: a person for the user, a Run
 * as its own placement.
 */
async function fixture(t: TestContext, { children = 0, userRequested = false, profile = 'fake' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-returns-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const writer = new FileWriter(root);
  let project: string;
  try { writer.save('config.yaml', null, Buffer.from(config)); project = initializeControlFixture(root); } finally { writer.close(); }
  const commands = new ControlTaskCommands(root, { kind: 'human' });
  const create = async (title: string, parentId: string, marked = false): Promise<{ id: string }> =>
    (await commands.create({ parentId, userRequested: marked, tasks: [{ title, values: decide }] })).tasks[0];
  const place = (taskId: string, profileKey = 'fake', responsible = true): Placement => {
    const people = new PlacementStore(root);
    try { return people.createAndPlace({ taskId, profileKey, responsible }).placement; } finally { people.close(); }
  };
  const parent = await create('Parent', project, userRequested);
  // A task with children keeps its responsible, so the parent has one before its children are created.
  const owner = place(parent.id, profile);
  const childrenTasks: { id: string }[] = [], childOwners: Placement[] = [];
  for (let i = 0; i < children; i++) {
    const child = await create(`Child ${i}`, parent.id);
    childrenTasks.push(child); childOwners.push(place(child.id));
  }
  const worker = place(parent.id, 'fake', false);
  const service = new RequestService(root), reports = new TaskReportService(root);
  const store = new RunStore(root, { busyTimeoutMs: 1000 });
  t.after(() => store.close());
  const current = (id: string) => new ControlTaskStore(root).get(id);
  const seatOf = (taskId: string): Placement => store.readPlacements(reader => reader.responsiblePlacement(taskId))!;
  /** A person, the user's proxy, asks Task `taskId`'s responsible to work (W0). */
  const human = async (taskId = parent.id, body = 'Do the work'): Promise<Receipt> =>
    service.request({ taskId, body, requestId: randomUUID(), expectedTaskHash: (await current(taskId)).hash,
      expectedPlacementRevision: seatOf(taskId).revision }, { purpose: 'instruction', actor: { kind: 'human' } });
  /** The Run `caller` asks a placement of Task `taskId`: a child's responsible, or a worker of its own Task. */
  const agent = async (taskId: string, placement: Placement, caller: string): Promise<Receipt> =>
    service.request({ taskId, body: 'Please handle this', requestId: randomUUID(),
      expectedTaskHash: (await current(taskId)).hash, expectedPlacementRevision: placement.revision,
      targetPlacementId: placement.id }, { purpose: 'instruction',
      actor: { kind: 'placement', placementId: store.get(caller)!.placementId }, actorRunId: caller });
  /** A Run starts, and its agent takes what the Run carried. */
  const start = (id: string) => store.write(tx => tx.update({ ...tx.get(id)!, state: 'running',
    started_at: new Date().toISOString(), pids: { manager: 1, agent: 2 } }));
  const end = (id: string, state: 'succeeded' | 'failed' | 'cancelled' = 'succeeded') => store.write(tx => tx.finish({
    ...tx.get(id)!, session: tx.get(id)!.session ?? { provider: 'codex', id: `synthetic-${id}` }, state, reason: state === 'failed' ? 'output' : state === 'cancelled' ? 'stopped' : null,
    ended_at: new Date().toISOString() },
    state === 'succeeded' ? { state: 'present', text: 'done' } : { state: 'missing', text: null }));
  /** The Run `runId` acts as its own placement, on its own Task. */
  const asRun = (runId: string) => {
    const run = store.get(runId)!;
    return { actor: { kind: 'placement', placementId: run.placementId } as const,
      caller: { kind: 'run', runId, placementId: run.placementId, taskId: run.task, role: run.role,
        responsible: run.role === 'owner' } as const };
  };
  /** The responsible Run `runId` reports a state of its Task; `urgent` has a done go to the requester now. */
  const report = async (runId: string, state: 'doing' | 'done' | 'stopped', urgent?: string) => {
    const { actor, caller } = asRun(runId);
    return reports.report({ task: caller.taskId, state, title: `${state} report`, description: `The work is ${state}.`, opId: randomUUID(),
      expectedTaskHash: (await current(caller.taskId)).hash, ...(urgent === undefined ? {} : { urgent }) }, actor, caller);
  };
  /** A person, the user's proxy, stops Task `taskId` with everything below it. */
  const stop = async (taskId: string) => reports.report({ task: taskId, state: 'stopped', title: 'Stop it',
    opId: randomUUID(), expectedTaskHash: (await current(taskId)).hash }, { kind: 'human' }, { kind: 'human' });
  /** The responsible Run asks its parent or the user the question of its body; returns the question's ID. */
  const ask = async (runId: string, askTo?: string) => {
    const { actor, caller } = asRun(runId), opId = randomUUID();
    await reports.report({ task: caller.taskId, state: 'waiting', askTo: askTo ?? ((await current((await current(caller.taskId)).meta.parentId!)).meta.kind === 'project' ? 'user' : (await current(caller.taskId)).meta.parentId!), title: 'Question', description: 'Please decide', opId,
      expectedTaskHash: (await current(caller.taskId)).hash }, actor, caller);
    return opId;
  };
  const withdraw = async (runId: string, questionId: string) => {
    const { actor, caller } = asRun(runId);
    return reports.report({ task: caller.taskId, withdraw: questionId, opId: randomUUID(),
      expectedTaskHash: (await current(caller.taskId)).hash }, actor, caller);
  };
  /** The Run `runId`, of the Task the question asked, answers Task `taskId`'s question. */
  const answer = async (taskId: string, questionId: string, runId: string) => {
    const { actor, caller } = asRun(runId);
    return new TaskRequestService(root).request({ task: taskId, answers: questionId, body: 'This way', opId: randomUUID() },
      actor, caller);
  };
  /** The Run `runId` records a comment on its Task, as task comment writes it; `urgent` sends it to the requester now. */
  const comment = async (runId: string, urgent?: string) => {
    const { actor, caller } = asRun(runId), expectedTaskHash = (await current(caller.taskId)).hash;
    const control = new ControlStore(root);
    try {
      control.write(db => {
        const runs = new RunStore(root, { busyTimeoutMs: 1000 }, false, db);
        try {
          runs.write(tx => recordComment({ store: runs, runs: tx }, { actor, runId, taskId: caller.taskId, opId: randomUUID(),
            expectedTaskHash, title: 'Note', ...(urgent === undefined ? {} : { urgentReason: urgent }) }));
        } finally { runs.close(); }
      });
    } finally { control.close(); }
  };
  const pass = (): Promise<{ acceptedRequestIds: string[]; held: { taskId: string; reason: string }[] }> =>
    new ReturnRouter(root).pass(undefined, { project });
  const ball = async (id: string) => (await readControlTree(root)).balls[id] ?? null;
  const rows = (taskId: string) => store.readReturns().filter(row => row.toTaskId === taskId);
  /** The closing return of a Request. */
  const row = (requestId: string) => store.readReturns().find(item => item.requestId === requestId);
  const runOf = (requestId: string) => store.getRequest(requestId)!.runId!;
  const cycles = (taskId: string) => store.snapshot(project).waitCycles.filter(cycle => cycle.taskId === taskId);
  return { root, project, parent, owner, childrenTasks, childOwners, worker, service, store, commands, create, place,
    current, human, agent, start, end, report, stop, ask, withdraw, answer, comment, pass, ball, rows, row, runOf, cycles };
}

/** The parent's Run asks its child, whose Run reports done and ends; the parent's Run still works. */
async function completedChild(t: TestContext) {
  const h = await fixture(t, { children: 1 });
  const first = await h.human(); h.start(first.runId);
  const child = h.childrenTasks[0]!, reply = await h.agent(child.id, h.childOwners[0]!, first.runId);
  h.start(reply.runId); await h.report(reply.runId, 'done'); h.end(reply.runId);
  return { h, child, reply };
}

test('W1: results already arrived at one pass wake the idle seat once with success, failure and stop together', async t => {
  const h = await fixture(t, { children: 3 });
  const first = await h.human(); h.start(first.runId);
  const sent: Receipt[] = [];
  for (const [index, child] of h.childrenTasks.entries()) sent.push(await h.agent(child.id, h.childOwners[index]!, first.runId));
  const [cycle, ...others] = h.cycles(h.parent.id);
  assert.deepEqual([others.length, cycle?.closedAt], [0, null], 'the first Request opened the cycle, the others joined it');
  assert.ok(sent.every(request => h.store.getRequest(request.requestId)?.waitCycleId === cycle?.id));
  for (const request of sent) h.start(request.runId);
  h.end(first.runId);
  await h.report(sent[0]!.runId, 'done'); h.end(sent[0]!.runId);
  h.end(sent[1]!.runId, 'failed');
  await h.stop(h.childrenTasks[2]!.id); h.end(sent[2]!.runId, 'cancelled');
  const woke = await h.pass();
  assert.equal(woke.acceptedRequestIds.length, 1);
  const wake = woke.acceptedRequestIds[0]!;
  assert.notEqual(h.cycles(h.parent.id)[0]?.closedAt, null, 'the cycle records that its last Request closed');
  assert.deepEqual(sent.map(request => { const closing = h.row(request.requestId);
    return [closing?.outcome, closing?.deliveries.map(delivery => delivery.wakeRequestId)]; }),
  [['succeeded', [wake]], ['failed', [wake]], ['stopped', [wake]]]);
  const text = h.store.getRequest(wake)!.body;
  for (const [index, words] of ['done', 'failed', 'stopped'].entries())
    assert.ok(text.includes(`Child task ${h.childrenTasks[index]!.id}: ${words}`), words);
  assert.deepEqual((await h.pass()).acceptedRequestIds, [], 'once');
});

test('W1: a seat working without input is woken once its turn ends, with what it sent and saw closed in that turn; a failed turn wakes nobody (U2)', async t => {
  const h = await fixture(t);
  const first = await h.human(); h.start(first.runId);
  const work = await h.agent(h.parent.id, h.worker, first.runId);
  h.start(work.runId); h.end(work.runId);
  assert.deepEqual((await h.pass()).acceptedRequestIds, [], 'its turn goes on and takes no input');
  assert.equal(returnDisposition(h.row(work.requestId)!), 'pending');
  h.end(first.runId);
  const woke = await h.pass();
  assert.equal(woke.acceptedRequestIds.length, 1);
  assert.deepEqual((await h.pass()).acceptedRequestIds, [], 'once');
  const wake = h.runOf(woke.acceptedRequestIds[0]!);
  h.start(wake); h.end(wake, 'failed');
  assert.deepEqual((await h.pass()).acceptedRequestIds, [], 'a failed turn wakes nobody');
  assert.equal(returnDisposition(h.row(work.requestId)!), 'carried', 'what it took waits for the next Request to the seat');
  assert.equal(userTurn(await h.ball(h.parent.id))?.reason, 'failed', 'its requester, the user, retries or stops it');
  assert.deepEqual((await h.pass()).acceptedRequestIds, []);
});

test('W1: a working seat whose agent takes input is woken at once, and its turn\'s success consumes the delivery', async t => {
  const h = await fixture(t, { profile: 'steer' });
  const first = await h.human(); h.start(first.runId);
  const work = await h.agent(h.parent.id, h.worker, first.runId);
  h.start(work.runId); h.end(work.runId);
  const woke = await h.pass();
  assert.equal(woke.acceptedRequestIds.length, 1, 'its input is open');
  const request = h.store.getRequest(woke.acceptedRequestIds[0]!)!, wake = request.runId!;
  assert.deepEqual([request.deliveryState, h.store.get(wake)?.resumes], ['waiting_for_run', first.runId]);
  // The scheduler feeds the wake to the working agent, which takes it (planInputs and the input's receipt).
  h.store.write(tx => tx.update({ ...tx.get(wake)!, state: 'joined', into: first.runId, ended_at: new Date().toISOString() }));
  const attempt = randomUUID();
  h.store.connection.prepare('INSERT INTO run_attempts(run_no,attempt_id,launch_json) VALUES (?,?,?)')
    .run(runNumber(first.runId), attempt, '{}');
  h.store.connection.prepare(`INSERT INTO run_inputs(input_id,attempt_id,instruction_run_no,content_digest,state,initial)
    VALUES (?,?,?,?,'taken',0)`).run(randomUUID(), attempt, runNumber(wake), 'a'.repeat(64));
  await h.pass();
  assert.ok(h.row(work.requestId)!.deliveries[0]!.receivedAt);
  await h.report(first.runId, 'done'); h.end(first.runId);
  assert.deepEqual((await h.pass()).acceptedRequestIds, [], 'the turn that took it wakes nobody again');
  const closing = h.row(work.requestId)!;
  assert.equal(returnDisposition(closing), 'disposed');
  assert.ok(closing.deliveries[0]!.consumedAt);
  assert.equal((await h.current(h.parent.id)).meta.state, 'done');
});

test('U2b: a wake waiting for a turn that then fails is withdrawn, and its returns wait for the retry', async t => {
  const h = await fixture(t, { profile: 'steer' });
  const first = await h.human(); h.start(first.runId);
  const work = await h.agent(h.parent.id, h.worker, first.runId);
  h.start(work.runId); h.end(work.runId);
  const woke = await h.pass();
  assert.equal(woke.acceptedRequestIds.length, 1);
  const wake = h.runOf(woke.acceptedRequestIds[0]!);
  h.end(first.runId, 'failed');
  assert.deepEqual((await h.pass()).acceptedRequestIds, []);
  assert.deepEqual([h.store.get(wake)?.state, h.store.getRequest(woke.acceptedRequestIds[0]!)?.deliveryState],
    ['cancelled', 'aborted']);
  const closing = h.row(work.requestId)!;
  assert.deepEqual(closing.deliveries.map(delivery => delivery.releaseReason), ['seat_failed']);
  assert.equal(returnDisposition(closing), 'carried');
  const retry = await h.human();
  assert.equal(h.row(work.requestId)!.deliveries.at(-1)?.wakeRequestId, retry.requestId);
});

test('W1: a seat whose own Task it stopped is not woken, and what closes for it is resolved', async t => {
  const h = await fixture(t);
  const first = await h.human(); h.start(first.runId);
  const work = await h.agent(h.parent.id, h.worker, first.runId); h.start(work.runId);
  await h.report(first.runId, 'stopped');
  assert.equal(h.store.get(work.runId)?.stop_requested, true, 'the stop reaches the work it sent');
  h.end(work.runId, 'cancelled'); h.end(first.runId);
  assert.deepEqual((await h.pass()).acceptedRequestIds, []);
  const closing = h.row(work.requestId)!;
  assert.deepEqual([closing.outcome, closing.resolution?.reason], ['stopped', 'seat_finished']);
});

test('W1: a Request sent after its cycle\'s last closure but before a pass waits in a cycle of its own, and the earlier closing return is delivered independently', async t => {
  const h = await fixture(t, { children: 2 });
  const first = await h.human(); h.start(first.runId);
  const earlier = await h.agent(h.childrenTasks[0]!.id, h.childOwners[0]!, first.runId);
  h.start(earlier.runId); await h.report(earlier.runId, 'done'); h.end(earlier.runId);
  const later = await h.agent(h.childrenTasks[1]!.id, h.childOwners[1]!, first.runId);
  const closed = h.store.getRequest(earlier.requestId)!.waitCycleId, open = h.store.getRequest(later.requestId)!.waitCycleId;
  assert.notEqual(open, closed);
  assert.deepEqual(h.cycles(h.parent.id).map(cycle => [cycle.id, cycle.closedAt === null]), [[closed, false], [open, true]]);
  assert.equal(h.row(earlier.requestId)?.outcome, 'succeeded', 'the closed cycle got its closing return as the new one opened');
  h.end(first.runId);
  const early = await h.pass();
  assert.equal(early.acceptedRequestIds.length, 1, 'the new open cycle does not withhold the earlier result');
  assert.equal(h.row(earlier.requestId)?.deliveries[0]?.wakeRequestId, early.acceptedRequestIds[0]);
  const earlyRun = h.runOf(early.acceptedRequestIds[0]!); h.start(earlyRun); h.end(earlyRun);
  h.start(later.runId); await h.report(later.runId, 'done'); h.end(later.runId);
  const woke = await h.pass();
  assert.equal(woke.acceptedRequestIds.length, 1);
  assert.equal(h.row(later.requestId)?.deliveries[0]?.wakeRequestId, woke.acceptedRequestIds[0]);
  assert.equal(h.row(earlier.requestId)?.deliveries.length, 1, 'the earlier result is not reserved twice');
});

test('W2: a question to the parent wakes it at once while its cycle goes on; the question keeps the seat it asked and what it asked', async t => {
  const h = await fixture(t, { children: 2 });
  const first = await h.human(); h.start(first.runId);
  const [child] = h.childrenTasks;
  const asking = [{ decide_question: 'Which layout?', decide_choices: [
    { decide_choice: 'Sidebar Keep it', decide_choice_detail: 'Nothing moves', decide_choice_recommended: 'No retraining' },
    { decide_choice: 'Tabs' }], decide_note: 'Both fit a phone', decide_stop: 'The redesign is dropped' }];
  seedValues(h.root, child!.id, { decide: asking });
  const sent = [await h.agent(child!.id, h.childOwners[0]!, first.runId),
    await h.agent(h.childrenTasks[1]!.id, h.childOwners[1]!, first.runId)];
  for (const request of sent) h.start(request.runId);
  h.end(first.runId);
  const question = await h.ask(sent[0]!.runId);
  const asked = (await h.current(child!.id)).meta.log.find(entry => entry.id === question);
  assert.equal(asked?.askedTo, h.parent.id, 'asked of the requester, fixed when asked');
  // What it asks is fixed in the asking record itself, as the Task's decide value was then; no text is kept beside it.
  assert.deepEqual(asked?.decide, asking);
  seedValues(h.root, child!.id, { decide: [{ decide_question: 'Rewritten since' }] });
  assert.deepEqual((await h.current(child!.id)).meta.log.find(entry => entry.id === question)?.decide, asking);
  const control = new ControlStore(h.root, { busyTimeoutMs: 1000 });
  try { assert.equal(control.read(db => Number(db.prepare('SELECT count(*) AS n FROM log_texts WHERE log_id=?').get(question)!.n)), 0); }
  finally { control.close(); }
  assert.deepEqual(h.rows(h.parent.id).map(item => [item.outcome, item.causeLogId]), [['question', question]]);
  assert.deepEqual(await h.ball(child!.id), { holder: 'parent', reason: 'question' });
  const woke = await h.pass();
  assert.equal(woke.acceptedRequestIds.length, 1);
  const wake = h.store.getRequest(woke.acceptedRequestIds[0]!)!;
  assert.equal(wake.taskId, h.parent.id);
  assert.ok(wake.body.includes(`--task ${child!.id} --answers ${question}`), 'its line says how to answer');
  // The notice carries the question's full text as an agent reads it: the fixed items, not the values as they are now.
  const text = ['### 1 Which layout?', '#### Sidebar Keep it', 'Nothing moves', 'Recommended: No retraining', '#### Tabs', '',
    'Both fit a phone', '', 'Stop: The redesign is dropped'].join('\n');
  assert.equal(questionText(asking), text);
  assert.ok(wake.body.includes(`"Question":\n${text}\n`), wake.body);
  assert.doesNotMatch(wake.body, /Rewritten since/);
  assert.equal(h.cycles(h.parent.id)[0]?.closedAt, null, 'the cycle goes on');
});

test('W2: an urgent comment wakes the parent at once; a plain one wakes nobody', async t => {
  const h = await fixture(t, { children: 1 });
  const first = await h.human(); h.start(first.runId);
  const sent = await h.agent(h.childrenTasks[0]!.id, h.childOwners[0]!, first.runId);
  h.start(sent.runId); h.end(first.runId);
  await h.comment(sent.runId);
  assert.deepEqual(h.rows(h.parent.id), [], 'a comment stays in its Task\'s own record');
  assert.deepEqual((await h.pass()).acceptedRequestIds, []);
  await h.comment(sent.runId, 'It changes the plan');
  const woke = await h.pass();
  assert.equal(woke.acceptedRequestIds.length, 1);
  assert.ok(h.store.getRequest(woke.acceptedRequestIds[0]!)!.body.includes('It changes the plan'));
});

test('W2: an urgent done and its closing result go together even while another child is open', async t => {
  const h = await fixture(t, { children: 2 });
  const first = await h.human(); h.start(first.runId);
  const sent = [await h.agent(h.childrenTasks[0]!.id, h.childOwners[0]!, first.runId),
    await h.agent(h.childrenTasks[1]!.id, h.childOwners[1]!, first.runId)];
  for (const request of sent) h.start(request.runId);
  h.end(first.runId);
  await h.report(sent[0]!.runId, 'done', 'It changes the plan'); h.end(sent[0]!.runId);
  const early = await h.pass();
  assert.equal(early.acceptedRequestIds.length, 1);
  const note = h.rows(h.parent.id).find(item => item.outcome === 'urgent')!;
  assert.equal(note.deliveries[0]?.wakeRequestId, early.acceptedRequestIds[0]);
  assert.equal(h.row(sent[0]!.requestId)?.deliveries[0]?.wakeRequestId, early.acceptedRequestIds[0],
    'the closing result goes with its urgent note');
  const wake = h.runOf(early.acceptedRequestIds[0]!);
  h.start(wake); h.end(wake);
  assert.deepEqual((await h.pass()).acceptedRequestIds, []);
  await h.report(sent[1]!.runId, 'done', 'It changes the plan too'); h.end(sent[1]!.runId);
  const last = await h.pass();
  assert.equal(last.acceptedRequestIds.length, 1);
  const lastNote = h.rows(h.parent.id).find(item => item.outcome === 'urgent' && item.id !== note.id)!;
  assert.deepEqual([h.row(sent[1]!.requestId), lastNote]
    .map(item => item?.deliveries.at(-1)?.wakeRequestId), [0, 1].map(() => last.acceptedRequestIds[0]));
});

for (const marked of [false, true]) test(`W2: a Task ${marked ? 'the user asked for' : 'the user requested directly but did not mark'} refuses an urgent comment and an urgent done in the same words`, async t => {
  const h = await fixture(t, { userRequested: marked });
  const first = await h.human(); h.start(first.runId);
  const refused = { code: 'urgent_to_user', message: 'Cannot send an urgent notification when the requester is the user; ask a question instead' };
  await assert.rejects(h.comment(first.runId, 'Read this now'), refused);
  await assert.rejects(h.report(first.runId, 'done', 'Read this now'), refused);
  assert.deepEqual(h.rows(h.parent.id), []);
  assert.equal((await h.current(h.parent.id)).meta.log.some(entry => entry.urgentReason !== undefined), false);
});

test('W3: an open answer wakes the asking Task\'s responsible without a Request or Run; a later answer becomes a Request', async t => {
  const h = await fixture(t, { children: 1 });
  const first = await h.human(); h.start(first.runId);
  const child = h.childrenTasks[0]!, sent = await h.agent(child.id, h.childOwners[0]!, first.runId);
  h.start(sent.runId);
  const question = await h.ask(sent.runId); h.end(sent.runId);
  const before = [h.store.readRequests().length, h.store.read().length];
  await h.answer(child.id, question, first.runId);
  assert.deepEqual([h.store.readRequests().length, h.store.read().length], before, 'an answer makes no Request or Run');
  assert.deepEqual(h.rows(child.id).map(item => item.outcome), ['answer']);
  const woke = await h.pass();
  const wakes = woke.acceptedRequestIds.map(id => h.store.getRequest(id)!);
  assert.deepEqual(wakes.map(wake => wake.taskId), [child.id], 'the parent\'s Run still works and takes no input');
  assert.ok(wakes[0]!.body.includes(`Task ${child.id}: answer to question ${question}`));
  assert.equal(h.rows(h.parent.id).find(item => item.outcome === 'question')?.resolution?.reason, 'question_closed',
    'the answered question no longer goes to the parent');
  const late = await h.answer(child.id, question, first.runId);
  assert.equal(late.outcome.kind, 'request_accepted');
  assert.equal(h.store.getRequest(late.outcome.request.requestId)!.answersQuestion, question);
});

for (const by of ['worker', 'child'] as const) test(`U2b: a seat that failed is not woken when its ${by === 'worker' ? 'worker' : 'child Task'} finishes; its retry's Request carries it`, async t => {
  const h = await fixture(t, { children: by === 'child' ? 1 : 0 });
  const first = await h.human(); h.start(first.runId);
  const child = h.childrenTasks[0];
  const [taskId, seat, line] = child === undefined ? [h.parent.id, h.worker, `Member ${h.worker.id}: succeeded`]
    : [child.id, h.childOwners[0]!, `Child task ${child.id}: done`];
  const sent = await h.agent(taskId, seat, first.runId); h.start(sent.runId);
  h.end(first.runId, 'failed');
  await h.pass();
  assert.equal(userTurn(await h.ball(h.parent.id))?.reason, 'failed');
  if (child !== undefined) await h.report(sent.runId, 'done');
  h.end(sent.runId);
  assert.deepEqual((await h.pass()).acceptedRequestIds, [], 'a failed seat takes no W1');
  assert.equal(returnDisposition(h.row(sent.requestId)!), 'pending');
  assert.equal((await h.current(h.parent.id)).meta.state, 'error', 'what closed for it leaves its failure as it was');
  const retry = await h.human();
  assert.equal(h.row(sent.requestId)?.deliveries[0]?.wakeRequestId, retry.requestId);
  assert.ok((h.store.getText(retry.runId)?.prompt ?? '').includes(line), 'its start text carries it');
  h.start(retry.runId); await h.pass();
  assert.deepEqual(await h.ball(h.parent.id), { holder: 'owner' });
});

test('U2b: an answer that comes while the asking seat failed waits, and the retry\'s Request carries it', async t => {
  const h = await fixture(t, { children: 1 });
  const first = await h.human(); h.start(first.runId);
  const child = h.childrenTasks[0]!, seat = h.childOwners[0]!, sent = await h.agent(child.id, seat, first.runId);
  h.start(sent.runId);
  const question = await h.ask(sent.runId); h.end(sent.runId, 'failed');
  await h.answer(child.id, question, first.runId);
  assert.deepEqual((await h.pass()).acceptedRequestIds, []);
  assert.equal((await h.current(child.id)).meta.state, 'error', 'a failure leaves its question to be answered');
  const answered = () => h.rows(child.id).find(item => item.outcome === 'answer')!;
  assert.equal(returnDisposition(answered()), 'pending');
  const retry = await h.agent(child.id, seat, first.runId);
  assert.equal(answered().deliveries[0]?.wakeRequestId, retry.requestId);
  assert.ok((h.store.getText(retry.runId)?.prompt ?? '').includes(`answer to question ${question}`));
});

test('W0: a new responsible\'s handover carries what its failed predecessor took, and the new one finishes the Task', async t => {
  const h = await fixture(t);
  const first = await h.human(); h.start(first.runId);
  const work = await h.agent(h.parent.id, h.worker, first.runId);
  h.start(work.runId); h.end(work.runId); h.end(first.runId);
  const woke = await h.pass();
  assert.equal(woke.acceptedRequestIds.length, 1);
  const taking = h.runOf(woke.acceptedRequestIds[0]!);
  h.start(taking); h.end(taking, 'failed');
  assert.deepEqual((await h.pass()).acceptedRequestIds, [], 'a failed seat takes no W1');
  assert.equal(returnDisposition(h.row(work.requestId)!), 'carried', 'the predecessor took it and failed');
  const successor = (await new PlacementCommands(h.root).placeNewResponsible({ taskId: h.parent.id, profileKey: 'fake',
    expectedTaskHash: (await h.current(h.parent.id)).hash, replacePlacementId: h.owner.id,
    expectedPlacementRevision: h.owner.revision }, { kind: 'human' })).placement;
  const handover = await h.pass();
  assert.equal(handover.acceptedRequestIds.length, 1, 'the handover wakes the new responsible of a failed seat');
  const told = h.store.getRequest(handover.acceptedRequestIds[0]!)!;
  assert.equal(told.placementId, successor.id);
  assert.deepEqual(h.rows(h.parent.id).filter(item => item.deliveries.some(delivery => delivery.wakeRequestId === told.id &&
    delivery.releasedAt === null)).map(item => item.outcome).sort(), ['handover', 'succeeded']);
  assert.ok((h.store.getText(told.runId!)?.prompt ?? '').includes(`Member ${h.worker.id}: succeeded`),
    'the carried return comes in its start text');
  h.start(told.runId!);
  await h.report(told.runId!, 'done');
  h.end(told.runId!);
  await h.pass();
  assert.equal((await h.current(h.parent.id)).meta.state, 'done');
  assert.equal(returnDisposition(h.row(work.requestId)!), 'disposed');
});

test('an unmarked child failure wakes its parent by W1, and the parent retries it', async t => {
  const h = await fixture(t);
  const first = await h.human(); h.start(first.runId);
  const child = await h.create('Child work', h.parent.id), seat = h.place(child.id);
  const sent = await h.agent(child.id, seat, first.runId);
  h.start(sent.runId); h.end(sent.runId, 'failed'); h.end(first.runId);
  const woke = await h.pass();
  assert.equal(woke.acceptedRequestIds.length, 1);
  const wake = h.store.getRequest(woke.acceptedRequestIds[0]!)!;
  assert.equal(wake.taskId, h.parent.id);
  assert.ok(wake.body.includes(`Child task ${child.id}: failed`));
  assert.deepEqual(await h.ball(child.id), { holder: 'parent', reason: 'failed' });
  const retry = await h.agent(child.id, seat, wake.runId!);
  assert.equal(h.store.get(retry.runId)?.placementId, seat.id);
});

test('what was not delivered of a question goes once it closes by its answer, its withdrawal or its Task\'s stop, and a stopped Task\'s urgent note with it', async t => {
  const h = await fixture(t, { children: 3 });
  const first = await h.human(); h.start(first.runId);
  const sent: Receipt[] = [];
  for (const [index, child] of h.childrenTasks.entries()) sent.push(await h.agent(child.id, h.childOwners[index]!, first.runId));
  const questions: string[] = [];
  for (const request of sent) { h.start(request.runId); questions.push(await h.ask(request.runId)); }
  await h.comment(sent[2]!.runId, 'It changes the plan');
  await h.pass();
  assert.ok(h.rows(h.parent.id).every(item => item.deliveries.length === 0), 'the parent works on and takes no input');
  await h.answer(h.childrenTasks[0]!.id, questions[0]!, first.runId);
  await h.withdraw(sent[1]!.runId, questions[1]!);
  await h.stop(h.childrenTasks[2]!.id);
  await h.pass();
  const reason = (outcome: string, cause?: string) => h.rows(h.parent.id)
    .find(item => item.outcome === outcome && (cause === undefined || item.causeLogId === cause))?.resolution?.reason;
  assert.deepEqual([reason('question', questions[0]), reason('question', questions[1]), reason('question', questions[2]),
    reason('urgent')], ['question_closed', 'question_closed', 'origin_stopped', 'origin_stopped']);
});

test('comments and user questions create no notices, but a result wakes the parent while another child works', async t => {
  const h = await fixture(t, { children: 2, userRequested: true });
  const first = await h.human(); h.start(first.runId);
  const sent = [await h.agent(h.childrenTasks[0]!.id, h.childOwners[0]!, first.runId),
    await h.agent(h.childrenTasks[1]!.id, h.childOwners[1]!, first.runId)];
  for (const request of sent) h.start(request.runId);
  await h.comment(first.runId); await h.comment(sent[0]!.runId);
  await h.report(sent[0]!.runId, 'done'); h.end(sent[0]!.runId);
  const question = await h.ask(first.runId);
  assert.equal((await h.current(h.parent.id)).meta.log.find(entry => entry.id === question)?.askedTo, null);
  h.end(first.runId);
  const early = await h.pass();
  assert.equal(early.acceptedRequestIds.length, 1, 'the sibling still running does not hold the closing result');
  assert.deepEqual(h.rows(h.parent.id).map(item => item.outcome), ['succeeded'],
    'comments and a question to the user send no notices');
  const earlyRun = h.runOf(early.acceptedRequestIds[0]!); h.start(earlyRun); h.end(earlyRun);
  assert.equal(userTurn(await h.ball(h.parent.id)), null, 'the result admission withdrew the old user question');
  assert.equal((await h.current(h.parent.id)).meta.log.find(entry => entry.questionId === question)?.kind, 'question_withdrawn');
  await h.report(sent[1]!.runId, 'done'); h.end(sent[1]!.runId);
  const woke = await h.pass();
  assert.equal(woke.acceptedRequestIds.length, 1, 'the cycle\'s last closure wakes it');
  const wake = h.runOf(woke.acceptedRequestIds[0]!);
  h.start(wake);
  await assert.rejects(h.withdraw(wake, question), { code: 'question_closed' });
  await h.report(wake, 'done'); h.end(wake);
  assert.deepEqual((await h.pass()).acceptedRequestIds, []);
  assert.equal(userTurn(await h.ball(h.parent.id))?.reason, 'review');
  assert.equal(h.store.readRequests().filter(request => request.purpose === 'return_continuation').length, 2);
});

test('a responsible that ends while a Request it sent is open works on until the return wakes it; one that ends after taking it without a report fails', async t => {
  const h = await fixture(t, { children: 1 });
  const first = await h.human(); h.start(first.runId);
  const sent = await h.agent(h.childrenTasks[0]!.id, h.childOwners[0]!, first.runId); h.start(sent.runId);
  h.end(first.runId);
  await h.pass();
  await h.report(sent.runId, 'done'); h.end(sent.runId);
  const apply = TaskTransition.prototype.apply;
  let reads = 0;
  t.mock.method(TaskTransition.prototype, 'apply', function(this: unknown, tx: unknown,
    transition: { action: string; runId?: string }) {
    if (transition.action === 'run_ended' && transition.runId === first.runId) reads++;
    return apply.call(this, tx, transition);
  });
  const woke = await h.pass();
  for (let again = 0; again < 2; again++) assert.deepEqual((await h.pass()).acceptedRequestIds, []);
  assert.equal(woke.acceptedRequestIds.length, 1);
  assert.equal((await h.current(h.parent.id)).meta.state, 'doing', 'its end is judged as things stood when it ended');
  assert.equal(h.row(sent.requestId)?.deliveries[0]?.wakeRequestId, woke.acceptedRequestIds[0]);
  const wake = h.runOf(woke.acceptedRequestIds[0]!);
  h.start(wake); await h.pass();
  const read = reads;
  assert.equal(read, 0, 'the settled earlier end is an immutable boundary, not recomputed after the return');
  h.end(wake); await h.pass();
  assert.equal(reads, read, 'once the next Run started, the earlier end is not read again');
  const parent = await h.current(h.parent.id);
  assert.deepEqual([parent.meta.state, parent.meta.log.at(-1)?.id, h.store.get(wake)?.state],
    ['error', `LEND${wake}`, 'succeeded'], 'the Run that took the return and ended with no report fails it (no_report)');
});

test('a wake\'s admission decides again: a notice that came after the router chose sends that wake back to the next pass', async t => {
  const h = await fixture(t);
  const first = await h.human(); h.start(first.runId);
  const work = await h.agent(h.parent.id, h.worker, first.runId);
  h.start(work.runId); h.end(work.runId); h.end(first.runId);
  const moving = await h.create('Added meanwhile', h.project);
  const request = RequestService.prototype.request;
  let raced = false;
  const hook = t.mock.method(RequestService.prototype, 'request', async function(this: unknown, input: unknown,
    context: { purpose: string }) {
    if (context.purpose === 'return_continuation' && !raced) { raced = true; await h.commands.move({ id: moving.id, parentId: h.parent.id, expectedTaskHash: (await h.current(moving.id)).hash }); }
    return request.call(this, input, context);
  });
  assert.deepEqual((await h.pass()).acceptedRequestIds, []);
  hook.mock.restore();
  assert.equal(raced, true);
  assert.deepEqual(h.store.readRequests().filter(item => item.purpose === 'return_continuation'), [], 'the refused admission left no Request');
  assert.deepEqual(h.rows(h.parent.id).map(item => item.deliveries.length), [0, 0]);
  const woke = await h.pass();
  assert.equal(woke.acceptedRequestIds.length, 1);
  assert.ok(h.rows(h.parent.id).every(item => item.deliveries[0]?.wakeRequestId === woke.acceptedRequestIds[0]));
});

test('a question answered after the router chose its wake goes no more: that wake is sent back, and the next pass wakes without it', async t => {
  const h = await fixture(t, { children: 2 });
  const first = await h.human(); h.start(first.runId);
  const sent = [await h.agent(h.childrenTasks[0]!.id, h.childOwners[0]!, first.runId),
    await h.agent(h.childrenTasks[1]!.id, h.childOwners[1]!, first.runId)];
  for (const request of sent) h.start(request.runId);
  h.end(first.runId);
  const question = await h.ask(sent[0]!.runId);
  await h.comment(sent[1]!.runId, 'It changes the plan');
  const request = RequestService.prototype.request;
  let raced = false;
  const hook = t.mock.method(RequestService.prototype, 'request', async function(this: unknown, input: { taskId: string },
    context: { purpose: string }) {
    if (context.purpose === 'return_continuation' && input.taskId === h.parent.id && !raced) {
      raced = true;
      await h.answer(h.childrenTasks[0]!.id, question, first.runId);
    }
    return request.call(this, input, context);
  });
  assert.deepEqual((await h.pass()).acceptedRequestIds, []);
  hook.mock.restore();
  const asked = () => h.rows(h.parent.id).find(item => item.outcome === 'question')!;
  assert.equal(asked().resolution, null, 'the refused admission rolled its clearing back with it');
  const woke = await h.pass();
  assert.equal(asked().resolution?.reason, 'question_closed');
  assert.deepEqual(woke.acceptedRequestIds.map(id => h.store.getRequest(id)?.taskId), [h.parent.id]);
  assert.deepEqual(h.rows(h.parent.id).filter(item => item.deliveries.length > 0).map(item => item.outcome), ['urgent']);
});

test('a pass yields to Task writes and puts off a busy delivery; an admission refusal is the user\'s turn until a Request to the seat carries it', async t => {
  const h = await fixture(t);
  const first = await h.human(); h.start(first.runId);
  const member = await h.agent(h.parent.id, h.worker, first.runId);
  h.start(member.runId); h.end(first.runId); h.end(member.runId);
  await assert.rejects(new ReturnRouter(h.root).pass(() => true, { project: h.project }),
    error => error instanceof Problem && error.code === 'busy');
  assert.equal(h.store.readReturns().length, 0);
  await assert.rejects(new ReturnRouter(h.root).pass(() => h.store.readReturns().length > 0, { project: h.project }),
    /yielded to a Task write/);
  assert.ok(h.store.readReturns().length > 0, 'a yield after the write keeps its reconciliation');
  assert.ok(h.store.readReturns().every(item => item.deliveries.length === 0), 'a yield before the wake reserves nothing');
  const original = RequestService.prototype.request;
  // A refusal that a later pass can get past puts the delivery off; any other holds it. A busy one comes last: the next
  // pass of changed projects (here, the forbidden one) tries again what it put off.
  const passing = [PROBLEM_CODE.conflict, PROBLEM_CODE.conversationBusy, PROBLEM_CODE.handoffPending, PROBLEM_CODE.busy];
  let mode: string = PROBLEM_CODE.forbidden, refused = 0, tried = 0;
  t.mock.method(RequestService.prototype, 'request', function(this: unknown, input: unknown, context: { purpose: string }) {
    if (context.purpose === 'return_continuation') tried++;
    if (context.purpose === 'return_continuation' && mode !== 'pass') {
      refused++;
      throw new Problem(mode as typeof PROBLEM_CODE.busy, 'injected delivery outcome');
    }
    return original.call(this, input, context);
  });
  let sent = member;
  const closing = () => h.row(sent.requestId)!;
  for (const code of passing) {
    mode = code;
    const before = refused;
    const put = await new ReturnRouter(h.root).pass(undefined, { project: h.project });
    assert.equal(refused, before + 1, `the delivery met the ${code} refusal`);
    assert.deepEqual([put.acceptedRequestIds, put.held], [[], []], `a ${code} delivery is not sent`);
    assert.equal(closing().holdReason, null, `a ${code} delivery is put off, not held`);
    assert.equal(closing().deliveries.length, 0, `a ${code} delivery reserves nothing`);
    // Once the seat takes it, the next pass sends what was put off, once.
    mode = 'pass';
    const retried = await new ReturnRouter(h.root).pass(undefined, { project: h.project });
    assert.equal(retried.acceptedRequestIds.length, 1, `what a ${code} put off is sent on the next pass`);
    assert.equal(closing().deliveries.at(-1)?.wakeRequestId, retried.acceptedRequestIds[0]);
    const tries = tried;
    assert.deepEqual((await new ReturnRouter(h.root).pass(undefined, { project: h.project })).acceptedRequestIds, [],
      `what a ${code} put off is sent once`);
    assert.equal(tried, tries, `what a ${code} put off is not tried again once sent`);
    // The woken seat sends its worker again, for the next refusal to meet.
    const wake = h.runOf(retried.acceptedRequestIds[0]!); h.start(wake);
    sent = await h.agent(h.parent.id, h.worker, wake);
    h.start(sent.runId); h.end(wake); h.end(sent.runId);
  }
  mode = PROBLEM_CODE.forbidden;
  const held = await new ReturnRouter(h.root).pass(undefined, 'changed');
  assert.ok(held.held.some(item => item.reason === 'forbidden'));
  assert.equal(closing().holdReason, 'forbidden');
  mode = 'pass';
  const again = await h.pass();
  assert.deepEqual(again.acceptedRequestIds, [], 'the held return is not sent again by itself');
  assert.ok(again.held.some(item => item.taskId === h.parent.id && item.reason === 'forbidden'));
  const turn = userTurn(await h.ball(h.parent.id));
  assert.deepEqual([turn?.reason, turn?.code], ['blocked', 'forbidden']);
  const resumed = await h.human();
  assert.deepEqual([closing().holdReason, closing().deliveries.at(-1)?.wakeRequestId], [null, resumed.requestId]);
});

test('a worker\'s end closes its Request as it ended, and wakes the idle seat once', async t => {
  for (const [state, outcome] of [['succeeded', 'succeeded'], ['failed', 'failed'], ['cancelled', 'stopped']] as const) {
    const h = await fixture(t);
    const first = await h.human(); h.start(first.runId);
    const member = await h.agent(h.parent.id, h.worker, first.runId);
    h.start(member.runId); h.end(first.runId); h.end(member.runId, state);
    assert.equal((await h.pass()).acceptedRequestIds.length, 1, state);
    assert.equal(h.row(member.requestId)?.outcome, outcome);
    assert.deepEqual((await h.pass()).acceptedRequestIds, [], state);
  }
});

test('a pass reads a placement release made between its state links and its reconciliation, at its one write point', async t => {
  const h = await fixture(t, { children: 1 });
  const first = await h.human(); h.start(first.runId);
  const child = h.childrenTasks[0]!, seat = h.childOwners[0]!;
  const sent = await h.agent(child.id, seat, first.runId);
  // Stopped before it started: the child stays todo, so its responsible may leave it.
  h.end(sent.runId, 'cancelled');
  const reconcile = ReturnLifecycle.prototype.reconcile;
  let released = false;
  const hook = t.mock.method(ReturnLifecycle.prototype, 'reconcile', function(this: unknown) {
    const db = currentControlConnection(h.root);
    if (db && !released) {
      released = true;
      assert.equal(db.isTransaction, true);
      const people = new PlacementStore(h.root, false, db);
      try { people.release(seat.id, seat.revision); } finally { people.close(); }
    }
    return reconcile.call(this);
  });
  await h.pass(); hook.mock.restore();
  assert.equal(released, true);
  assert.deepEqual(h.store.readReturns().filter(item => item.requestId === sent.requestId)
    .map(item => [item.outcome, item.toTaskId]), [['closed', h.parent.id]]);
  await h.pass();
  assert.equal(h.store.readReturns().filter(item => item.requestId === sent.requestId).length, 1);
  assert.equal((await h.current(child.id)).meta.state, 'todo');
});

test('a lifecycle over some Tasks sends a closing return to the requester its Request and Run name', async t => {
  const { h, child, reply } = await completedChild(t);
  const task = await h.current(child.id);
  const state = h.store.write(tx => new ReturnLifecycle(h.store.connection, tx, [task], h.project).reconcile());
  assert.equal(state.returns.find(item => item.requestId === reply.requestId)?.toTaskId, h.parent.id);
});

test('a failed reconciliation preserves committed state boundaries and a retry closes each Request once', async t => {
  const { h, reply } = await completedChild(t);
  const before = await h.current(h.parent.id);
  const reconcile = ReturnLifecycle.prototype.reconcile;
  let faults = 0;
  const hook = t.mock.method(ReturnLifecycle.prototype, 'reconcile', function(this: unknown) {
    if (faults++ === 0) throw new Error('injected reconcile fault');
    return reconcile.call(this);
  });
  await assert.rejects(h.pass(), /injected reconcile fault/);
  hook.mock.restore();
  const linked = await h.current(h.parent.id);
  assert.notEqual(linked.hash, before.hash, 'an independent committed Run boundary survives the later reconciliation fault');
  const boundaryIds = linked.meta.log.filter(log => log.id.startsWith('LSTART')).map(log => log.id);
  assert.equal(h.store.readReturns().filter(item => item.requestId === reply.requestId).length, 0);
  await h.pass();
  assert.equal((await h.current(h.parent.id)).meta.state, 'doing');
  assert.equal(h.store.readReturns().filter(item => item.requestId === reply.requestId).length, 1);
  assert.deepEqual((await h.current(h.parent.id)).meta.log.filter(log => log.id.startsWith('LSTART')).map(log => log.id), boundaryIds);
});

test('pending parent and child boundaries settle deepest first with the same result in either input order', async t => {
  const results = [];
  for (const parentFirst of [true, false]) {
    const h = await fixture(t, { children: 1 });
    const child = h.childrenTasks[0]!, first = await h.human(); h.start(first.runId);
    const sent = await h.agent(child.id, h.childOwners[0]!, first.runId); h.start(sent.runId);
    h.end(sent.runId, 'failed'); h.end(first.runId);
    const apply = TaskTransition.prototype.apply;
    let parentSawChildFinish = false;
    const hook = t.mock.method(TaskTransition.prototype, 'apply', function(this: TaskTransition,
      tx: Parameters<typeof apply>[0], change: Parameters<typeof apply>[1]) {
      if (change.taskId === h.parent.id && change.action === 'run_started') {
        assert.equal(new TaskRepository(h.root, tx.store.connection).get(child.id).meta.state, 'error',
          'the parent boundary reads the child failure already committed');
        parentSawChildFinish = true;
      }
      return apply.call(this, tx, change);
    });
    const ids = parentFirst ? [h.parent.id, child.id] : [child.id, h.parent.id];
    const routed = await new ReturnRouter(h.root).route({ tasks: new Set(ids), after: 0 as ChangeSeq,
      through: 7 as ChangeSeq, mode: 'changed' });
    hook.mock.restore();
    assert.equal(routed.completedThrough, 7);
    assert.equal(parentSawChildFinish, true);
    assert.equal((await h.current(child.id)).meta.state, 'error');
    assert.equal(h.row(sent.requestId)?.outcome, 'failed');
    assert.ok(h.cycles(h.parent.id)[0]?.closedAt, 'the child failure closes the parent waiting cycle');
    assert.equal(routed.acceptedRequestIds.length, 1, 'the idle parent receives the failed child result once');
    results.push({
      tasks: await Promise.all([h.parent.id, child.id].map(async id => {
        const task = await h.current(id);
        return { id, state: task.meta.state, transitions: task.meta.log.map(log =>
          ({ kind: log.kind, from: log.fromState, to: log.toState })) };
      })),
      closing: { outcome: h.row(sent.requestId)!.outcome, to: h.row(sent.requestId)!.toTaskId,
        deliveries: h.row(sent.requestId)!.deliveries.length },
      wakes: routed.acceptedRequestIds.map(id => h.store.getRequest(id)!.taskId),
    });
  }
  assert.deepEqual(results[0], results[1], 'Task history, closing result and delivered wake are independent of input order');
});

test('a failed seat boundary leaves the range incomplete while another seat settles and retry finishes it', async t => {
  const h = await fixture(t, { children: 2 });
  const [broken, healthy] = h.childrenTasks;
  const failed = await h.human(broken!.id), other = await h.human(healthy!.id);
  h.start(failed.runId); h.start(other.runId); h.end(failed.runId, 'failed'); h.end(other.runId, 'failed');
  const apply = TaskTransition.prototype.apply;
  const hook = t.mock.method(TaskTransition.prototype, 'apply', function(this: TaskTransition,
    tx: Parameters<typeof apply>[0], change: Parameters<typeof apply>[1]) {
    if (change.taskId === broken!.id && change.action === 'run_ended') throw new Error('injected seat boundary fault');
    return apply.call(this, tx, change);
  });
  const work = { tasks: new Set([broken!.id, healthy!.id]), after: 0 as ChangeSeq, through: 7 as ChangeSeq, mode: 'changed' as const };
  await assert.rejects(new ReturnRouter(h.root).route(work), /injected seat boundary fault/);
  hook.mock.restore();
  assert.equal((await h.current(healthy!.id)).meta.state, 'error', 'the other seat commits its failed Run result');
  const unfinished = await h.current(broken!.id);
  assert.equal(unfinished.meta.state, 'doing', 'the independent start survived the failed end transaction');
  assert.ok(!unfinished.meta.log.some(log => log.id === `LEND${failed.runId}`));
  const recovered = await new ReturnRouter(h.root).route(work);
  assert.equal(recovered.completedThrough, 7, 'only the recovered pass completes the range');
  assert.equal((await h.current(broken!.id)).meta.state, 'error');
});

test('state links reread a reassigned owner and its new Run and Request within one transaction', async t => {
  const h = await fixture(t);
  const first = await h.human(); h.start(first.runId); h.end(first.runId, 'failed');
  const control = new ControlStore(h.root);
  try { control.write(db => {
    const people = new PlacementStore(h.root, false, db);
    const store = new RunStore(h.root, { busyTimeoutMs: 1000 }, false, db);
    const links = () => store.write(runs => reconcileStateLinks({ store, runs }, h.project));
    try {
      assert.equal(links().tasks.find(task => task.id === h.parent.id)!.meta.state, 'error');
      const next = people.createAndReplaceResponsible({ taskId: h.parent.id, profileKey: 'fake',
        replacePlacementId: h.owner.id, expectedPlacementRevision: h.owner.revision }).placement;
      store.write(tx => {
        const run = createFixtureRun(store, tx, { ...fields(), task: h.parent.id, placementId: next.id,
          requestId: 'replacement-request' }, 'replacement');
        tx.update({ ...run, state: 'running', started_at: new Date(Date.now() + 10).toISOString() });
      });
      const snapshot = links();
      assert.equal(snapshot.tasks.find(task => task.id === h.parent.id)!.meta.state, 'doing');
      const state = store.write(tx => new ReturnLifecycle(db, tx, snapshot.tasks, h.project).reconcile());
      assert.ok(state.requests.some(request => request.id === 'replacement-request'));
      assert.ok(state.runs.some(run => run.placementId === next.id && run.state === 'running'));
    } finally { people.close(); store.close(); }
  }); } finally { control.close(); }
  assert.equal((await h.current(h.parent.id)).meta.state, 'doing');
});

for (const answered of [false, true]) test(`B: pending results go together ${answered ? 'after' : 'before'} a human answer while other Requests stay open`, async t => {
  const h = await fixture(t, { children: 3 });
  const waiting = h.childrenTasks[0]!;
  const first = await h.human(); h.start(first.runId);
  const sent: Receipt[] = [];
  for (const [i, child] of h.childrenTasks.entries()) sent.push(await h.agent(child.id, h.childOwners[i]!, first.runId));
  const work = await h.agent(h.parent.id, h.worker, first.runId);
  for (const item of [...sent, work]) h.start(item.runId);
  const question = await h.ask(sent[0]!.runId, 'user'); h.end(sent[0]!.runId);
  h.end(first.runId);
  assert.equal((await h.current(waiting.id)).meta.log.find(entry => entry.id === question)?.askedTo, null);
  assert.deepEqual((await h.pass()).acceptedRequestIds, [], 'a human question alone does not wake the parent');
  if (answered) await new TaskRequestService(h.root).request({ task: waiting.id, answers: question,
    body: 'Proceed', opId: randomUUID() }, { kind: 'human' }, { kind: 'human' });
  await h.report(sent[2]!.runId, 'done'); h.end(sent[2]!.runId);
  h.end(work.runId);
  const result = await h.pass();
  const parentWakes = result.acceptedRequestIds.filter(id => h.store.getRequest(id)?.taskId === h.parent.id);
  assert.equal(parentWakes.length, 1, 'both arrived results go in a single parent wake');
  const wake = parentWakes[0]!;
  for (const done of [sent[2]!, work]) assert.equal(h.row(done.requestId)?.deliveries[0]?.wakeRequestId, wake);
  assert.equal(h.row(sent[0]!.requestId), undefined, 'human wait is not a closing return');
  assert.equal(h.row(sent[1]!.requestId), undefined, 'running work is not a closing return');
  assert.equal(h.cycles(h.parent.id)[0]?.closedAt, null, 'partial delivery does not close the wait cycle');
  const { seatFactsOf, seatSourceOf } = await import('@alpacawork/backend/test-dist/control/wake.js');
  const tasks = await Promise.all([h.parent, ...h.childrenTasks].map(item => h.current(item.id)));
  const facts = seatFactsOf(seatSourceOf(tasks, h.store.snapshot(h.project),
    { profiles: new Set(['fake']), automaticLimit: 20 }), h.parent.id);
  assert.equal(facts.openRequests, 2, 'the exact true open Requests survive before and after the answer');
  const run = h.runOf(wake); h.start(run);
  await assert.rejects(h.report(run, 'done'), { code: PROBLEM_CODE.conflict, detail: { requests: 2 } }, 'the parent still cannot finish because true Requests remain open');
  assert.deepEqual((await h.pass()).acceptedRequestIds, [], 'repeated pass never reserves the same returns twice');
  assert.deepEqual([h.row(sent[2]!.requestId)?.deliveries.length, h.row(work.requestId)?.deliveries.length], [1, 1]);
});

for (const outcome of ['succeeded', 'failed', 'cancelled', 'not_delivered', 'uncertain'] as const)
  test(`B: delivery ${outcome} keeps its existing receipt policy while a child Request is open`, async t => {
    const h = await fixture(t, { children: 1 });
    const first = await h.human(); h.start(first.runId);
    const child = await h.agent(h.childrenTasks[0]!.id, h.childOwners[0]!, first.runId); h.start(child.runId);
    const work = await h.agent(h.parent.id, h.worker, first.runId); h.start(work.runId); h.end(work.runId);
    h.end(first.runId);
    const routed = await h.pass();
    assert.equal(routed.acceptedRequestIds.length, 1, 'an open child does not delay the worker result');
    const request = routed.acceptedRequestIds[0]!, run = h.runOf(request);
    if (outcome === 'not_delivered') h.store.write(tx => tx.abortRequest(tx.get(run)!, request));
    else {
      if (outcome === 'uncertain') {
        h.store.write(tx => tx.update({ ...tx.get(run)!, state: 'running', started_at: new Date().toISOString() }));
        const attempt = randomUUID();
        h.store.connection.prepare('INSERT INTO run_attempts(run_no,attempt_id,launch_json) VALUES (?,?,?)')
          .run(runNumber(run), attempt, '{}');
        h.store.connection.prepare(`INSERT INTO run_inputs(input_id,attempt_id,instruction_run_no,content_digest,state,initial)
          VALUES (?,?,?,?,'uncertain',1)`).run(randomUUID(), attempt, runNumber(run), 'a'.repeat(64));
        h.end(run);
      } else { h.start(run); h.end(run, outcome); }
    }
    const next = await h.pass(), row = h.row(work.requestId)!;
    assert.equal(h.row(child.requestId), undefined, 'the unfinished dependency never gains a closing return');
    assert.equal(h.cycles(h.parent.id)[0]?.closedAt, null);
    if (outcome === 'not_delivered') {
      assert.equal(row.deliveries[0]?.releaseReason, 'not_delivered');
      assert.equal(next.acceptedRequestIds.length, 1, 'a proven non-delivery may retry despite the open child');
      assert.equal(row.deliveries.length, 2);
      assert.equal(row.deliveries[1]?.wakeRequestId, next.acceptedRequestIds[0]);
    } else {
      assert.deepEqual(next.acceptedRequestIds, [], 'consumed, carried and unknown receipts never self-replay');
      assert.equal(row.deliveries.length, 1);
      if (outcome === 'succeeded') {
        assert.equal(returnDisposition(row), 'disposed');
        assert.ok(row.deliveries[0]?.receivedAt); assert.ok(row.deliveries[0]?.consumedAt);
      } else if (outcome === 'uncertain') {
        assert.equal(returnDisposition(row), 'in_flight');
        assert.equal(row.deliveries[0]?.receivedAt, null);
        assert.equal(row.deliveries[0]?.releasedAt, null);
        assert.equal(userTurn(await h.ball(h.parent.id))?.reason, 'unconfirmed');
      } else {
        assert.equal(returnDisposition(row), 'carried');
        assert.equal(row.deliveries[0]?.releaseReason, 'unsuccessful');
        const retry = await h.human();
        assert.equal(h.row(work.requestId)?.deliveries.at(-1)?.wakeRequestId, retry.requestId);
      }
    }
  });

for (const barrier of ['held', 'failed'] as const)
  test(`B: a ${barrier} seat keeps arrived results even with an open child`, async t => {
    const h = await fixture(t, { children: 1 });
    const first = await h.human(); h.start(first.runId);
    const child = await h.agent(h.childrenTasks[0]!.id, h.childOwners[0]!, first.runId); h.start(child.runId);
    const work = await h.agent(h.parent.id, h.worker, first.runId); h.start(work.runId); h.end(work.runId);
    if (barrier === 'held') await new TaskReportService(h.root).report({ task: h.parent.id, state: 'held', title: 'Hold',
      opId: randomUUID(), expectedTaskHash: (await h.current(h.parent.id)).hash }, { kind: 'human' }, { kind: 'human' });
    h.end(first.runId, barrier === 'failed' ? 'failed' : 'succeeded');
    for (let i = 0; i < 2; i++) assert.deepEqual((await h.pass()).acceptedRequestIds, []);
    assert.equal(returnDisposition(h.row(work.requestId)!), 'pending');
    assert.equal(h.row(work.requestId)?.deliveries.length, 0);
    assert.equal(h.row(child.requestId), undefined);
  });


test('a transaction seat captures Requests while head and execution-input facts stay current', async t => {
  const h = await fixture(t, { profile: 'steer' });
  const first = await h.human(), tasks = [await h.current(h.parent.id)];
  const settings = { profiles: new Set(['steer']), automaticLimit: 1 };
  h.store.write(tx => {
    const captured = seatSourceIn(tx, h.project, tasks, settings);
    assert.equal(seatFactsOf(captured, h.parent.id).head?.state, 'queued');
    tx.update({ ...tx.get(first.runId)!, state: 'running', started_at: new Date().toISOString() });
    assert.deepEqual(seatFactsOf(captured, h.parent.id).head, { state: 'running', intoState: null, inputOpen: true });
    const attempt = randomUUID();
    h.store.connection.prepare('INSERT INTO run_attempts(run_no,attempt_id,launch_json,diagnostic) VALUES (?,?,?,?)')
      .run(runNumber(first.runId), attempt, '{}', JSON.stringify({ message: 'current execution fault' }));
    assert.equal(seatFactsOf(captured, h.parent.id).head?.inputOpen, false, 'same source reads current execution diagnostic');
    h.store.connection.prepare('UPDATE run_attempts SET diagnostic=NULL WHERE attempt_id=?').run(attempt);
    assert.equal(seatFactsOf(captured, h.parent.id).head?.inputOpen, true);
    const input = randomUUID();
    h.store.connection.prepare(`INSERT INTO run_inputs(input_id,attempt_id,instruction_run_no,content_digest,state,initial)
      VALUES (?,?,?,?,'uncertain',1)`).run(input, attempt, runNumber(first.runId), 'a'.repeat(64));
    assert.deepEqual([...captured.uncertain(h.owner.id)], [first.runId]);
    assert.equal(seatFactsOf(captured, h.parent.id).head?.inputOpen, false);
    h.store.connection.prepare("UPDATE run_inputs SET state='resolved' WHERE input_id=?").run(input);
    assert.deepEqual([...captured.uncertain(h.owner.id)], []);
    assert.equal(seatFactsOf(captured, h.parent.id).head?.inputOpen, true);

    tx.insertRequest({ id: 'Q-current-automatic', taskId: h.parent.id, placementId: h.owner.id,
      placementRevision: h.owner.revision, taskHash: tasks[0]!.hash, waitCycleId: null, headRunId: first.runId,
      mode: 'continue', body: 'A fresh accepted continuation', purpose: 'return_continuation',
      author: { kind: 'placement', placementId: h.owner.id },
      submittedAt: new Date(Date.parse(tx.get(first.runId)!.created_at) + 1000).toISOString(), deliveryState: 'queued' });
    assert.equal(seatFactsOf(captured, h.parent.id).automaticLimitReached, false, 'old capture excludes a later SQL admission');
    const fresh = seatSourceIn(tx, h.project, tasks, settings);
    assert.equal(seatFactsOf(fresh, h.parent.id).automaticLimitReached, true, 'new source reads the current transaction');
    tx.updateRequest('Q-current-automatic', 'aborted');
    assert.equal(seatFactsOf(fresh, h.parent.id).automaticLimitReached, true, 'same capture survives later SQL abort');
    assert.equal(seatFactsOf(seatSourceIn(tx, h.project, tasks, settings), h.parent.id).automaticLimitReached, false,
      'next source reads the aborted state');
  });
});

test('receipts preserve joined, missing and not-sent evidence, and a page reads its wake inputs once', async t => {
  const h = await fixture(t, { profile: 'steer' });
  const first = await h.human(); h.start(first.runId);
  const second = await h.human();
  h.store.write(tx => tx.update({ ...tx.get(second.runId)!, state: 'joined', into: first.runId, ended_at: new Date().toISOString() }));
  const attempt = randomUUID(), input = randomUUID();
  h.store.connection.prepare('INSERT INTO run_attempts(run_no,attempt_id,launch_json) VALUES (?,?,?)')
    .run(runNumber(first.runId), attempt, '{}');
  h.store.connection.prepare(`INSERT INTO run_inputs(input_id,attempt_id,instruction_run_no,content_digest,state,initial)
    VALUES (?,?,?,?,'not_sent',0)`).run(input, attempt, runNumber(second.runId), 'a'.repeat(64));
  const records = h.store.read();
  const delivery = (wakeRequestId: string) =>
    ({ wakeRequestId, reservedAt: new Date().toISOString(), receivedAt: null, consumedAt: null, releasedAt: null, releaseReason: null });
  const receipt = (wakeRequestId: string) => returnReceipt(h.store.connection, records, delivery(wakeRequestId));
  const page = [first.requestId, second.requestId, 'missing-request', second.requestId].map(delivery);
  let reads = 0;
  const prepare = h.store.connection.prepare.bind(h.store.connection), counted = new WeakSet<object>();
  t.mock.method(h.store.connection, 'prepare', function(sql: string) {
    const statement = prepare(sql);
    if (sql.includes('SELECT r.request_id,i.state') && !counted.has(statement)) {
      counted.add(statement);
      const all = statement.all.bind(statement);
      t.mock.method(statement, 'all', (...args) => { reads++; return all(...args); });
    }
    return statement;
  });
  assert.equal(unknownReceipts(h.store.connection, []).size, 0);
  assert.equal(reads, 0);
  for (const state of ['not_sent', 'uncertain', 'taken'] as const) {
    h.store.connection.prepare('UPDATE run_inputs SET state=? WHERE input_id=?').run(state, input);
    assert.equal(receipt(first.requestId).received, true);
    assert.deepEqual(receipt('missing-request'), { received: false, unknown: false, actual: null });
    assert.equal(receipt(second.requestId).received, state === 'taken');
    assert.equal(receipt(second.requestId).unknown, state === 'uncertain');
    assert.equal(receipt(second.requestId).actual?.id, first.runId);
    reads = 0;
    assert.deepEqual([...unknownReceipts(h.store.connection, page)], state === 'uncertain' ? [second.requestId] : []);
    assert.equal(reads, 1, 'input query count does not grow with deliveries');
  }
});
