import { commandFetchWith } from './helpers/command-fetch.ts';
import { fetchBuffered } from './helpers/buffered-http.ts';
import { createFixtureRun } from './helpers/run-fixture.ts';
import { assignResponsible, initializeControlFixture } from './helpers/control-fixture.ts';
import { callerWorkspace, conversationHeaders } from './coordinator-caller.fixture.ts';
/** Participant changes by the Task's responsible Run, as its placement; no agent is launched. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { RunStore } from '@alpacawork/runs';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { AGENTS_TEMPLATE } from '@alpacawork/backend/test-dist/agents-settings.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { PlacementCommands } from '@alpacawork/backend/test-dist/control/placement-commands.js';
import { issueRunCredential } from '@alpacawork/backend/test-dist/control/credentials.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { placeMemberReceiptSchema } from '@alpacawork/contract/control';

async function setup(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-member-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const writer = new FileWriter(root);
  let project: string;
  try { writer.save('config.yaml', null, Buffer.from(AGENTS_TEMPLATE)); project = initializeControlFixture(root); }
  finally { writer.close(); }
  const task = (await new ControlTaskCommands(root, { kind: 'human' }).create({ parentId: project, userRequested: false, tasks: [{ title: 'Team' }] })).tasks[0];
  const people = new PlacementStore(root);
  const owner = people.place({ taskId: task.id, agentId: people.createAgent().id,
    profileKey: 'codex', responsible: true });
  people.close();
  const store = new RunStore(root, { busyTimeoutMs: 0 });
  const run = store.write(tx => {
    const created = createFixtureRun(store, tx, { task: task.id, placementId: owner.id, requestId: globalThis.crypto.randomUUID(),
      agent: 'codex', role: 'owner', resumes: null, continues: false, session: null,
      caller: null, cwd: root, launch: { adapter: 'codex', env: [], argv: ['unused'], path: '/bin', values: {}} }, 'prompt');
    tx.update({ ...created, state: 'running', started_at: new Date().toISOString() });
    return created;
  });
  store.close();
  return { root, task, owner, run, token: issueRunCredential(root, run.id),
    actor: { kind: 'placement', placementId: owner.id } as const, commands: new PlacementCommands(root) };
}
const taskHash = async (root: string, id: string) =>
  (await new ControlTaskStore(root).snapshot()).tasks.find(task => task.id === id)!.hash;

test('responsible Run places a new member, reuses its person ID, and releases an idle placement', async t => {
  const h = await setup(t);
  const first = await h.commands.placeMember({ taskId: h.task.id, profileKey: 'claude', expectedTaskHash: h.task.hash,
    expectedResponsibleRevision: h.owner.revision }, h.actor);
  assert.deepEqual([first.agent.id, first.placement.responsible, first.placement.active],
    [first.placement.agentId, false, true]);
  const ended = await h.commands.releaseMember({ taskId: h.task.id, placementId: first.placement.id,
    expectedTaskHash: await taskHash(h.root, h.task.id), expectedResponsibleRevision: h.owner.revision,
    expectedPlacementRevision: first.placement.revision }, h.actor);
  assert.deepEqual([ended.placement.id, ended.placement.active], [first.placement.id, false]);
  const second = await h.commands.placeMember({ taskId: h.task.id, agentId: first.agent.id,
    profileKey: 'claude', expectedTaskHash: await taskHash(h.root, h.task.id),
    expectedResponsibleRevision: h.owner.revision }, h.actor);
  assert.equal(second.agent.id, first.agent.id);
  assert.notEqual(second.placement.id, first.placement.id);
});

test('member mutations reject a current owner target and stale revision', async t => {
  const h = await setup(t);
  const base = { taskId: h.task.id, profileKey: 'claude',
    expectedTaskHash: h.task.hash, expectedResponsibleRevision: h.owner.revision };
  await assert.rejects(h.commands.placeMember({ ...base, expectedResponsibleRevision: 2 }, h.actor),
    (error: { code: string }) => error.code === 'conflict');
  await assert.rejects(h.commands.releaseMember({ taskId: h.task.id, placementId: h.owner.id,
    expectedTaskHash: h.task.hash, expectedResponsibleRevision: h.owner.revision,
    expectedPlacementRevision: h.owner.revision }, h.actor),
  (error: { code: string }) => error.code === 'forbidden');
});

test('member with a queued Run cannot be released', async t => {
  const h = await setup(t);
  const member = await h.commands.placeMember({ taskId: h.task.id, profileKey: 'claude', expectedTaskHash: h.task.hash,
    expectedResponsibleRevision: h.owner.revision }, h.actor);
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  try { store.write(tx => createFixtureRun(store, tx, { task: h.task.id, placementId: member.placement.id, requestId: globalThis.crypto.randomUUID(),
    agent: 'claude', role: 'worker', resumes: null, continues: false, session: null,
    caller: { run: h.run.id }, cwd: h.root, launch: { adapter: 'codex', env: [], argv: ['unused'], path: '/bin', values: {}} }, 'prompt')); }
  finally { store.close(); }
  await assert.rejects(h.commands.releaseMember({ taskId: h.task.id, placementId: member.placement.id,
    expectedTaskHash: await taskHash(h.root, h.task.id), expectedResponsibleRevision: h.owner.revision,
    expectedPlacementRevision: member.placement.revision }, h.actor), /unfinished runs/);
});

test('HTTP member assignment binds authorization to the request, not a shared server context', async t => {
  const w = callerWorkspace(t), tasks = new ControlTaskStore(w.root);
  const commands = new ControlTaskCommands(w.root, { kind: 'human' });
  const ownTask = (await commands.create({ parentId: w.project, userRequested: false,
    tasks: [{ title: 'Team' }] })).tasks[0]!;
  const otherTask = (await commands.create({ parentId: w.project, userRequested: false,
    tasks: [{ title: 'Other team' }] })).tasks[0]!;
  const ownPlacement = await assignResponsible(w.root, ownTask, 'codex');
  const otherPlacement = await assignResponsible(w.root, otherTask, 'codex');
  // Hold the managers' locks so periodic reconciliation cannot retire these request identities mid-test.
  const own = w.heldRun({ task: ownTask.id, placementId: ownPlacement.id });
  const other = w.heldRun({ task: otherTask.id, placementId: otherPlacement.id });
  const url = await w.start(), conversation = 'member-request-context', words = 'Add a member to this team';

  const runHeaders = (run: typeof own): Record<string, string> =>
    ({ authorization: `Alpacawork-Run ${run.id}:${run.env.ALPACAWORK_RUN_TOKEN}` });
  const coordinator = conversationHeaders(conversation, 'codex');
  const post = async (headers: Record<string, string> = {}, quote?: string) =>
    fetch(new URL('/api/commands/agent/assign', url), { method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ task: ownTask.id, role: 'member', profile: 'claude',
        expectedTaskHash: (await tasks.get(ownTask.id)).hash, expectedResponsibleRevision: ownPlacement.revision,
        ...(quote === undefined ? {} : { quote }) }) });
  const accepts = async (headers: Record<string, string>, actor: object, quote?: string) => {
    const response = await post(headers, quote);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(placeMemberReceiptSchema.parse(result.agent).placement.responsible, false);
    assert.equal('log' in result.task, false);
    assert.deepEqual((await tasks.get(ownTask.id)).meta.log.at(-1)!.actor, actor);
  };
  const refuses = async (headers: Record<string, string>, reason: string) => {
    const before = (await tasks.get(ownTask.id)).hash;
    const response = await post(headers);
    assert.equal(response.status, 403);
    const error = (await response.json()).error;
    assert.equal(error.reason.kind, reason);
    if (reason === 'authorization_required') assert.deepEqual(error.detail, { action: 'agent.assign.worker' });
    assert.equal((await tasks.get(ownTask.id)).hash, before, 'a refused request changes no placement or Task');
  };
  await accepts({}, { kind: 'human' });
  await refuses({ authorization: `Alpacawork-Run ${own.id}:${'0'.repeat(64)}` }, 'run_credential_missing_or_invalid');
  await accepts(runHeaders(own), { kind: 'placement', placementId: ownPlacement.id });
  await refuses(runHeaders(other), 'authorization_required');
  await accepts(coordinator, { kind: 'main', provider: 'codex', conversationId: conversation });
  const proxy = await post(coordinator, words);
  assert.equal(proxy.status, 200);
  const proxyResult = await proxy.json();
  assert.equal(placeMemberReceiptSchema.parse(proxyResult.agent).placement.responsible, false);
  const actor = (await tasks.get(ownTask.id)).meta.log.at(-1)!.actor;
  assert.deepEqual(actor,
    { kind: 'main', provider: 'codex', conversationId: conversation,
      quote: words });
  await refuses(runHeaders(other), 'authorization_required');
  await accepts({}, { kind: 'human' });
});

test('this PC\'s folders are listed for a person, never for a Run', async t => {
  const h = await setup(t), server = await startServer(h.root, 0);
  t.after(async () => { await server.close(); });
  const list = (authorization?: string) => fetch(new URL(`/api/workspace/folders?path=${encodeURIComponent(tmpdir())}`, server.url),
    { headers: authorization ? { authorization } : {} });
  assert.equal((await list()).status, 200);
  assert.equal((await list(`Alpacawork-Run ${h.run.id}:${h.token}`)).status, 403);
  const make = (authorization?: string) => fetch(new URL('/api/workspace/folders/new', server.url), {
    method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
    body: JSON.stringify({ path: tmpdir(), name: '..' }),
  });
  assert.equal((await make()).status, 400, 'a person reaches name validation');
  assert.equal((await make(`Alpacawork-Run ${h.run.id}:${h.token}`)).status, 403, 'a Run never reaches mkdir');
});

test('this PC\'s own folder chooser is never shown to a screen opened at the public name', async t => {
  const h = await setup(t), server = await startServer(h.root, 0, { publicHost: 'pc.example.ts.net' });
  t.after(async () => { await server.close(); });
  const body = JSON.stringify({ title: 'Choose' });
  const answer = await new Promise<{ status: number; text: string }>((done, reject) => {
    const sent = request(new URL('/api/workspace/folders/choose', server.url), { method: 'POST', headers: {
      host: 'pc.example.ts.net', origin: 'https://pc.example.ts.net', 'content-type': 'application/json' } }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; }).on('end', () => done({ status: response.statusCode!, text }));
    });
    sent.on('error', reject);
    sent.end(body);
  });
  assert.equal(answer.status, 403, answer.text);
  assert.equal(JSON.parse(answer.text).error.reason.kind, 'folder_chooser_only_on_this_pc');
});

const fetch = commandFetchWith(fetchBuffered);
