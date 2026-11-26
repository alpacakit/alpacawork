import assert from 'node:assert/strict';
import { currentRequestRun, type RunStore, type RunTransaction } from '@alpacawork/runs';

/** A synthetic message's current Run, read by Request identity. */
export function coordinatorRunFor(store: RunStore, request: string, reader: Pick<RunTransaction, 'runtimeGet'> = store) {
  const row = store.connection.prepare(currentRequestRun('?')).get(request);
  const run = row && reader.runtimeGet(`R${row.id}`);
  assert.ok(run?.role === 'coordinator', `no coordinator Run for ${request}`);
  return run;
}
