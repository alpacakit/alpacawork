import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
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
  const first = randomUUID(), pending = randomUUID();
  const send = (id: string, plan: object) => conversation.ask({
    id, conversationId, text: JSON.stringify(plan), attachments: [], selected: {},
  });
  const app = await startServer(h.root, 0);
  try {
    send(first, { gate: h.gate('first'), sessionLimit: true, fallbackGate: h.gate('answer'), output: 'Replacement reply' });
    await until(() => conversation.read().turns.find(turn => turn.id === first)?.status === 'running', 'first turn starts');
    send(pending, { output: 'Follow-up reply' });
    h.release('first');
    await until(() => conversation.read().turns.some(turn => turn.id === first && turn.attempts?.length === 2), 'replacement trial is visible');
    assert.deepEqual(conversation.read().turns.map(turn => turn.id), [first, pending]);
    assert.equal(conversation.read().turns.find(turn => turn.id === pending)?.status, 'queued');
    h.release('answer');
    await until(() => conversation.read().turns.every(turn => turn.status === 'succeeded'), 'both replies arrive in order');
    const turns = conversation.read().turns;
    assert.deepEqual(turns.map(turn => turn.answer), ['Replacement reply', 'Follow-up reply']);
    assert.equal(turns[0]?.attempts?.[0]?.availability?.cause, 'session_limit');
    const active = h.store.read().filter(run => run.requestId === first).at(-1);
    const following = h.store.read().find(run => run.requestId === pending);
    assert.equal(following?.agent, 'codex');
    assert.equal(following?.resumes, active?.id);
    assert.equal(following?.session?.id, active?.session?.id);
    assert.deepEqual(memory.get(), recorded);
  } finally { await app.close(); }
});
