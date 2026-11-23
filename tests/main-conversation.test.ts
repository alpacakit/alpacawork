import { coordinatorSnapshotSchema } from '@alpacawork/contract/coordinator';
/**
 * Who calls (resolveCaller) and what the coordinator writes as main. A Run is its credential's while it is a current
 * placement; a Task Run's own conversation is never the coordinator; the conversation a coordinator Run runs in is the
 * screen's; any other is an outside conversation, which writes immediately and records an optional quote.
 */
import { test } from 'node:test';
import { currentTaskLog } from './helpers/control-fixture.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RunStore } from '@alpacawork/runs';
import { ControlStore } from '@alpacawork/db';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ControlTaskStore, TaskRepository } from '@alpacawork/backend/test-dist/control/task-store.js';
import { PlacementCommands } from '@alpacawork/backend/test-dist/control/placement-commands.js';
import { issueRunCredential, resolveCaller } from '@alpacawork/backend/test-dist/control/credentials.js';
import { dialoguesOf } from '@alpacawork/backend/test-dist/coordinator/messages.js';
import { CoordinatorConversation } from '@alpacawork/backend/test-dist/coordinator/conversation.js';
import { assignResponsible } from './helpers/control-fixture.ts';
import { cleanCliEnv } from './helpers/http-cli.ts';
import { receiverClock } from './helpers/receiver-clock.ts';
import { setupReview } from './review.fixture.ts';
import { reconcileLinks } from './return-handling.fixture.ts';
import { askUser, call, callerWorkspace, claudeConversation, codexConversation, conversationHeaders,
  NO_AGENT_CONFIG, post, run, until } from './coordinator-caller.fixture.ts';

const person = { kind: 'human' } as const;
const conversationId = 'test-main-conversation';
const mainActor = { kind: 'main', provider: 'claude', conversationId } as const;
const main = claudeConversation(conversationId);
/** The actor of the Task's newest record, as `task get` shows it; a write's receipt carries no History. */
const actorOf = async (url: string, task: { id: string }) =>
  (await call(url, ['task', 'get', '--task', task.id, '--log', '1'])).task.log.at(-1)?.actor as unknown;

test('outside Claude Code and Codex conversations write on their first real CLI operation with no hooks', async t => {
  const w = callerWorkspace(t), url = await w.start();
  for (const [env, provider, conversation] of [[main, 'claude', conversationId],
    [codexConversation('test-codex-thread'), 'codex', 'test-codex-thread'],
    [{ CODEX_SESSION_ID: 'test-codex-session' }, 'codex', 'test-codex-session']] as const) {
    const created = (await call(url, ['task', 'new', '--from-user', '--parent', w.project, '--title', 'First operation'], env)).task;
    assert.deepEqual(await actorOf(url, created), { kind: 'main', provider, conversationId: conversation });
    assert.equal(created.userRequested, true);
    const changed = (await call(url, ['task', 'update', '--task', created.id, '--title', 'Changed',
      '--expected-task-hash', created.hash, '--quote', 'This text was never reported to the server'], env)).task;
    assert.deepEqual(await actorOf(url, changed), { kind: 'main', provider, conversationId: conversation,
      quote: 'This text was never reported to the server' });
    const saved = new ControlStore(w.root, { busyTimeoutMs: 1000 }, true);
    try {
      const dialogue = saved.read(db => dialoguesOf(db, [new TaskRepository(w.root, db).metadataWithHistory(created.id)]));
      assert.deepEqual(dialogue.map(({ messageId, words, answer }) => ({ messageId, words, answer })),
        [{ messageId: currentTaskLog(w.root, changed.id).at(-1)!.id, words: 'This text was never reported to the server', answer: null }]);
    } finally { saved.close(); }
  }
  for (const endpoint of ['open', 'close']) {
    const removed = await post(url, '/api/coordinator/turn/' + endpoint, {}, conversationHeaders(conversationId));
    assert.equal(removed.status, 404, 'turn registration API is removed');
  }
});

test('the coordinator places, instructs and stops Runs on a top Task as main; a replay answers its receipt in any conversation', async t => {
  // This actor/receipt case constructs its Run directly. Drive its boundary explicitly, independently of timer luck.
  receiverClock(t);
  const w = callerWorkspace(t);
  const url = await w.start();

  const created = (await call(url, ['task', 'new', '--no-from-user', '--parent', w.project, '--title', 'Main task'], main)).task;
  const assignment = await call(url, ['agent', 'assign', '--task', created.id, '--role', 'responsible',
    '--profile', 'codex', '--expected-task-hash', created.hash], main);
  const placed = assignment.agent.placement;
  assert.equal((await call(url, ['task', 'get', '--task', created.id, '--log', '1'])).task.log.at(-1)?.kind, 'responsible_changed');
  assert.deepEqual(await actorOf(url, assignment.task), mainActor);

  const queued = w.heldRun({ task: created.id, placementId: placed.id, running: false });
  const stopped = await call(url, ['run', 'stop', '--run', queued.id], main);
  assert.deepEqual(stopped.cancelled, [queued.id]);
  // Complete the synthetic Run's boundary before taking the version for the next instruction.
  reconcileLinks(w.root, w.project);
  const afterStop = (await call(url, ['task', 'get', '--task', created.id, '--log', '20'])).task;
  const stopLog = afterStop.log.find((entry: { kind: string }) => entry.kind === 'run_stop_requested');
  assert.deepEqual(stopLog?.runIds, [queued.id]);
  assert.deepEqual(stopLog?.actor, mainActor);
  // A queued Run never started, so stopping it does not imply work or review.
  assert.equal(afterStop.state, 'todo');

  const args = ['task', 'request', '--task', created.id, '--instruction-file', w.file('brief.txt', 'Main request'),
    '--expected-task-hash', afterStop.hash, '--expected-placement-revision', String(placed.revision)];
  // A background reconciliation may occur between reading a Task and using its version.
  reconcileLinks(w.root, w.project);
  const requested = await call(url, args, main);
  assert.equal(requested.outcome.kind, 'request_accepted');
  assert.deepEqual((await call(url, ['task', 'get', '--task', created.id, '--log', '100'])).task.log
    .find((entry: { id: string }) => entry.id === requested.outcome.opId)?.actor, mainActor);
  const store = new RunStore(w.root, { busyTimeoutMs: 1000 });
  try {
    const request = store.readRequests().find(item => item.id === requested.outcome.opId);
    assert.equal(request?.purpose, 'instruction');
    assert.equal(request?.author.kind, 'main');
    assert.deepEqual(request?.author, mainActor);
  } finally { store.close(); }
  // A replay is answered from its saved receipt before current execution state is checked.
  const replay = await run(url, [...args, '--op-id', requested.outcome.opId], claudeConversation('different-main-conversation'));
  assert.equal(replay.code, 0, replay.stderr);
  assert.deepEqual(JSON.parse(replay.stdout), requested);
});

test('a stopped unstarted Run keeps todo but its reconciled boundary invalidates an earlier instruction version', async t => {
  receiverClock(t);
  const w = callerWorkspace(t), url = await w.start();
  const created = (await call(url, ['task', 'new', '--no-from-user', '--parent', w.project, '--title', 'Stopped boundary CAS'], main)).task;
  const assignment = await call(url, ['agent', 'assign', '--task', created.id, '--role', 'responsible',
    '--profile', 'codex', '--expected-task-hash', created.hash], main);
  const placement = assignment.agent.placement;
  const queued = w.heldRun({ task: created.id, placementId: placement.id, running: false });
  await call(url, ['run', 'stop', '--run', queued.id], main);
  const earlier = (await call(url, ['task', 'get', '--task', created.id, '--log', '20'])).task;
  reconcileLinks(w.root, w.project);
  const current = (await call(url, ['task', 'get', '--task', created.id, '--log', '20'])).task;
  assert.equal(earlier.state, 'todo'); assert.equal(current.state, 'todo');
  assert.notEqual(earlier.hash, current.hash, 'the new boundary record is a real Task revision');
  assert.ok(current.log.some((entry: { id: string }) => entry.id === `LEND${queued.id}`));
  const args = ['task', 'request', '--task', created.id, '--instruction-file', w.file('brief.txt', 'Next instruction'),
    '--expected-placement-revision', String(placement.revision)];
  const refused = await run(url, [...args, '--expected-task-hash', earlier.hash], main);
  assert.equal(refused.code, 2, 'a typed CLI refusal keeps its command-failure exit code');
  assert.equal(JSON.parse(refused.stderr).error.code, 'conflict');
  const accepted = await call(url, [...args, '--expected-task-hash', current.hash], main);
  assert.equal(accepted.outcome.kind, 'request_accepted');
});

test('HTTP stopping a synthetic Run records its ID and human actor on the Task', async t => {
  const w = callerWorkspace(t);
  const url = await w.start();
  const created = (await call(url, ['task', 'new', '--title', 'HTTP stop', '--parent', w.project])).task;
  const assignment = await call(url, ['agent', 'assign', '--task', created.id, '--role', 'responsible', '--profile', 'codex',
    '--expected-task-hash', created.hash]);
  const queued = w.heldRun({ task: created.id, placementId: assignment.agent.placement.id, running: false });
  const response = await post(url, '/api/run/stop', { run: queued.id });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.cancelled, [queued.id]);
  const store = new RunStore(w.root, { busyTimeoutMs: 1000 });
  try { assert.equal(store.get(queued.id)?.state, 'cancelled'); } finally { store.close(); }
  const task = (await call(url, ['task', 'get', '--task', created.id, '--log', '20'])).task;
  const stopLog = task.log.find((entry: { kind: string }) => entry.kind === 'run_stop_requested');
  assert.deepEqual(stopLog?.runIds, [queued.id]);
  assert.deepEqual(stopLog?.actor, person);
});

test('outside quote records neither grant authority nor require matching a previous utterance or project policy', async t => {
  const h = await setupReview(t, { userRequested: true });
  writeFileSync(join(h.root, 'config.yaml'), NO_AGENT_CONFIG);
  const asked = await askUser(h.root, h.project, 'claude'), { url } = await h.start();
  const answer = join(h.root, 'answer.md'); writeFileSync(answer, 'Option A');
  const shownQuestion = await call(url, ['task', 'get', '--task', asked.task]);
  const answerOwner = shownQuestion.agents.find((agent: { active: boolean; responsible: boolean }) => agent.active && agent.responsible);
  assert.ok(answerOwner);
  const answered = await call(url, ['task', 'request', '--task', asked.task, '--answers', asked.question,
    '--instruction-file', answer], main);
  assert.equal(answered.outcome.kind, 'answered');
  assert.equal(((await actorOf(url, { id: asked.task })) as { quote?: string })?.quote, undefined);
  const current = (await call(url, ['task', 'get', '--task', h.task.id])).task;
  const confirmed = (await call(url, ['task', 'report', '--task', h.task.id, '--state', 'done', '--about-run', h.reviewRun,
    '--expected-task-hash', current.hash, '--expected-placement-revision', String(h.expectedPlacementRevision),
    '--quote', 'Arbitrary record text, absent from every conversation and policy'], main)).task;
  assert.equal(confirmed.state, 'done');
  assert.deepEqual(await actorOf(url, confirmed), { ...mainActor, quote: 'Arbitrary record text, absent from every conversation and policy' });
  const shown = (await call(url, ['task', 'get', '--task', h.project])).task;
  const policyFile = join(h.root, 'policy.json'); writeFileSync(policyFile, JSON.stringify({ project_policy: 'New scope' }));
  const edited = (await call(url, ['task', 'update', '--task', h.project, '--values-file', policyFile,
    '--expected-task-hash', shown.hash], main)).task;
  assert.deepEqual(edited.values, { project_policy: 'New scope' });
  assert.deepEqual(await actorOf(url, edited), mainActor);
});

test('Run markers the CLI cannot send whole, and a Task Run\'s own conversation, never act as main', async t => {
  const w = callerWorkspace(t);
  const task = (await new ControlTaskCommands(w.root, person).create({ parentId: w.project, userRequested: true,
    tasks: [{ title: 'Owned by Run' }] })).tasks[0];
  const placement = await assignResponsible(w.root, task, 'codex');
  const sessionId = 'registered-run-conversation';
  const owner = w.heldRun({ task: task.id, placementId: placement.id, session: sessionId });
  reconcileLinks(w.root, w.project);
  const url = await w.start();
  const hash = (await call(url, ['task', 'get', '--task', task.id])).task.hash;
  const runEnv = { ...owner.env, CODEX_THREAD_ID: sessionId };
  const incomplete = { code: 'invalid_input' };
  const cases = [
    { name: 'marker alone', env: { ...main, ALPACAWORK_RUN: owner.id }, refused: incomplete },
    { name: 'marker removed, token and session retained', env: { ALPACAWORK_RUN_TOKEN: owner.env.ALPACAWORK_RUN_TOKEN, CODEX_THREAD_ID: sessionId }, refused: incomplete },
    { name: 'marker empty, token and session retained', env: { ...runEnv, ALPACAWORK_RUN: '' }, refused: incomplete },
    // Refused as the Run's, not as an outside conversation without a live turn.
    { name: 'marker and token removed, registered session retained', env: { CODEX_THREAD_ID: sessionId },
      refused: { code: 'forbidden', message: /belongs to an alpacawork Run/ } },
    { name: 'token alone blocks an unrelated session', env: { ALPACAWORK_RUN_TOKEN: owner.env.ALPACAWORK_RUN_TOKEN, CODEX_THREAD_ID: 'unregistered-main-id' }, refused: incomplete },
    { name: 'empty marker blocks an unrelated session', env: { ...runEnv, ALPACAWORK_RUN: '', CODEX_THREAD_ID: 'unregistered-main-id' }, refused: incomplete },
  ];
  // One gate reads these for every command (entries.ts, credentials.ts): each case once, each command by both refusals.
  for (const [index, { name, env, refused }] of cases.entries()) {
    const commands = [
      ['task', 'new', '--no-from-user', '--parent', w.project, '--title', `Forbidden: ${name}`],
      ['task', 'report', '--task', task.id, '--state', 'done', '--title', 'Close task', '--expected-task-hash', hash],
      ['run', 'stop', '--run', owner.id],
    ];
    for (const args of index === 0 || index === 3 ? commands : commands.slice(0, 1))
      await assert.rejects(call(url, args, env), refused, `${name}: ${args.slice(0, 2).join(' ')}`);
  }
  const current = (await call(url, ['task', 'get', '--task', task.id, '--log', '20'])).task;
  assert.equal(current.state, 'doing');
  assert.equal(current.log.some((entry: { title: string | null }) => entry.title === 'Close task'), false);
  // Over HTTP, a credential of a Run the server does not have is refused as well.
  const unknown = 'R999';
  const refused = await post(url, '/api/task/new', { title: 'Forbidden HTTP', parent: w.project, fromUser: false },
    { authorization: `Alpacawork-Run ${unknown}:${issueRunCredential(w.root, unknown)}` });
  assert.equal(refused.status, 403);
});

test('a Run is its credential\'s only while a current placement, an owner only as the responsible; its report resent under the same operation ID passes after it ended', async t => {
  const w = callerWorkspace(t);
  const task = (await new ControlTaskCommands(w.root, person).create({ parentId: w.project, userRequested: true,
    tasks: [{ title: 'Run work' }] })).tasks[0];
  const responsible = await assignResponsible(w.root, task, 'codex');
  const member = (await new PlacementCommands(w.root).placeMember({ taskId: task.id, profileKey: 'codex',
    expectedTaskHash: (await new ControlTaskStore(w.root).get(task.id)).hash, expectedResponsibleRevision: responsible.revision },
  person)).placement;
  const owner = w.heldRun({ task: task.id, placementId: responsible.id });
  const worker = w.heldRun({ task: task.id, placementId: member.id, role: 'worker' });
  // An owner Run whose placement is not the Task's responsible.
  const stray = w.heldRun({ task: task.id, placementId: member.id, role: 'owner' });
  reconcileLinks(w.root, w.project);
  const url = await w.start();
  const hash = async () => (await call(url, ['task', 'get', '--task', task.id])).task.hash;
  const comment = async (title: string) => ['task', 'comment', '--task', task.id, '--title', title, '--expected-task-hash', await hash()];

  await assert.rejects(call(url, await comment('Forged'), { ...owner.env, ALPACAWORK_RUN_TOKEN: 'f'.repeat(64) }),
    { code: 'forbidden', message: /missing or invalid/ });
  assert.deepEqual(await actorOf(url, (await call(url, await comment('From the worker'), worker.env)).task),
    { kind: 'placement', placementId: member.id });
  await assert.rejects(call(url, await comment('From the stray owner'), stray.env), { code: 'forbidden', message: /not a current placement/ });
  w.end(worker); w.end(stray, 'cancelled');
  // Their ends reach the Task now, not in the middle of the report below.
  reconcileLinks(w.root, w.project);

  const report = ['task', 'report', '--task', task.id, '--state', 'done', '--title', 'Finished', '--description-file', '-',
    '--expected-task-hash', await hash(), '--op-id', randomUUID()];
  const reported = await run(url, report, owner.env, 'The requested work is complete.');
  assert.equal(reported.code, 0, reported.stderr);
  w.end(owner);
  const resent = await run(url, report, owner.env, 'The requested work is complete.');
  assert.equal(resent.code, 0, resent.stderr);
  assert.deepEqual(JSON.parse(resent.stdout), JSON.parse(reported.stdout), 'the same report, sent again, is its Run\'s');
  await assert.rejects(call(url, report, worker.env, 'The requested work is complete.'), { code: 'forbidden' }, 'another ended Run cannot replay this receipt');
  await assert.rejects(call(url, report.map(value => value === 'Finished' ? 'Changed input' : value), owner.env, 'The requested work is complete.'),
    { code: 'idempotency_conflict' }, 'the ended Run still has to match the original fingerprint');
  await assert.rejects(call(url, await comment('After the end'), owner.env), { code: 'forbidden', message: /not a current placement/ });

  // HTTP headers and the CLI's environment claim the same caller.
  const viaHeaders = await post(url, '/api/task/comment', { task: task.id, title: 'After the end', expectedTaskHash: await hash() },
    { authorization: `Alpacawork-Run ${owner.id}:${owner.env.ALPACAWORK_RUN_TOKEN}` });
  assert.deepEqual([viaHeaders.status, viaHeaders.body.error.code], [403, 'forbidden']);
  assert.match(viaHeaders.body.error.message, /not a current placement/);

  const viaCli = (await call(url, ['task', 'new', '--no-from-user', '--parent', w.project, '--title', 'Via the CLI'], main)).task;
  const viaHttp = await post(url, '/api/task/new', { title: 'Via HTTP', parent: w.project, fromUser: false },
    conversationHeaders(conversationId));
  assert.equal(viaHttp.status, 200, JSON.stringify(viaHttp.body));
  assert.deepEqual([await actorOf(url, viaCli), await actorOf(url, viaHttp.body.task)], [mainActor, mainActor]);
  // The local administration CLI claims a Run from its environment alone, and is no Run's either.
  const admin = spawnSync(process.execPath, [join(import.meta.dirname, '../apps/backend/dist/backend.js'),
    '--workspace', w.root, 'workspace', 'init'], { env: cleanCliEnv({ ...owner.env, HOME: w.root, XDG_CONFIG_HOME: join(w.root, 'negative-config') }), encoding: 'utf8' });
  assert.equal(JSON.parse(admin.stderr).error.code, 'forbidden', admin.stderr);
  const returns = await post(url, '/api/workspace/returns', {}, { authorization: `Alpacawork-Run ${owner.id}:${owner.env.ALPACAWORK_RUN_TOKEN}` });
  assert.deepEqual([returns.status, returns.body.error.code], [403, 'forbidden']);
});

test('a conversation calling before its Run\'s session is imported is still told apart: a Task Run\'s is refused, the screen\'s is the coordinator\'s', async t => {
  const w = callerWorkspace(t);
  const task = (await new ControlTaskCommands(w.root, person).create({ parentId: w.project, userRequested: false,
    tasks: [{ title: 'Run work' }] })).tasks[0];
  const placement = await assignResponsible(w.root, task, 'codex');
  const taskRun = w.heldRun({ task: task.id, placementId: placement.id, session: null, attempt: true });
  const screen = w.screenRun({ words: 'Show the status', session: null, agent: 'codex' });
  const store = new RunStore(w.root, { busyTimeoutMs: 1000 });
  t.after(() => store.close());
  const direct = (provider: 'claude' | 'codex', conversation: string) =>
    resolveCaller(w.root, { direct: { provider, conversationId: conversation } }, store);

  // The Runs learn their conversations from their own output, which no import has read yet.
  w.journal(taskRun, 'task-run-thread');
  assert.throws(() => direct('codex', 'task-run-thread'), { code: 'forbidden', reason: { kind: 'conversation_belongs_alpacawork_run' } });
  assert.equal(store.runtimeGet(taskRun.id)?.session?.id, 'task-run-thread', 'resolveCaller imported the session once');
  w.journal(screen, 'screen-thread');
  const coordinator = direct('codex', 'screen-thread');
  assert.deepEqual(coordinator, { kind: 'coordinator', source: 'screen', provider: 'codex',
    conversation: screen.conversation, runId: screen.id });
  assert.deepEqual(direct('claude', 'outside-conversation'),
    { kind: 'coordinator', source: 'claude', conversation: 'outside-conversation' });
});

test('a screen message\'s result is what its turn\'s writes recorded and what the server refused of them, once its Run ended', async t => {
  const w = callerWorkspace(t);
  const asked = await askUser(w.root, w.project, 'codex');
  const screen = w.screenRun({ words: `For ${asked.task}, I choose option A`, session: 'screen-thread', agent: 'codex' });
  const url = await w.start();
  await w.startScreenRun(url, screen);
  const asScreen = codexConversation('screen-thread');
  const resultOf = () => new CoordinatorConversation(w.root).read().turns.find(item => item.id === screen.requestId)?.result;
  // A write on a version the Task no longer has is refused; the answer then goes.
  const refusal = await run(url, ['task', 'report', '--task', asked.task, '--state', 'stopped',
    '--expected-task-hash', '0'.repeat(64), '--quote', 'I choose option A'], asScreen);
  assert.equal(JSON.parse(refusal.stderr).error.code, 'conflict');
  const shownQuestion = await call(url, ['task', 'get', '--task', asked.task]);
  const answerOwner = shownQuestion.agents.find((agent: { active: boolean; responsible: boolean }) => agent.active && agent.responsible);
  assert.ok(answerOwner);
  const answered = (await call(url, ['task', 'request', '--task', asked.task, '--answers', asked.question,
    '--instruction-file', w.file('answer.md', 'Option A'), '--quote', 'I choose option A'], asScreen)).task;
  assert.equal(resultOf(), null, 'nothing is final while its turn lives');
  w.end(screen);
  const writes = (currentTaskLog(w.root, answered.id) as { id: string; kind: string; toState: string | null; questionId?: string; runId?: string;
    actor: { message?: string } }[])
    .filter(entry => entry.actor.message === screen.requestId)
    .map(entry => ({ task: asked.task, record: entry.id, kind: entry.kind, toState: entry.toState,
      ...entry.kind === 'answered' ? { question: entry.questionId } : {},
      ...entry.kind === 'review_approved' ? { runId: entry.runId } : {} }));
  assert.ok(writes.some(write => write.kind === 'answered' && write.question === asked.question), JSON.stringify(writes));
  const serverError = JSON.parse(refusal.stderr).error;
  delete serverError.detail.operation; // The CLI adds its own receipt-check hint after the server response.
  assert.deepEqual(resultOf(), { writes, refused: [{ task: asked.task, ...serverError }] });
});

test('serve\'s periodic pass drops a cleared conversation\'s files', async t => {
  const w = callerWorkspace(t);
  const url = await w.start();

  const { id } = coordinatorSnapshotSchema.parse(await (await fetch(new URL('/api/coordinator', url))).json()).conversation;
  const saved = await fetch(new URL(`/api/coordinator/attachments?conversationId=${id}&requestId=${randomUUID()}&name=note.txt`, url),
    { method: 'POST', headers: { 'X-Alpacawork-Op-Id': randomUUID() }, body: 'note' });
  assert.equal(saved.status, 200, await saved.text());
  const folder = join(w.root, '.alpacawork', 'coordinator', id);
  assert.equal(existsSync(folder), true);
  const cleared = await post(url, '/api/coordinator/clear', { conversationId: id });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  await until(() => !existsSync(folder), 'the pass removes the files of the cleared conversation');
});

test('a real write fault keeps its unknown-save classification in the screen result', async t => {
  const w = callerWorkspace(t), asked = await askUser(w.root, w.project, 'codex');
  const screen = w.screenRun({ words: `For ${asked.task}, change title`, session: 'fault-screen', agent: 'codex' });
  const url = await w.start(); await w.startScreenRun(url, screen);
  const before = (await call(url, ['task', 'get', '--task', asked.task])).task;
  const store = new ControlStore(w.root, { busyTimeoutMs: 1000 });
  try { store.write(db => db.exec(`CREATE TRIGGER simulated_task_write_fault BEFORE INSERT ON task_log
    WHEN json_extract(NEW.entry,'$.toState') = 'stopped' BEGIN SELECT RAISE(ABORT, 'simulated-write-fault'); END`)); }
  finally { store.close(); }
  const refused = await run(url, ['task', 'report', '--task', asked.task, '--state', 'stopped',
    '--expected-task-hash', before.hash, '--quote', 'change title'], codexConversation('fault-screen'));
  const actual = JSON.parse(refused.stderr).error;
  assert.equal(actual.retry, 'check', refused.stderr);
  const attempts = actual.detail.operation.attempts;
  if (actual.detail?.operation) { delete actual.detail.operation; if (!Object.keys(actual.detail).length) delete actual.detail; }
  w.end(screen);
  const result = new CoordinatorConversation(w.root).read().turns.find(turn => turn.id === screen.requestId)!.result;
  assert.deepEqual(result, { writes: [], refused: Array.from({ length: attempts }, () => ({ task: asked.task, ...actual })) });
  assert.equal((await call(url, ['task', 'get', '--task', asked.task])).task.hash, before.hash);
});
