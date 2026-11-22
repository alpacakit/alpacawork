import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
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
    assert.equal(receipts(h.root).filter(item => item.branch === 'agent').length, 3);
  } finally { await app.close(); }
});
