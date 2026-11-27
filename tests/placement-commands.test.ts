import { initializeControlFixture } from './helpers/control-fixture.ts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { PlacementCommands } from '@alpacawork/backend/test-dist/control/placement-commands.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { AGENTS_TEMPLATE } from '@alpacawork/backend/test-dist/agents-settings.js';

const human = { kind: 'human' } as const;
async function taskHash(root: string, id: string) {
  return (await new ControlTaskStore(root).snapshot()).tasks.find(task => task.id === id)!.hash;
}

async function setup(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-place-command-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const writer = new FileWriter(root);
  try { writer.save('config.yaml', null, Buffer.from(AGENTS_TEMPLATE));  } finally { writer.close(); }
  const project = initializeControlFixture(root);
  const task = (await new ControlTaskCommands(root, { kind: 'human' }).create({ parentId: project, userRequested: false, tasks: [{ title: 'Work' }] })).tasks[0];
  return { root, project, task, commands: new PlacementCommands(root) };
}

test('placing a new responsible person is atomic and rejects a duplicate owner', async t => {
  const h = await setup(t);
  const first = await h.commands.placeNewResponsible({ taskId: h.task.id, profileKey: 'codex', expectedTaskHash: h.task.hash }, human);
  assert.equal(first.placement.responsible, true);
  const before = (await new ControlTaskStore(h.root).snapshot()).tasks.find(task => task.id === h.task.id)!;
  await assert.rejects(h.commands.placeNewResponsible({ taskId: h.task.id, profileKey: 'claude', expectedTaskHash: await taskHash(h.root, h.task.id) }, human), /already has a responsible/);
  const after = (await new ControlTaskStore(h.root).snapshot()).tasks.find(task => task.id === h.task.id)!;
  assert.equal(after.hash, before.hash, 'a rejected DB mutation leaves no placement intent');
  const store = new PlacementStore(h.root);
  try { assert.equal(store.agents().length, 1, 'rejected placement must roll back the new person'); }
  finally { store.close(); }
});

test('responsibility rejects a profile absent from current settings', async t => {
  const h = await setup(t);
  await assert.rejects(h.commands.placeNewResponsible({ taskId: h.task.id, profileKey: 'missing', expectedTaskHash: h.task.hash }, human), /configured launch profile/);
  const store = new PlacementStore(h.root);
  try { assert.deepEqual(store.agents(), []); }
  finally { store.close(); }
});

test('set-responsible checks task hash, placement ownership and revision', async t => {
  const h = await setup(t);
  await h.commands.placeNewResponsible({ taskId: h.task.id, profileKey: 'codex', expectedTaskHash: h.task.hash }, human);
  const store = new PlacementStore(h.root);
  let member;
  try {
    const agent = store.createAgent();
    member = store.place({ taskId: h.task.id, agentId: agent.id, profileKey: 'claude', responsible: false });
  } finally { store.close(); }
  const switched = await h.commands.setResponsible({ taskId: h.task.id, placementId: member.id,
    expectedTaskHash: await taskHash(h.root, h.task.id), expectedPlacementRevision: member.revision }, human);
  assert.equal(switched.placement.responsible, true);
  assert.deepEqual([switched.previousPlacement?.active, switched.previousPlacement?.responsible], [false, true]);
  await assert.rejects(h.commands.setResponsible({ taskId: h.task.id, placementId: member.id,
    expectedTaskHash: await taskHash(h.root, h.task.id), expectedPlacementRevision: member.revision }, human), /revision changed/);
  await assert.rejects(h.commands.setResponsible({ taskId: h.task.id, placementId: member.id,
    expectedTaskHash: 'a'.repeat(64), expectedPlacementRevision: switched.placement.revision }, human), /Task changed/);
});

test('place-agent replaces an idle responsible person atomically without making them a member', async t => {
  const h = await setup(t);
  const first = await h.commands.placeNewResponsible({ taskId: h.task.id, profileKey: 'codex', expectedTaskHash: h.task.hash }, human);
  await assert.rejects(h.commands.placeNewResponsible({ taskId: h.task.id, profileKey: 'claude', expectedTaskHash: await taskHash(h.root, h.task.id), replacePlacementId: first.placement.id,
    expectedPlacementRevision: 2 }, human), /placement changed/);
  const next = await h.commands.placeNewResponsible({ taskId: h.task.id, profileKey: 'claude', expectedTaskHash: await taskHash(h.root, h.task.id), replacePlacementId: first.placement.id,
    expectedPlacementRevision: first.placement.revision }, human);
  assert.equal(next.previousPlacement?.id, first.placement.id);
  assert.equal(next.previousPlacement?.active, false);
  const store = new PlacementStore(h.root);
  try {
    assert.equal(store.placements(h.task.id).filter(item => item.active).length, 1);
    assert.equal(store.placements(h.task.id).find(item => item.id === next.placement.id)?.responsible, true);
  } finally { store.close(); }
});

test('release preserves the placement as inactive history', async t => {
  const h = await setup(t);
  const created = await h.commands.placeNewResponsible({ taskId: h.task.id, profileKey: 'codex', expectedTaskHash: h.task.hash }, human);
  const released = await h.commands.release({ taskId: h.task.id, placementId: created.placement.id,
    expectedTaskHash: await taskHash(h.root, h.task.id), expectedPlacementRevision: created.placement.revision }, human);
  assert.deepEqual([released.placement.active, released.placement.responsible], [false, true]);
  const store = new PlacementStore(h.root);
  try { assert.equal(store.placements(h.task.id)[0]?.id, created.placement.id); }
  finally { store.close(); }
});

test('each placement change is one record on its Task by the actor it was decided for; a project holds none', async t => {
  const h = await setup(t);
  const tasks = new ControlTaskStore(h.root);
  const placed = await h.commands.placeNewResponsible({ taskId: h.task.id, profileKey: 'codex', expectedTaskHash: h.task.hash }, human);
  const member = await h.commands.placeMember({ placedAs: 'default', taskId: h.task.id, profileKey: 'claude',
    expectedTaskHash: await taskHash(h.root, h.task.id), expectedResponsibleRevision: placed.placement.revision },
  { kind: 'placement', placementId: placed.placement.id });
  const released = await h.commands.release({ taskId: h.task.id, placementId: placed.placement.id,
    expectedTaskHash: await taskHash(h.root, h.task.id), expectedPlacementRevision: placed.placement.revision }, human);
  const task = await tasks.get(h.task.id);
  // TaskTransition writes each at the Task's next revision, so a placement change moves the Task's hash.
  assert.equal(task.meta.version, 4n);
  assert.deepEqual(task.meta.log.slice(1).map(entry => [entry.kind, entry.actor, entry.placementId, entry.placementRevision,
    entry.placementEffect, entry.toState]), [
    ['responsible_changed', human, placed.placement.id, placed.placement.revision, 'responsible', null],
    ['placement_changed', { kind: 'placement', placementId: placed.placement.id }, member.placement.id,
      member.placement.revision, 'member', null],
    ['responsible_changed', human, placed.placement.id, released.placement.revision, 'released', null],
  ]);
  await assert.rejects(h.commands.placeNewResponsible({ taskId: h.project, profileKey: 'codex',
    expectedTaskHash: (await tasks.get(h.project)).hash }, human), { code: 'invalid_input' });
});
