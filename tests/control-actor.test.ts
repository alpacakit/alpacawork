import { commandFetch as fetch } from './helpers/command-fetch.ts';
/**
 * Who may do what, through the public HTTP entries: every HTTP act of authorize's table (ACTIONS, its only source)
 * tried by every caller over HTTP, as the server identifies them: a Run by its credential, the coordinator by its
 * conversation, with or without the user's words quoted, and a person. An act the table lets a caller do gets past
 * authorize and is refused, if at all, for the Task's own facts: each write here names a version that is no longer
 * current, so no allowed write changes the fixture. The pure decision is authorize.test.ts's.
 */
import { currentTaskLog } from './helpers/control-fixture.ts';
import { taskFlow, type Responsible, type Seat } from './task-flow.fixture.ts';
import { createFixtureRun } from './helpers/run-fixture.ts';
import { reconcileLinks } from './return-handling.fixture.ts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import { problemSchema } from '@alpacawork/contract';
import { ACTIONS } from '@alpacawork/backend/test-dist/control/authorize.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { PlacementCommands } from '@alpacawork/backend/test-dist/control/placement-commands.js';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { issueRunCredential } from '@alpacawork/backend/test-dist/control/credentials.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { POLL_INTERVAL_MS } from '@alpacawork/backend/test-dist/poll-interval.js';

const human = { kind: 'human' } as const;
/** A version no Task, placement or config.yaml has: an allowed write is refused for it, after authorize. */
const STALE = 'a'.repeat(64);
/** The user's outside Codex conversation, where the coordinator speaks for the user. */
const CONVERSATION = 'control-actor-coordinator';
/** What the user said in the coordinator's live turn. */
const SAID = 'Please proceed with that';
/** A line of the project's policy, which the coordinator may quote too, though not as what the user said now. */
const POLICY = 'Delegated scope: you may revise previews without asking';

/** The Runs that call, by the Task they work on: F's is in another project. */
const RUNS = ['A', 'C', 'W', 'S', 'H', 'R', 'F'] as const;
type Who = (typeof RUNS)[number] | 'human' | 'coordinator' | 'policy' | 'utterance';
const everyone: Who[] = [...RUNS, 'human', 'coordinator', 'policy', 'utterance'];
const coordinators: Who[] = ['coordinator', 'policy', 'utterance'];
const proxies: Who[] = ['human', 'coordinator', 'policy', 'utterance'];

/**
 * Project P (the fixture's, with a policy line) and project Q. In P: A, a top task whose responsible's Run works and
 * asked its children C and S; C with a worker W and a question to A it withdrew; the user's H, holding its question
 * to the user, with a worker that has no Run; the user's R, done and awaiting the review while its Run still runs, with a question it withdrew; the
 * user's R2, a review the user held; the user's E and A's E2, failed. In Q: F, at work. A dummy queued Run on C's worker
 * and one on A are what run stop stops. The server's own passes are off, so nothing launches or settles.
 */
async function actors(t: TestContext) {
  const f = await taskFlow(t);
  await f.commands.update({ id: f.project, values: { project_policy: `Development\n${POLICY}` },
    expectedTaskHash: (await f.get(f.project)).hash });
  const other = (await f.commands.create({ kind: 'project', color: '#39659b', parentId: 'P1', userRequested: null,
    tasks: [{ title: 'Q' }] })).tasks[0].id as string;
  const A = await f.task('A'), a = await f.work(A);
  const C = await f.task('C', { parentId: A.id }), c = await f.work(C, a);
  const askedA = await f.ask(c);
  await f.withdraw(c, askedA);
  const worker = (await new PlacementCommands(f.root).placeMember({ taskId: C.id, profileKey: 'fake',
    expectedTaskHash: (await f.get(C.id)).hash, expectedResponsibleRevision: 1 }, human)).placement;
  const instructed = await new TaskRequestService(f.root).request({ task: C.id, agent: worker.id, body: 'Inspect',
    opId: randomUUID(), expectedTaskHash: (await f.get(C.id)).hash, expectedPlacementRevision: worker.revision },
  { kind: 'placement', placementId: C.placementId },
  { kind: 'run', runId: c.runId, placementId: C.placementId, taskId: C.id, role: 'owner', responsible: true });
  const w: Seat = { id: C.id, placementId: worker.id, runId: instructed.outcome.request.runId };
  f.start(w);
  const S = await f.task('S', { parentId: A.id }), s = await f.work(S, a);
  const H = await f.task('H', { parentId: A.id }), h = await f.work(H);
  const held = await f.ask(h, 'user');
  await f.person(H.id, 'held');
  const helper = (await new PlacementCommands(f.root).placeMember({ taskId: H.id, profileKey: 'fake',
    expectedTaskHash: (await f.get(H.id)).hash, expectedResponsibleRevision: 1 }, human)).placement;
  const R = await f.task('R', { userRequested: true }), r = await f.work(R);
  const askedUser = await f.ask(r, 'user');
  await f.withdraw(r, askedUser);
  await f.report(r, 'done');
  const R2 = await f.task('R2', { userRequested: true }), r2 = await f.work(R2);
  await f.report(r2, 'done');
  f.end(r2);
  await f.person(R2.id, 'held');
  const E = await f.task('E', { userRequested: true });
  f.end(await f.work(E), 'failed');
  const E3 = await f.task('Held user failure', { userRequested: true });
  f.end(await f.work(E3), 'failed');
  await f.person(E3.id, 'held');
  const E2 = await f.task('E2', { parentId: A.id });
  f.end(await f.work(E2, a), 'failed');
  const F = await f.task('F', { parentId: other }), runF = await f.work(F);
  reconcileLinks(f.root, other);
  assert.deepEqual(await Promise.all([A, C, S, H, R, R2, E, E2, F].map(task => f.state(task.id))),
    ['doing', 'doing', 'doing', 'held', 'waiting', 'held', 'error', 'error', 'doing']);
  const queued = (task: string, placementId: string) => f.store(runs => runs.write(tx => createFixtureRun(runs, tx, {
    task, placementId, requestId: randomUUID(), agent: 'fake', role: 'worker', resumes: null, continues: false,
    session: null, caller: null, cwd: f.root, launch: { adapter: 'codex', env: [], argv: ['unused'],
       path: '/bin', values: {} } }, 'Never launched')).id);
  const stops = { C: queued(C.id, worker.id), A: queued(A.id, `P${randomUUID()}`) };
  // The server's passes run every second: off for these tests, so no Run is launched, settled or found lost.
  const interval = globalThis.setInterval;
  globalThis.setInterval = ((callback: Parameters<typeof setInterval>[0], ms?: number, ...args: unknown[]) =>
    interval(callback, ms === POLL_INTERVAL_MS ? 3_600_000 : ms, ...args)) as typeof setInterval;
  let server: Awaited<ReturnType<typeof startServer>>;
  try { server = await startServer(f.root, 0); } finally { globalThis.setInterval = interval; }
  t.after(() => server.close());
  const runs: Record<(typeof RUNS)[number], Seat> = { A: a, C: c, W: w, S: s, H: h, R: r, F: runF };
  /** Who calls: a Run by its credential, the coordinator by its conversation, or a person. */
  const headers = (who: Who): Record<string, string> => who === 'human' ? {}
    : coordinators.includes(who) ? { 'x-alpacawork-provider': 'codex', 'x-alpacawork-conversation': CONVERSATION }
    : { authorization: `Alpacawork-Run ${runs[who as (typeof RUNS)[number]].runId}:` +
      issueRunCredential(f.root, runs[who as (typeof RUNS)[number]].runId) };
  /** One request as `who`; a body that takes the user's words carries them for the coordinator that quotes. */
  const call = async (who: Who, request: Call) => {
    const quote = !request.quotes ? undefined : who === 'policy' ? POLICY : who === 'utterance' ? SAID : undefined;
    const body = request.body === undefined ? undefined
      : JSON.stringify({ ...request.body,
        // Only the target's own Run asks; a manager can return a held review without question options.
        ...(RUNS.includes(who as typeof RUNS[number]) && request.path === '/api/commands/task/report' && request.body.state === 'waiting' && request.body.task === runs[who as typeof RUNS[number]].id
          ? { askTo: 'user' } : {}), ...(quote === undefined ? {} : { quote }) });
    const response = await fetch(new URL(request.path, server.url), { method: request.method, body,
      headers: { 'content-type': 'application/json', ...headers(who), ...(request.method === 'GET' ? {} : request.execution ? { 'x-alpacawork-restore-id': 'initial' } : {
        'x-alpacawork-op-id': typeof request.body?.opId === 'string' ? request.body.opId : randomUUID() }),
      ...request.headers } });
    const text = await response.text();
    const refused = response.status === 403 ? problemSchema.parse(JSON.parse(text)).error : null;
    return { status: response.status, text, refused };
  };
  return { f, other, A, C, S, H, R, R2, E, E2, E3, F, worker, helper, runs, stops, held, askedA, askedUser, server, call };
}

/**
 * One request: what it sends, whether it carries the quoting coordinator's words (`--quote`, where its command takes
 * one), and what an allowed caller gets past authorize: by default the refusal of the stale version it names.
 */
type Call = { method: 'GET' | 'POST' | 'PUT'; path: string; body?: Record<string, unknown>; quotes?: boolean;
  headers?: Record<string, string>; execution?: true; allowed?: readonly number[] };
const get = (path: string): Call => ({ method: 'GET', path, allowed: [200] });
const post = (path: string, body: Record<string, unknown>, quotes = false): Call =>
  ({ method: 'POST', path, body: { ...body }, quotes });

test('every HTTP act of the table lets exactly its callers through the public entries, and names itself when it refuses', async t => {
  const h = await actors(t);
  const { A, C, H, R, R2, E, E2, E3, worker, f } = h;
  const task = (id: string) => ({ task: id, expectedTaskHash: STALE });
  const report = (id: string, fields: Record<string, unknown>) =>
    post('/api/commands/task/report', { ...task(id), ...(fields.state === 'done' ? { title: 'Report', description: 'The result is ready.' } : {}), opId: randomUUID(), ...fields }, true);
  const request = (id: string, fields: Record<string, unknown> = {}) => post('/api/commands/task/request',
    { ...task(id), instruction: 'Do the work', opId: randomUUID(), expectedPlacementRevision: 1, ...fields }, true);
  const settings = await (await fetch(new URL('/api/commands/config/get', h.server.url))).json() as
    { limits: Record<string, unknown>; agentsText: string };
  const rows: { act: string; call: Call; allow: readonly Who[]; note?: string; proxyAct?: string; runAct?: string }[] = [
    { act: 'task.read', call: get(`/api/commands/task/get?task=${C.id}`), allow: everyone.filter(who => who !== 'F'),
      note: 'a Run reads its own project only' },
    { act: 'task.list', call: get('/api/commands/task/list'), allow: everyone },
    { act: 'field.list', call: get('/api/commands/field/list'), allow: everyone },
    { act: 'field.set', call: { ...post('/api/commands/field/set', { field: 'actor_note', title: 'Note', type: 'text' }, true), allowed: [200] },
      allow: proxies, note: 'a definition every project shares' },
    { act: 'field.delete', call: { ...post('/api/commands/field/delete', { field: 'never_defined' }, true), allowed: [404] },
      allow: proxies },
    { act: 'field.use', call: post('/api/commands/field/use', { task: f.project, inherit: true, expectedTaskHash: STALE }, true),
      allow: ['A', 'C', 'S', 'R', ...proxies], note: 'its own project\'s, by a responsible Run not held' },
    { act: 'field.use', call: post('/api/commands/field/use', { task: h.other, inherit: true, expectedTaskHash: STALE }, true),
      allow: ['F', ...proxies], note: 'another project\'s' },
    { act: 'task.new.child', call: post('/api/commands/task/new', { title: 'New', parent: C.id, fromUser: false,
      expectedParentHash: STALE }, true), allow: ['C'], note: 'below the Run\'s own Task, internal' },
    { act: 'task.new.child', call: post('/api/commands/task/new', { title: 'New', parent: H.id, fromUser: false,
      expectedParentHash: STALE }, true), allow: [], note: 'not below a held Task by its Run' },
    { act: 'task.new', call: post('/api/commands/task/new', { title: 'New', parent: f.project, fromUser: false,
      expectedParentHash: STALE }, true), allow: proxies },
    { act: 'task.new.from_user', call: post('/api/commands/task/new', { title: 'New', parent: f.project, fromUser: true,
      expectedParentHash: STALE }, true), allow: proxies },
    { act: 'task.new.project', call: post('/api/commands/task/new', { title: 'New', kind: 'project', color: '#39659b', parent: f.project,
      expectedParentHash: STALE }, true), allow: proxies },
    { act: 'task.update.title', call: post('/api/commands/task/update', { ...task(C.id), title: 'Renamed' }, true),
      allow: ['C', 'A', ...proxies] },
    { act: 'task.update.values', call: post('/api/commands/task/update', { ...task(C.id), values: { notes: 'New notes' } }, true),
      allow: ['C', 'A', ...proxies] },
    { act: 'task.update.values', call: post('/api/commands/task/update', { ...task(H.id), values: { notes: 'New notes' } }, true),
      allow: ['A', ...proxies], note: 'a held Task\'s Run writes no values' },
    { act: 'task.update.values', call: post('/api/commands/task/update', { ...task(f.project), values: { project_policy: 'New policy' } }, true),
      allow: proxies, note: 'a project\'s policy is the user\'s words' },
    { act: 'task.update.analysisSubject', call: post('/api/commands/task/update',
      { ...task(C.id), analysisSubject: { kind: 'cause', key: 'look_feel' } }, true), allow: ['C', 'A', ...proxies] },
    { act: 'task.update.cwd', call: post('/api/commands/task/update', { ...task(f.project), cwd: tmpdir() }, true),
      allow: proxies },
    { act: 'task.update.color', call: post('/api/commands/task/update', { ...task(f.project), color: '#abcdef' }, true),
      allow: proxies },
    { act: 'task.update.userRequested', call: post('/api/commands/task/update', { ...task(C.id), fromUser: true }, true),
      allow: proxies },
    { act: 'task.move', call: post('/api/commands/task/move', { ...task(C.id), parent: h.S.id }, true), allow: ['A', ...proxies],
      note: 'below the parent Run\'s own Task' },
    { act: 'task.move', call: post('/api/commands/task/move', { ...task(C.id), parent: f.project }, true), allow: proxies,
      note: 'out from below the parent Run\'s own Task' },
    ...(['archive', 'delete', 'restore'] as const).map(action =>
      ({ act: `task.${action}`, call: post(`/api/commands/task/${action}`, task(C.id), true),
        allow: proxies })),
    { act: 'task.checkpoint', call: report(C.id, { state: 'doing', values: { notes: 'Latest snapshot' } }), allow: ['C'] },
    { act: 'task.checkpoint', call: report(H.id, { state: 'doing', values: { notes: 'Latest snapshot' } }), allow: [], note: 'not while held' },
    { act: 'task.report.doing', call: report(C.id, { state: 'doing' }), allow: ['C'] },
    { act: 'task.report.doing', proxyAct: 'task.report.restore', runAct: 'task.report.restore', call: report(H.id, { state: 'doing' }), allow: ['H', 'A', ...proxies],
      note: 'the Run works on; the user\'s proxy returns the hold' },
    { act: 'task.report.waiting', proxyAct: 'task.review',
      call: report(C.id, { state: 'waiting', title: 'Which way?', description: 'A or B' }),
      allow: ['C', ...proxies], note: 'a Run asks; the proxy submits for review (the transition checks state)' },
    { act: 'task.report.waiting', proxyAct: 'task.review',
      call: report(H.id, { state: 'waiting', title: 'Which way?', description: 'A or B' }),
      allow: ['H', ...proxies], note: 'a held Run asks; a non-Run submission still faces the stale version and state checks' },
    { act: 'task.review', runAct: 'task.report.waiting',
      call: report(C.id, { state: 'waiting', title: 'Review result', description: 'Snapshot submission' }),
      allow: ['C', ...proxies], note: 'the same waiting transport identifies a distinct non-Run review act' },
    { act: 'task.report.waiting', proxyAct: 'task.report.restore', runAct: 'task.report.restore', call: report(R2.id, { state: 'waiting' }), allow: proxies,
      note: 'the user\'s proxy returns a held review' },
    { act: 'task.report.done', call: report(C.id, { state: 'done' }), allow: ['C'] },
    { act: 'task.confirm', call: report(C.id, { state: 'done', aboutRun: h.runs.C.runId,
      expectedPlacementRevision: 1 }), allow: proxies, note: 'an explicit review target is checked as a confirmation even after reopening' },
    { act: 'task.report.done', proxyAct: 'task.confirm', call: report(H.id, { state: 'done' }), allow: proxies,
      note: 'the user proxy completes a held question; the held Run cannot report done' },
    { act: 'task.confirm', call: report(R.id, { state: 'done', aboutRun: h.runs.R.runId, expectedPlacementRevision: 1 }),
      allow: proxies, note: 'neither the responsible nor its parent confirms the user\'s review' },
    { act: 'task.confirm', call: report(R2.id, { state: 'done', aboutRun: h.runs.R.runId, expectedPlacementRevision: 1 }),
      allow: proxies, note: 'a held review' },
    { act: 'task.report.stopped', call: report(C.id, { state: 'stopped' }), allow: ['C', 'A', ...proxies] },
    { act: 'task.report.stopped', call: report(H.id, { state: 'stopped' }), allow: ['A', ...proxies] },
    { act: 'task.report.stopped.user', call: report(E3.id, { state: 'stopped' }), allow: proxies,
      note: 'holding a user failure preserves who may stop it' },
    { act: 'task.report.stopped.user', call: report(E.id, { state: 'stopped' }), allow: proxies,
      note: 'the user\'s request that failed' },
    { act: 'task.report.stopped.user', call: report(R.id, { state: 'stopped' }), allow: proxies },
    { act: 'task.report.restore', call: report(H.id, { state: 'todo' }), allow: ['A', ...proxies],
      note: 'managers restore a hold; the source is checked after the version' },
    { act: 'task.report.held', call: report(R.id, { state: 'held' }), allow: proxies },
    { act: 'task.withdraw', call: report(C.id, { withdraw: h.askedA }), allow: ['C'] },
    { act: 'task.withdraw', call: report(H.id, { withdraw: h.held }), allow: ['H'], note: 'while held too' },
    { act: 'task.comment', call: post('/api/commands/task/comment', { ...task(C.id), title: 'Note' }, true), allow: everyone.filter(who => who !== 'F') },
    { act: 'task.comment', call: post('/api/commands/task/comment', { ...task(H.id), title: 'Note' }, true), allow: everyone.filter(who => who !== 'F'),
      note: 'records throughout the project, even while the Run own Task is held' },
    { act: 'task.comment.urgent', call: post('/api/commands/task/comment', { ...task(C.id), title: 'Note', urgent: 'Now' }, true),
      allow: ['C'] },
    { act: 'task.comment.urgent', call: post('/api/commands/task/comment', { ...task(H.id), title: 'Note', urgent: 'Now' }, true),
      allow: ['H'], note: 'an urgent note is a record too' },
    { act: 'task.request', call: request(C.id), allow: ['A', ...proxies] },
    { act: 'task.request', call: request(A.id), allow: ['human', ...coordinators],
      note: 'the coordinator instructs a top Task\'s responsible without the user\'s words' },
    { act: 'task.request', call: request(E2.id), allow: ['A', ...proxies], note: 'a failure an agent asked for' },
    { act: 'task.request.worker', call: request(C.id, { agent: worker.id }), allow: ['C'] },
    { act: 'task.request.worker', call: request(H.id, { agent: h.helper.id }), allow: [], note: 'not while held' },
    { act: 'task.request.user', call: request(E3.id), allow: proxies, note: 'holding a user failure preserves who may retry it' },
    { act: 'task.request.user', call: request(E.id), allow: proxies,
      note: 'the parent does not retry what the user asked for' },
    { act: 'task.request', call: request(R.id), allow: proxies, note: 'ordinary instruction while waiting' },
    { act: 'task.answer', call: { ...post('/api/commands/task/request', { task: R.id, instruction: 'This way', answers: h.askedUser,
      opId: randomUUID() }, true), allowed: [200,409] }, allow: proxies, note: 'a question to the user' },
    { act: 'task.answer', call: { ...post('/api/commands/task/request', { task: C.id, instruction: 'This way', answers: h.askedA,
      opId: randomUUID() }, true), allowed: [200,409] }, allow: ['A'], note: 'a question to the parent' },
    { act: 'agent.assign', call: post('/api/commands/agent/assign', { ...task(C.id), role: 'responsible', profile: 'fake' }, true),
      allow: ['A', ...proxies] },
    { act: 'agent.assign', call: post('/api/commands/agent/assign', { ...task(A.id), role: 'responsible', profile: 'fake' }, true),
      allow: ['human', ...coordinators], note: 'a top Task' },
    { act: 'agent.handover', call: post('/api/commands/agent/handover', { ...task(C.id), agent: worker.id,
      expectedPlacementRevision: 1 }, true), allow: ['A', ...proxies] },
    { act: 'agent.handover', call: post('/api/commands/agent/handover', { ...task(A.id), agent: A.placementId,
      expectedPlacementRevision: 1 }, true), allow: ['human', ...coordinators] },
    { act: 'agent.release', call: post('/api/commands/agent/release', { ...task(C.id), agent: C.placementId,
      expectedPlacementRevision: 1 }, true), allow: ['A', ...proxies], note: 'the parent\'s responsible or user proxy releases its child\'s' },
    { act: 'agent.release', call: post('/api/commands/agent/release', { ...task(A.id), agent: A.placementId,
      expectedPlacementRevision: 1 }, true), allow: ['human', ...coordinators] },
    { act: 'agent.assign.worker', call: post('/api/commands/agent/assign', { ...task(C.id), role: 'member', profile: 'fake',
      expectedResponsibleRevision: 1 }, true), allow: ['C', ...proxies] },
    { act: 'agent.assign.worker', call: post('/api/commands/agent/assign', { ...task(H.id), role: 'member', profile: 'fake',
      expectedResponsibleRevision: 1 }, true), allow: proxies, note: 'the held Run does not manage placements; the user proxy does' },
    { act: 'agent.release.worker', call: post('/api/commands/agent/release', { ...task(C.id), agent: worker.id,
      expectedPlacementRevision: 1, expectedResponsibleRevision: 1 }, true), allow: ['C', ...proxies] },
    { act: 'agent.release.worker', call: post('/api/commands/agent/release', { ...task(H.id), agent: h.helper.id,
      expectedPlacementRevision: 1, expectedResponsibleRevision: 1 }, true), allow: proxies, note: 'the held Run does not manage placements; the user proxy does' },
    { act: 'file.write', call: { method: 'PUT', path: `/api/tasks/${C.id}/file?path=notes.txt`,
      headers: { 'x-alpacawork-content-digest': STALE }, allowed: [400] }, allow: ['C', 'W', 'human'],
    note: 'a content digest that differs is refused after authorize' },
    { act: 'update.review', call: get('/api/update/review'), allow: ['human'], note: 'human reaches the unavailable review in an unmanaged workspace' },
    { act: 'update.review', call: get('/api/update/status'), allow: ['human'], note: 'the screen reads the update status as its side of review' },
    { act: 'update.confirm', call: post('/api/update/confirm', { opId: randomUUID(), candidateId: 'candidate', reviewDigest: STALE }), allow: ['human'] },
    { act: 'update.cancel', call: post('/api/update/cancel', { opId: randomUUID() }), allow: ['human'] },
    { act: 'screen', call: get(`/api/workspace/folders?path=${encodeURIComponent(tmpdir())}`), allow: ['human'] },
    { act: 'screen', call: { ...post('/api/workspace/folders/new', { path: tmpdir(), name: '..' }), allowed: [400] },
      allow: ['human'], note: 'folder creation is screen-only; an invalid name prevents any disk change' },
    { act: 'screen', call: { ...post('/api/voice/token', {}), allowed: [404] }, allow: ['human'],
      note: 'voice input, with no voice settings here' },
    { act: 'screen', call: get('/api/environment-file'), allow: ['human'], note: 'what the server read of its environment file is the settings screen\'s' },
    { act: 'coordinator.screen', call: get('/api/coordinator'), allow: ['human'] },
    { act: 'config.inspect', call: { ...post('/api/commands/config/inspect', { adapter: 'codex', command: `${f.root}/missing-probe` }),
      execution: true, allowed: [200] }, allow: proxies },
    { act: 'config.set', call: post('/api/commands/config/set', { config: stringify({ limits: settings.limits }),
      agents: settings.agentsText, expectedConfigHash: STALE }), allow: proxies },
    // These two change what they stop: the first allowed stop ends the queued Run, a later one finds none.
    { act: 'run.stop', call: { ...post('/api/commands/run/stop', { run: h.stops.C }, true), allowed: [200, 404] }, allow: ['A', ...proxies],
      note: 'run stop carries the same verified proxy quote as other Task management' },
    { act: 'run.stop', call: { ...post('/api/commands/run/stop', { run: h.stops.A }, true), allowed: [200, 404] },
      allow: ['human', ...coordinators], note: 'a top Task' },
    { act: 'settings.read', call: get('/api/commands/settings/get'), allow: proxies, note: 'the person\'s own settings' },
    { act: 'settings.set', call: post('/api/commands/settings/set', { key: 'theme', value: 'dark', expectedRevision: STALE }),
      allow: proxies },
    { act: 'runtime', call: get('/api/runtime/preflight'), allow: ['human'] },
    { act: 'runtime', call: get('/api/runtime/readiness'), allow: ['human'] },
    { act: 'runtime', call: get('/api/runtime/diagnostics'), allow: ['human'] },
    // The pass a person retries changes nothing here; the quiesce stops writes, so it comes last.
    { act: 'admin', call: { ...post('/api/commands/workspace/returns', {}), allowed: [200] }, allow: ['human'] },
    { act: 'runtime', call: { ...post('/api/runtime/quiesce', {}), allowed: [200] }, allow: ['human'] },
  ];
  for (const { act, call, allow, note, proxyAct, runAct } of rows) {
    // The allowed go last, so that a stop or the quiesce does not change what the refused are tried on.
    for (const who of [...everyone.filter(who => !allow.includes(who)), ...allow]) {
      const label = `${act}${note ? ` (${note})` : ''} as ${who}`;
      const result = await h.call(who, call);
      if (allow.includes(who)) assert.ok((call.allowed ?? [409]).includes(result.status), `${label}: ${result.status} ${result.text}`);
      else assert.deepEqual([result.status, result.refused?.code, result.refused?.detail], [403, 'forbidden',
        { action: RUNS.includes(who as typeof RUNS[number]) ? runAct ?? act : proxyAct ?? act }],
        `${label}: ${result.text}`);
    }
  }
  // Every HTTP act was tried. `release` is a local-backend-only entry and its grants are exercised through
  // requireLocal in release-authority.test.ts; there is no release HTTP operation to send here.
  assert.deepEqual([...new Set(rows.map(row => row.act))].sort(), Object.keys(ACTIONS).filter(act => act !== 'release').sort());
});

test('what a Run, the coordinator and a person write, and what a Run reads', async t => {
  const h = await actors(t);
  const { A, C, F, f } = h;
  const create = async (who: Who, body: Record<string, unknown>) => {
    const result = await h.call(who, post('/api/commands/task/new', body, true));
    return { ...result, task: result.status === 200 ? JSON.parse(result.text).task : null };
  };
  // A Run creates below its own Task only, and never the user's request.
  const sub = await create('C', { title: 'Sub', parent: C.id });
  assert.equal(sub.status, 200, sub.text);
  assert.deepEqual([sub.task.parentId, sub.task.userRequested, currentTaskLog(f.root, sub.task.id)[0]!.actor],
    [C.id, false, { kind: 'placement', placementId: C.placementId }]);
  assert.equal((await create('C', { title: 'Beside', parent: A.id })).status, 403);
  for (const who of ['human', ...coordinators, 'A', 'W'] as Who[]) {
    const child = await create(who, { title: 'Forbidden child', parent: C.id, fromUser: false });
    assert.equal(child.status, 403, child.text);
    assert.deepEqual(JSON.parse(child.text).error.reason, { kind: 'child_by_its_responsible' });
  }
  for (const who of proxies) {
    const child = await create(who, { title: 'Forbidden marked child', parent: C.id, fromUser: true });
    assert.equal(child.status, 400, child.text);
    assert.deepEqual(JSON.parse(child.text).error.reason, { kind: 'user_request_belongs_to_top' });
  }

  assert.equal((await create('C', { title: 'Asked', parent: C.id, fromUser: true })).refused?.code, 'forbidden');
  // A person creates a task, the user's request unless internal, and a project, top or nested.
  const asked = await create('human', { title: 'Asked', parent: f.project });
  assert.deepEqual([asked.status, asked.task.userRequested], [200, true]);
  const nested = await create('human', { title: 'Nested', kind: 'project', color: '#39659b', parent: f.project });
  const top = await create('human', { title: 'Top', kind: 'project', color: '#39659b', parent: 'none' });
  assert.deepEqual([nested.task.kind, nested.task.parentId, top.task.kind, top.task.parentId],
    ['project', f.project, 'project', null]);
  // The coordinator says whose Task it creates.
  const unstated = await create('coordinator', { title: 'Unstated', parent: f.project });
  assert.equal(unstated.status, 400);
  assert.deepEqual(JSON.parse(unstated.text).error.issues.map((issue: { path: string }) => issue.path), ['fromUser']);
  const internal = await create('coordinator', { title: 'Internal', parent: f.project, fromUser: false });
  assert.deepEqual([internal.status, internal.task.userRequested, currentTaskLog(f.root, internal.task.id)[0]!.actor],
    [200, false, { kind: 'main', provider: 'codex', conversationId: CONVERSATION }]);
  // A person places a top Task's responsible, moves a task within its project and updates it.
  const placed = await h.call('human', post('/api/commands/agent/assign', { task: asked.task.id, role: 'responsible',
    profile: 'fake', expectedTaskHash: asked.task.hash }));
  assert.equal(placed.status, 200, placed.text);
  const moved = await h.call('human', post('/api/commands/task/move', { task: internal.task.id, parent: asked.task.id,
    expectedTaskHash: internal.task.hash }));
  assert.equal(moved.status, 200, moved.text);
  const renamed = await h.call('human', post('/api/commands/task/update', { task: internal.task.id, title: 'Renamed',
    expectedTaskHash: JSON.parse(moved.text).task.hash }));
  assert.equal(renamed.status, 200, renamed.text);
  // A Run reads its own project only: another project's Tasks are not in its list, and one of them is not read.
  const ids = async (who: Who) => (JSON.parse((await h.call(who, get('/api/commands/task/list?all=true'))).text)
    .tasks as { id: string }[]).map(task => task.id);
  const [own, foreign, everything] = [await ids('C'), await ids('F'), await ids('human')];
  assert.ok(own.includes(C.id) && !own.includes(F.id), own.join());
  assert.ok(foreign.includes(F.id) && !foreign.includes(C.id) && !foreign.includes(A.id), foreign.join());
  assert.ok(everything.includes(C.id) && everything.includes(F.id));
  assert.equal((await h.call('F', get(`/api/commands/task/get?task=${C.id}`))).status, 403);
  assert.equal((await h.call('F', get(`/api/commands/task/get?task=${F.id}`))).status, 200);
});

test('the services write as the actor authorize decided: who may act is decided there alone', async t => {
  const f = await taskFlow(t);
  const A = await f.task('A'), a = await f.work(A);
  const C = await f.task('C', { parentId: A.id });
  const S: Responsible = await f.task('S', { parentId: A.id }), s = await f.work(S, a);
  const asS = { kind: 'placement', placementId: S.placementId } as const;
  // The table limits project creation to a person/live utterance, and a Run's child staffing/stopping to its parent;
  // a sibling's Run, called directly without the public authorization entry, does all three.
  const project = (await new ControlTaskCommands(f.root, asS).create({ kind: 'project', color: '#39659b', parentId: f.project,
    userRequested: null, tasks: [{ title: 'By a Run' }] })).tasks[0];
  assert.deepEqual([project.kind, currentTaskLog(f.root, project.id)[0]!.actor], ['project', asS]);
  const placed = await new PlacementCommands(f.root).placeNewResponsible({ placedAs: 'default', taskId: C.id, profileKey: 'fake',
    expectedTaskHash: (await f.get(C.id)).hash, replacePlacementId: C.placementId, expectedPlacementRevision: 1 }, asS);
  assert.equal(placed.previousPlacement?.id, C.placementId);
  await new TaskReportService(f.root).report({ task: C.id, state: 'stopped', title: 'Stopped', opId: randomUUID(),
    expectedTaskHash: (await f.get(C.id)).hash }, asS,
  { kind: 'run', runId: s.runId, placementId: S.placementId, taskId: S.id, role: 'owner', responsible: true });
  const stopped = await f.get(C.id);
  assert.deepEqual([stopped.meta.state, stopped.meta.log.at(-1)?.actor], ['stopped', asS]);
});


test('owners and workers record on other project Tasks with their Run and placement, without state or urgent authority', async t => {
  const h = await actors(t);
  for (const who of ['C', 'W'] as const) {
    const before = await h.f.get(h.S.id);
    const result = await h.call(who, post('/api/commands/task/comment', { task: h.S.id, title: 'Integration note',
      expectedTaskHash: before.hash }));
    assert.equal(result.status, 200, result.text);
    const after = await h.f.get(h.S.id);
    assert.equal(after.meta.state, before.meta.state);
    assert.equal(after.meta.hold, before.meta.hold);
    const entry = after.meta.log.at(-1)!;
    assert.deepEqual(entry.actor, { kind: 'placement', placementId: h.runs[who].placementId });
    assert.equal(entry.runId, h.runs[who].runId);
    assert.equal(entry.toState, null);
    assert.equal(entry.urgentReason, undefined);
    const history = await h.call('human', get(`/api/task/history?task=${h.S.id}`));
    assert.equal(history.status, 200, history.text);
    const event = JSON.parse(history.text).events.find((event: { id: string }) => event.id === entry.id);
    // The writing Run is linked; the fake agent records no model or effort, so both are null, not left out.
    assert.deepEqual(event.author, { kind: 'parent', taskId: h.C.id, profileKey: 'fake', modelId: null, effort: null });
    assert.equal(event.runId, h.runs[who].runId);
    assert.equal(event.kind, 'comment');
    for (const request of [
      post('/api/commands/task/comment', { task: h.S.id, title: 'Wake', urgent: 'Now', expectedTaskHash: after.hash }),
      post('/api/commands/task/report', { task: h.S.id, state: 'doing', title: 'Work', opId: randomUUID(), expectedTaskHash: after.hash }),
      post('/api/commands/task/comment', { task: h.F.id, title: 'Foreign', expectedTaskHash: (await h.f.get(h.F.id)).hash }),
    ]) {
      const refused = await h.call(who, request);
      assert.equal(refused.status, 403, refused.text);
    }
    assert.equal((await h.f.get(h.S.id)).hash, after.hash, 'refusals do not change the target');
  }
});
