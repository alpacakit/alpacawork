/** One request of the user through the real CLI, HTTP, a Run and the screen's projection, from its project to done. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { cli, coordinator, http, setup, until } from './harness.ts';

test('a user request made in a new project awaits review on the screen until the coordinator confirms it', async t => {
  const h = await setup(t, 1);
  const app = await h.server();
  const check = (result: Awaited<ReturnType<typeof cli>>) => {
    assert.equal(result.code, 0, result.stderr || result.stdout); return result.body;
  };
  const live = async () => (await http(app.url, 'workspace/live')).body;
  // A person makes the project, nested in the fixture's.
  const project = check(await cli(h.root, 'task new', { kind: 'project', color: '#39659b', title: 'Release', parent: h.project })).task;
  assert.deepEqual([project.kind, project.parentId], ['project', h.project]);
  // The coordinator makes what the user asked for a Task of the project, quoting the user's words, places its
  // responsible and asks it to work.
  const asked = 'Write release instructions';

  const created = check(await cli(h.root, 'task new', { title: 'Release notes', parent: project.id, 'from-user': '',
    quote: asked }, coordinator)).task;
  assert.deepEqual([created.kind, created.parentId, created.userRequested, created.state],
    ['task', project.id, true, 'todo']);
  const assigned = check(await cli(h.root, 'agent assign', { task: created.id, role: 'responsible', profile: 'reporter',
    'expected-task-hash': created.hash }, coordinator));
  const placement = assigned.agent.placement;
  const instruction = h.gate('instruction.md'); writeFileSync(instruction, 'Write the release notes');
  const work = check(await cli(h.root, 'task request', { task: created.id, 'instruction-file': instruction,
    'expected-task-hash': assigned.task.hash, 'expected-placement-revision': String(placement.revision) }, coordinator))
    .outcome.request.runId;
  // The responsible reports done through the CLI with its Run's credential: the user's request awaits their review.
  await h.waitState(work, 'succeeded');
  // Run completion is imported before its end is linked to the Task. The review snapshot must include
  // that link: otherwise the pending reconciliation can invalidate its hash before confirmation.
  const review = await until(async () => {
    const view = check(await cli(h.root, 'task get', { task: created.id, log: '1' }));
    const end = view.task.log[0];
    return end?.runId === work && end.stage?.boundary === 'settled_end' && view;
  }, `${work}'s end is linked to its Task`);
  assert.deepEqual([review.task.state, review.task.projectId, review.reviewRun], ['waiting', project.id, work]);
  // The screen lists it as its project's row awaiting the user's review.
  const listed = await until(async () => {
    const index = await live();
    return index.home.some((row: { taskId: string; section: string }) => row.taskId === created.id && row.section === 'review')
      && index;
  }, 'the request is listed for review');
  assert.deepEqual(listed.home.find((row: { taskId: string }) => row.taskId === created.id), { taskId: created.id,
    section: 'review', summary: { done: 0, total: 0 } });
  assert.equal(listed.tasks.find((row: { id: string }) => row.id === created.id).projectId, project.id);
  assert.equal(listed.counts.home[project.id].review, 1);
  // The user says it is done; the coordinator confirms the Run under review, quoting them.
  const approval = 'Mark the release instructions complete';

  const ready = check(await cli(h.root, 'task get', { task: created.id }));
  assert.equal(ready.reviewRun, review.reviewRun); assert.equal(ready.task.state, 'waiting');
  const confirmed = check(await cli(h.root, 'task report', { task: created.id, state: 'done',
    'about-run': ready.reviewRun, 'expected-task-hash': ready.task.hash,
    'expected-placement-revision': String(placement.revision), quote: approval }, coordinator));
  assert.equal(confirmed.task.state, 'done');
  // The screen moves it from the home list to its project's finished Tasks.
  await until(async () => {
    const index = await live();
    return !index.home.some((row: { taskId: string }) => row.taskId === created.id) &&
      index.counts.closed[project.id]?.finished === 1;
  }, 'the confirmed request is listed with the finished Tasks');
  h.integrity();
});
