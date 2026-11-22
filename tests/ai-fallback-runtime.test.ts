import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { sourceMessage } from '@alpacawork/backend/test-dist/coordinator/messages.js';
import { CoordinatorConversation } from '@alpacawork/backend/test-dist/coordinator/conversation.js';
import { createLaunchMemory } from '@alpacawork/backend/test-dist/receiver/person-state.js';
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { assignResponsible, currentTaskHash, currentTaskLog, seedFixtureTask } from './helpers/control-fixture.ts';
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
  const ask = async (body: string, aiStack?: [{ agent: string; values: { model: string } }, 'stop']) => {
    const request = await service.request({ task: h.taskId, agent: placement.id, opId: randomUUID(), body, aiStack,
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
  assert.equal(prior.resumes, null);
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
    assert.doesNotMatch(prompt, /Do the important task first\.|continuing the same conversation/);
  } finally { await app.close(); }
});

test('terminating a remaining tool process prevents an otherwise eligible fallback', async t => {
  const h = await setup(t);
  h.pauseProjection();
  writeFileSync(join(h.root, 'config.yaml'), stringify({ ...h.config,
    aiStack: [{ agent: 'claude', values: {} }, { agent: 'codex', values: {} }],
  }, { aliasDuplicateObjects: false }));
  const conversation = new CoordinatorConversation(h.root), id = randomUUID(), conversationId = conversation.read().id;
  const app = await startServer(h.root, 0);
  try {
    conversation.ask({ id, conversationId, text: JSON.stringify({ group: true, gate: h.gate('ready'), sessionLimit: true }),
      attachments: [], selected: {} });
    await until(() => receipts(h.root).some(entry => entry.branch === 'child'), 'the agent leaves a child process');
    h.release('ready');
    await until(() => conversation.read().turns.find(turn => turn.id === id)?.status === 'failed', 'the exhausted turn ends');
    const runs = h.store.read().filter(run => run.requestId === id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.availability?.cause, 'session_limit');
  } finally { await app.close(); }
});

test('a queued coordinator message follows the replacement conversation without changing the selected AI memory', async t => {
  const h = await setup(t);
  h.pauseProjection();
  writeFileSync(join(h.root, 'config.yaml'), stringify({ ...h.config,
    aiStack: [{ agent: 'claude', values: {} }, { agent: 'codex', values: {} }],
  }, { aliasDuplicateObjects: false }));
  const memory = createLaunchMemory(h.root);
  const recorded = await memory.change({ kind: 'choose', agent: 'claude', values: {} });
  const conversation = new CoordinatorConversation(h.root);
  const conversationId = conversation.read().id;
  const first = randomUUID(), joined = randomUUID(), pending = randomUUID();
  const send = (id: string, plan: object, tasks?: string[]) => conversation.ask({
    id, conversationId, text: JSON.stringify(plan), attachments: [], selected: {}, tasks,
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
    assert.match(receipts(h.root).find(item => item.pid === h.store.runtimeGet(active.id)?.pids.agent)!.prompt, /An extra instruction/);
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
    assert.deepEqual(memory.get(), recorded);
  } finally { await app.close(); }
});
