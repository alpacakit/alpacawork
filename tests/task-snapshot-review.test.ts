/** A historic completed Task is reviewed as a Task snapshot, without inventing a Run or a placement. */
import type { TestContext } from 'node:test';
import { evidenceTest as test, rememberEvidenceWorkspace } from './helpers/failure-workspace.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { readControlTree } from './helpers/control-tree.ts';
import { ControlStore } from '@alpacawork/db';
import { assignResponsible } from './helpers/control-fixture.ts';
import { callerWorkspace, claudeConversation, conversationHeaders, post } from './coordinator-caller.fixture.ts';
import { call, run } from './helpers/cli-session.ts';
import { patchTask } from '../e2e/fixture/task-state.ts';

const human = { kind: 'human' } as const;
type Workspace = ReturnType<typeof callerWorkspace>;
const words = 'Put this completed task back into review; then approve the result';
const conversation = 'snapshot-review-coordinator';
const coordinator = claudeConversation(conversation);

/** Historical fixture only: no production workspace, and no synthetic Run. All transitions under test use CLI/HTTP. */
async function historical(w: Workspace, title = 'Earlier review equivalent', options: { parentId?: string; userRequested?: boolean } = {}) {
  const task = (await new ControlTaskCommands(w.root, human).create({ parentId: options.parentId ?? w.project,
    userRequested: options.userRequested ?? options.parentId === undefined, tasks: [{ title, body: 'Previously completed and independently checked.' }] })).tasks[0];
  patchTask(w.root, task.id, { state: 'done', logs: [{ id: randomUUID(), kind: 'reported', at: new Date().toISOString(),
    title: 'Historical completion', description: null, actor: human, fromState: 'todo', toState: 'done' }] });
  return new ControlTaskStore(w.root).get(task.id);
}
const reportHttp = (url: string, input: object, headers: Record<string, string> = {}) => {
  const opId = randomUUID();
  return post(url, '/api/commands/task/report', input, { ...headers, 'X-Alpacawork-Op-Id': opId });
};
const get = (url: string, id: string) => call(url, ['task', 'get', '--task', id, '--log', '100']);
const reportArgs = (id: string, state: string, hash: string) =>
  ['task', 'report', '--task', id, '--state', state, '--expected-task-hash', hash];
async function refused(url: string, args: string[], env = {}, code = 'conflict') {
  const result = await run(url, args, env);
  assert.notEqual(result.code, 0, result.stdout);
  const problem = JSON.parse(result.stderr).error;
  assert.equal(problem.code, code, JSON.stringify(problem));
  return problem;
}
async function opened(t: TestContext) {
  const w = callerWorkspace(t), task = await historical(w), url = await w.start();

  return { w, task, url };
}

test('CLI reopens an unassigned completed Task for review, then confirms only its shown Task hash', async t => {
  const { w, task, url } = await opened(t);
  const before = await readControlTree(w.root);
  const waiting = await call(url, [...reportArgs(task.id, 'waiting', task.hash), '--quote', words], coordinator);
  assert.equal(waiting.task.state, 'waiting');
  const shown = await get(url, task.id), tree = await readControlTree(w.root);
  assert.equal(shown.task.log.at(-1).kind, 'reported');
  assert.equal(shown.task.log.at(-1).runId ?? null, null);
  assert.equal(shown.task.log.at(-1).actor.quote, words);
  assert.equal(shown.reviewRun, null);
  assert.deepEqual(shown.questions, []);
  const ball = tree.balls[task.id];
  assert.ok(ball?.holder === 'user');
  assert.equal(ball.reason, 'review');
  assert.equal(ball.aboutRunId, null);
  assert.deepEqual(tree.runs, before.runs);
  assert.equal(tree.placements.filter(each => each.taskId === task.id).length, 0);
  const done = await call(url, [...reportArgs(task.id, 'done', shown.task.hash), '--quote', words], coordinator);
  assert.equal(done.task.state, 'done');
  const approved = (await get(url, task.id)).task.log.at(-1);
  assert.equal(approved.kind, 'review_approved');
  assert.equal(approved.runId ?? null, null);
  assert.deepEqual((await readControlTree(w.root)).runs, before.runs);
});

test('coordinator review submission and confirmation need no quote matching, while stale decisions change nothing', async t => {
  for (const quote of [undefined, 'These words were never said']) {
    const { task, url } = await opened(t);
    const waiting = await call(url, [...reportArgs(task.id, 'waiting', task.hash),
      ...(quote === undefined ? [] : ['--quote', quote])], coordinator);
    assert.equal(waiting.task.state, 'waiting');
    const before = await get(url, task.id);
    assert.equal(before.task.log.at(-1).actor.quote, quote);
    await refused(url, reportArgs(task.id, 'done', task.hash), coordinator, 'conflict');
    assert.deepEqual(await get(url, task.id), before);
    const done = await reportHttp(url, { task: task.id, state: 'done', expectedTaskHash: waiting.task.hash,
      ...(quote === undefined ? {} : { quote }) }, conversationHeaders(conversation));
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.task.state, 'done');
    assert.equal((await get(url, task.id)).task.log.at(-1).actor.quote, quote);
  }
});

test('both snapshot operations replay unchanged, conflict on different input, and reject a fresh stale decision', async t => {
  const { task, url } = await opened(t);
  for (const state of ['waiting', 'done']) {
    const hash = (await get(url, task.id)).task.hash, opId = randomUUID();
    const args = [...reportArgs(task.id, state, hash), '--title', `${state} decision`, '--op-id', opId, '--quote', words];
    const first = await call(url, args, coordinator);
    const after = await get(url, task.id);
    assert.deepEqual(await call(url, args, coordinator), first);
    assert.deepEqual(await get(url, task.id), after);
    await refused(url, args.map(arg => arg === `${state} decision` ? 'Other decision' : arg), coordinator, 'idempotency_conflict');
    assert.deepEqual(await get(url, task.id), after);
    const stale = await run(url, [...reportArgs(task.id, state, hash), '--quote', words], coordinator);
    assert.notEqual(stale.code, 0);
    // Once approved, a fresh targetless done is outside the proxy's duty as well as carrying an old hash.
    assert.ok(['conflict', 'forbidden'].includes(JSON.parse(stale.stderr).error.code), stale.stderr);
    assert.deepEqual(await get(url, task.id), after);
  }
});

test('hash changes refuse submission and approval; a Task review rejects any supplied Run identity', async t => {
  const { w, task, url } = await opened(t);
  const changed = await new ControlTaskCommands(w.root, human).update({ id: task.id, title: 'Revised historic result', expectedTaskHash: task.hash });
  await refused(url, reportArgs(task.id, 'waiting', task.hash));
  const waiting = await call(url, reportArgs(task.id, 'waiting', changed.task.hash));
  await refused(url, [...reportArgs(task.id, 'done', waiting.task.hash), '--about-run', 'R999999', '--expected-placement-revision', '1']);
  const updated = await new ControlTaskCommands(w.root, human).update({ id: task.id, title: 'Changed since shown', expectedTaskHash: waiting.task.hash });
  await refused(url, reportArgs(task.id, 'done', waiting.task.hash));
  assert.equal((await get(url, task.id)).task.hash, updated.task.hash);
});

test('placement changes invalidate the shown snapshot through the Task hash', async t => {
  const { w, task, url } = await opened(t);
  const waiting = await call(url, reportArgs(task.id, 'waiting', task.hash));
  await assignResponsible(w.root, { id: task.id, hash: waiting.task.hash }, 'codex');
  await refused(url, reportArgs(task.id, 'done', waiting.task.hash));
  const latest = await get(url, task.id);
  assert.notEqual(latest.task.hash, waiting.task.hash);
  assert.equal((await call(url, reportArgs(task.id, 'done', latest.task.hash))).task.state, 'done');
});

test('a snapshot receives an ordinary instruction after a responsible is placed, with no invented target Run', async t => {
  const { w, task, url } = await opened(t);
  const waiting = await call(url, reportArgs(task.id, 'waiting', task.hash));
  const placement = await assignResponsible(w.root, { id: task.id, hash: waiting.task.hash }, 'codex');
  const shown = await get(url, task.id);
  const sent = await call(url, ['task', 'request', '--task', task.id, '--instruction-file', '-',
    '--expected-task-hash', shown.task.hash, '--expected-placement-revision', String(placement.revision),
    '--quote', words], coordinator, 'Please revise this result');
  assert.equal(sent.outcome.kind, 'request_accepted');
  const latest = await get(url, task.id);
  const accepted = latest.task.log.find((each: { id: string }) => each.id === sent.outcome.opId);
  assert.ok(accepted);
  assert.equal(accepted.kind, 'request_accepted');
  assert.equal(accepted.runId, undefined);
  assert.equal(accepted.actor.quote, words);
  assert.equal(sent.task.state, 'doing', 'request acceptance invalidates the snapshot review');
  assert.ok(sent.outcome.request.runId, 'the new Run does real requested work, rather than representing the prior result');
});

test('hold and unhold preserve a Task snapshot review instead of converting it into a question or Run review', async t => {
  const { w, task, url } = await opened(t);
  const waiting = await call(url, reportArgs(task.id, 'waiting', task.hash));
  const held = await call(url, reportArgs(task.id, 'held', waiting.task.hash));
  const restored = await call(url, reportArgs(task.id, 'waiting', held.task.hash));
  const shown = await get(url, task.id);
  assert.deepEqual(shown.questions, []);
  assert.equal(shown.reviewRun, null);
  const ball = (await readControlTree(w.root)).balls[task.id];
  assert.ok(ball?.holder === 'user');
  assert.equal(ball.reason, 'review');
  assert.equal(ball.aboutRunId, null);
  assert.equal((await call(url, reportArgs(task.id, 'done', restored.task.hash))).task.state, 'done');
});

test('snapshot review does not erase the user-request boundary or unfinished children', async t => {
  const w = callerWorkspace(t);
  const internal = await historical(w, 'Internal task', { userRequested: false });
  const commands = new ControlTaskCommands(w.root, human);
  const unfinished = (await commands.create({ parentId: w.project, userRequested: true,
    tasks: [{ title: 'Has unfinished child' }] })).tasks[0];
  await assignResponsible(w.root, unfinished, 'codex');
  await commands.create({ parentId: unfinished.id, userRequested: false, tasks: [{ title: 'Still todo' }] });
  patchTask(w.root, unfinished.id, { state: 'done' });
  const url = await w.start();
  for (const task of [internal, unfinished]) {
    const current = await get(url, task.id);
    const result = await run(url, reportArgs(task.id, 'waiting', current.task.hash));
    assert.notEqual(result.code, 0, `must reject ${task.id}: ${result.stdout}`);
    assert.equal((await get(url, task.id)).task.hash, current.task.hash);
  }
});

for (const role of ['owner', 'worker'] as const) test(`a normal ${role} Run cannot manage another completed Task or confirm its snapshot`, async t => {
  const w = callerWorkspace(t), target = await historical(w);
  const own = (await new ControlTaskCommands(w.root, human).create({ parentId: w.project, userRequested: false,
    tasks: [{ title: 'Ordinary agent work' }] })).tasks[0];
  const placement = await assignResponsible(w.root, own, 'codex');
  const held = w.heldRun({ task: own.id, placementId: placement.id, role });
  const url = await w.start();
  await refused(url, reportArgs(target.id, 'waiting', target.hash), held.env, 'forbidden');
  const waiting = await call(url, reportArgs(target.id, 'waiting', target.hash));
  await refused(url, reportArgs(target.id, 'done', waiting.task.hash), held.env, 'forbidden');
  assert.equal((await get(url, target.id)).task.state, 'waiting');
});

// These historic inconsistencies must be refused by the same finish constraints as an ordinary done report.
test('an unresolved question cannot be hidden by submitting a historical completed Task for review', async t => {
  const w = callerWorkspace(t);
  const { askUser } = await import('./coordinator-caller.fixture.ts');
  const asked = await askUser(w.root, w.project, 'codex');
  patchTask(w.root, asked.task, { state: 'done' });
  const url = await w.start(), before = await get(url, asked.task);
  const problem = await refused(url, reportArgs(asked.task, 'waiting', before.task.hash), {}, 'unavailable');
  assert.match(problem.message, /Reply-wait invariant/);
  assert.deepEqual(await get(url, asked.task), before);
});

test('a queued unfinished Run blocks snapshot submission even when the recorded Task was historically done', async t => {
  const w = callerWorkspace(t), task = await historical(w);
  const placement = await assignResponsible(w.root, task, 'codex');
  w.heldRun({ task: task.id, placementId: placement.id, running: false });
  const url = await w.start(), before = await get(url, task.id);
  const problem = await refused(url, reportArgs(task.id, 'waiting', before.task.hash), {}, 'handoff_pending');
  assert.equal(problem.reason.kind, 'runs_on_or_below_unfinished');
  assert.deepEqual(await get(url, task.id), before);
});

test('a historical completed parent still needs a responsible before snapshot review even when every child is done', async t => {
  const w = callerWorkspace(t), commands = new ControlTaskCommands(w.root, human);
  const parent = (await commands.create({ parentId: w.project, userRequested: true,
    tasks: [{ title: 'Completed parent with a completed child' }] })).tasks[0];
  const owner = await assignResponsible(w.root, parent, 'codex');
  await historical(w, 'Completed child', { parentId: parent.id });
  patchTask(w.root, parent.id, { state: 'done' });
  // Historical state only: normal release already refuses to uncover a parent.
  const control = new ControlStore(w.root);
  try {
    control.write(db => {
      db.prepare('UPDATE placements SET ended_at=?,revision=revision+1 WHERE id=?')
        .run(new Date().toISOString(), owner.id);
      db.prepare("INSERT INTO return_resolutions(return_id,reason,at) SELECT id,'migrated_handled',? FROM returns WHERE to_task_id=?")
        .run(new Date().toISOString(), parent.id);
    });
  } finally { control.close(); }
  const url = await w.start(), before = await get(url, parent.id);
  await refused(url, reportArgs(parent.id, 'waiting', before.task.hash), {}, 'responsible_missing');
  assert.deepEqual(await get(url, parent.id), before);
});
