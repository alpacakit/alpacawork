/**
 * The ancestors a change below sends back to doing, as TaskTransition writes them: a finished ancestor when
 * work below starts again, and a review, or a review the user held, when anything below changes. The pure rule is
 * state-rules.test.ts's (reopenTargets); this drives it through the services and the store as the server does.
 */
import { taskFlow, type Responsible } from './task-flow.fixture.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PlacementCommands } from '@alpacawork/backend/test-dist/control/placement-commands.js';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';

const human = { kind: 'human' } as const;

/** Grandparent → parent → child, each with its responsible, stopped from the top by the user. */
async function stoppedBranch(t: Parameters<typeof taskFlow>[0]) {
  const f = await taskFlow(t);
  const grandparent = await f.task('Grandparent');
  const parent = await f.task('Parent', { parentId: grandparent.id });
  const child = await f.task('Child', { parentId: parent.id });
  await f.person(grandparent.id, 'stopped');
  assert.deepEqual([await f.state(grandparent.id), await f.state(parent.id), await f.state(child.id)],
    ['stopped', 'stopped', 'stopped']);
  /** A person asks Task `to` to work again, at the versions shown. */
  const ask = async (to: Responsible, opId: string, expectedTaskHash?: string) =>
    new TaskRequestService(f.root).request({ task: to.id, body: 'Restart', opId,
      expectedTaskHash: expectedTaskHash ?? (await f.get(to.id)).hash,
      expectedPlacementRevision: f.store(runs => runs.getPlacement(to.placementId)!.revision) }, human, human);
  return { f, grandparent, parent, child, ask };
}

test('a stopped child asked again stays stopped until its Run starts, which sends its finished ancestors back to doing', async t => {
  const { f, grandparent, parent, child, ask } = await stoppedBranch(t);
  const before = await f.get(parent.id);
  const accepted = await ask(child, 'restart');
  assert.equal(accepted.task.state, 'stopped');
  const record = (await f.get(child.id)).meta.log.at(-1);
  assert.deepEqual([record?.kind, record?.fromState, record?.toState],
    ['request_accepted', 'stopped', null]);
  assert.equal((await f.get(parent.id)).hash, before.hash, 'an instruction alone sends nothing back');
  f.start({ ...child, runId: accepted.outcome.request.runId });
  assert.equal(await f.state(child.id), 'doing');
  for (const id of [parent.id, grandparent.id]) {
    const back = (await f.get(id)).meta.log.at(-1)!;
    assert.deepEqual([back.kind, back.fromState, back.toState, back.title, back.actor],
      ['linked', 'stopped', 'doing', null, { kind: 'placement', placementId: child.placementId }], id);
  }
  assert.equal(await f.state(f.project), 'todo', 'the climb stops at the project');
});

test('a review goes back to doing when work below it changes, and so does a review the user held', async t => {
  const f = await taskFlow(t);
  /** What the user asked for, finished by its responsible with a finished child, awaiting the user's review. */
  const review = async (title: string) => {
    const top = await f.task(title, { userRequested: true });
    let own = await f.work(top);
    const child = await f.task(`${title} child`, { parentId: top.id });
    const work = await f.work(child, own);
    await f.report(work, 'done');
    f.end(work);
    own = await f.receive(own);
    await f.report(own, 'done');
    f.end(own);
    assert.equal(await f.state(top.id), 'waiting');
    return { top, child };
  };
  const plain = await review('Plain'), held = await review('Held');
  await f.person(held.top.id, 'held');
  // The review's finished child is asked again: its Run's start sends the review back, so no stale result is confirmed.
  await f.work(plain.child);
  assert.equal(await f.state(plain.child.id), 'doing');
  const reopened = (await f.get(plain.top.id)).meta.log.at(-1)!;
  assert.deepEqual([reopened.kind, reopened.fromState, reopened.toState], ['linked', 'waiting', 'doing']);
  // Work added below the held review sends it back too, and its hold with it.
  await f.plan('Added', { parentId: held.top.id });
  const unheld = (await f.get(held.top.id)).meta.log.at(-1)!;
  assert.deepEqual([unheld.kind, unheld.fromState, unheld.toState], ['linked', 'held', 'doing']);
});

test('a move sends back the reviews on its new path and on the path it left', async t => {
  const f = await taskFlow(t);
  const review = async (title: string) => {
    const top = await f.task(title, { userRequested: true });
    let own = await f.work(top);
    const child = await f.task(`${title} child`, { parentId: top.id });
    const work = await f.work(child, own);
    await f.report(work, 'done');
    f.end(work);
    own = await f.receive(own);
    await f.report(own, 'done');
    return { top, child };
  };
  const from = await review('From'), to = await review('To');
  await f.commands.move({ id: from.child.id, parentId: to.top.id, expectedTaskHash: (await f.get(from.child.id)).hash });
  assert.deepEqual([await f.state(from.top.id), await f.state(to.top.id)], ['doing', 'doing']);
  assert.equal(await f.state(from.child.id), 'done', 'the moved Task keeps its state');
});

test('a rejected instruction leaves the Task and its finished ancestors as they were', async t => {
  const { f, parent, child, ask } = await stoppedBranch(t);
  const before = [await f.get(child.id), await f.get(parent.id)];
  await assert.rejects(ask(child, 'stale', 'a'.repeat(64)), { code: 'conflict' });
  assert.deepEqual([(await f.get(child.id)).hash, (await f.get(parent.id)).hash], before.map(task => task.hash));
  assert.equal(f.store(runs => runs.getRequest('stale')), null);
});

test('a failed Request insertion leaves the Task and its finished ancestors as they were', async t => {
  const { f, parent, child, ask } = await stoppedBranch(t);
  const before = [await f.get(child.id), await f.get(parent.id)];
  const db = new DatabaseSync(join(f.root, '.alpacawork', 'alpacawork.sqlite'));
  db.exec("CREATE TRIGGER fail_request BEFORE INSERT ON requests BEGIN SELECT RAISE(ABORT, 'injected request failure'); END");
  try { await assert.rejects(ask(child, 'failed-target'), /injected request failure/); }
  finally { db.close(); }
  assert.deepEqual([(await f.get(child.id)).hash, (await f.get(parent.id)).hash], before.map(task => task.hash));
  assert.equal(f.store(runs => runs.getRequest('failed-target')), null);
});

test('a member\'s Run is no boundary of its Task: it sends nothing back', async t => {
  const f = await taskFlow(t);
  const parent = await f.task('Parent');
  const child = await f.task('Child', { parentId: parent.id });
  const own = await f.work(child);
  const member = (await new PlacementCommands(f.root).placeMember({ taskId: child.id, profileKey: 'fake',
    expectedTaskHash: (await f.get(child.id)).hash,
    expectedResponsibleRevision: f.store(runs => runs.getPlacement(child.placementId)!.revision) }, human)).placement;
  const instructed = await new TaskRequestService(f.root).request({ task: child.id, agent: member.id, body: 'Inspect',
    opId: randomUUID(), expectedTaskHash: (await f.get(child.id)).hash, expectedPlacementRevision: member.revision },
  { kind: 'placement', placementId: own.placementId },
  { kind: 'run', runId: own.runId, placementId: own.placementId, taskId: child.id, role: 'owner', responsible: true });
  assert.equal(instructed.task.state, 'doing');
  assert.equal((await f.get(child.id)).meta.log.at(-1)?.toState, null);
  f.start({ id: child.id, placementId: member.id, runId: instructed.outcome.request.runId });
  assert.deepEqual([await f.state(child.id), await f.state(parent.id)], ['doing', 'todo']);
});
