import { grantFixtureRequest } from './helpers/control-fixture.ts';
import { createFixtureRun } from './helpers/run-fixture.ts';
import { initializeControlFixture, currentTaskHash } from './helpers/control-fixture.ts';
/** Request admission tests inspect saved records; launching is disabled in this fixture. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { stringify } from 'yaml';
import { RunStore, depth } from '@alpacawork/runs';
import { requestReceiptSchema } from '@alpacawork/contract/control';
import { userTurn } from '@alpacawork/contract';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { AGENTS_TEMPLATE } from '@alpacawork/backend/test-dist/agents-settings.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { PlacementCommands } from '@alpacawork/backend/test-dist/control/placement-commands.js';
import { RequestService } from '@alpacawork/backend/test-dist/control/requests.js';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import { returnDisposition } from '@alpacawork/backend/test-dist/control/return-lifecycle.js';
import { stopRunsIn } from '@alpacawork/backend/test-dist/runs/entry.js';
import { removeTaskAttachment, saveTaskAttachment } from '@alpacawork/backend/test-dist/control/task-files.js';
import { settleTransaction, closeLaunches } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { readControlTree } from './helpers/control-tree.ts';

/** A person's Request, as authorize decides its actor. */
const human = { purpose: 'instruction', actor: { kind: 'human' } } as const;

/** `limits` are config.yaml's, by their keys. */
async function setup(t: TestContext, limits: Record<string, number> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-request-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const writer = new FileWriter(root);
  const config = stringify({ limits }) + AGENTS_TEMPLATE;
  let project: string;
  try { writer.save('config.yaml', null, Buffer.from(config)); project = initializeControlFixture(root); }
  finally { writer.close(); }
  const task = (await new ControlTaskCommands(root, { kind: 'human' }).create({ parentId: project, userRequested: false, tasks: [{ title: 'Request target' }] })).tasks[0];
  const placements = new PlacementStore(root);
  const agent = placements.createAgent();
  const placement = placements.place({ taskId: task.id, agentId: agent.id, profileKey: 'claude', responsible: true });
  placements.close();
  return { root, project, task, placement, service: new RequestService(root) };
}

async function setupLimitedCaller(t: TestContext, limits: Record<string, number>) {
  const h = await setup(t, limits);
  const people = new PlacementStore(h.root);
  const members = Array.from({ length: 2 }, () =>
    people.createAndPlace({ taskId: h.task.id, profileKey: 'claude', responsible: false }).placement);
  people.close();
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  const caller = store.write(tx => {
    const run = createFixtureRun(store, tx, { task: h.task.id, placementId: h.placement.id, requestId: globalThis.crypto.randomUUID(),
      agent: 'claude', role: 'owner', resumes: null, continues: false, session: null, caller: null,
      cwd: h.root, launch: { adapter: 'codex', env: [], argv: ['unused-never-launched'], path: '/bin', values: {}} }, 'synthetic');
    tx.update({ ...run, state: 'running', started_at: new Date().toISOString() });
    return run;
  });
  mkdirSync(join(h.root, '.alpacawork', 'runs'), { recursive: true });
  store.close();
  const context = { purpose: 'instruction', actor: { kind: 'placement', placementId: h.placement.id },
    actorRunId: caller.id } as const;
  const input = (placement: (typeof members)[number], requestId: string) => ({ taskId: h.task.id,
    mode: 'new' as const, body: 'Synthetic child work', requestId, targetPlacementId: placement.id,
    expectedTaskHash: currentTaskHash(h.root, h.task.id), expectedPlacementRevision: placement.revision });
  return { ...h, members, caller, context, input };
}

test('placement admission refuses depth and child limits before adding a Request, Run or prompt', async t => {
  for (const scenario of [{ limits: { depth: 1, children_per_run: 2 }, code: 'too_deep', firstAccepted: false },
    { limits: { depth: 2, children_per_run: 1 }, code: 'too_many_children', firstAccepted: true }]) {
    const h = await setupLimitedCaller(t, scenario.limits);
    const firstInput = h.input(h.members[0]!, `Q-${scenario.code}-1`);
    const first = scenario.firstAccepted ? await h.service.request(firstInput, h.context) : null;
    const store = new RunStore(h.root, { busyTimeoutMs: 0 });
    try {
      const before = { requests: store.readRequests(), runs: store.read(),
        folders: readdirSync(join(h.root, '.alpacawork', 'runs')).sort() };
      const rejected = scenario.firstAccepted ? h.input(h.members[1]!, `Q-${scenario.code}-2`) : firstInput;
      await assert.rejects(h.service.request(rejected, h.context),
        (error: { code: string; status: number; message: string; detail: { preserveDraft: boolean } }) =>
          error.code === scenario.code && error.status === 400 && error.detail.preserveDraft &&
          (scenario.code !== 'too_many_children' ||
            (error.message.includes('completed children still count') && !error.message.includes('wait for'))));
      assert.deepEqual(store.readRequests(), before.requests);
      assert.deepEqual(store.read(), before.runs);
      assert.deepEqual(readdirSync(join(h.root, '.alpacawork', 'runs')).sort(), before.folders);
      if (first) {
        assert.deepEqual(await h.service.request(firstInput, h.context), first,
          'the same Request ID returns its original receipt even after the limit is reached');
        assert.deepEqual(store.readRequests(), before.requests);
      }
    } finally { store.close(); }
  }
});

test('concurrent placement requests reserve only one child slot', async t => {
  const h = await setupLimitedCaller(t, { depth: 2, children_per_run: 1 });
  const outcomes = await Promise.allSettled(h.members.map((member, index) =>
    h.service.request(h.input(member, `Q-concurrent-${index}`), h.context)));
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.deepEqual(outcomes.filter(outcome => outcome.status === 'rejected')
    .map(outcome => outcome.reason.code), ['too_many_children']);
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  try {
    assert.equal(store.readRequests().filter(request => request.id !== h.caller.requestId).length, 1);
    assert.equal(store.read().length, 2);
    assert.deepEqual(readdirSync(join(h.root, '.alpacawork', 'runs')).sort(), []);
  } finally { store.close(); }
});

test('a held Task writer refuses Request admission, then a released writer permits it', async t => {
  const h = await setup(t, { depth: 1, children_per_run: 1 });
  const input = { taskId: h.task.id, mode: 'new' as const, body: 'After writer', requestId: 'Q-after-writer',
    expectedTaskHash: currentTaskHash(h.root, h.task.id), expectedPlacementRevision: h.placement.revision };
  const db = new DatabaseSync(join(h.root, '.alpacawork/alpacawork.sqlite'));
  try {
    db.exec('BEGIN IMMEDIATE');
    await assert.rejects(h.service.request(input, human),
      (error: Error) => /locked/.test(error.message));
    db.exec('ROLLBACK');
  } finally { db.close(); }
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  try {
    assert.deepEqual(store.readRequests(), []);
    assert.deepEqual(store.read(), []);
    assert.deepEqual(store.read().map(run => run.id), []);
  } finally { store.close(); }
  const accepted = await h.service.request(input, human);
  assert.equal(accepted.deliveryState, 'queued');
});

test('a request saves original input, a queued Run and a stable receipt', async t => {
  const h = await setup(t);
  const input = { taskId: h.task.id, mode: 'new' as const, body: 'Please inspect this task', requestId: 'Q1',
    expectedTaskHash: currentTaskHash(h.root, h.task.id), expectedPlacementRevision: h.placement.revision, expectedHeadRunId: null };
  const first = requestReceiptSchema.parse(await h.service.request(input, human));
  const again = await h.service.request(input, human);
  assert.deepEqual(again, first);
  assert.equal(first.deliveryState, 'queued');
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  try {
    const run = store.get(first.runId)!;
    assert.deepEqual([run.placementId, run.requestId, run.state], [h.placement.id, 'Q1', 'queued']);
    assert.equal(store.write(tx => tx.getRequest('Q1'))?.body, input.body);
    const delivered = store.getText(first.runId)!.prompt;
    assert.ok(delivered.includes(`\n## Request\nWritten by the user.\n${input.body}\n`), 'a person\'s request says the user wrote it');
    assert.ok(delivered.includes(`read alpacawork task get --task ${h.task.id}.`), 'the body is read by its command');
  } finally { store.close(); }
  const original = (await readControlTree(h.root)).requests.find(request => request.id === input.requestId);
  assert.deepEqual([original?.purpose, original?.author, original?.body, original?.runId],
    ['instruction', { kind: 'human' }, input.body, first.runId]);
  await assert.rejects(h.service.request({ ...input, body: 'Different' }, human), /different input/);
});

test('a reply to a queued head is serialized after that head', async t => {
  const h = await setup(t, { depth: 1, children_per_run: 1 });
  const first = await h.service.request({ taskId: h.task.id, mode: 'new', body: 'First', requestId: 'Q1',
    expectedTaskHash: currentTaskHash(h.root, h.task.id), expectedPlacementRevision: 1 }, human);
  const second = await h.service.request({ taskId: h.task.id, mode: 'continue', body: 'Second', requestId: 'Q2',
    expectedTaskHash: currentTaskHash(h.root, h.task.id), expectedPlacementRevision: 1, expectedHeadRunId: first.runId }, human);
  assert.equal(second.deliveryState, 'waiting_for_run');
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  try {
    assert.deepEqual([store.get(second.runId)?.resumes, store.get(second.runId)?.state], [first.runId, 'queued']);
    // Decide the next manager launch without spawning a process: only the head is eligible.
    const decision = await settleTransaction(store, readAgentsSettings(h.root));
    try { assert.deepEqual(decision.launches.map(item => item.id), [first.runId]); }
    finally { closeLaunches(decision.launches); }
    assert.equal(store.get(second.runId)?.state, 'queued');
  }
  finally { store.close(); }
});

test('a serialized reply becomes ready when its predecessor finishes', async t => {
  const h = await setup(t);
  const first = await h.service.request({ taskId: h.task.id, mode: 'new', body: 'First', requestId: 'Q1',
    expectedTaskHash: currentTaskHash(h.root, h.task.id), expectedPlacementRevision: 1 }, human);
  const second = await h.service.request({ taskId: h.task.id, mode: 'continue', body: 'Second', requestId: 'Q2',
    expectedTaskHash: currentTaskHash(h.root, h.task.id), expectedPlacementRevision: 1, expectedHeadRunId: first.runId }, human);
  assert.equal(second.deliveryState, 'waiting_for_run');
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  try {
    store.write(tx => {
      const initial = tx.get(first.runId)!;
      tx.update({ ...initial, state: 'running', started_at: new Date().toISOString() });
      tx.finish({ ...tx.get(first.runId)!, state: 'succeeded', ended_at: new Date().toISOString() }, { state: 'present', text: 'fixture reply' });
    });
    const decision = await settleTransaction(store, readAgentsSettings(h.root));
    try { assert.deepEqual(decision.launches.map(item => item.id), [second.runId]); }
    finally { closeLaunches(decision.launches); }
    assert.equal(store.write(tx => tx.getRequest('Q2'))?.deliveryState, 'queued');
    assert.equal(store.get(second.runId)?.state, 'running');
  } finally { store.close(); }
});

test('stale task and placement versions refuse admission with current values', async t => {
  const h = await setup(t);
  await assert.rejects(h.service.request({ taskId: h.task.id, mode: 'new', body: 'Draft', requestId: 'Q1',
    expectedTaskHash: 'a'.repeat(64), expectedPlacementRevision: 1 }, human),
    (error: { code: string; detail: { currentTaskHash: string; preserveDraft: boolean } }) =>
      error.code === 'conflict' && error.detail.currentTaskHash === h.task.hash && error.detail.preserveDraft);
  await assert.rejects(h.service.request({ taskId: h.task.id, mode: 'new', body: 'Draft', requestId: 'Q2',
    expectedTaskHash: currentTaskHash(h.root, h.task.id), expectedPlacementRevision: 2 }, human), /changed/);
});

test('a deleted draft attachment cannot be admitted as an instruction', async t => {
  const h = await setup(t);
  // A person writes the Task's files, as authorize lets them.
  const writer = () => ({ actor: { kind: 'human' }, task: h.task.id } as const);
  const saved = await saveTaskAttachment(h.root, h.task.id, 'Q-file', 'proof.png', Buffer.from('image'), globalThis.crypto.randomUUID(), writer);
  await removeTaskAttachment(h.root, h.task.id, 'Q-file', 'proof.png', globalThis.crypto.randomUUID(), writer);
  await assert.rejects(h.service.request({ taskId: h.task.id, body: `See this\n\n![proof.png](${saved.absolutePath})`,
    requestId: 'Q-file', expectedTaskHash: currentTaskHash(h.root, h.task.id), expectedPlacementRevision: h.placement.revision },
  human), (error: { code: string }) => error.code === 'conflict');
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  try { assert.equal(store.getRequest('Q-file'), null); } finally { store.close(); }
});

test('the conversation head is optional, but an explicit stale head is rejected', async t => {
  const h = await setup(t);
  const first = await h.service.request({ taskId: h.task.id, mode: 'new', body: 'First', requestId: 'Q1',
    expectedTaskHash: currentTaskHash(h.root, h.task.id), expectedPlacementRevision: 1 }, human);
  const second = await h.service.request({ taskId: h.task.id, body: 'Second', requestId: 'Q2',
    expectedTaskHash: currentTaskHash(h.root, h.task.id), expectedPlacementRevision: 1 }, human);
  assert.notEqual(second.runId, first.runId);
  await assert.rejects(h.service.request({ taskId: h.task.id, body: 'Third', requestId: 'Q3',
    expectedTaskHash: currentTaskHash(h.root, h.task.id), expectedPlacementRevision: 1, expectedHeadRunId: first.runId }, human),
    (error: { code: string; detail: { currentHeadRunId: string; preserveDraft: boolean } }) =>
      error.code === 'conflict' && error.detail.currentHeadRunId === second.runId && error.detail.preserveDraft);
});

test('scheduler rechecks placement before launching an accepted request', async t => {
  const h = await setup(t);
  const receipt = await h.service.request({ taskId: h.task.id, mode: 'new', body: 'Draft', requestId: 'Q1',
    expectedTaskHash: currentTaskHash(h.root, h.task.id), expectedPlacementRevision: 1 }, human);
  // Simulate recovery from a conflicting database state that bypassed PlacementCommands.
  const db = new DatabaseSync(join(h.root, '.alpacawork', 'alpacawork.sqlite'));
  try { db.prepare('UPDATE placements SET responsible=0, revision=2, ended_at=? WHERE id=?')
    .run(new Date().toISOString(), h.placement.id); }
  finally { db.close(); }
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  try {
    const decision = await settleTransaction(store, readAgentsSettings(h.root));
    try {
      assert.deepEqual(decision.launches, []);
      assert.deepEqual(decision.summary.skipped, [{ run: receipt.runId, reason: 'placement changed after request admission' }]);
    } finally { closeLaunches(decision.launches); }
    assert.equal(store.get(receipt.runId)?.state, 'queued');
  } finally { store.close(); }
});

/** The Runs of `root` start and end in the store, as their manager writes them; an agent takes what its Run carried. */
function runsOf(t: TestContext, root: string) {
  const store = new RunStore(root, { busyTimeoutMs: 1000 });
  t.after(() => store.close());
  const start = (id: string) => store.write(tx => tx.update({ ...tx.get(id)!, state: 'running',
    started_at: new Date().toISOString(), pids: { manager: 1, agent: 2 } }));
  const end = (id: string) => store.write(tx => tx.finish({ ...tx.get(id)!, state: 'succeeded', reason: null,
    ended_at: new Date().toISOString() }, { state: 'present', text: 'done' }));
  return { store, start, end };
}
const hashOf = async (root: string, taskId: string): Promise<string> => (await new ControlTaskStore(root).get(taskId)).hash;
/** A worker of Task `taskId`. */
function member(root: string, taskId: string): { id: string; revision: number } {
  const people = new PlacementStore(root);
  try { return people.createAndPlace({ taskId, profileKey: 'claude', responsible: false }).placement; }
  finally { people.close(); }
}
/** The Run `runId` of the Task's responsible `placementId` sends a Request, as its own placement. */
const fromRun = (placementId: string, runId: string) =>
  ({ purpose: 'instruction', actor: { kind: 'placement', placementId }, actorRunId: runId }) as const;
/** One router pass over the fixture's project. */
const route = (h: { root: string; project: string }): Promise<{ acceptedRequestIds: string[];
  held: { taskId: string; reason: string }[] }> => new ReturnRouter(h.root).pass(undefined, { project: h.project });

test('child creation emits no notice; a marked child is refused without consuming a Task ID', async t => {
  const h = await setup(t);
  const commands = new ControlTaskCommands(h.root, { kind: 'human' });
  const quiet = (await commands.create({ parentId: h.task.id, userRequested: false, tasks: [{ title: 'Planned' }] })).tasks[0];
  await assert.rejects(commands.create({ parentId: h.task.id, userRequested: true, tasks: [{ title: 'Added by the user' }] }),
    { code: 'invalid_input', reason: { kind: 'user_request_belongs_to_top' } });
  const { store } = runsOf(t, h.root);
  assert.deepEqual(store.readReturns(), []);
  assert.deepEqual((await route(h)).acceptedRequestIds, []);
  const next = (await commands.create({ parentId: h.project, userRequested: true, tasks: [{ title: 'Top' }] })).tasks[0];
  assert.equal(Number(next.id.slice(1)), Number(quiet.id.slice(1)) + 1);
});

test('a new responsible receives one handover notice and the common open work section', async t => {
  const h = await setup(t);
  const worker = member(h.root, h.task.id);
  const { store, start, end } = runsOf(t, h.root);
  const first = await h.service.request({ taskId: h.task.id, body: 'Do the work', requestId: 'Q1',
    expectedTaskHash: currentTaskHash(h.root, h.task.id), expectedPlacementRevision: h.placement.revision }, human);
  start(first.runId);
  await h.service.request({ taskId: h.task.id, targetPlacementId: worker.id, body: 'Investigate the cause',
    requestId: 'W1', expectedTaskHash: currentTaskHash(h.root, h.task.id), expectedPlacementRevision: worker.revision },
  fromRun(h.placement.id, first.runId));
  end(first.runId);
  assert.deepEqual((await route(h)).acceptedRequestIds, [], 'the Task works on while the Request it sent is open');
  const task = await new ControlTaskStore(h.root).get(h.task.id);
  assert.equal(task.meta.state, 'doing');
  const next = (await new PlacementCommands(h.root).placeNewResponsible({ taskId: h.task.id, profileKey: 'claude',
    expectedTaskHash: task.hash, replacePlacementId: h.placement.id, expectedPlacementRevision: h.placement.revision },
  { kind: 'human' })).placement;
  const changed = (await new ControlTaskStore(h.root).get(h.task.id)).meta.log.at(-1);
  assert.equal(changed?.kind, 'responsible_changed');
  assert.deepEqual(store.readReturns().filter(row => row.outcome === 'handover').map(row => [row.toTaskId, row.causeLogId]),
    [[h.task.id, changed?.id]]);
  const woke = await route(h);
  assert.equal(woke.acceptedRequestIds.length, 1);
  const run = store.get(store.getRequest(woke.acceptedRequestIds[0]!)!.runId!)!;
  assert.equal(run.placementId, next.id);
  const prompt = store.getText(run.id)?.prompt ?? '';
  assert.equal(prompt.split('you are now its owner').length, 2, 'the handover is told once, by its notice line');
  assert.ok(prompt.includes(`Member ${worker.id} (request W1 "Investigate the cause"`), 'it names the open Request');
  assert.equal(prompt.split('## Open work\n').length, 2, 'open work has one common section');
  assert.doesNotMatch(prompt, /^## .*handover/im);
});

test('a seat\'s own continuation is called by its last owner Run: it adds no depth, and a stop of the first Run reaches it', async t => {
  const h = await setup(t);
  const worker = member(h.root, h.task.id);
  const { store, start, end } = runsOf(t, h.root);
  const first = await h.service.request({ taskId: h.task.id, body: 'Do the work', requestId: 'Q1',
    expectedTaskHash: currentTaskHash(h.root, h.task.id), expectedPlacementRevision: h.placement.revision }, human);
  start(first.runId);
  let owner = first.runId;
  for (let round = 1; round <= 3; round++) {
    const work = await h.service.request({ taskId: h.task.id, targetPlacementId: worker.id, body: 'Investigate',
      requestId: `W${round}`, expectedTaskHash: await hashOf(h.root, h.task.id),
      expectedPlacementRevision: worker.revision }, fromRun(h.placement.id, owner));
    start(work.runId); end(work.runId); end(owner);
    const woke = await route(h);
    assert.equal(woke.acceptedRequestIds.length, 1, `round ${round}`);
    const next = store.get(store.getRequest(woke.acceptedRequestIds[0]!)!.runId!)!;
    assert.deepEqual([next.caller?.run, depth(store.snapshot(h.project).records ?? [], next)], [owner, 1], `round ${round}`);
    owner = next.id; start(owner);
  }
  const stopped = store.write(tx => stopRunsIn(store, tx, [first.runId]));
  assert.ok(stopped.result.stop_requested.includes(owner), 'a stop of the first Run reaches its latest continuation');
});

test('a seat stopped at its automatic limit is the user\'s turn, and the user\'s next Request carries what waited', async t => {
  const h = await setup(t, { automatic_per_placement: 1 });
  const workers = [member(h.root, h.task.id), member(h.root, h.task.id)];
  const { store, start, end } = runsOf(t, h.root);
  const delegate = async (worker: { id: string; revision: number }, caller: string, requestId: string) =>
    h.service.request({ taskId: h.task.id, targetPlacementId: worker.id, body: 'Investigate', requestId,
      expectedTaskHash: await hashOf(h.root, h.task.id), expectedPlacementRevision: worker.revision },
    fromRun(h.placement.id, caller));
  const first = await h.service.request({ taskId: h.task.id, body: 'Do the work', requestId: 'Q1',
    expectedTaskHash: currentTaskHash(h.root, h.task.id), expectedPlacementRevision: h.placement.revision }, human);
  start(first.runId);
  const one = await delegate(workers[0]!, first.runId, 'W1');
  start(one.runId); end(one.runId); end(first.runId);
  const woke = await route(h);
  assert.equal(woke.acceptedRequestIds.length, 1, 'the first automatic wake is within the limit');
  const second = store.getRequest(woke.acceptedRequestIds[0]!)!.runId!;
  start(second);
  const two = await delegate(workers[1]!, second, 'W2');
  start(two.runId); end(two.runId); end(second);
  const stopped = await route(h);
  assert.deepEqual(stopped.acceptedRequestIds, []);
  assert.ok(stopped.held.some(item => item.taskId === h.task.id && item.reason === 'automatic_limit'));
  const turn = userTurn((await readControlTree(h.root)).balls[h.task.id] ?? null);
  assert.deepEqual([turn?.reason, turn?.count], ['limit', 1]);
  const waiting = store.readReturns().find(row => row.requestId === two.requestId)!;
  assert.equal(returnDisposition(waiting), 'pending', 'nothing that waits is dropped');
  const resumed = await h.service.request({ taskId: h.task.id, body: 'Go on', requestId: 'Q2',
    expectedTaskHash: await hashOf(h.root, h.task.id), expectedPlacementRevision: h.placement.revision }, human);
  assert.equal(store.readReturns().find(row => row.id === waiting.id)?.deliveries.at(-1)?.wakeRequestId, 'Q2');
  assert.ok((store.getText(resumed.runId)?.prompt ?? '').includes(`Member ${workers[1]!.id}: succeeded`));
  assert.deepEqual((await route(h)).acceptedRequestIds, [], 'nothing else waits');
});

for (const prior of ['failed', 'cancelled'] as const) test(`a queued continuation of a seat whose last Run ${prior === 'failed' ? 'failed never launches (U2)' : 'was stopped launches: a stop is no failure'}`, async t => {
  const h = await setup(t);
  const first = await h.service.request({ taskId: h.task.id, mode: 'new', body: 'First', requestId: 'Q1',
    expectedTaskHash: currentTaskHash(h.root, h.task.id), expectedPlacementRevision: h.placement.revision }, human);
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  try {
    store.write(tx => {
      tx.update({ ...tx.get(first.runId)!, state: 'running', started_at: new Date().toISOString() });
      tx.finish({ ...tx.get(first.runId)!, state: prior, reason: prior === 'failed' ? 'output' : 'stopped',
        ended_at: new Date().toISOString() }, { state: 'missing', text: null });
    });
    // The server's own continuation of the seat, still queued.
    const next = store.write(tx => {
      const ended = tx.get(first.runId)!;
      tx.insertRequest({ id: 'Q-continue', taskId: h.task.id, placementId: h.placement.id,
        placementRevision: h.placement.revision, taskHash: h.task.hash, waitCycleId: null, headRunId: ended.id,
        mode: 'continue', body: 'Returns', purpose: 'return_continuation', author: { kind: 'placement', placementId: h.placement.id },
        submittedAt: new Date().toISOString(), deliveryState: 'queued' });
      grantFixtureRequest(store, tx, 'Q-continue');
      return tx.create({ task: h.task.id, placementId: h.placement.id, requestId: 'Q-continue', agent: ended.agent,
        role: 'owner', resumes: ended.id, continues: false, session: ended.session, caller: { run: ended.id },
        cwd: ended.cwd, launch: ended.launch }, 'Returns');
    });
    const decision = await settleTransaction(store, readAgentsSettings(h.root));
    try { assert.deepEqual(decision.launches.map(item => item.id), prior === 'failed' ? [] : [next.id]); }
    finally { closeLaunches(decision.launches); }
    assert.equal(store.get(next.id)?.state, prior === 'failed' ? 'queued' : 'running');
  } finally { store.close(); }
});


test('a router-selected wake is refused when another automatic admission reaches the limit before its fresh RequestService read', async t => {
  const h = await setup(t, { automatic_per_placement: 1 });
  const worker = member(h.root, h.task.id), { store, start, end } = runsOf(t, h.root);
  const first = await h.service.request({ taskId: h.task.id, body: 'Do the work', requestId: 'Q-before-race',
    expectedTaskHash: currentTaskHash(h.root, h.task.id), expectedPlacementRevision: h.placement.revision }, human);
  start(first.runId);
  const work = await h.service.request({ taskId: h.task.id, targetPlacementId: worker.id, body: 'Investigate', requestId: 'Q-race-work',
    expectedTaskHash: currentTaskHash(h.root, h.task.id), expectedPlacementRevision: worker.revision }, fromRun(h.placement.id, first.runId));
  start(work.runId); end(work.runId); end(first.runId);
  const original = RequestService.prototype.request;
  let raced = false, rejection: unknown, injectionError: unknown;
  const hook = t.mock.method(RequestService.prototype, 'request', async function(this: unknown,
    input: unknown, context: { purpose: string }) {
    if (context.purpose === 'return_continuation' && !raced) {
      raced = true;
      try { store.write(tx => {
        const id = 'Q-racing-automatic';
        tx.insertRequest({ id, taskId: h.task.id, placementId: h.placement.id, placementRevision: h.placement.revision,
          taskHash: currentTaskHash(h.root, h.task.id), waitCycleId: null, headRunId: first.runId, mode: 'continue',
          body: 'A different admitted continuation', purpose: 'return_continuation',
          author: { kind: 'placement', placementId: h.placement.id },
          submittedAt: new Date(Date.parse(tx.get(first.runId)!.created_at) + 1000).toISOString(), deliveryState: 'queued' });
        const run = createFixtureRun(store, tx, { task: h.task.id, placementId: h.placement.id, requestId: id,
          agent: 'claude', role: 'owner', resumes: first.runId, continues: false, session: null,
          caller: { run: first.runId }, cwd: h.root,
          launch: { adapter: 'codex', env: [], argv: ['never-launched'], path: '/bin', values: {} } }, 'Synthetic admitted work');
        tx.finish({ ...run, state: 'cancelled', reason: 'stopped', ended_at: new Date().toISOString() }, { state: 'missing', text: null });
      }); } catch (error) { injectionError = error; throw error; }
    }
    try { return await original.call(this, input, context); }
    catch (error) { rejection = error; throw error; }
  });
  const routed = await route(h);
  hook.mock.restore();
  assert.equal(raced, true, 'the router selected the wake before the competing admission');
  assert.equal(injectionError, undefined, String(injectionError));
  assert.deepEqual(routed.acceptedRequestIds, []);
  assert.match(String(rejection), /automatic_limit/, 'fresh admission refused for the limit itself, not a stale hash or busy head');
  assert.equal(store.readRequests().filter(request => request.purpose === 'return_continuation').length, 1,
    'the refused wake leaves only the competing accepted Request');
});
