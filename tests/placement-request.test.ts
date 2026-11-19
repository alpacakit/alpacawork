import { stringify } from 'yaml';
import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { createFixtureRun } from './helpers/run-fixture.ts';
import { initializeControlFixture, currentTaskHash } from './helpers/control-fixture.ts';
/** Agent-authored requests are tested against records without starting an agent. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { controlDatabasePath } from '@alpacawork/db';
import { RunStore, descendants, type RunTransaction } from '@alpacawork/runs';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { AGENTS_TEMPLATE } from '@alpacawork/backend/test-dist/agents-settings.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { RequestService } from '@alpacawork/backend/test-dist/control/requests.js';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { PlacementCommands } from '@alpacawork/backend/test-dist/control/placement-commands.js';
import { readControlTree } from './helpers/control-tree.ts';
import { readTaskView } from '@alpacawork/backend/test-dist/control/task-views.js';
import { fields } from './runs-fixtures.ts';

/** A person's Request, as authorize decides its actor. */
const human = { purpose: 'instruction', actor: { kind: 'human' } } as const;

async function setup(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-placement-request-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const writer = new FileWriter(root);
  let project: string;
  try { writer.save('config.yaml', null, Buffer.from(AGENTS_TEMPLATE)); project = initializeControlFixture(root); }
  finally { writer.close(); }
  const commands = new ControlTaskCommands(root, { kind: 'human' });
  const parent = (await commands.create({ parentId: project, userRequested: false, tasks: [{ title: 'Parent' }] })).tasks[0];
  const other = (await commands.create({ parentId: project, userRequested: false, tasks: [{ title: 'Other' }] })).tasks[0];
  // A task with a child keeps its responsible, so the parent has one before its child is created.
  const placements = new PlacementStore(root);
  const person = placements.createAgent();
  const owner = placements.place({ taskId: parent.id, agentId: person.id, profileKey: 'codex', responsible: true });
  const child = (await commands.create({ parentId: parent.id, userRequested: false, tasks: [{ title: 'Child' }] })).tasks[0];
  const member = placements.place({ taskId: parent.id, agentId: placements.createAgent().id,
    profileKey: 'claude', responsible: false });
  const childOwner = placements.place({ taskId: child.id, agentId: placements.createAgent().id,
    profileKey: 'claude', responsible: true });
  const unrelated = placements.place({ taskId: other.id, agentId: placements.createAgent().id,
    profileKey: 'claude', responsible: true });
  placements.close();
  const store = new RunStore(root, { busyTimeoutMs: 0 });
  const caller = store.write(tx => {
    const run = createFixtureRun(store, tx, { task: parent.id, placementId: owner.id, requestId: globalThis.crypto.randomUUID(),
      agent: 'codex', role: 'owner', resumes: null, continues: false, session: null,
      caller: null, cwd: root, launch: { adapter: 'codex', env: [], argv: ['unused'], path: '/bin', values: {}} }, 'prompt');
    tx.update({ ...run, state: 'running', started_at: new Date().toISOString() });
    return run;
  });
  store.close();
  return { root, parent, child, other, owner, member, childOwner, unrelated, caller, service: new RequestService(root) };
}

test('direct sending chooses new only when the finished conversation cannot resume, then continues the new one', async t => {
  const h = await setup(t);
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  try {
    store.write(tx => tx.finish({ ...tx.get(h.caller.id)!, state: 'succeeded', ended_at: new Date().toISOString() }, { state: 'present', text: 'fixture reply' }));
    const input = (head: string) => ({ taskId: h.parent.id, body: 'Continue work', requestId: randomUUID(),
      expectedTaskHash: currentTaskHash(h.root, h.parent.id), expectedPlacementRevision: h.owner.revision, expectedHeadRunId: head });
    const fresh = await h.service.request(input(h.caller.id), human);
    assert.equal(store.readRequests().find(item => item.id === fresh.requestId)?.mode, 'new');
    store.write(tx => {
      tx.update({ ...tx.get(fresh.runId)!, state: 'running', started_at: new Date().toISOString() });
      tx.finish({ ...tx.get(fresh.runId)!, state: 'succeeded',
        session: { provider: 'codex', id: 'resumable-session' }, ended_at: new Date().toISOString() }, { state: 'present', text: 'fixture reply' });
    });
    const continued = await h.service.request(input(fresh.runId), human);
    assert.equal(store.readRequests().find(item => item.id === continued.requestId)?.mode, 'continue');
    assert.equal(store.get(continued.runId)?.resumes, fresh.runId);
  } finally { store.close(); }
});

test('a review-blocked conversation refuses direct sending without silently starting another', async t => {
  const h = await setup(t);
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  try {
    store.write(tx => tx.update({ ...tx.get(h.caller.id)!, state: 'needs_review', reason: 'conversation_busy' }));
    await assert.rejects(h.service.request({ taskId: h.parent.id, body: 'Next instruction', requestId: randomUUID(),
      expectedTaskHash: currentTaskHash(h.root, h.parent.id), expectedPlacementRevision: h.owner.revision,
      expectedHeadRunId: h.caller.id }, human),
    (error: { code: string }) => error.code === 'conversation_busy');
    assert.equal(store.readRequests().filter(request => request.id !== h.caller.requestId).length, 0);
  } finally { store.close(); }
});

test('the backend placement row carries its current conversation head', async t => {
  const h = await setup(t);
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  try {
    const next = store.write(tx => createFixtureRun(store, tx, { task: h.parent.id, placementId: h.owner.id, requestId: globalThis.crypto.randomUUID(),
      agent: 'codex', role: 'owner', resumes: null, continues: false, session: null,
      caller: null, cwd: h.root, launch: { adapter: 'codex', env: [], argv: ['unused'], path: '/bin', values: {} } }, 'next'));
    const placement = () => readControlTree(h.root).then(tree => tree.placements.find(item => item.id === h.owner.id)!);
    assert.equal((await placement()).headRunId, next.id);
    assert.equal((await readControlTree(h.root)).placements.find(item => item.id === h.member.id)?.headRunId, null);
  } finally { store.close(); }
});

test('task get exposes each placement head from the same RunStore snapshot, excluding joined and aborted runs', async t => {
  const h = await setup(t), store = new RunStore(h.root, { busyTimeoutMs: 0 });
  try {
    const initial = await readTaskView(h.root, h.parent.id, {}, null);
    assert.deepEqual(initial.errors, []);
    assert.equal(initial.agents.find(item => item.id === h.member.id)!.headRunId, null,
      'a placement without a conversation has a known null head');
    assert.equal(initial.agents.find(item => item.id === h.owner.id)!.headRunId, h.caller.id);
    const heads = store.write(tx => [h.owner, h.member].map(placement => {
      const create = () => createFixtureRun(store, tx, fields({ task: h.parent.id, placementId: placement.id,
        agent: placement.profileKey, role: placement.responsible ? 'owner' : 'worker', cwd: h.root }), 'Head fixture');
      const head = create(), joined = create(), aborted = create();
      tx.update({ ...joined, state: 'joined', into: head.id, ended_at: new Date().toISOString() });
      tx.updateRequest(aborted.requestId, 'aborted');
      return head;
    }));
    const snapshot = store.snapshot();
    const view = await readTaskView(h.root, h.parent.id, { runs: 1 }, null);
    assert.deepEqual(view.errors, []);
    for (const placement of [h.owner, h.member]) {
      const projected = view.agents.find(item => item.id === placement.id)!.headRunId;
      assert.equal(projected, snapshot.headRunIds.get(placement.id));
      assert.equal(projected, store.conversationHead(placement.id)!.id);
      assert.equal(projected, heads.find(run => run.placementId === placement.id)!.id);
    }
    assert.notEqual(view.runs![0]!.id, view.agents.find(item => item.id === h.owner.id)!.headRunId,
      'the Task latest Run cannot substitute for its responsible placement head');
    const shown = view.agents.find(item => item.id === h.owner.id)!.headRunId!;
    store.write(tx => createFixtureRun(store, tx, fields({ task: h.parent.id, placementId: h.owner.id,
      agent: 'codex', role: 'owner', cwd: h.root }), 'New head after the read'));
    await assert.rejects(h.service.request({ taskId: h.parent.id, mode: 'new', body: 'Use the read head',
      requestId: randomUUID(), expectedTaskHash: view.task.hash, expectedPlacementRevision: h.owner.revision,
      expectedHeadRunId: shown }, human),
    (error: { code: string; message: string }) => error.code === 'conflict' && /Conversation head changed/.test(error.message));
  } finally { store.close(); }
});

test('task get reports an unreadable Run snapshot as unknown rather than a first conversation', async t => {
  const h = await setup(t);
  const db = new DatabaseSync(controlDatabasePath(h.root));
  try {
    // Synthetic corruption reproduces a read failure while placement identity remains readable.
    db.prepare("UPDATE runs SET record=json_set(record,'$.agent','Invalid Agent') WHERE id=?")
      .run(Number(h.caller.id.slice(1)));
    const view = await readTaskView(h.root, h.parent.id, {}, null);
    assert.ok(view.errors.some(error => error.code === 'runs_unavailable'));
    for (const placement of [h.owner, h.member]) {
      const projected = view.agents.find(item => item.id === placement.id)!;
      assert.equal(projected.headRunId, null);
      assert.equal(projected.runtime.displayState, 'unknown', 'a null head with a read error is not known absence');
    }
  } finally { db.close(); }
});

test('a responsible Run may request its member and direct child owner with its own author', async t => {
  const h = await setup(t);
  const context = { purpose: 'instruction', actor: { kind: 'placement', placementId: h.owner.id }, actorRunId: h.caller.id } as const;
  const memberInput = { taskId: h.parent.id, mode: 'new' as const, body: 'Check this', requestId: randomUUID(),
    expectedTaskHash: currentTaskHash(h.root, h.parent.id), expectedPlacementRevision: h.member.revision,
    targetPlacementId: h.member.id };
  const memberReceipt = await h.service.request(memberInput, context);
  assert.deepEqual(await h.service.request(memberInput, context), memberReceipt);
  const childReceipt = await h.service.request({ taskId: h.child.id, mode: 'new', body: 'Own this child',
    requestId: randomUUID(), expectedTaskHash: h.child.hash, expectedPlacementRevision: h.childOwner.revision,
    targetPlacementId: h.childOwner.id }, context);
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  try {
    assert.deepEqual([store.get(memberReceipt.runId)?.role, store.get(memberReceipt.runId)?.caller],
      ['worker', { run: h.caller.id }]);
    assert.deepEqual([store.get(childReceipt.runId)?.role, store.get(childReceipt.runId)?.caller],
      ['owner', { run: h.caller.id }]);
  } finally { store.close(); }
  const tree = await readControlTree(h.root);
  assert.deepEqual(tree.requests.filter(request => [memberReceipt.requestId, childReceipt.requestId].includes(request.id))
    .map(request => [request.purpose, request.author, request.recipientRole]),
  [['instruction', { kind: 'placement', placementId: h.owner.id }, 'worker'],
    ['instruction', { kind: 'placement', placementId: h.owner.id }, 'owner']]);
  const completed = new RunStore(h.root, { busyTimeoutMs: 0 });
  try {
    completed.write(tx => tx.finish({ ...tx.get(h.caller.id)!, state: 'succeeded',
      ended_at: new Date().toISOString() }, { state: 'present', text: 'fixture reply' }));
  } finally { completed.close(); }
  const placements = new PlacementStore(h.root);
  try { placements.setResponsible(h.member.id, h.member.revision); }
  finally { placements.close(); }
  const afterPromotion = await readControlTree(h.root);
  assert.equal(afterPromotion.placements.find(item => item.id === h.member.id)?.responsible, true);
  assert.equal(afterPromotion.requests.find(item => item.id === memberReceipt.requestId)?.recipientRole, 'worker');
});

test('Task stop shares one relationship index for 1000 Request reservations', async t => {
  const count = 1000;
  const h = await setup(t), store = new RunStore(h.root, { busyTimeoutMs: 0 });
  try {
    const ids = store.write(tx => Array.from({ length: count }, (_, i) => {
      const requestId = `stop-${i}`;
      tx.insertRequest({ id: requestId, taskId: h.child.id, placementId: h.childOwner.id,
        placementRevision: h.childOwner.revision, taskHash: h.child.hash, waitCycleId: null, headRunId: null,
        mode: 'new', body: 'Never launch', purpose: 'instruction', author: { kind: 'human' },
        submittedAt: new Date().toISOString(), deliveryState: 'queued' });
      return createFixtureRun(store, tx, { task: h.child.id, placementId: h.childOwner.id, requestId,
        agent: 'claude', role: 'owner', resumes: null, continues: false, session: null,
        caller: null, cwd: h.root, launch: { adapter: 'codex', env: [], argv: ['unused'], path: '/bin', values: {} } }, 'No launch').id;
    }));
    const write = RunStore.prototype.write;
    let captured = false, wholeReads = 0;
    const reads = new Map<string, number>();
    const mock = t.mock.method(RunStore.prototype, 'write', function<T>(this: RunStore, callback: (tx: RunTransaction) => T): T {
      return write.call(this, (tx: RunTransaction) => {
        if (!captured) {
          captured = true;
          const { all, get } = tx;
          tx.all = (...args) => { wholeReads++; return all(...args); };
          tx.get = id => { reads.set(id, (reads.get(id) ?? 0) + 1); return get(id); };
        }
        return callback(tx);
      }) as T;
    });
    // A person stops the Task: task report --state stopped stops its Runs in the same write.
    await new TaskReportService(h.root).report({ task: h.child.id, state: 'stopped', title: 'Stop', opId: randomUUID(),
      expectedTaskHash: h.child.hash }, { kind: 'human' }, { kind: 'human' });
    mock.mock.restore();
    assert.deepEqual(ids.filter(id => store.get(id)?.state !== 'cancelled'), []);
    assert.equal(wholeReads, 0, 'the stop reads the Runs below its roots, never the workspace\'s Runs');
    assert.deepEqual(ids.filter(id => reads.get(id) !== 1), [],
      'root selection, descendant traversal and effects share one read of each Run');
    assert.ok(store.readRequests().every(request => request.deliveryState === 'queued'),
      'human stop does not acquire Request cancellation semantics');
  } finally { store.close(); }
});

// The launch choices of a person's instructions: the profiles the screen
// offers, one Run for a retried instruction, and the choices a conversation keeps.

/** A task of the fixture's project with no responsible yet, in a workspace whose profiles offer launch choices. */
async function launchChoices(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-launch-choices-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = initializeControlFixture(root);
  writeFileSync(join(root, 'config.yaml'), stringify({ agents: {
    zeta: { ...fixtureAgentSetting('claude'), params: { model: ['large', 'small'], effort: ['high', 'low'] } },
    alpha: { ...fixtureAgentSetting('claude'), params: { model: ['two', 'one'], effort: [] } },
  } }));
  const task = (await new ControlTaskCommands(root, { kind: 'human' }).create({ parentId: project, userRequested: true,
    tasks: [{ title: 'Choices' }] })).tasks[0];
  const hash = async () => (await new ControlTaskStore(root).get(task.id)).hash;
  const place = async (profileKey = 'zeta') => (await new PlacementCommands(root).placeNewResponsible({ taskId: task.id,
    profileKey, expectedTaskHash: await hash() }, { kind: 'human' })).placement;
  /** A person's instruction to the responsible, as task request admits it. */
  const instruct = (input: { body: string; opId: string; revision: number; selected?: Record<string, string>;
    newConversation?: boolean; expectedTaskHash: string }) => new TaskRequestService(root).request({ task: task.id,
    body: input.body, opId: input.opId, selected: input.selected, newConversation: input.newConversation,
    expectedTaskHash: input.expectedTaskHash, expectedPlacementRevision: input.revision },
  { kind: 'human' }, { kind: 'human' });
  /** The Run starts and finishes, as its manager writes it. */
  const finish = (id: string) => {
    const store = new RunStore(root, { busyTimeoutMs: 0 });
    try {
      store.write(tx => tx.update({ ...tx.get(id)!, state: 'running', started_at: new Date().toISOString() }));
      store.write(tx => tx.finish({ ...tx.get(id)!, state: 'succeeded', ended_at: new Date().toISOString() },
        { state: 'present', text: 'fixture reply' }));
    } finally { store.close(); }
  };
  const values = (id: string) => {
    const store = new RunStore(root, { busyTimeoutMs: 0 });
    try { return store.get(id)?.launch.values; } finally { store.close(); }
  };

  return { root, task, hash, place, instruct, finish, values };
}

test('profiles offer choices in config order and reject selections outside those offers', async t => {
  const h = await launchChoices(t);
  const offers = (await readControlTree(h.root)).profiles;
  assert.deepEqual(offers.map(profile => profile.key), ['zeta', 'alpha']);
  assert.deepEqual(offers[0]!.choices.map(({ key, candidates, initial }) => ({ key, candidates, initial })), [
    { key: 'model', candidates: ['large', 'small'], initial: 'large' },
    { key: 'effort', candidates: ['high', 'low'], initial: 'high' },
  ]);
  const placement = await h.place();
  await assert.rejects(h.instruct({ body: 'Invalid choice', opId: 'invalid-choice', revision: placement.revision,
    selected: { model: 'missing' }, expectedTaskHash: await h.hash() }), { code: 'invalid_input' });
});

test('a retried first instruction creates one Run with its launch choices', async t => {
  const h = await launchChoices(t);
  const placement = await h.place();
  const selected = { model: 'small', effort: 'low' };
  await assert.rejects(h.instruct({ body: 'Do work', opId: 'first', revision: placement.revision, selected,
    expectedTaskHash: 'a'.repeat(64) }), { code: 'conflict' });
  const shown = await h.hash();
  const accepted = await h.instruct({ body: 'Do work', opId: 'first', revision: placement.revision, selected,
    expectedTaskHash: shown });
  const replay = await h.instruct({ body: 'Do work', opId: 'first', revision: placement.revision, selected,
    expectedTaskHash: shown });
  assert.deepEqual(replay.outcome, accepted.outcome);
  await assert.rejects(h.instruct({ body: 'Do work', opId: 'first', revision: placement.revision,
    selected: { model: 'large', effort: 'low' }, expectedTaskHash: shown }), /another launch choice/);
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  try {
    assert.equal(store.readRequests().length, 1);
    assert.equal(store.read().length, 1);
    assert.deepEqual(store.read()[0]?.launch.values, selected);
  } finally { store.close(); }
});

test('a continuation keeps the first choices; a new conversation, or a first one without any, takes the defaults', async t => {
  const h = await launchChoices(t);
  const placement = await h.place();
  const first = await h.instruct({ body: 'First', opId: 'first', revision: placement.revision,
    selected: { model: 'small', effort: 'low' }, expectedTaskHash: await h.hash() });
  assert.deepEqual(h.values(first.outcome.request.runId), { model: 'small', effort: 'low' });
  h.finish(first.outcome.request.runId);
  const continued = await h.instruct({ body: 'Continue', opId: 'continue', revision: placement.revision,
    expectedTaskHash: await h.hash() });
  assert.equal(continued.outcome.request.conversationRef.headRunId, first.outcome.request.runId);
  assert.deepEqual(h.values(continued.outcome.request.runId), { model: 'small', effort: 'low' });
  h.finish(continued.outcome.request.runId);
  const restarted = await h.instruct({ body: 'Restart', opId: 'restart', revision: placement.revision,
    newConversation: true, expectedTaskHash: await h.hash() });
  assert.deepEqual(h.values(restarted.outcome.request.runId), { model: 'large', effort: 'high' });
  // A responsible's first conversation that names no choice starts with the defaults too.
  const other = await launchChoices(t);
  const owner = await other.place();
  const defaults = await other.instruct({ body: 'Default first launch', opId: 'default', revision: owner.revision,
    expectedTaskHash: await other.hash() });
  assert.deepEqual(other.values(defaults.outcome.request.runId), { model: 'large', effort: 'high' });
});
