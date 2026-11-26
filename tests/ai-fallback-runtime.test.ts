import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { serverSettingsSchema, type AiStackPrefix } from '@alpacawork/contract';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { sourceMessage } from '@alpacawork/backend/test-dist/coordinator/messages.js';
import { CoordinatorConversation } from '@alpacawork/backend/test-dist/coordinator/conversation.js';
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { assignResponsible, currentTaskHash, currentTaskLog, seedFixtureTask } from './helpers/control-fixture.ts';
import { commandFetch } from './helpers/command-fetch.ts';
import { receipts, setup, until } from './runs-runtime.fixture.ts';

test('an exhausted owner gives the same request to another agent and the parent gets one return', async t => {
  const h = await setup(t);
  h.pauseProjection();
  writeFileSync(join(h.root, 'config.yaml'), stringify({ ...h.config,
    aiStack: [{ agent: 'claude', values: {} }, { agent: 'codex', values: {} }],
  }, { aliasDuplicateObjects: false }));

  const parent = h.create('claude', { gate: h.gate('parent') });
  await h.tick();
  await h.waitState(parent, 'running');
  const child = seedFixtureTask(h.root, h.taskId, 'Child work');
  const placement = await assignResponsible(h.root, child, 'claude');
  const requestId = randomUUID();
  const service = new TaskRequestService(h.root);
  const admitted = await service.request({ task: child.id, opId: requestId,
    body: JSON.stringify({ sessionLimit: true, fallbackGate: h.gate('answer'), output: 'Work complete' }),
    expectedTaskHash: currentTaskHash(h.root, child.id), expectedPlacementRevision: placement.revision },
  { kind: 'placement', placementId: h.ownerPlacementId },
  { kind: 'run', runId: parent.id, placementId: h.ownerPlacementId, taskId: h.taskId, role: 'owner', responsible: true });
  assert.equal(admitted.outcome.kind, 'request_accepted');
  if (admitted.outcome.kind !== 'request_accepted') throw new Error('Child request must be accepted');
  const first = admitted.outcome.request.runId;

  // Stop at the commit preceding the next launch. The production manager publishes the exhaustion event.
  await h.tick();
  const importer = new RunEventImporter(h.store);
  await until(() => {
    importer.pass([first]);
    return h.store.get(first)?.state === 'failed';
  }, 'the first agent stops and the next is reserved');
  const stopped = h.store.get(first)!;
  assert.equal(stopped.availability?.cause, 'session_limit');
  assert.ok(stopped.supersededBy);
  const next = h.store.get(stopped.supersededBy)!;
  assert.equal(next.state, 'queued');
  assert.equal(next.agent, 'codex');
  assert.equal(next.requestId, requestId);
  assert.equal(next.placementId, placement.id);
  assert.equal(next.resumes, null);
  assert.equal(h.store.readReturns().filter(row => row.requestId === requestId).length, 0);

  const app = await startServer(h.root, 0);
  try {
    await until(() => h.store.get(next.id)?.state === 'running', 'the reserved candidate starts after startup');
    assert.ok(currentTaskLog(h.root, child.id).every(entry => entry.toState !== 'error'));
    await new TaskReportService(h.root).report({
      task: child.id, state: 'done', opId: randomUUID(), title: 'Finished', description: 'The request is complete.',
      expectedTaskHash: currentTaskHash(h.root, child.id),
    }, { kind: 'placement', placementId: placement.id },
    { kind: 'run', runId: next.id, placementId: placement.id, taskId: child.id, role: 'owner', responsible: true });
    h.release('answer');
    await until(() => h.store.get(next.id)?.state === 'succeeded' &&
      h.store.readReturns().some(row => row.requestId === requestId), 'the final reply reaches the parent');
    assert.equal(h.store.readReturns().filter(row => row.requestId === requestId).length, 1);
    assert.deepEqual(h.store.read().filter(run => run.requestId === requestId).map(run => run.agent), ['claude', 'codex']);
    assert.ok(currentTaskLog(h.root, child.id).every(entry => entry.toState !== 'error'));
    const history = await fetch(new URL(`/api/task/history?mode=latest&task=${child.id}`, app.url));
    const captured = await history.json();
    assert.equal(history.status, 200, JSON.stringify(captured.error));
    const requestRow = captured.events.find((event: { id: string }) => event.id === requestId);
    assert.equal(requestRow.recipient.profileKey, 'claude');
    const row = captured.events.find((event: { id: string }) => event.id === first);
    assert.equal(row.carriedOn, true);
    assert.equal(row.cause, 'session_limit');
    assert.equal(row.author.profileKey, 'claude');
    assert.equal(row.recipient.profileKey, 'codex');
    assert.equal(receipts(h.root).filter(item => item.branch === 'agent').length, 3);
  } finally { await app.close(); }
});

test('a worker uses a named model just for its request and retains the prior conversation on fallback', async t => {
  const h = await setup(t);
  h.pauseProjection();
  writeFileSync(join(h.root, 'config.yaml'), stringify({ ...h.config,
    agents: { ...h.config.agents, claude: { ...h.config.agents.claude, params: { model: ['opus', 'fable'], effort: ['high'] } },
      codex: { ...h.config.agents.codex, params: { ...h.config.agents.codex.params, effort: ['medium', 'low'] },
        without: { 'gpt-6.2-sol': ['effort'] } } },
    aiStack: [{ agent: 'claude', values: { model: 'opus' } }, { agent: 'codex', values: { effort: 'low' } },
      { agent: 'plain', values: {} }, { agent: 'own', values: {} }],
  }, { aliasDuplicateObjects: false }));
  const owner = h.create('claude', { gate: h.gate('owner') });
  await h.tick();
  await h.waitState(owner, 'running');
  const placements = new PlacementStore(h.root);
  let placement;
  try { placement = placements.createAndPlace({ taskId: h.taskId, profileKey: 'claude', responsible: false }).placement; }
  finally { placements.close(); }
  const service = new TaskRequestService(h.root);
  const ask = async (body: string, aiStack?: AiStackPrefix, newConversation?: boolean) => {
    const request = await service.request({ task: h.taskId, agent: placement.id, opId: randomUUID(), body, aiStack, newConversation,
      expectedTaskHash: currentTaskHash(h.root, h.taskId), expectedPlacementRevision: placement.revision },
    { kind: 'placement', placementId: h.ownerPlacementId },
    { kind: 'run', runId: owner.id, placementId: h.ownerPlacementId, taskId: h.taskId, role: 'owner', responsible: true });
    if (request.outcome.kind !== 'request_accepted') throw new Error('Worker request must be accepted');
    return h.store.get(request.outcome.request.runId)!;
  };
  const named = await ask('Do the important task first.', [{ agent: 'claude', values: { model: 'fable' } }, 'stop']);
  assert.equal(named.launch.values.model, 'fable');
  h.finish(named);
  const prior = await ask('Keep the draft title "Report for Friday".');
  assert.equal(prior.launch.values.model, 'opus');
  assert.equal(prior.resumes, named.id);
  h.finish(prior);
  const first = await ask(JSON.stringify({ sessionLimit: true, output: 'Worker result' }));
  assert.equal(first.resumes, prior.id);
  const app = await startServer(h.root, 0);
  try {
    await until(() => h.store.readReturns().some(row => row.requestId === first.requestId), 'the worker returns once');
    const initial = h.store.get(first.id)!;
    const next = h.store.get(initial.supersededBy!)!;
    assert.equal(next.state, 'succeeded');
    assert.equal(next.role, 'worker');
    assert.equal(next.placementId, placement.id);
    assert.equal(next.agent, 'codex');
    assert.deepEqual(h.store.readReturns().filter(row => row.requestId === first.requestId).map(row => row.boundaryRunId), [next.id]);
    const { prompt } = receipts(h.root).find(item => item.pid === next.pids.agent)!;
    assert.match(prompt, /Report for Friday/);
    assert.match(prompt, /fixture reply/);
    assert.match(prompt, /Do the important task first\./);
    assert.doesNotMatch(prompt, /continuing the same conversation/);

    const settings = serverSettingsSchema.parse(await (await fetch(new URL('/api/commands/config/get', app.url))).json());
    const [primary, replacement, third, fourth] = settings.aiStack!;
    assert.equal(next.launch.values.effort, 'low');
    assert.deepEqual(replacement!.values, next.launch.values);
    const saved = await commandFetch(new URL('/api/commands/config/set', app.url), { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedConfigHash: settings.hash, agents: settings.agentsText,
        config: stringify({ limits: settings.limits, aiStack: [primary, replacement, fourth, third] }) }) });
    assert.equal(saved.status, 200, await saved.text());
    const reloaded = readAgentsSettings(h.root);
    assert.ok(reloaded.ok);
    assert.deepEqual(reloaded.config.aiStack?.map(row => row.agent), ['claude', 'codex', 'own', 'plain']);
    assert.deepEqual(reloaded.config.aiStack?.[1]?.values, next.launch.values);
    const continued = await ask('Continue with the same worker.');
    assert.equal(continued.agent, 'codex');
    assert.equal(continued.resumes, next.id);
    assert.deepEqual(continued.launch.values, next.launch.values);
    await until(() => h.store.get(continued.id)?.state === 'succeeded', 'the worker continues in the fallback session');

    const fresh = await ask('Start a fresh discussion with the same worker.', undefined, true);
    assert.equal(fresh.agent, 'codex');
    assert.equal(fresh.resumes, null);
  } finally { await app.close(); }
});

test('a waiting worker request keeps its own stack when the preceding request names another model', async t => {
  const h = await setup(t);
  h.pauseProjection();
  writeFileSync(join(h.root, 'config.yaml'), stringify({ ...h.config,
    agents: { ...h.config.agents, claude: { ...h.config.agents.claude, params: { model: ['opus', 'fable'], effort: ['high'] } } },
    aiStack: [{ agent: 'claude', values: { model: 'opus' } }, { agent: 'codex', values: {} }],
  }, { aliasDuplicateObjects: false }));
  const owner = h.create('claude', { gate: h.gate('owner') });
  await h.tick();
  await h.waitState(owner, 'running');
  const placements = new PlacementStore(h.root);
  let placement;
  try { placement = placements.createAndPlace({ taskId: h.taskId, profileKey: 'claude', responsible: false }).placement; }
  finally { placements.close(); }
  const service = new TaskRequestService(h.root);
  const ask = async (plan: object, aiStack?: AiStackPrefix) => {
    const request = await service.request({ task: h.taskId, agent: placement.id, opId: randomUUID(), body: JSON.stringify(plan), aiStack,
      expectedTaskHash: currentTaskHash(h.root, h.taskId), expectedPlacementRevision: placement.revision },
    { kind: 'placement', placementId: h.ownerPlacementId },
    { kind: 'run', runId: owner.id, placementId: h.ownerPlacementId, taskId: h.taskId, role: 'owner', responsible: true });
    if (request.outcome.kind !== 'request_accepted') throw new Error('Worker request must be accepted');
    return h.store.get(request.outcome.request.runId)!;
  };
  const app = await startServer(h.root, 0);
  try {
    const first = await ask({ gate: h.gate('start'), sessionLimit: true },
      [{ agent: 'claude', values: { model: 'opus' } }, { agent: 'claude', values: { model: 'fable' } }, 'stop']);
    await h.waitState(first, 'running');
    const pending = await ask({ output: 'Separate result' });
    assert.equal(pending.resumes, first.id);
    h.release('start');
    await h.waitState(pending, 'succeeded');
    const replacement = h.store.get(h.store.get(first.id)!.supersededBy!)!;
    assert.equal(replacement.launch.values.model, 'fable');
    const resumed = h.store.get(pending.id)!;
    assert.equal(resumed.launch.values.model, 'opus');
    assert.equal(resumed.resumes, replacement.id);
    assert.deepEqual(resumed.session, replacement.session);
  } finally { await app.close(); }
});

test('terminating a remaining tool process prevents an otherwise eligible fallback', async t => {
  const h = await setup(t);
  h.pauseProjection();
  writeFileSync(join(h.root, 'config.yaml'), stringify({ ...h.config,
    coordinatorAiStack: [{ agent: 'claude', values: {} }, { agent: 'codex', values: {} }],
  }, { aliasDuplicateObjects: false }));
  const conversation = new CoordinatorConversation(h.root), id = randomUUID(), conversationId = conversation.read().id;
  const app = await startServer(h.root, 0);
  try {
    conversation.ask({ id, conversationId, text: JSON.stringify({ group: true, gate: h.gate('ready'), sessionLimit: true }),
      attachments: [] });
    await until(() => receipts(h.root).some(entry => entry.branch === 'child'), 'the agent leaves a child process');
    h.release('ready');
    await until(() => conversation.read().turns.find(turn => turn.id === id)?.status === 'failed', 'the exhausted turn ends');
    const runs = h.store.read().filter(run => run.requestId === id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.availability?.cause, 'session_limit');
  } finally { await app.close(); }
});

test('a queued coordinator message follows the replacement conversation using the coordinator stack', async t => {
  const h = await setup(t);
  h.pauseProjection();
  writeFileSync(join(h.root, 'config.yaml'), stringify({ ...h.config,
    coordinatorAiStack: [{ agent: 'claude', values: {} }, { agent: 'codex', values: {} }],
  }, { aliasDuplicateObjects: false }));
  const conversation = new CoordinatorConversation(h.root);
  const conversationId = conversation.read().id;
  const first = randomUUID(), joined = randomUUID(), pending = randomUUID();
  const send = (id: string, plan: object, tasks?: string[]) => conversation.ask({
    id, conversationId, text: JSON.stringify(plan), attachments: [], tasks,
  });
  const app = await startServer(h.root, 0);
  try {
    send(first, { gate: h.gate('first'), receiveJoined: true, sessionLimit: true, fallbackGate: h.gate('answer'), output: 'Replacement reply' });
    await until(() => h.store.read().some(run => run.requestId === first && run.pids.agent), 'first turn starts');
    send(joined, { output: 'An extra instruction' }, [h.taskId]);
    conversation.sendNow(conversationId, joined);
    await until(() => conversation.read().turns.find(turn => turn.id === joined)?.status === 'joined', 'the earlier AI takes the extra instruction');
    send(pending, { output: 'Follow-up reply' });
    h.release('first');
    await until(() => conversation.read().turns.some(turn => turn.id === first && turn.attempts?.length === 2), 'replacement trial is visible');
    assert.deepEqual(conversation.read().turns.map(turn => turn.id), [first, joined, pending]);
    assert.equal(conversation.read().turns.find(turn => turn.id === pending)?.status, 'queued');
    const active = h.store.read().filter(run => run.requestId === first).at(-1)!;
    await until(() => receipts(h.root).some(item => item.pid === h.store.runtimeGet(active.id)?.pids.agent), 'the replacement receives the prompt');
    assert.equal(sourceMessage(h.store.connection, active.id, joined), joined);
    assert.throws(() => sourceMessage(h.store.connection, active.id, pending), { code: 'invalid_input' });
    const fallbackPrompt = receipts(h.root).find(item => item.pid === h.store.runtimeGet(active.id)?.pids.agent)!.prompt;
    assert.equal(fallbackPrompt.split('An extra instruction').length, 2);
    assert.equal(fallbackPrompt.split('Read the alpacawork skill').length, 2);
    assert.deepEqual(conversation.read().resets, [], 'switching within one reply creates no separate history row');
    h.release('answer');
    await until(() => conversation.read().turns.filter(turn => turn.status === 'succeeded').length === 2, 'both replies arrive in order');
    const turns = conversation.read().turns;
    assert.deepEqual(turns.map(turn => turn.answer ?? null), ['Replacement reply', null, 'Follow-up reply']);
    assert.equal(turns[0]?.attempts?.[0]?.availability?.cause, 'session_limit');
    const history = await fetch(new URL(`/api/task/history?mode=latest&task=${h.taskId}`, app.url));
    const captured = await history.json();
    assert.equal(history.status, 200, JSON.stringify(captured.error));
    const dialogue = captured.events.find((event: { id: string }) => event.id === joined);
    assert.equal(dialogue.summary, 'Replacement reply');
    assert.equal(dialogue.coordinator.profileKey, 'codex');
    const following = h.store.read().find(run => run.requestId === pending);
    assert.equal(following?.agent, 'codex');
    assert.equal(following?.resumes, active?.id);
    assert.equal(following?.session?.id, h.store.runtimeGet(active.id)?.session?.id);
    assert.equal(conversation.read().nextLaunch?.agent, 'codex');

    // The next request goes back to the primary after its recorded window ends.
    h.store.write(tx => {
      const initial = h.store.connection.prepare('SELECT id FROM runs WHERE request_id=? AND attempt=0').get(first);
      const expired = tx.runtimeGet(`R${initial?.id}`);
      assert.ok(expired?.role === 'coordinator' && expired.state === 'failed');
      tx.update({ ...expired, availability: { ...expired.availability!, resetsAt: '2000-01-01T00:00:00Z' } });
    });
    assert.equal(conversation.read().nextLaunch?.agent, 'claude');
    const recovered = randomUUID();
    send(recovered, { output: 'Primary reply' });
    await until(() => conversation.read().turns.some(turn => turn.id === recovered && turn.status === 'succeeded'), 'primary replies again');
    assert.equal(h.store.read().find(run => run.requestId === recovered)?.agent, 'claude');
    assert.equal(conversation.read().resets.at(-1)?.reason.kind, 'another_ai');

    const later = randomUUID();
    writeFileSync(join(h.root, 'config.yaml'), stringify({ ...h.config,
      agents: { ...h.config.agents, retry: h.config.agents.claude, replacement: h.config.agents.codex },
      coordinatorAiStack: [{ agent: 'retry', values: {} }, { agent: 'replacement', values: {} }],
    }, { aliasDuplicateObjects: false }));
    conversation.ask({ id: later, conversationId, attachments: [],
      text: JSON.stringify({ sessionLimit: true, output: 'Second replacement' }) });
    await until(() => conversation.read().turns.some(turn => turn.id === later && turn.status === 'succeeded'), 'the later turn also switches');
    const latest = h.store.read().filter(run => run.requestId === later).at(-1)!;
    const prior = receipts(h.root).find(item => item.pid === latest.pids.agent)!.prompt;
    assert.match(prior, /An extra instruction/, 'earlier joined instructions follow their answered turn');
  } finally { await app.close(); }
});
