import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasContinuableSession } from '../packages/contract/dist/run-contract.js';

test('a failed or stopped sessionless Run has no continued selection', () => {
  assert.equal(hasContinuableSession({ state: 'failed', session: null }), false);
  assert.equal(hasContinuableSession({ state: 'cancelled', session: null }), false);
  assert.equal(hasContinuableSession({ state: 'failed', session: { provider: 'claude', id: 's' } }), true);
  assert.equal(hasContinuableSession({ state: 'queued', session: null }), true);
});
