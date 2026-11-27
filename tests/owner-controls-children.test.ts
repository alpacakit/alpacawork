import { stringify } from 'yaml';
import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { commandFetch as fetch } from './helpers/command-fetch.ts';
import { createFixtureRun } from './helpers/run-fixture.ts';
import { initializeControlFixture } from './helpers/control-fixture.ts';
import { reconcileLinks } from './return-handling.fixture.ts';
/** A responsible Run controls the people of its direct child Tasks, as a direct connection does. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '@alpacawork/runs';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { PlacementCommands } from '@alpacawork/backend/test-dist/control/placement-commands.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { RequestService } from '@alpacawork/backend/test-dist/control/requests.js';
import { issueRunCredential } from '@alpacawork/backend/test-dist/control/credentials.js';
import { readControlTree } from './helpers/control-tree.ts';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';

const human = { kind: 'human' } as const;

async function hash(root: string, id: string) {
  return (await readControlTree(root)).tasks.find(task => task.id === id)!.hash;
}
async function lastLog(root: string, id: string) {
  return (await readControlTree(root)).tasks.find(task => task.id === id)!.log.at(-1)!;
}
/** The handover notices to Task `id`: what tells its new responsible what it takes over. */
function handovers(root: string, id: string) {
  const store = new RunStore(root, { busyTimeoutMs: 0 });
  try {
    return store.readReturns().filter(row => row.outcome === 'handover' && row.toTaskId === id)
      .map(row => row.causeLogId);
  } finally { store.close(); }
}
function runningRun(root: string, taskId: string, placementId: string, role: 'owner' | 'worker' = 'owner') {
  const store = new RunStore(root, { busyTimeoutMs: 0 });
  try {
    return store.write(tx => {
      const created = createFixtureRun(store, tx, { task: taskId, placementId, requestId: globalThis.crypto.randomUUID(),
        agent: 'zeta', role, resumes: null, continues: false, session: null, caller: null, cwd: root,
        launch: { adapter: 'codex', env: [], argv: ['unused'], path: '/bin', values: {} } }, 'prompt');
      tx.update({ ...created, state: 'running', started_at: new Date().toISOString() });
      return created;
    });
  } finally { store.close(); }
}

/** P (owner Run running) → C1, C2. */
async function setup(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-owner-children-')));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => {
    try { await server?.close(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  const writer = new FileWriter(root);
  let project: string;
  try { project = initializeControlFixture(root); } finally { writer.close(); }
  writeFileSync(join(root, 'config.yaml'), stringify({ agents: {
    zeta: { ...fixtureAgentSetting('claude'), params: { model: ['large', 'small'], effort: [] } },
  } }));
  const commands = new ControlTaskCommands(root, human);
  const parent = (await commands.create({ parentId: project, userRequested: false, tasks: [{ title: 'Parent' }] })).tasks[0];
  const owner = (await new PlacementCommands(root).placeNewResponsible({ taskId: parent.id, profileKey: 'zeta',
    expectedTaskHash: parent.hash }, human)).placement;
  const run = runningRun(root, parent.id, owner.id);
  // The parent's responsible Run acts as its placement, and calls as that Run.
  const asOwner = { kind: 'placement', placementId: owner.id } as const;
  const ownerCaller = { kind: 'run', runId: run.id, placementId: owner.id, taskId: parent.id, role: 'owner',
    responsible: true } as const;
  const runCommands = new ControlTaskCommands(root, asOwner);
  const child = (await runCommands.create({ parentId: parent.id, userRequested: false, tasks: [{ title: 'Child' }],
    expectedParentHash: await hash(root, parent.id) })).tasks[0];
  const sibling = (await runCommands.create({ parentId: parent.id, userRequested: false, tasks: [{ title: 'Sibling' }],
    expectedParentHash: await hash(root, parent.id) })).tasks[0];
  return { root, project, parent, child, sibling, owner, run, asOwner, ownerCaller,
    async start() { return server = await startServer(root, 0); } };
}

test('the parent responsible Run places, replaces, hands over and releases a child responsible', async t => {
  const h = await setup(t);
  const place = new PlacementCommands(h.root);
  const actor = h.asOwner;
  const first = await place.placeNewResponsible({ placedAs: 'default', taskId: h.child.id, profileKey: 'zeta',
    expectedTaskHash: await hash(h.root, h.child.id) }, h.asOwner);
  assert.deepEqual((await lastLog(h.root, h.child.id)).actor, actor);
  const replaced = await place.placeNewResponsible({ placedAs: 'default', taskId: h.child.id, profileKey: 'zeta',
    expectedTaskHash: await hash(h.root, h.child.id), replacePlacementId: first.placement.id,
    expectedPlacementRevision: first.placement.revision }, h.asOwner);
  assert.equal(replaced.previousPlacement?.active, false);
  const people = new PlacementStore(h.root);
  const member = people.place({ taskId: h.child.id, agentId: people.createAgent().id,
    profileKey: 'zeta', responsible: false });
  people.close();
  const handed = await place.setResponsible({ placedAs: 'policy', taskId: h.child.id, placementId: member.id,
    expectedTaskHash: await hash(h.root, h.child.id), expectedPlacementRevision: member.revision }, h.asOwner);
  assert.equal(handed.placement.responsible, true);
  const released = await place.release({ taskId: h.child.id, placementId: handed.placement.id,
    expectedTaskHash: await hash(h.root, h.child.id), expectedPlacementRevision: handed.placement.revision }, h.asOwner);
  assert.equal(released.placement.active, false);
  assert.deepEqual((await lastLog(h.root, h.child.id)).actor, actor);
  // The child was not at work: nothing was handed over.
  assert.deepEqual(handovers(h.root, h.child.id), []);
});

test('a child at work changes its responsible only by replacement or handover, which tells the new one', async t => {
  const h = await setup(t);
  const place = new PlacementCommands(h.root);
  const first = (await place.placeNewResponsible({ placedAs: 'default', taskId: h.child.id, profileKey: 'zeta',
    expectedTaskHash: await hash(h.root, h.child.id) }, h.asOwner)).placement;
  // Its Run ends with no end, no question and no open Request: the child is in error, still at work.
  const run = runningRun(h.root, h.child.id, first.id);
  reconcileLinks(h.root, h.project);
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  try {
    store.write(tx => tx.finish({ ...tx.get(run.id)!, state: 'succeeded', ended_at: new Date().toISOString() },
      { state: 'present', text: 'done' }));
  } finally { store.close(); }
  reconcileLinks(h.root, h.project);
  assert.equal((await readControlTree(h.root)).tasks.find(task => task.id === h.child.id)?.state, 'error');
  // Released alone, the child would have nobody at work on it.
  await assert.rejects(place.release({ taskId: h.child.id, placementId: first.id,
    expectedTaskHash: await hash(h.root, h.child.id), expectedPlacementRevision: first.revision }, h.asOwner),
  { code: 'handover_required', detail: { task: h.child.id, hasChildren: false, state: 'error' } });
  const replaced = await place.placeNewResponsible({ placedAs: 'default', taskId: h.child.id, profileKey: 'zeta',
    expectedTaskHash: await hash(h.root, h.child.id), replacePlacementId: first.id,
    expectedPlacementRevision: first.revision }, h.asOwner);
  const replacement = await lastLog(h.root, h.child.id);
  assert.deepEqual([replacement.kind, replacement.placementId, replacement.actor],
    ['responsible_changed', replaced.placement.id, h.asOwner]);
  assert.deepEqual(handovers(h.root, h.child.id), [replacement.id], 'the replacement tells its new responsible');
  const people = new PlacementStore(h.root);
  const member = people.place({ taskId: h.child.id, agentId: people.createAgent().id,
    profileKey: 'zeta', responsible: false });
  people.close();
  await place.setResponsible({ placedAs: 'policy', taskId: h.child.id, placementId: member.id,
    expectedTaskHash: await hash(h.root, h.child.id), expectedPlacementRevision: member.revision }, h.asOwner);
  const handover = await lastLog(h.root, h.child.id);
  assert.deepEqual(handovers(h.root, h.child.id).sort(), [replacement.id, handover.id].sort(), 'so does a handover');
});

test('the parent responsible Run chooses launch values with each instruction to a child; one left out keeps the last', async t => {
  const h = await setup(t);
  const placed = await new PlacementCommands(h.root).placeNewResponsible({ placedAs: 'default', taskId: h.child.id, profileKey: 'zeta',
    expectedTaskHash: await hash(h.root, h.child.id) }, h.asOwner);
  const requests = new TaskRequestService(h.root);
  const request = (input: Parameters<TaskRequestService['request']>[0]) => requests.request(input, h.asOwner, h.ownerCaller);
  const first = await request({ task: h.child.id, body: 'Do work', opId: 'owner-first',
    selected: { model: 'small' }, placedAs: 'policy', expectedTaskHash: await hash(h.root, h.child.id),
    expectedPlacementRevision: placed.placement.revision });
  assert.equal(first.outcome.kind, 'request_accepted');
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  try {
    const run = store.read().find(item => item.task === h.child.id)!;
    assert.deepEqual(run.launch.values, { model: 'small', effort: null });
    assert.deepEqual(store.readRequests().find(item => item.id === 'owner-first')?.author,
      { kind: 'placement', placementId: h.owner.id });
  } finally { store.close(); }
  const second = await request({ task: h.child.id, body: 'More', opId: 'owner-second',
    selected: { model: 'large' }, placedAs: 'policy', expectedTaskHash: await hash(h.root, h.child.id),
    expectedPlacementRevision: placed.placement.revision });
  assert.equal(second.outcome.kind, 'request_accepted');
  const third = await request({ task: h.child.id, body: 'Again', opId: 'owner-third',
    expectedTaskHash: await hash(h.root, h.child.id), expectedPlacementRevision: placed.placement.revision });
  assert.equal(third.outcome.kind, 'request_accepted');
  const later = new RunStore(h.root, { busyTimeoutMs: 0 });
  try {
    const runOf = (id: string) => later.read().find(item => item.id === later.readRequests().find(request => request.id === id)?.runId)!;
    assert.deepEqual(runOf('owner-second').launch.values, { model: 'large', effort: null });
    assert.deepEqual(runOf('owner-third').launch.values, { model: 'large', effort: null });
  } finally { later.close(); }
  // Sent again under its ID, an instruction keeps the choice it was admitted with.
  await assert.rejects(request({ task: h.child.id, body: 'More', opId: 'owner-second',
    selected: { model: 'small' }, placedAs: 'policy', expectedTaskHash: second.task.hash,
    expectedPlacementRevision: placed.placement.revision }), /another launch choice|different input/);
  // An automatic return carries no choice.
  await assert.rejects(new RequestService(h.root).request({ taskId: h.child.id, requestId: 'return-choice', body: 'Replies',
    expectedTaskHash: await hash(h.root, h.child.id), expectedPlacementRevision: placed.placement.revision,
    targetPlacementId: placed.placement.id, selected: { model: 'large' } }, { purpose: 'return_continuation', returnIds: ['R-none'] }),
    /Launch choices come with/);
});

test('HTTP run stop from the parent responsible Run stops a child and records who asked', async t => {
  const h = await setup(t);
  const placed = await new PlacementCommands(h.root).placeNewResponsible({ placedAs: 'default', taskId: h.child.id, profileKey: 'zeta',
    expectedTaskHash: await hash(h.root, h.child.id) }, h.asOwner);
  const childRun = runningRun(h.root, h.child.id, placed.placement.id);
  const grandchild = (await new ControlTaskCommands(h.root, human).create({ parentId: h.child.id, userRequested: false,
    tasks: [{ title: 'Grandchild' }] })).tasks[0];
  const grandOwner = await new PlacementCommands(h.root).placeNewResponsible({ taskId: grandchild.id,
    profileKey: 'zeta', expectedTaskHash: await hash(h.root, grandchild.id) }, human);
  const grandRun = runningRun(h.root, grandchild.id, grandOwner.placement.id);
  const server = await h.start();
  const stop = async (body: { run: string }) => {
    const response = await fetch(new URL('/api/commands/run/stop', server.url), { method: 'POST',
      headers: { 'content-type': 'application/json',
        authorization: `Alpacawork-Run ${h.run.id}:${issueRunCredential(h.root, h.run.id)}` }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as { error?: { code: string } } };
  };
  for (const input of [{ run: grandRun.id }, { run: h.run.id }]) {
    const refused = await stop(input);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error?.code, 'forbidden');
  }
  const stopped = await stop({ run: childRun.id });
  assert.equal(stopped.status, 200);
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  try {
    assert.equal(store.get(childRun.id)?.stop_requested, true);
    assert.equal(store.get(grandRun.id)?.stop_requested, false);
    assert.equal(store.get(h.run.id)?.stop_requested, false);
  } finally { store.close(); }
  const audit = (await readControlTree(h.root)).tasks.find(task => task.id === h.child.id)!
    .log.find(entry => entry.kind === 'run_stop_requested')!;
  assert.equal(audit.kind, 'run_stop_requested');
  assert.deepEqual(audit.actor, { kind: 'placement', placementId: h.owner.id });
});
