import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { callerWorkspace, post, codexConversation, until } from './coordinator-caller.fixture.ts';
import { run } from './helpers/cli-session.ts';
import { assignResponsible } from './helpers/control-fixture.ts';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';

/** A Task's newest record, as `task get` shows it; a write's receipt carries no History. */
async function lastRecord(url: string, id: string) {
  const result = await run(url, ['task', 'get', '--task', id, '--log', '1']);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout).task.log.at(-1);
}

test('the parent owner moves direct children inside its subtree via CLI and HTTP; other seats and outside targets stay refused', { timeout: 30000 }, async t => {
  const w = callerWorkspace(t);
  const commands = new ControlTaskCommands(w.root, { kind: 'human' });
  const make = async (title: string, parentId: string) => (await commands.create({ parentId, userRequested: false, tasks: [{ title }] })).tasks[0];
  const parent = await make('Parent', w.project);
  const owner = await assignResponsible(w.root, parent, 'codex');
  const destination = await make('Inside destination', parent.id);
  await assignResponsible(w.root, destination, 'codex');
  const outside = await make('Outside destination', w.project);
  await assignResponsible(w.root, outside, 'codex');
  const first = await make('Moving via CLI', parent.id);
  const second = await make('Moving via HTTP', parent.id);
  const childOwner = await assignResponsible(w.root, first, 'codex');
  const people = new PlacementStore(w.root);
  const worker = people.createAndPlace({ taskId: parent.id, profileKey: 'codex', responsible: false }).placement;
  people.close();
  const ownerRun = w.heldRun({ task: parent.id, placementId: owner.id });
  const memberRun = w.heldRun({ task: parent.id, placementId: worker.id, role: 'worker' });
  const ownRun = w.heldRun({ task: first.id, placementId: childOwner.id });
  const url = await w.start();
  const read = async (id: string) => {
    const result = await run(url, ['task', 'get', '--task', id]);
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout).task;
  };
  const move = async (id: string, to: string, env: NodeJS.ProcessEnv = {}) => {
    const before = await read(id);
    return run(url, ['task', 'move', '--task', id, '--parent', to, '--expected-task-hash', before.hash], env);
  };
  const coordinator = codexConversation(randomUUID());
  await until(async () => (await read(first.id)).state === 'doing' && (await read(parent.id)).state === 'doing',
    'serve applies the held Runs starts before comparing Task hashes');

  for (const [label, to, env] of [
    ['owner outside', outside.id, ownerRun.env],
    ['member inside', destination.id, memberRun.env],
    ['member outside', outside.id, memberRun.env],
    ['child owner itself', destination.id, ownRun.env],
  ] as const) {
    const before = await read(first.id);
    const denied = await move(first.id, to, env);
    assert.equal(denied.code, 2, label + ': ' + denied.stderr);
    assert.equal(JSON.parse(denied.stderr).error.code, 'forbidden', label);
    assert.equal((await read(first.id)).hash, before.hash, label + ' does not mutate');
  }
  const before = await read(first.id);
  const allowed = await move(first.id, destination.id, ownerRun.env);
  assert.equal(allowed.code, 0, allowed.stderr);
  const moved = JSON.parse(allowed.stdout).task;
  assert.deepEqual([moved.id, moved.path, moved.parentId], [first.id, first.path, destination.id]);
  assert.deepEqual((await lastRecord(url, first.id)).actor, { kind: 'placement', placementId: owner.id });
  const httpBefore = await read(second.id);
  const result = await post(url, '/api/commands/task/move', { task: second.id, parent: destination.id, expectedTaskHash: httpBefore.hash },
    { authorization: `Alpacawork-Run ${ownerRun.id}:${ownerRun.env.ALPACAWORK_RUN_TOKEN}` });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.task.parentId, destination.id);
  const stale = await run(url, ['task', 'move', '--task', first.id, '--parent', parent.id, '--expected-task-hash', before.hash]);
  assert.equal(JSON.parse(stale.stderr).error.code, 'conflict');
  const human = await move(first.id, outside.id);
  assert.equal(human.code, 0, human.stderr);
  assert.equal(JSON.parse(human.stdout).task.parentId, outside.id);
  const former = await move(second.id, parent.id, ownerRun.env);
  assert.equal(JSON.parse(former.stderr).error.code, 'forbidden');
});

test('a coordinator moves across owner subtrees only with verified user words; CLI and HTTP keep tree, version, claims and audit checks', { timeout: 30000 }, async t => {
  const w = callerWorkspace(t);
  const commands = new ControlTaskCommands(w.root, { kind: 'human' });
  const make = async (title: string, parentId: string) => (await commands.create({ parentId, userRequested: false, tasks: [{ title }] })).tasks[0];
  const parent = await make('Old parent', w.project);
  await assignResponsible(w.root, parent, 'codex');
  const destination = await make('New parent', w.project);
  await assignResponsible(w.root, destination, 'codex');
  const first = await make('CLI child', parent.id), second = await make('HTTP child', parent.id);
  const foreignProject = (await commands.create({ kind: 'project', color: '#39659b', parentId: null, userRequested: null, tasks: [{ title: 'Foreign' }] })).tasks[0];
  const uncovered = await make('Uncovered parent', w.project);
  const url = await w.start(), conversation = randomUUID(), env = codexConversation(conversation);
  const words = 'Move the tasks to the requested parents';
  const get = async (id: string) => {
    const r = await run(url, ['task', 'get', '--task', id]);
    assert.equal(r.code, 0, r.stderr);
    return JSON.parse(r.stdout).task;
  };
  const attempt = async (id: string, to: string, quote?: string, hash?: string, opId = randomUUID(), caller = env) =>
    run(url, ['task', 'move', '--task', id, '--parent', to, '--expected-task-hash', hash ?? (await get(id)).hash,
      '--op-id', opId, ...(quote === undefined ? [] : ['--quote', quote])], caller);
  const denied = async (id: string, to: string, quote: string | undefined, code: string, hash?: string) => {
    const before = await get(id), result = await attempt(id, to, quote, hash);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(JSON.parse(result.stderr).error.code, code, result.stderr);
    assert.equal((await get(id)).hash, before.hash, 'refusal does not change Task');
  };

  await denied(first.id, destination.id, words, 'conflict', '0'.repeat(64));
  await denied(first.id, foreignProject.id, words, 'invalid_input');
  await denied(first.id, first.id, words, 'conflict');
  await denied(parent.id, first.id, words, 'conflict'); // cycle
  await denied(first.id, uncovered.id, words, 'responsible_missing');
  const before = await get(first.id), opId = randomUUID();
  const result = await attempt(first.id, destination.id, words, before.hash, opId);
  assert.equal(result.code, 0, result.stderr);
  const moved = JSON.parse(result.stdout).task;
  assert.deepEqual([moved.id, moved.path, moved.parentId], [first.id, first.path, destination.id]);
  const record = await lastRecord(url, first.id);
  assert.deepEqual(record.formerAncestors.slice(0, 2), [parent.id, w.project]);
  assert.deepEqual(record.actor, { kind: 'main', provider: 'codex', conversationId: conversation,
    quote: words });
  const replay = await attempt(first.id, destination.id, words, before.hash, opId);
  assert.equal(replay.code, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).task.hash, moved.hash, 'same opId replays original receipt');
  assert.equal((await get(first.id)).hash, moved.hash, 'replay adds no record');
  const secondBefore = await get(second.id);
  const http = await post(url, '/api/commands/task/move', { task: second.id, parent: destination.id, quote: words,
    expectedTaskHash: secondBefore.hash }, { 'X-Alpacawork-Provider': 'codex', 'X-Alpacawork-Conversation': conversation });
  assert.equal(http.status, 200, JSON.stringify(http.body));
  assert.equal(http.body.task.parentId, destination.id);
  assert.equal((await lastRecord(url, second.id)).actor.quote, words);
  const otherConversation = randomUUID();

  const changed = await attempt(first.id, parent.id, undefined, moved.hash, randomUUID(), codexConversation(otherConversation));
  assert.equal(changed.code, 0, changed.stderr);
  assert.equal(JSON.parse(changed.stdout).task.parentId, parent.id);
  const help = await run(url, ['task', 'move', '-h']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--quote/);
  assert.match(help.stdout, /Within parent responsible's subtree:.*the responsible Run of the Task's parent/);
  const outside = help.stdout.split('\n').find(line => line.includes('Outside that subtree:'));
  assert.match(outside!, /only a person or the coordinator/);
  assert.doesNotMatch(outside!, /responsible Run|member/);
});

test('a coordinator can carry project policy words on move without becoming a Task parent', { timeout: 15000 }, async t => {
  const w = callerWorkspace(t), commands = new ControlTaskCommands(w.root, { kind: 'human' });
  const policy = 'Move tasks within this project when instructed';
  await commands.update({ id: w.project, values: { project_policy: `- 方針: ${policy}` }, expectedTaskHash: (await new ControlTaskStore(w.root).get(w.project)).hash });
  const parent = (await commands.create({ parentId: w.project, userRequested: false, tasks: [{ title: 'Parent' }] })).tasks[0];
  await assignResponsible(w.root, parent, 'codex');
  const child = (await commands.create({ parentId: parent.id, userRequested: false, tasks: [{ title: 'Child' }] })).tasks[0];
  const url = await w.start(), conversation = randomUUID();

  const result = await run(url, ['task', 'move', '--task', child.id, '--parent', w.project, '--quote', policy,
    '--expected-task-hash', child.hash], codexConversation(conversation));
  assert.equal(result.code, 0, result.stderr);
  const moved = JSON.parse(result.stdout).task;
  assert.equal(moved.parentId, w.project);
  assert.equal((await lastRecord(url, child.id)).actor.quote, policy);
});
