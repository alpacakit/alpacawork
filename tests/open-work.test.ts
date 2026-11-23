/** Launch admission and the advertised CLI read share open work. No provider or production data is used. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { RequestReceipt } from '@alpacawork/contract/control';
import { PROTOCOL_LIMITS } from '@alpacawork/contract/run-protocol';
import { PlacementCommands } from '@alpacawork/backend/test-dist/control/placement-commands.js';
import { RequestService } from '@alpacawork/backend/test-dist/control/requests.js';
import { readTaskView } from '@alpacawork/backend/test-dist/control/task-views.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { assignResponsible, currentTaskHash } from './helpers/control-fixture.ts';
import { createFixtureRun } from './helpers/run-fixture.ts';
import { cliRun } from './helpers/http-cli.ts';
import { handlingFixture } from './return-handling.fixture.ts';
import { fields } from './runs-fixtures.ts';
import { POLL_INTERVAL_MS } from '@alpacawork/backend/test-dist/poll-interval.js';

type Fixture = Awaited<ReturnType<typeof handlingFixture>>;
type Placement = { id: string; revision: number };
const human = { purpose: 'instruction', actor: { kind: 'human' } } as const;
const count = (text: string, value: string) => text.split(value).length - 1;
const promptOf = (h: Fixture, receipt: RequestReceipt) => h.store.getText(receipt.runId)!.prompt;
const readOpen = (h: Fixture) => readTaskView(h.root, h.task.id, { include: ['openObligations'] as const }, null);
const instruction = (h: Fixture, placement: Placement, mode: 'new' | 'continue') => new RequestService(h.root).request({
  taskId: h.task.id, targetPlacementId: placement.id, body: 'Resume the assigned work', requestId: randomUUID(), mode,
  expectedTaskHash: currentTaskHash(h.root, h.task.id), expectedPlacementRevision: placement.revision,
}, human);

/** The same admission as delegation, with a distinct full body so headline-only retrieval cannot pass. */
const delegate = (h: Fixture, caller: string, placement: Placement, body: string) => new RequestService(h.root).request({
  taskId: h.task.id, targetPlacementId: placement.id, body, requestId: randomUUID(),
  expectedTaskHash: currentTaskHash(h.root, h.task.id), expectedPlacementRevision: placement.revision,
}, { purpose: 'instruction', actor: { kind: 'placement', placementId: h.owner.id }, actorRunId: caller });

function assertListedOnce(prompt: string, request: RequestReceipt, body: string) {
  assert.equal(count(prompt, '## Open work\n'), 1, 'one common section in the saved launch, including router text');
  assert.equal(count(prompt, `request ${request.requestId} "`), 1, 'the Request is not repeated by a handover notice');
  assert.ok(prompt.includes(body.split('\n')[0]!), prompt);
  assert.ok(prompt.includes(`Run ${request.runId}`), prompt);
}

/** As in return-repro.fixture, keep serve's automatic settle off while exercising only its formal HTTP reader. */
async function withCli(h: Fixture) {
  const interval = globalThis.setInterval;
  globalThis.setInterval = ((callback: Parameters<typeof setInterval>[0], ms?: number, ...args: unknown[]) =>
    interval(callback, ms === POLL_INTERVAL_MS ? 3600000 : ms, ...args)) as typeof setInterval;
  let app: Awaited<ReturnType<typeof startServer>>;
  try { app = await startServer(h.root, 0); }
  finally { globalThis.setInterval = interval; }
  return { call: (args: string[]) => cliRun(app.url, args), close: () => app.close() };
}

test('new owners get open work once, workers get none, and an ordinary continuation keeps its existing context', async t => {
  const h = await handlingFixture(t), first = await h.human();
  const initial = promptOf(h, first);
  assert.equal(count(initial, '## Open work\n'), 1);
  assert.match(initial, /No open requests\./);
  await h.start(first.runId);
  const body = 'Investigate the synthetic boundary\nKeep the full second line 😀\nAnd the last line.';
  const work = await delegate(h, first.runId, h.worker, body);
  assert.doesNotMatch(promptOf(h, work), /## Open work\n|Open requests/, 'members receive only their assignment');
  h.end(first.runId);

  const fresh = await instruction(h, h.owner, 'new');
  assert.equal(h.store.get(fresh.runId)!.resumes, null);
  assertListedOnce(promptOf(h, fresh), work, body);
  const view = await readOpen(h);
  assert.deepEqual(view.errors, []);
  assert.deepEqual(view.openObligations!.requests.map(request => [request.id, request.body, request.taskId,
    request.placementId, request.runId]), [[work.requestId, body, h.task.id, h.worker.id, work.runId]]);
  await h.start(fresh.runId); h.end(fresh.runId);
  const continued = await instruction(h, h.owner, 'continue');
  assert.equal(h.store.get(continued.runId)!.resumes, fresh.runId);
  assert.doesNotMatch(promptOf(h, continued), /## Open work\n/);
  assert.ok(!promptOf(h, continued).includes(`request ${work.requestId} "`));
});

test('a router handover into a new placement lists the same inherited work exactly once', async t => {
  const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId);
  const body = 'Continue the inherited investigation\nIts full instruction survives replacement.';
  const work = await delegate(h, first.runId, h.worker, body);
  h.end(first.runId); await h.pass();
  const next = (await new PlacementCommands(h.root).placeNewResponsible({ taskId: h.task.id, profileKey: 'fake',
    expectedTaskHash: (await h.current()).hash, replacePlacementId: h.owner.id,
    expectedPlacementRevision: h.owner.revision }, { kind: 'human' })).placement;
  const dispatched = await h.pass();
  assert.equal(dispatched.acceptedRequestIds.length, 1);
  const receipt = h.store.getRequest(dispatched.acceptedRequestIds[0]!)!;
  const run = h.store.get(receipt.runId!)!;
  assert.equal(run.placementId, next.id);
  assert.equal(run.resumes, null);
  const prompt = h.store.getText(run.id)!.prompt;
  assert.equal(count(prompt, 'you are now its owner'), 1);
  assertListedOnce(prompt, work, body);
  assert.deepEqual((await readOpen(h)).openObligations!.requests.map(request => request.id), [work.requestId]);
});

test('a former member resumes its own conversation as owner and receives the handover list once', async t => {
  const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId);
  const candidate = await h.delegate(first.runId); await h.start(candidate.runId); h.end(candidate.runId);
  const other = (await new PlacementCommands(h.root).placeMember({ taskId: h.task.id, profileKey: 'fake',
    expectedTaskHash: (await h.current()).hash, expectedResponsibleRevision: h.owner.revision }, { kind: 'human' })).placement;
  const body = 'Open after responsibility transfer\nDo not confuse the completed member Request with this one.';
  const work = await delegate(h, first.runId, other, body);
  h.end(first.runId); await h.reconcile();
  const promoted = (await new PlacementCommands(h.root).setResponsible({ taskId: h.task.id, placementId: h.worker.id,
    expectedTaskHash: (await h.current()).hash, expectedPlacementRevision: h.worker.revision }, { kind: 'human' })).placement;
  const dispatched = await h.pass();
  assert.equal(dispatched.acceptedRequestIds.length, 1);
  const run = h.store.get(h.runOf(dispatched.acceptedRequestIds[0]!))!;
  assert.equal(run.placementId, promoted.id);
  assert.equal(run.role, 'owner');
  assert.equal(run.resumes, candidate.runId, 'the handover uses the former member conversation');
  const prompt = h.store.getText(run.id)!.prompt;
  assert.equal(count(prompt, 'you are now its owner'), 1);
  assertListedOnce(prompt, work, body);
  const open = (await readOpen(h)).openObligations!;
  assert.deepEqual(open.requests.map(request => request.id), [work.requestId], 'a finished member Request is closed');
  assert.ok(open.returns.some(row => row.requestId === candidate.requestId), 'its unhandled result remains reachable');
});

test('a direct request carrying a handover also supplies open work into a continuing member conversation', async t => {
  const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId);
  const candidate = await h.delegate(first.runId); await h.start(candidate.runId); h.end(candidate.runId);
  const child = (await h.commands.create({ parentId: h.task.id, userRequested: false,
    tasks: [{ title: 'Synthetic child' }] })).tasks[0]!;
  const childOwner = await assignResponsible(h.root, child, 'fake');
  const body = 'Open child instruction\nThe destination is a child Task, not a member of this Task.';
  const work = await new RequestService(h.root).request({ taskId: child.id, body, requestId: randomUUID(),
    expectedTaskHash: currentTaskHash(h.root, child.id), expectedPlacementRevision: childOwner.revision },
  { purpose: 'instruction', actor: { kind: 'placement', placementId: h.owner.id }, actorRunId: first.runId });
  h.end(first.runId); await h.reconcile();
  const promoted = (await new PlacementCommands(h.root).setResponsible({ taskId: h.task.id, placementId: h.worker.id,
    expectedTaskHash: (await h.current()).hash, expectedPlacementRevision: h.worker.revision }, { kind: 'human' })).placement;
  // No router pass: this direct instruction takes the pending handover through carry, rather than reserve.
  const receipt = await instruction(h, promoted, 'continue');
  assert.equal(h.store.get(receipt.runId)!.resumes, candidate.runId);
  const prompt = promptOf(h, receipt);
  assertListedOnce(prompt, work, body);
  assert.ok(prompt.includes(`Child task ${child.id} (request ${work.requestId}`));
  assert.equal(count(prompt, 'you are now its owner'), 1);
  const open = (await readOpen(h)).openObligations!;
  assert.deepEqual(open.requests.map(request => [request.id, request.body, request.taskId, request.placementId, request.runId]),
    [[work.requestId, body, child.id, childOwner.id, work.runId]]);
});

test('a budgeted saved prompt advertises a formal CLI read that reaches every omitted full Request', async t => {
  const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId);
  const work = await h.delegate(first.runId);
  const { runId: _runId, ...template } = h.store.getRequest(work.requestId)!;
  // The existing low-level synthetic Run fixture keeps this a bounded data setup: no queue/provider executes.
  const seeded = h.store.write(tx => Array.from({ length: 1400 }, (_, index) => {
    const id = randomUUID(), body = `${'境'.repeat(40)} ${index}\nFull instruction ${index}: preserve this tail 😀`;
    tx.insertRequest({ ...template, id, body, headRunId: null, mode: 'new' });
    const run = createFixtureRun(h.store, tx, fields({ task: h.task.id, placementId: h.worker.id, requestId: id,
      agent: 'fake', role: 'worker', cwd: h.root, caller: { run: first.runId } }), 'Synthetic, never launched');
    return { id, body, taskId: h.task.id, placementId: h.worker.id, runId: run.id };
  }));
  h.end(first.runId);
  const fresh = await instruction(h, h.owner, 'new'), prompt = promptOf(h, fresh);
  assert.ok(Buffer.byteLength(prompt) <= PROTOCOL_LIMITS.prompt);
  assert.equal(count(prompt, '## Open work\n'), 1);
  assert.match(prompt, /Open requests: 1401; returns and notices not yet handled: \d+\. Too large to include/);
  assert.ok(!prompt.includes(seeded[0]!.id), 'the full list really exceeded the launch budget');
  const advertised = prompt.match(/alpacawork (task get --task T\d+ --include openObligations)/);
  assert.ok(advertised, prompt);
  const cli = await withCli(h);
  try {
    const result = await cli.call(advertised[1]!.split(' '));
    assert.equal(result.code, 0, result.stderr);
    const view = JSON.parse(result.stdout);
    assert.deepEqual(view.errors, []);
    assert.equal(view.openObligations.requests.length, seeded.length + 1, 'no hidden truncation in the explicit read');
    const actual = new Map<string, { id: string; body: string; taskId: string; placementId: string; runId: string }>(
      view.openObligations.requests.map((request: { id: string }) => [request.id, request]));
    for (const expected of seeded) {
      const request = actual.get(expected.id)!;
      assert.ok(request, expected.id);
      assert.deepEqual({ id: request.id, body: request.body, taskId: request.taskId,
        placementId: request.placementId, runId: request.runId }, expected);
    }
    assert.equal(actual.get(work.requestId)!.runId, work.runId);
  } finally { await cli.close(); }
});

test('an explicit open-work read keeps a closing return until it is consumed, without reopening its Request', async t => {
  const h = await handlingFixture(t), delivered = await h.deliver();
  const before = (await readOpen(h)).openObligations!;
  assert.deepEqual(before.requests, []);
  assert.deepEqual(before.returns.map(row => row.id), [delivered.answer.id]);
  await h.consume(delivered.run);
  const after = await readOpen(h);
  assert.deepEqual(after.errors, []);
  assert.deepEqual(after.openObligations, { requests: [], returns: [] });
});
