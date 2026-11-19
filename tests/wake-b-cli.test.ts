/** B through the real HTTP/CLI commands, with isolated storage and no production workspace. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, pass, fixture, userBall } from './return-repro.fixture.ts';
import { returnDisposition } from '@alpacawork/backend/test-dist/control/return-lifecycle.js';

test('B CLI: an open child does not hide arrived results behind outstanding when the automatic limit stops even urgent delivery', async t => {
  const h = await fixture(t);
  const parent = await h.human(h.T.id, h.OT.revision); h.start(parent.runId);
  const child = await h.agent(h.C.id, h.OC.id, h.OC.revision, parent.runId); h.start(child.runId);
  const work = await h.agent(h.T.id, h.WT.id, h.WT.revision, parent.runId); h.start(work.runId);
  h.end(parent.runId); h.end(work.runId);
  await h.urgent(child.runId, h.C.id);
  writeFileSync(join(h.root, 'config.yaml'), config(0));
  const result = await pass(h.root);
  assert.deepEqual(result.acceptedRequestIds, []);
  assert.deepEqual(result.held, [{ taskId: h.T.id, reason: 'automatic_limit', project: h.project }]);
  const pending = h.store.readReturns().filter(row => row.toTaskId === h.T.id);
  assert.deepEqual(new Set(pending.map(row => row.outcome)), new Set(['succeeded', 'urgent']));
  assert.ok(pending.every(row => returnDisposition(row) === 'pending' && row.deliveries.length === 0));
  assert.deepEqual([(await userBall(h.root, h.T.id))?.reason, (await userBall(h.root, h.T.id))?.count],
    ['limit', 2], 'the limit reports both pending rows, including the closing result');
});
