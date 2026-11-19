/** The common Task-management grants must be reachable with the CLI's optional quote record, including placement and stop. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { assignResponsible } from './helpers/control-fixture.ts';
import { call, callerWorkspace, codexConversation, run } from './coordinator-caller.fixture.ts';

const human = { kind: 'human' } as const;
const conversation = 'task-management';
const coordinator = codexConversation(conversation);
const policy = 'Manage Tasks and their placements';

async function nested(w: ReturnType<typeof callerWorkspace>) {
  const commands = new ControlTaskCommands(w.root, human), tasks = new ControlTaskStore(w.root);
  await commands.update({ id: w.project, values: { project_policy: policy }, expectedTaskHash: (await tasks.get(w.project)).hash });
  const parent = (await commands.create({ parentId: w.project, userRequested: false, tasks: [{ title: 'Parent' }] })).tasks[0]!;
  await assignResponsible(w.root, parent, 'codex');
  const child = (await commands.create({ parentId: parent.id, userRequested: false, tasks: [{ title: 'Managed child' }] })).tasks[0]!;
  return { parent, child };
}

test('a policy quote reaches Task edits, records, lifecycle and all placement management over the real CLI', async t => {
  const w = callerWorkspace(t), { child } = await nested(w), url = await w.start();

  const get = () => call(url, ['task', 'get', '--task', child.id, '--log', '100']);
  const manage = async (group: string, verb: string, args: string[]) => call(url,
    [group, verb, '--task', child.id, ...args, '--expected-task-hash', (await get()).task.hash, '--quote', policy], coordinator);
  const unquoted = await call(url, ['task', 'update', '--task', child.id, '--title', 'Unquoted',
    '--expected-task-hash', (await get()).task.hash], coordinator);
  assert.equal(unquoted.task.title, 'Unquoted');
  await manage('task', 'update', ['--title', 'Managed title']);
  await manage('task', 'update', ['--values-file', w.file('values.json', '{"notes":"Managed notes"}')]);
  await manage('task', 'comment', ['--title', 'Management record']);
  await manage('task', 'archive', []);
  assert.equal((await get()).task.lifecycle, 'archived');
  await manage('task', 'restore', []);
  assert.equal((await get()).task.lifecycle, 'active');
  await manage('agent', 'assign', ['--role', 'responsible', '--profile', 'codex']);
  let shown = await get();
  let responsible = shown.agents.find((each: { active: boolean; responsible: boolean }) => each.active && each.responsible);
  await manage('agent', 'assign', ['--role', 'member', '--profile', 'codex',
    '--expected-responsible-revision', String(responsible.revision)]);
  shown = await get();
  const member = shown.agents.find((each: { active: boolean; responsible: boolean }) => each.active && !each.responsible);
  await manage('agent', 'handover', ['--agent', member.id, '--expected-placement-revision', String(member.revision)]);
  shown = await get();
  responsible = shown.agents.find((each: { active: boolean; responsible: boolean }) => each.active && each.responsible);
  await manage('agent', 'assign', ['--role', 'member', '--profile', 'codex',
    '--expected-responsible-revision', String(responsible.revision)]);
  shown = await get();
  const released = shown.agents.find((each: { active: boolean; responsible: boolean }) => each.active && !each.responsible);
  await manage('agent', 'release', ['--agent', released.id, '--expected-placement-revision', String(released.revision),
    '--expected-responsible-revision', String(responsible.revision)]);
  await manage('agent', 'release', ['--agent', responsible.id, '--expected-placement-revision', String(responsible.revision)]);
  shown = await get();
  const managed = shown.task.log.filter((entry: { actor: { kind: string } }) => entry.actor.kind === 'main');
  assert.equal(managed.length, 12, 'each managed operation leaves its own audit record');
  assert.equal(managed[0].actor.quote, undefined);
  for (const entry of managed.slice(1)) {
    assert.equal(entry.actor.conversationId, conversation);
    assert.equal(entry.actor.quote, policy);
  }
  assert.equal(shown.task.title, 'Managed title');
  assert.deepEqual(shown.task.values, { notes: 'Managed notes' });
});

test('project creation, code location, project policy and deletion need no verified utterance', async t => {
  const w = callerWorkspace(t), { child } = await nested(w), url = await w.start();
  const created = await call(url, ['task', 'new', '--kind', 'project', '--color', '#39659b', '--parent', w.project, '--title', 'New project'], coordinator);
  assert.equal(created.task.kind, 'project');
  let project = (await call(url, ['task', 'get', '--task', w.project])).task;
  await call(url, ['task', 'update', '--task', w.project, '--cwd', w.root, '--expected-task-hash', project.hash], coordinator);
  project = (await call(url, ['task', 'get', '--task', w.project])).task;
  await call(url, ['task', 'update', '--task', w.project, '--values-file', w.file('policy.json', '{"project_policy":"New policy"}'),
    '--expected-task-hash', project.hash, '--quote', 'Not present in a policy or utterance'], coordinator);
  const current = (await call(url, ['task', 'get', '--task', child.id])).task;
  const deleted = await call(url, ['task', 'delete', '--task', child.id, '--expected-task-hash', current.hash], coordinator);
  assert.equal(deleted.task.lifecycle, 'deleted');
  const restored = await call(url, ['task', 'restore', '--task', child.id, '--expected-task-hash', deleted.task.hash], coordinator);
  assert.equal(restored.task.lifecycle, 'active');
});

test('a quoted Run stop reaches the common grant and records the coordinator without changing its identity', async t => {
  const w = callerWorkspace(t), { child } = await nested(w);
  const placement = await assignResponsible(w.root, child, 'codex');
  const held = w.heldRun({ task: child.id, placementId: placement.id, running: false });
  const url = await w.start();

  const result = await call(url, ['run', 'stop', '--run', held.id, '--quote', policy], coordinator);
  assert.ok(result.cancelled.includes(held.id));
  const shown = await call(url, ['task', 'get', '--task', child.id, '--log', '100']);
  const stop = shown.task.log.find((entry: { kind: string }) => entry.kind === 'run_stop_requested');
  assert.equal(stop.actor.kind, 'main');
  assert.equal(stop.actor.conversationId, conversation);
  assert.equal(stop.actor.quote, policy);
  assert.deepEqual(stop.runIds, [held.id]);
});
