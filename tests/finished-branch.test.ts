/**
 * What keeps a Task from finishing (state-rules finishBlocked) and the finished-branch rule: nothing unfinished is ever
 * below a finished (done or stopped) Task. The pure rules are state-rules.test.ts's and contract's; this drives them
 * through the services as the server does.
 */
import { taskFlow } from './task-flow.fixture.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const below = (id: string, ids: string[]) => ({ code: 'finished_branch',
  message: `Unfinished Tasks below ${id} (${ids.join(', ')}): make them done or stopped first`, detail: { tasks: ids } });
const above = (id: string, state: string) => ({ code: 'finished_branch',
  message: `${id} is ${state}: nothing unfinished goes below a finished Task`, detail: { task: id } });

test('a Task finishes only with nothing unfinished below it, a failed child too, and says which Tasks', async t => {
  const f = await taskFlow(t);
  const parent = await f.task('Parent');
  let own = await f.work(parent);
  const child = await f.task('Child', { parentId: parent.id });
  const grandchild = await f.plan('Grandchild', { parentId: child.id });
  const before = await f.get(parent.id);
  await assert.rejects(f.report(own, 'done'), below(parent.id, [child.id, grandchild]));
  assert.equal((await f.get(parent.id)).hash, before.hash, 'the refusal writes nothing');
  // A failed child is unfinished: its parent retries it to done or stops it first.
  const work = await f.work(child, own);
  f.end(work, 'failed');
  assert.equal(await f.state(child.id), 'error');
  own = await f.receive(own);
  await assert.rejects(f.report(own, 'done'), below(parent.id, [child.id, grandchild]));
  await f.person(child.id, 'stopped');
  await f.report(own, 'done');
  assert.equal(await f.state(parent.id), 'done');
});

test('an open question, an open Request, a Run below and a return not taken each keep a Task from finishing', async t => {
  const f = await taskFlow(t);
  const parent = await f.task('Parent');
  let own = await f.work(parent);
  const child = await f.task('Child', { parentId: parent.id });
  const work = await f.work(child, own);
  const question = await f.ask(work, parent.id);
  await assert.rejects(f.report(own, 'done'), { code: 'conflict', detail: { questions: [question] } });
  await f.withdraw(work, question);
  // Its child's Request has not closed.
  await assert.rejects(f.report(own, 'done'), { code: 'conflict', detail: { requests: 1 } });
  // Its result is closed but not received; this precedes the other unfinished Run blocker.
  f.start(work);
  await f.report(work, 'done');
  await assert.rejects(f.report(own, 'done'), { code: 'conflict', detail: { returns: 1 } });
  // Taking the real result removes only the receipt blocker; the child's Run still prevents completion.
  own = await f.receive(own);
  await assert.rejects(f.report(own, 'done'), { code: 'handoff_pending', detail: { runs: [work.runId] } });
  f.end(work);
  await f.report(own, 'done');
  assert.equal(await f.state(parent.id), 'done');
});

test('a finished branch takes no new work: a creation, a move or a restore below it is refused', async t => {
  const f = await taskFlow(t);
  const closed = await f.task('Closed');
  await f.report(await f.work(closed), 'done');
  await assert.rejects(f.plan('Late', { parentId: closed.id }), above(closed.id, 'done'));
  const open = await f.task('Open');
  await assert.rejects(f.commands.move({ id: open.id, parentId: closed.id, expectedTaskHash: (await f.get(open.id)).hash }),
    above(closed.id, 'done'));
  // Finished work may go below it.
  await f.report(await f.work(open), 'done');
  await f.commands.move({ id: open.id, parentId: closed.id, expectedTaskHash: (await f.get(open.id)).hash });
  assert.equal((await f.get(open.id)).meta.parentId, closed.id);
  // An archived Task is outside the rule; restored below a finished parent, it is back in it.
  const parent = await f.task('Parent');
  const own = await f.work(parent);
  const shelved = await f.plan('Shelved', { parentId: parent.id });
  await f.commands.lifecycle({ id: shelved, action: 'archive', expectedTaskHash: (await f.get(shelved)).hash });
  await f.report(own, 'done');
  await assert.rejects(f.commands.lifecycle({ id: shelved, action: 'restore', expectedTaskHash: (await f.get(shelved)).hash }),
    above(parent.id, 'done'));
  assert.equal((await f.get(shelved)).meta.lifecycle, 'archived');
});
