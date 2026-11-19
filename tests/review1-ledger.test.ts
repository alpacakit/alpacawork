import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlStore, keepControlTables } from '@alpacawork/db';
import { unclosedSent } from '@alpacawork/runs';
import { handlingFixture } from './return-handling.fixture.ts';

test('a seat continuation never closes, so it must not stay an unclosed sent candidate', async t => {
  const h = await handlingFixture(t), release = keepControlTables(h.root);
  const reader = new ControlStore(h.root, { busyTimeoutMs: 1000 }, true);
  t.after(() => { reader.close(); release(); });
  const delivered = await h.deliver();
  await h.consume(delivered.run);
  const candidates = reader.read(db => unclosedSent(db, h.root, [h.task.id]).get(h.task.id)!);
  assert(!candidates.includes(delivered.request), 'the consumed continuation is still a candidate');
});
