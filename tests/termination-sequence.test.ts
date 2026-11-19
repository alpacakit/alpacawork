import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminationSequence } from '@alpacawork/backend/test-dist/runs/termination.js';

test('TERM and KILL are issued once with their grace', () => {
  const graceMs = 10_000;
  const sequence = new TerminationSequence(graceMs);
  assert.equal(sequence.next(100), 'SIGTERM');
  assert.equal(sequence.next(100), null);
  assert.equal(sequence.next(100 + graceMs - 1), null);
  assert.equal(sequence.next(100 + graceMs), 'SIGKILL');
  assert.equal(sequence.killedAt, 100 + graceMs);
  assert.equal(sequence.next(100 + graceMs), null);
  assert.equal(sequence.next(100000), null);
});
