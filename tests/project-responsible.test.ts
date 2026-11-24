import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PlacementCommands } from '@alpacawork/backend/test-dist/control/placement-commands.js';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import { authorize, type Action } from '@alpacawork/backend/test-dist/control/authorize.js';
import { closureOf, returnFacts } from '@alpacawork/backend/test-dist/control/return-rules.js';
import { readTaskView } from '@alpacawork/backend/test-dist/control/task-views.js';
import { taskFlow, type Seat } from './task-flow.fixture.ts';
import { assignResponsible } from './helpers/control-fixture.ts';
import { readWorkspaceProjection } from './helpers/workspace-projection.ts';

type Flow = Awaited<ReturnType<typeof taskFlow>>;
const owner = (seat: Seat) => ({ kind: 'run', role: 'owner', responsible: true,
  taskId: seat.id, runId: seat.runId, placementId: seat.placementId } as const);
async function projectSeat(flow: Flow) {
  return { id: flow.project, placementId: (await assignResponsible(flow.root, await flow.get(flow.project), 'fake')).id };
}

test('an independent task stays active while the project finishes and its next instruction starts', async t => {
  // Both admissions, both starts and both reports can happen within one timestamp.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-24T11:00:00Z') });
  const flow = await taskFlow(t), seat = await projectSeat(flow);
  const independent = await flow.work(await flow.task('Independent assignment', { userRequested: true }));
  const first = await flow.work(seat), queued = await flow.request(seat);
  const before = await flow.get(seat.id);
  const request = flow.store(store => store.getRequest(flow.run(queued).requestId)!);
  const outcome = async () => {
    const task = await flow.get(seat.id);
    return closureOf(request, returnFacts([{ ...task.meta, responsible: true }], [flow.run(queued)]));
  };

  assert.equal(before.meta.baseState, 'doing');
  assert.equal((await flow.report(first, 'done')).task.baseState, 'done');
  assert.equal(await outcome(), null);
  assert.equal(await flow.state(independent.id), 'doing');
  flow.end(first);
  flow.start(queued);
  assert.equal(await flow.state(seat.id), 'doing');
  assert.equal(await outcome(), null);
  assert.equal((await flow.report(queued, 'done')).task.baseState, 'done');
  assert.equal((await outcome())?.outcome, 'succeeded');
  flow.end(queued);
  assert.equal(await flow.state(seat.id), 'done');
  const third = await flow.work(seat);
  await flow.person(seat.id, 'stopped');
  assert.equal(await flow.state(independent.id), 'doing');
  assert.equal(flow.run(third).stop_requested, true);
  assert.equal(flow.run(independent).stop_requested, false);
});

test('project work waits for its own request and receives the answer and result through the ordinary routes', async t => {
  const flow = await taskFlow(t), seat = await projectSeat(flow);
  const project = await flow.work(seat);
  const child = await flow.work(await flow.task('Count returned items'), project);
  await assert.rejects(flow.report(project, 'done'), { code: 'conflict' });
  const question = await flow.ask(child, project.id);
  await flow.answer(child.id, question, project);
  const resumedChild = await flow.receive(child);
  await flow.report(resumedChild, 'done');
  flow.end(resumedChild);

  const resumed = await flow.receive(project);
  const returns = flow.store(store => store.readReturns());
  assert.ok(returns.some(row => row.toTaskId === seat.id && row.outcome === 'succeeded' &&
    row.requestId === flow.run(child).requestId));
  assert.equal((await flow.report(resumed, 'done')).task.baseState, 'done');
  flow.end(resumed);
});

test('a question to a completed project reopens it and survives a hold until it can wake', async t => {
  const flow = await taskFlow(t), seat = await projectSeat(flow);
  const project = await flow.work(seat);
  await flow.report(project, 'done');
  flow.end(project);
  const child = await flow.work(await flow.task('Question after handoff', { userRequested: true }));
  const question = await flow.ask(child, project.id);
  assert.equal(await flow.state(project.id), 'doing');
  assert.deepEqual((await readTaskView(flow.root, project.id, {}, null)).incomingQuestions.map(each => each.id), [question]);
  await flow.person(project.id, 'held');
  const router = new ReturnRouter(flow.root);
  const paused = await router.pass(undefined, { project: project.id });
  assert.deepEqual(paused.acceptedRequestIds, []);
  assert.equal(await flow.state(child.id), 'doing');
  await flow.person(project.id, 'doing');

  const config = join(flow.root, 'config.yaml'), saved = readFileSync(config);
  writeFileSync(config, 'agents: {}\n');
  const gated = await router.pass(undefined, { project: project.id });
  assert.deepEqual(gated.held, [{ taskId: project.id, reason: 'no_profile' }]);
  const projection = await readWorkspaceProjection(flow.root);
  assert.equal(projection.view(project.id).row.ball?.holder, 'user');
  writeFileSync(config, saved);
  const revision = flow.store(store => store.getPlacement(seat.placementId)!.revision);
  const { placement } = await new PlacementCommands(flow.root).placeNewResponsible({
    taskId: seat.id, profileKey: 'fake', replacePlacementId: seat.placementId,
    expectedPlacementRevision: revision, expectedTaskHash: (await flow.get(seat.id)).hash,
  }, { kind: 'human' });

  const dispatched = await router.pass(undefined, { project: project.id });
  const request = flow.store(store => dispatched.acceptedRequestIds.map(id => store.getRequest(id)!)
    .find(each => each.taskId === project.id));
  assert.ok(request?.runId);
  const resumed = { ...project, placementId: placement.id, runId: request.runId };
  flow.start(resumed);
  await flow.answer(child.id, question, resumed);
  assert.equal((await readTaskView(flow.root, project.id, {}, null)).incomingQuestions.length, 0);
});

test('a project seat can manage its own top-level tasks without gaining rights in a nested project', async t => {
  const flow = await taskFlow(t), seat = await projectSeat(flow), active = await flow.work(seat);
  const nested = (await flow.commands.create({ kind: 'project', color: '#39659b', parentId: seat.id,
    userRequested: null, tasks: [{ title: 'Nested project' }] })).tasks[0]!;
  const child = await flow.task('Internal task');
  const decide = (id: string, action: Action) => flow.store(store => authorize(store.connection, owner(active), action, { task: id, quote: null }));
  assert.doesNotThrow(() => decide(seat.id, { name: 'task.new', kind: 'task', userRequested: false }));
  for (const action of [{ name: 'run.stop' }, { name: 'agent.handover' }, { name: 'task.request', worker: false }] as const) {
    assert.doesNotThrow(() => decide(child.id, action));
    assert.throws(() => decide(nested.id, action), { code: 'forbidden' });
  }

  const nestedPlacement = await assignResponsible(flow.root, await flow.get(nested.id), 'fake');
  const nestedOwner = await flow.work({ id: nested.id, placementId: nestedPlacement.id });
  const readAbove = (action: Action) => flow.store(store =>
    authorize(store.connection, owner(nestedOwner), action, { task: seat.id, quote: null }));
  assert.doesNotThrow(() => readAbove({ name: 'task.read' }));
  assert.throws(() => readAbove({ name: 'task.read.work' }), { code: 'forbidden' });
});

test('a project uses the ordinary rows and question detail when the user needs to act', async t => {
  const flow = await taskFlow(t), seat = await projectSeat(flow);
  const run = await flow.work(seat);
  const question = randomUUID();
  await new TaskReportService(flow.root).report({ task: seat.id, state: 'waiting', askTo: 'user', title: 'Publish the catalog',
    description: 'Choose the publication time', values: { decide: [{ decide_question: 'Which date?' }] },
    expectedTaskHash: (await flow.get(seat.id)).hash, opId: question }, { kind: 'placement', placementId: seat.placementId }, owner(run));
  const projection = await readWorkspaceProjection(flow.root);
  assert.equal(projection.view(seat.id).row.state, 'doing');
  assert.deepEqual(projection.view(seat.id).userQuestions?.map(each => each.id), [question]);
  await flow.answer(seat.id, question);
  assert.equal((await readTaskView(flow.root, seat.id, {}, null)).questions.length, 0);
});

test('a shared failure returns to the project while the user decides how to retry', async t => {
  const flow = await taskFlow(t), project = await flow.work(await projectSeat(flow));
  const child = await flow.task('Reconcile shipment');
  const failed = await flow.work(child, project);
  await flow.request(child);
  flow.end(failed, 'failed');

  const projection = await readWorkspaceProjection(flow.root);
  assert.equal(projection.view(child.id).row.ball?.holder, 'user');
  await assert.rejects(flow.request(child, project), { code: 'forbidden' });
  const resumed = await flow.receive(project);
  assert.ok(flow.store(store => store.readReturns()).some(row => row.requestId === flow.run(failed).requestId &&
    row.outcome === 'failed' && row.toTaskId === resumed.id));
  const retry = await flow.request(child);
  assert.equal(flow.run(retry).state, 'queued');
});
