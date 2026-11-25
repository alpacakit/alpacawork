import { decideValues, seedValues } from './helpers/task-values.ts';
import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { stringify } from 'yaml';
/** Handoffs exercise the same report, request and W1–W3 router services used by the CLI. No agent is launched. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { handlingFixture } from './return-handling.fixture.ts';
import { assignResponsible } from './helpers/control-fixture.ts';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { taskReportInput } from '@alpacawork/contract/inputs';

type Fixture = Awaited<ReturnType<typeof handlingFixture>>;
const snapshot = { conclusion: 'Preserve the fixed result', remaining: ['Wait for the next group'],
  decide: [{ decide_question: 'Which group?', decide_choices: [{ decide_choice: 'Next', decide_choice_detail: 'Proceed' }] }],
  notes: 'The reasoning is in the fixed artifact.' };
const caller = (h: Fixture, runId: string) => ({ kind: 'run' as const, runId, placementId: h.owner.id,
  taskId: h.task.id, role: 'owner' as const, responsible: true });
async function report(h: Fixture, run: string, next = true, state: 'doing' | 'waiting' = 'doing', values: object = snapshot) {
  const input = { task: h.task.id, state, ...(state === 'waiting' ? { askTo: 'user' as const } : {}), title: 'Handoff ready', description: 'Read the fixed result',
    values, ...(next ? { nextConversation: 'new' as const } : {}), opId: randomUUID(), expectedTaskHash: (await h.current()).hash };
  await new TaskReportService(h.root).report(input, { kind: 'placement', placementId: h.owner.id }, caller(h, run));
  return input;
}
const result = (h: Fixture, id: string) => h.store.get(id)!;
// An automatic placement request cannot resolve uncertain delivery; user actors can.
const automaticRetry = async (h: Fixture, newConversation = false) => new TaskRequestService(h.root).request({
  task: h.task.id, body: 'Retry', ...(newConversation ? { newConversation } : {}), opId: randomUUID(),
  expectedTaskHash: (await h.current()).hash, expectedPlacementRevision: h.owner.revision },
{ kind: 'placement', placementId: h.owner.id }, caller(h, h.store.read().at(-1)!.id));


test('W0 uses a successful owner handoff once and keeps the snapshot in the new prompt', async t => {
  const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId);
  seedValues(h.root, h.task.id, { conclusion: 'Preserve the fixed result' });
  const input = await report(h, first.runId, true, 'waiting');
  assert.deepEqual((await h.current()).values, snapshot);
  assert.equal((await h.current()).meta.log.at(-1)?.checkpoint?.nextConversation, 'new');
  h.end(first.runId);
  const next = await h.human();
  assert.equal(result(h, next.runId).resumes, null);
  assert.notEqual(result(h, next.runId).session?.id, result(h, first.runId).session?.id);
  assert.equal(result(h, next.runId).context?.rotationFrom, input.opId);
  // History says why: the report that prepared it.
  assert.deepEqual(result(h, next.runId).newConversation, { because: 'handoff', report: input.opId });
  assert.match(h.store.getText(next.runId)!.prompt, /## Task\nThe task record as of when this request was accepted/);
  assert.match(h.store.getText(next.runId)!.prompt, /Preserve the fixed result/);
  await h.start(next.runId); h.end(next.runId);
  const third = await h.human();
  assert.equal(result(h, third.runId).resumes, next.runId, 'the old intent is not used a second time');
});

test('an explicit new instruction and the owner intent share one admission and do not rotate twice', async t => {
  const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId);
  await report(h, first.runId); h.end(first.runId);
  const before = h.store.read().length;
  const input = { task: h.task.id, body: 'Next group with a new conversation', newConversation: true,
    opId: randomUUID(), expectedTaskHash: (await h.current()).hash, expectedPlacementRevision: h.owner.revision };
  const service = new TaskRequestService(h.root), person = { kind: 'human' } as const;
  const accepted = await service.request(input, person, person);
  assert.equal(accepted.outcome.kind, 'request_accepted');
  if (accepted.outcome.kind !== 'request_accepted') throw new Error('Expected accepted Request');
  const next = result(h, accepted.outcome.request.runId);
  assert.equal(next.resumes, null);
  assert.equal(h.store.read().length, before + 1);
  assert.deepEqual(await service.request(input, person, person), accepted, 'same operation replays the same admission');
  assert.equal(h.store.read().length, before + 1);
  await h.start(next.id); h.end(next.id);
  const third = await h.human();
  assert.equal(result(h, third.runId).resumes, next.id, 'the old prepared intent is not reused after the new conversation');
});

test('W1 finishes a worker wait cycle into a new conversation; without intent it continues', async t => {
  for (const nextConversation of [true, false]) {
    const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId);
    const worker = await h.delegate(first.runId); await h.start(worker.runId);
    await report(h, first.runId, nextConversation);
    h.end(first.runId); await h.pass(); h.end(worker.runId);
    const dispatched = await h.pass(); assert.equal(dispatched.acceptedRequestIds.length, 1);
    const next = result(h, h.runOf(dispatched.acceptedRequestIds[0]!));
    assert.equal(next.resumes, nextConversation ? null : first.runId);
  }
});

test('W2 child question uses the same prepared handoff while other work remains open', async t => {
  for (const nextConversation of [true, false]) {
    const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId);
    const child = (await h.commands.create({ parentId: h.task.id, userRequested: false,
      tasks: [{ title: 'Child', values: { decide: [{ decide_question: 'Child choice?' }] } }] })).tasks[0];
    const tasks = new ControlTaskStore(h.root), owner = await assignResponsible(h.root, child, 'fake');
    const request = (await new TaskRequestService(h.root).request({ task: child.id, body: 'Investigate', opId: randomUUID(),
      expectedTaskHash: (await tasks.get(child.id)).hash, expectedPlacementRevision: owner.revision },
    { kind: 'placement', placementId: h.owner.id }, caller(h, first.runId))).outcome.request;
    await h.start(request.runId); await report(h, first.runId, nextConversation); h.end(first.runId); await h.pass();
    await new TaskReportService(h.root).report({ task: child.id, state: 'waiting', askTo: h.task.id, title: 'Choose', description: 'Please choose',
      opId: randomUUID(), expectedTaskHash: (await tasks.get(child.id)).hash }, { kind: 'placement', placementId: owner.id },
    { kind: 'run', runId: request.runId, placementId: owner.id, taskId: child.id, role: 'owner', responsible: true });
    const dispatched = await h.pass(); assert.equal(dispatched.acceptedRequestIds.length, 1);
    const next = result(h, h.runOf(dispatched.acceptedRequestIds[0]!));
    assert.equal(next.task, h.task.id); assert.equal(next.resumes, nextConversation ? null : first.runId);
    assert.match(h.store.getText(next.id)!.prompt, /Child choice/);
  }
});

test('W3 answers a question in a new conversation with the fixed question and answer', async t => {
  for (const nextConversation of [true, false]) {
    const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId);
    const input = await report(h, first.runId, nextConversation, 'waiting'); h.end(first.runId); await h.pass();
    await new TaskRequestService(h.root).request({ task: h.task.id, answers: input.opId, expectedTaskHash: (await h.current()).hash, expectedPlacementRevision: h.owner.revision,
      body: 'Use group two', opId: randomUUID() }, { kind: 'human' }, { kind: 'human' });
    const dispatched = await h.pass(); assert.equal(dispatched.acceptedRequestIds.length, 1);
    const next = result(h, h.runOf(dispatched.acceptedRequestIds[0]!));
    assert.equal(next.resumes, nextConversation ? null : first.runId); assert.match(h.store.getText(next.id)!.prompt, /Use group two/);
  }
});

test('a later joined instruction invalidates readiness, and a fresh report may prepare again', async t => {
  for (const refresh of [false, true]) {
    const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId);
    await report(h, first.runId);
    const joined = await h.human();
    h.store.write(tx => tx.update({ ...tx.get(joined.runId)!, state: 'joined', into: first.runId, ended_at: new Date().toISOString() }));
    if (refresh) await report(h, first.runId);
    h.end(first.runId);
    const next = await h.human(); assert.equal(result(h, next.runId).resumes, refresh ? null : first.runId);
  }
});

test('changing the values after preparation invalidates the old handoff', async t => {
  const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId);
  await report(h, first.runId);
  await h.commands.update({ id: h.task.id, values: { notes: 'Changed by the requester' }, expectedTaskHash: (await h.current()).hash });
  h.end(first.runId); const next = await h.human(); assert.equal(result(h, next.runId).resumes, first.runId);
});

test('a later ordinary owner report clears the previous preparation until it is reported again', async t => {
  const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId);
  await report(h, first.runId);
  await new TaskReportService(h.root).report({ task: h.task.id, state: 'doing', title: 'More work',
    opId: randomUUID(), expectedTaskHash: (await h.current()).hash },
  { kind: 'placement', placementId: h.owner.id }, caller(h, first.runId));
  h.end(first.runId); const next = await h.human();
  assert.equal(result(h, next.runId).resumes, first.runId);
});

test('a queued instruction refuses readiness atomically and an unsuccessful source Run never prepares a rotation', async t => {
  const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId);
  await report(h, first.runId);
  await h.human();
  const before = await h.current();
  await assert.rejects(report(h, first.runId), (error: { code: string }) => error.code === 'handoff_pending');
  assert.deepEqual(await h.current(), before);
  const standalone = await handlingFixture(t), source = await standalone.human(); await standalone.start(source.runId);
  await report(standalone, source.runId); standalone.end(source.runId, 'failed');
  const retry = await standalone.human(); assert.equal(result(standalone, retry.runId).resumes, source.runId);
});

test('failed reports roll back the values and witness, and replay preserves the original witness', async t => {
  const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId);
  const before = await h.current();
  await assert.rejects(new TaskReportService(h.root).report({ task: h.task.id, state: 'done', title: 'Complete', description: 'The saved result is ready.', values: snapshot,
    nextConversation: 'new', opId: randomUUID(), expectedTaskHash: 'f'.repeat(64) },
  { kind: 'placement', placementId: h.owner.id }, caller(h, first.runId)), (error: { code: string }) => error.code === 'conflict');
  assert.deepEqual(await h.current(), before);
  const input = await report(h, first.runId); const saved = await h.current();
  await new TaskReportService(h.root).report(input, { kind: 'placement', placementId: h.owner.id }, caller(h, first.runId));
  assert.deepEqual(await h.current(), saved);
});

test('a failed new launch retries new, but a proven first receipt keeps that new conversation', async t => {
  for (const taken of [false, true]) {
    const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId);
    await report(h, first.runId); h.end(first.runId);
    const next = await h.human();
    await h.start(next.runId);
    if (taken) {
      h.uncertain(next.runId);
      h.store.connection.prepare("UPDATE run_inputs SET state='taken'").run();
    }
    h.store.write(tx => tx.finish({ ...tx.get(next.runId)!, state: 'failed', reason: taken ? 'output' : 'launch',
      ended_at: new Date().toISOString() }, { state: 'missing', text: null }));
    const retry = await h.human(); assert.equal(result(h, retry.runId).resumes, taken ? next.runId : null);
  }
});

test('a failed rotation with unknown receipt never silently starts another conversation', async t => {
  const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId);
  await report(h, first.runId); h.end(first.runId); const next = await h.human();
  await h.start(next.runId); h.uncertain(next.runId); h.end(next.runId, 'failed');
  await assert.rejects(automaticRetry(h), (error: { code: string }) => error.code === 'handoff_pending');
  await assert.rejects(automaticRetry(h, true), (error: { code: string }) => error.code === 'handoff_pending');
  const recovered = await h.human();
  assert.equal(result(h, recovered.runId).resumes, next.runId);
  assert.equal(h.store.connection.prepare('SELECT state FROM run_inputs').get()!.state, 'resolved');
});

test('the contract requires atomic values with next-conversation and excludes confirmations and stops', () => {
  const base = { state: 'doing', expectedTaskHash: 'a'.repeat(64), nextConversation: 'new' };
  assert.equal(taskReportInput.safeParse(base).success, false);
  assert.equal(taskReportInput.safeParse({ ...base, values: snapshot }).success, true);
  assert.equal(taskReportInput.safeParse({ ...base, values: snapshot, state: 'stopped' }).success, false);
  assert.equal(taskReportInput.safeParse({ ...base, values: snapshot, state: 'done', aboutRun: 'R1', expectedPlacementRevision: 1 }).success, false);
});

test('child versions include values-only changes and finished children, and disappear only after acknowledged removal', async t => {
  const h = await handlingFixture(t);
  const child = (await h.commands.create({ parentId: h.task.id, userRequested: false,
    tasks: [{ title: 'Versioned child', values: { conclusion: 'Initial result' } }] })).tasks[0];
  const tasks = new ControlTaskStore(h.root);
  const first = await h.human(); await h.start(first.runId);
  const firstVersion = (await tasks.get(child.id)).hash;
  assert.equal(result(h, first.runId).context?.children[child.id], firstVersion);
  await report(h, first.runId); h.end(first.runId);
  await h.commands.update({ id: child.id, values: { conclusion: 'Corrected result' }, expectedTaskHash: firstVersion });
  await new TaskReportService(h.root).report({ task: child.id, state: 'stopped', opId: randomUUID(),
    expectedTaskHash: (await tasks.get(child.id)).hash }, { kind: 'human' }, { kind: 'human' });
  const second = await h.human(); await h.start(second.runId);
  const prompt = h.store.getText(second.runId)!.prompt;
  assert.match(prompt, /Changes since the snapshot/); assert.match(prompt, /Corrected result/); assert.match(prompt, /state stopped/);
  await report(h, second.runId); h.end(second.runId);
  await h.commands.move({ id: child.id, parentId: h.project, expectedTaskHash: (await tasks.get(child.id)).hash });
  const third = await h.human(); await h.start(third.runId);
  assert.match(h.store.getText(third.runId)!.prompt, /moved from under this parent, or deleted/);
  assert.equal(result(h, third.runId).context?.children[child.id], null);
  await report(h, third.runId); h.end(third.runId);
  const fourth = await h.human(); assert.doesNotMatch(h.store.getText(fourth.runId)!.prompt, /moved from under this parent, or deleted/);
});

test('an explicit new conversation still works without a prepared handoff', async t => {
  const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId); h.end(first.runId);
  const next = (await new TaskRequestService(h.root).request({ task: h.task.id, body: 'Next', newConversation: true,
    opId: randomUUID(), expectedTaskHash: (await h.current()).hash, expectedPlacementRevision: h.owner.revision },
  { kind: 'human' }, { kind: 'human' })).outcome.request;
  assert.equal(result(h, next.runId).resumes, null);
});

test('the CLI saves values and next-conversation through the authenticated HTTP report entry', async t => {
  const { openSync, constants, closeSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tryLock, unlock } = await import('@alpacawork/core');
  const { issueRunCredential } = await import('@alpacawork/backend/test-dist/control/credentials.js');
  const { startCliFixtureServer, cliSync } = await import('./helpers/http-cli.ts');
  const h = await handlingFixture(t), first = await h.human();
  h.store.prepareFolder(first.runId);
  const fd = openSync(join(h.store.folder(first.runId), 'manager.lock'), constants.O_RDWR | constants.O_CREAT);
  assert.ok(tryLock(fd));
  await h.start(first.runId);
  h.store.close(); // The actual serve, rather than this fixture writer, owns the control lease from here.
  const server = await startCliFixtureServer(h.root);
  try {
    const valuesFile = join(h.root, 'handoff.json'); writeFileSync(valuesFile, JSON.stringify(snapshot));
    const before = await h.current();
    const sent = cliSync(server.url, ['task', 'report', '--state', 'doing', '--values-file', valuesFile,
      '--next-conversation', 'new', '--title', 'Ready', '--expected-task-hash', before.hash, '--op-id', randomUUID()],
    { ALPACAWORK_RUN: first.runId, ALPACAWORK_RUN_TOKEN: issueRunCredential(h.root, first.runId) });
    assert.equal(sent.code, 0, sent.stderr);
    const after = await h.current(); assert.deepEqual(after.values, snapshot);
    assert.equal(after.meta.log.at(-1)?.checkpoint?.nextConversation, 'new');
    const { RunStore } = await import('@alpacawork/runs');
    const stored = new RunStore(h.root, { busyTimeoutMs: 1000 }, true);
    try { assert.equal(stored.read().length, 1, 'reporting does not start an extra Run'); }
    finally { stored.close(); }
  } finally { await server.stop(); unlock(fd); closeSync(fd); }
});


test('editing the snapshot never bypasses the unknown receipt of an already reserved rotation', async t => {
  for (const explicit of [false, true]) {
    const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId);
    await report(h, first.runId); h.end(first.runId); const next = await h.human();
    await h.start(next.runId); h.uncertain(next.runId); h.end(next.runId, 'failed');
    await h.commands.update({ id: h.task.id, values: { notes: 'Requester changed the snapshot' }, expectedTaskHash: (await h.current()).hash });
    await assert.rejects(automaticRetry(h, explicit),
    (error: { code: string }) => error.code === 'handoff_pending');
  }
});

test('joined inputs retain earlier child witnesses, including values changes and explicit removals', async t => {
  const h = await handlingFixture(t);
  const child = (await h.commands.create({ parentId: h.task.id, userRequested: false,
    tasks: [{ title: 'Child to move', values: { conclusion: 'Initial result' } }] })).tasks[0];
  const tasks = new ControlTaskStore(h.root);
  const first = await h.human(); await h.start(first.runId);
  const firstVersion = (await tasks.get(child.id)).hash;
  // No report before the joined input: it has neither an acknowledged base nor new child events.
  const join = async () => {
    const input = await h.human();
    h.store.write(tx => tx.update({ ...tx.get(input.runId)!, state: 'joined', into: first.runId, ended_at: new Date().toISOString() }));
    return input;
  };
  await join(); await report(h, first.runId);
  assert.equal((await h.current()).meta.log.at(-1)?.checkpoint?.children[child.id], firstVersion);
  await h.commands.update({ id: child.id, values: { conclusion: 'Latest result' }, expectedTaskHash: firstVersion });
  await join(); await report(h, first.runId);
  assert.equal((await h.current()).meta.log.at(-1)?.checkpoint?.children[child.id], (await tasks.get(child.id)).hash);
  await h.commands.move({ id: child.id, parentId: h.project, expectedTaskHash: (await tasks.get(child.id)).hash });
  const moved = await join(); assert.match(h.store.getText(moved.runId)!.prompt, /moved from under this parent, or deleted/);
  await report(h, first.runId);
  assert.equal((await h.current()).meta.log.at(-1)?.checkpoint?.children[child.id], undefined);
  await join(); await report(h, first.runId); h.end(first.runId);
  const next = await h.human(); assert.doesNotMatch(h.store.getText(next.runId)!.prompt, /moved from under this parent, or deleted/);
});


test('W0 with a saved snapshot but no new intent continues the existing conversation', async t => {
  const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId);
  await report(h, first.runId, false); h.end(first.runId);
  const next = await h.human(); assert.equal(result(h, next.runId).resumes, first.runId);
});


test('a joined input cannot hide the unknown first receipt of a failed new conversation', async t => {
  const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId);
  await report(h, first.runId); h.end(first.runId);
  const next = await h.human(); await h.start(next.runId); h.uncertain(next.runId);
  const joined = (await automaticRetry(h)).outcome.request;
  h.store.write(tx => tx.update({ ...tx.get(joined.runId)!, state: 'joined', into: next.runId, ended_at: new Date().toISOString() }));
  h.end(next.runId, 'failed');
  await assert.rejects(new TaskRequestService(h.root).request({ task: h.task.id, body: 'Retry', newConversation: true,
    opId: randomUUID(), expectedTaskHash: (await h.current()).hash, expectedPlacementRevision: h.owner.revision },
  { kind: 'human' }, { kind: 'human' }), (error: { code: string }) => error.code === 'handoff_pending');
});


test('later cancelled inputs and edited checkpoints never hide an unresolved reserved invocation', async t => {
  const { stopRunsIn } = await import('@alpacawork/backend/test-dist/runs/entry.js');
  for (const edit of ['none', 'values', 'checkpoint'] as const) {
    const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId);
    await report(h, first.runId); h.end(first.runId); const rotation = await h.human(); await h.start(rotation.runId);
    h.uncertain(rotation.runId);
    if (edit === 'values') await h.commands.update({ id: h.task.id, values: { notes: 'Edited' }, expectedTaskHash: (await h.current()).hash });
    if (edit === 'checkpoint') await report(h, rotation.runId);
    const queued = (await automaticRetry(h)).outcome.request;
    h.store.write(tx => stopRunsIn(h.store, tx, [queued.runId], randomUUID()));
    h.end(rotation.runId, 'failed');
    await assert.rejects(automaticRetry(h), (error: { code: string }) => error.code === 'handoff_pending');
    await assert.rejects(new TaskRequestService(h.root).request({ task: h.task.id, body: 'New', newConversation: true,
      opId: randomUUID(), expectedTaskHash: (await h.current()).hash, expectedPlacementRevision: h.owner.revision },
    { kind: 'human' }, { kind: 'human' }), (error: { code: string }) => error.code === 'handoff_pending');
    assert.equal(h.store.connection.prepare('SELECT state FROM run_inputs').get()!.state, 'uncertain', 'refusal never commits human resolution');
    const recovered = await h.human();
    assert.equal(result(h, recovered.runId).session?.id, result(h, rotation.runId).session?.id);
    assert.equal(h.store.connection.prepare('SELECT state FROM run_inputs').get()!.state, 'resolved');
  }
});

test('a proved unsent reservation retries new even after its snapshot changes', async t => {
  const { stopRunsIn } = await import('@alpacawork/backend/test-dist/runs/entry.js');
  for (const failure of ['before-start', 'launch', 'not-sent'] as const) {
    const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId);
    const input = await report(h, first.runId); h.end(first.runId); const next = await h.human();
    if (failure === 'before-start') h.store.write(tx => stopRunsIn(h.store, tx, [next.runId], randomUUID()));
    else {
      await h.start(next.runId);
      if (failure === 'not-sent') { h.uncertain(next.runId); h.store.connection.prepare("UPDATE run_inputs SET state='not_sent'").run(); }
      h.store.write(tx => tx.finish({ ...tx.get(next.runId)!, state: 'failed', reason: failure === 'launch' ? 'launch' : 'output',
        ended_at: new Date().toISOString() }, { state: 'missing', text: null }));
    }
    await h.commands.update({ id: h.task.id, values: { conclusion: 'Updated before retry' }, expectedTaskHash: (await h.current()).hash });
    const retry = await h.human();
    assert.equal(result(h, retry.runId).resumes, null, failure);
    assert.equal(result(h, retry.runId).context?.rotationFrom, input.opId, failure);
    assert.notEqual(result(h, retry.runId).session?.id, result(h, next.runId).session?.id);
  }
});

test('human resolution rolls back if the continued admission is refused', async t => {
  const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId);
  await report(h, first.runId); h.end(first.runId); const next = await h.human();
  await h.start(next.runId); h.uncertain(next.runId); h.end(next.runId, 'failed');
  await assert.rejects(new TaskRequestService(h.root).request({ task: h.task.id, body: 'Continue', cwd: '/a/different/place',
    opId: randomUUID(), expectedTaskHash: (await h.current()).hash, expectedPlacementRevision: h.owner.revision },
  { kind: 'human' }, { kind: 'human' }), (error: { code: string }) => error.code === 'invalid_input');
  assert.equal(h.store.connection.prepare('SELECT state FROM run_inputs').get()!.state, 'uncertain');
});


test('a human resolves the unknown reservation even when no provider session was obtained', async t => {
  const { writeFileSync } = await import('node:fs'); const { join } = await import('node:path');
  const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId);
  await report(h, first.runId); h.end(first.runId);
  writeFileSync(join(h.root, 'config.yaml'), stringify({ agents: { "fake": fixtureAgentSetting('codex') } }));
  const next = await h.human(); assert.equal(result(h, next.runId).session, null);
  await h.start(next.runId); h.uncertain(next.runId); h.end(next.runId, 'failed');
  const recovered = await h.human();
  assert.equal(result(h, recovered.runId).resumes, null);
  assert.equal(result(h, recovered.runId).context?.rotationFrom, result(h, next.runId).context?.rotationFrom);
  assert.equal(h.store.connection.prepare('SELECT state FROM run_inputs').get()!.state, 'resolved');
});


test('a successful result does not replace an explicitly unknown initial receipt', async t => {
  const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId);
  await report(h, first.runId); h.end(first.runId); const next = await h.human();
  await h.start(next.runId); h.uncertain(next.runId); h.end(next.runId);
  await assert.rejects(automaticRetry(h, true), (error: { code: string }) => error.code === 'handoff_pending');
});

test('a committed human resolution permits a later explicit new conversation', async t => {
  const { stopRunsIn } = await import('@alpacawork/backend/test-dist/runs/entry.js');
  const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId);
  await report(h, first.runId); h.end(first.runId); const next = await h.human();
  await h.start(next.runId); h.uncertain(next.runId);
  const handled = await h.human();
  assert.equal(h.store.connection.prepare('SELECT state FROM run_inputs').get()!.state, 'resolved');
  h.store.write(tx => stopRunsIn(h.store, tx, [handled.runId], randomUUID())); h.end(next.runId, 'failed');
  const fresh = (await new TaskRequestService(h.root).request({ task: h.task.id, body: 'Start the next group',
    newConversation: true, opId: randomUUID(), expectedTaskHash: (await h.current()).hash,
    expectedPlacementRevision: h.owner.revision }, { kind: 'human' }, { kind: 'human' })).outcome.request;
  assert.equal(result(h, fresh.runId).resumes, null);
});


test('an outside coordinator with no quote resolves unknown delivery while preserving the same provider conversation', async t => {
  const h = await handlingFixture(t), first = await h.human(); await h.start(first.runId);
  await report(h, first.runId); h.end(first.runId);
  const rotation = await h.human(); await h.start(rotation.runId); h.uncertain(rotation.runId); h.end(rotation.runId, 'failed');
  await assert.rejects(automaticRetry(h), { code: 'handoff_pending' });
  const recovered = (await new TaskRequestService(h.root).request({ task: h.task.id, body: 'User-directed continuation',
    opId: randomUUID(), expectedTaskHash: (await h.current()).hash, expectedPlacementRevision: h.owner.revision },
  { kind: 'main', provider: 'codex', conversationId: 'outside-without-hook-or-quote' },
  { kind: 'coordinator', source: 'codex', conversation: 'outside-without-hook-or-quote' })).outcome.request;
  assert.equal(result(h, recovered.runId).resumes, rotation.runId);
  assert.equal(h.store.connection.prepare('SELECT state FROM run_inputs').get()!.state, 'resolved');
});
