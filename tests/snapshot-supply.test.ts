/** Complete prompt supply, provider receipt and owner acceptance are separate witnesses. No provider is launched. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { handlingFixture } from './return-handling.fixture.ts';
import { DEFAULT_SCHEMA, type TaskValues } from '@alpacawork/contract';
import { writeValues } from './helpers/task-values.ts';
import { runNumber } from '@alpacawork/contract/run';
import { MAX_INSTRUCTION_BYTES } from '@alpacawork/raw';
import { RequestService } from '@alpacawork/backend/test-dist/control/requests.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';

type Fixture = Awaited<ReturnType<typeof handlingFixture>>;
const VALUES: TaskValues = { conclusion: 'Keep the verified result', remaining: ['Reproduce the failure'],
  notes: 'The current next step and its evidence.' };
const SAME = /Same version as the record this conversation was already given in full/;
async function fixture(t: TestContext, values = VALUES) {
  const h = await handlingFixture(t);
  setValues(h, values);
  return h;
}
const setValues = (h: Fixture, values: TaskValues) => writeValues(h.root, h.task.id, values);
const replaced = (from: string, to: string): TaskValues => ({ ...VALUES, conclusion: (VALUES.conclusion as string).replace(from, to) });
const prompt = (h: Fixture, id: string) => h.store.getText(id)!.prompt;
const record = (h: Fixture, id: string) => h.store.get(id)!;
async function request(h: Fixture, options: { mode?: 'new'; body?: string; caller?: string } = {}) {
  return new RequestService(h.root).request({ taskId: h.task.id, requestId: randomUUID(),
    body: options.body ?? 'Continue the work', ...(options.mode ? { mode: options.mode } : {}),
    expectedTaskHash: (await h.current()).hash, expectedPlacementRevision: h.owner.revision }, options.caller
    ? { purpose: 'instruction', actor: { kind: 'placement', placementId: h.owner.id }, actorRunId: options.caller }
    : { purpose: 'instruction', actor: { kind: 'human' } });
}
function receipt(h: Fixture, id: string, state = 'taken', into = id) {
  const db = h.store.connection;
  let attempt = db.prepare('SELECT attempt_id FROM run_attempts WHERE run_no=?').get(runNumber(into))?.attempt_id;
  if (!attempt) {
    attempt = randomUUID();
    db.prepare('INSERT INTO run_attempts(run_no,attempt_id,launch_json) VALUES (?,?,?)').run(runNumber(into), attempt, '{}');
  }
  db.prepare('INSERT INTO run_inputs(input_id,attempt_id,instruction_run_no,content_digest,state,initial) VALUES (?,?,?,?,?,?)')
    .run(randomUUID(), attempt, runNumber(id), 'a'.repeat(64), state, into === id ? 1 : 0);
}
async function finishTaken(h: Fixture, id: string) {
  await h.start(id); receipt(h, id); h.end(id);
}

test('a complete taken supply shortens the same rendered snapshot, and shortened inputs never certify a full supply', async t => {
  const h = await fixture(t), first = await request(h);
  const supplied = record(h, first.runId).context!.suppliedSnapshot;
  assert.match(supplied!, /^[a-f0-9]{64}$/);
  assert.match(prompt(h, first.runId), /Keep the verified result/);
  await finishTaken(h, first.runId);
  const second = await request(h);
  assert.equal(record(h, second.runId).resumes, first.runId);
  assert.match(prompt(h, second.runId), SAME);
  assert.doesNotMatch(prompt(h, second.runId), /Keep the verified result/);
  assert.ok(prompt(h, second.runId).includes(`alpacawork task get --task ${h.task.id}`));
  assert.equal(record(h, second.runId).context!.suppliedSnapshot, undefined);
  assert.deepEqual(record(h, second.runId).context!.children, {});
  await finishTaken(h, second.runId);
  const third = await request(h);
  assert.match(prompt(h, third.runId), SAME, 'the original complete receipt remains in this conversation');
  assert.equal(record(h, third.runId).context!.suppliedSnapshot, undefined);
  const afterQueued = await request(h);
  assert.doesNotMatch(prompt(h, afterQueued.runId), SAME, 'an unreceived newer input stops the search for an older supply');
  assert.ok(record(h, afterQueued.runId).context!.suppliedSnapshot);
});

test('a changed rendered snapshot and every new conversation receive a complete supply', async t => {
  const h = await fixture(t), first = await request(h);
  await finishTaken(h, first.runId);
  setValues(h, replaced('verified result', 'updated evidence'));
  const changed = await request(h);
  assert.doesNotMatch(prompt(h, changed.runId), SAME);
  assert.match(prompt(h, changed.runId), /updated evidence/);
  assert.notEqual(record(h, changed.runId).context!.suppliedSnapshot, record(h, first.runId).context!.suppliedSnapshot);
  await finishTaken(h, changed.runId);
  setValues(h, VALUES);
  const restored = await request(h);
  assert.doesNotMatch(prompt(h, restored.runId), SAME, 'compare the latest complete supply, rather than any older matching one');
  await finishTaken(h, restored.runId);
  const fresh = await request(h, { mode: 'new' });
  assert.equal(record(h, fresh.runId).resumes, null);
  assert.doesNotMatch(prompt(h, fresh.runId), SAME);
  assert.equal(record(h, fresh.runId).context!.suppliedSnapshot, record(h, restored.runId).context!.suppliedSnapshot);
  // An older-format Run in the new conversation has no supply witness. Do not search the prior conversation.
  await h.start(fresh.runId);
  h.store.write(tx => tx.update({ ...tx.get(fresh.runId)!, context: { children: {} } }));
  receipt(h, fresh.runId); h.end(fresh.runId);
  const afterLegacy = await request(h);
  assert.doesNotMatch(prompt(h, afterLegacy.runId), SAME);
  assert.match(prompt(h, afterLegacy.runId), /Keep the verified result/);
  assert.ok(record(h, afterLegacy.runId).context!.suppliedSnapshot);
});

test('an absent, queued or unproved receipt cannot replace a complete snapshot', async t => {
  // A queued head is its own branch; the rest are no taken receipt, or none settled (suppliedSnapshotForRequest).
  for (const state of ['missing', 'queued', 'uncertain', 'not_sent', 'resolved']) {
    const h = await fixture(t), first = await request(h);
    if (state !== 'queued') await h.start(first.runId);
    if (state !== 'missing' && state !== 'queued') receipt(h, first.runId, state);
    const next = await request(h, { caller: first.runId });
    assert.doesNotMatch(prompt(h, next.runId), SAME, state);
    assert.match(prompt(h, next.runId), /Keep the verified result/, state);
    assert.ok(record(h, next.runId).context!.suppliedSnapshot, state);
  }
});

test('any unresolved receipt prevents shortening even when a taken receipt is also present', async t => {
  const h = await fixture(t), first = await request(h); await h.start(first.runId);
  receipt(h, first.runId);
  // The normal reservation index prevents this mixed legacy/corrupt state; the reader remains conservative.
  h.store.connection.exec('DROP INDEX run_inputs_reservation');
  const attempt = h.store.connection.prepare('SELECT attempt_id FROM run_attempts WHERE run_no=?').get(runNumber(first.runId))!.attempt_id;
  h.store.connection.prepare('INSERT INTO run_inputs(input_id,attempt_id,instruction_run_no,content_digest,state,initial) VALUES (?,?,?,?,?,0)')
    .run(randomUUID(), attempt, runNumber(first.runId), 'a'.repeat(64), 'uncertain');
  const next = await request(h, { caller: first.runId });
  assert.doesNotMatch(prompt(h, next.runId), SAME);
  assert.match(prompt(h, next.runId), /Keep the verified result/);
});

test('a prior fit fallback does not certify a full snapshot', async t => {
  const h = await fixture(t, { conclusion: 'Keep the verified result', notes: 'x'.repeat(270_000) });
  const fallback = await request(h, { body: 'x'.repeat(MAX_INSTRUCTION_BYTES) });
  assert.match(prompt(h, fallback.runId), /Too large to include\. Read it with alpacawork task get/);
  assert.equal(record(h, fallback.runId).context!.suppliedSnapshot, undefined);
  await finishTaken(h, fallback.runId);
  const retried = await request(h);
  assert.doesNotMatch(prompt(h, retried.runId), SAME);
  assert.equal(record(h, retried.runId).context!.suppliedSnapshot, undefined);
});

test('joined supply requires the joined input receipt and remains inside the conversation it joined', async t => {
  for (const taken of [false, true]) {
    const h = await fixture(t), first = await request(h); await h.start(first.runId); receipt(h, first.runId);
    setValues(h, replaced('verified result', 'joined evidence'));
    const joined = await request(h, { caller: first.runId });
    h.store.write(tx => tx.update({ ...tx.get(joined.runId)!, state: 'joined', into: first.runId,
      ended_at: new Date().toISOString() }));
    receipt(h, joined.runId, taken ? 'taken' : 'uncertain', first.runId);
    const next = await request(h, { caller: first.runId });
    assert.equal(record(h, next.runId).resumes, first.runId);
    if (taken) {
      assert.match(prompt(h, next.runId), SAME);
      assert.equal(record(h, next.runId).context!.suppliedSnapshot, undefined);
    } else {
      assert.doesNotMatch(prompt(h, next.runId), SAME);
      assert.match(prompt(h, next.runId), /joined evidence/);
    }
  }
});

test('a change of the project\'s schema changes the rendered version', async t => {
  const h = await fixture(t), first = await request(h); await finishTaken(h, first.runId);
  const tasks = new ControlTaskStore(h.root);
  await h.commands.setSchema({ task: h.project, fields: [...DEFAULT_SCHEMA].reverse(),
    expectedTaskHash: (await tasks.get(h.project)).hash });
  const changed = await request(h);
  assert.doesNotMatch(prompt(h, changed.runId), SAME);
  assert.notEqual(record(h, changed.runId).context!.suppliedSnapshot, record(h, first.runId).context!.suppliedSnapshot);
});

test('snapshot supply never changes the child acceptance checkpoint or next-conversation choice', async t => {
  const h = await fixture(t);
  const child = (await h.commands.create({ parentId: h.task.id, userRequested: false,
    tasks: [{ title: 'Fixed child', values: { conclusion: 'Child evidence' } }] })).tasks[0];
  const first = await request(h); await h.start(first.runId); receipt(h, first.runId);
  const children = record(h, first.runId).context!.children;
  const values = (await h.current()).values;
  const report = await new TaskReportService(h.root).report({ task: h.task.id, state: 'doing', values,
    opId: randomUUID(), expectedTaskHash: (await h.current()).hash }, { kind: 'placement', placementId: h.owner.id },
  { kind: 'run', runId: first.runId, placementId: h.owner.id, taskId: h.task.id, role: 'owner', responsible: true });
  const saved = await h.current();
  assert.equal(saved.meta.log.at(-1)!.checkpoint!.children[child.id], children[child.id]);
  assert.equal(saved.meta.log.at(-1)!.checkpoint!.nextConversation, undefined);
  h.end(first.runId);
  const next = await request(h);
  assert.equal(record(h, next.runId).resumes, first.runId);
  assert.match(prompt(h, next.runId), SAME);
  assert.equal(record(h, next.runId).context!.snapshotFrom, saved.meta.log.at(-1)!.id);
  assert.equal(record(h, next.runId).context!.suppliedSnapshot, undefined);
  assert.deepEqual(record(h, next.runId).context!.children, {});
  assert.ok(report);
});
