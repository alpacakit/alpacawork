/** History tells what happened to an agent's conversation: each compaction its agent said, and each new conversation. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { setup } from './runs-runtime.fixture.ts';

test('History has a row for the compaction an agent made on its own and for a later new conversation', async t => {
  const h = await setup(t);
  const compacting = h.create('claude', { compact: { before: 610_000, after: 140_000 } });
  await h.tick();
  await h.waitState(compacting, 'succeeded');
  const kept = h.store.get(compacting.id)!.compactions;
  assert.deepEqual(kept?.map(({ beforeTokens, afterTokens }) => ({ beforeTokens, afterTokens })), [{ beforeTokens: 610_000, afterTokens: 140_000 }]);
  // The same agent's next Run that resumes nothing starts its conversation anew.
  const anew = h.create('claude');
  await h.tick();
  await h.waitState(anew, 'succeeded');
  const app = await startServer(h.root, 0);
  try {
    const response = await fetch(new URL(`/api/task/history?mode=latest&task=${h.taskId}`, app.url));
    const history = await response.json();
    assert.equal(response.status, 200, JSON.stringify(history.error));
    const rows = history.events.filter((event: { kind: string }) => event.kind === 'conversation')
      .map((event: { id: string; conversation: { change: string; beforeTokens?: number; afterTokens?: number } }) => ({ id: event.id, ...event.conversation }));
    assert.deepEqual(rows.map((row: { id: string }) => row.id).sort(), [`${compacting.id}.1`, anew.id].sort());
    const compaction = rows.find((row: { change: string }) => row.change === 'compacted');
    assert.equal(compaction.beforeTokens, 610_000);
    assert.equal(compaction.afterTokens, 140_000);
    assert.equal(rows.filter((row: { change: string }) => row.change === 'new').length, 1, 'the first conversation is not a new one');
  } finally { await app.close(); }
});

test('a new conversation is a later Run that resumes nothing, never the next AI taking over a failed Run', async () => {
  const { newConversationStarts } = await import('@alpacawork/contract/run');
  const run = (id: string, placementId: string, at: string, more: object = {}) =>
    ({ id, placementId, resumes: null, state: 'succeeded' as const, startedAt: at, ...more });
  const starts = newConversationStarts([
    run('R1', 'a', '2026-11-26T00:00:00Z'),
    run('R2', 'a', '2026-11-26T00:01:00Z', { resumes: 'R1' }),
    run('R3', 'a', '2026-11-26T00:02:00Z', { state: 'failed', supersededBy: 'R4' }),
    run('R4', 'a', '2026-11-26T00:03:00Z'),
    run('R5', 'a', '2026-11-26T00:04:00Z'),
    run('R6', 'b', '2026-11-26T00:05:00Z'),
    run('R7', 'a', '2026-11-26T00:06:00Z', { state: 'joined' }),
  ]);
  assert.deepEqual(starts.map(each => each.id), ['R3', 'R5']);
});
