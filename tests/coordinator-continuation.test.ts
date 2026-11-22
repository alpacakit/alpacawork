/** One rule decides which session a coordinator message continues and the values an omitted choice keeps. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { continuation, resumable } from '@alpacawork/backend/test-dist/coordinator/continuation.js';

let next = 1;
const run = (agent: string, state: string, values: Record<string, string | null>, session: string | null = 's') =>
  ({ id: `R${next++}`, agent, state, session: session === null ? null : { provider: agent, id: session },
    launch: { adapter: 'claude', argv: ['claude'], path: '/bin', env: [], values } }) as any;

test('the values come from the Run continued, a waiting one included; explicit null is kept', () => {
  assert.equal(continuation([], 'first'), null, 'No Run: a new session with a new selection');
  const answered = run('first', 'succeeded', { model: 'b', effort: null });
  const waiting = run('first', 'queued', { model: 'a', effort: 'high' });
  const next = continuation([answered, waiting], 'first');
  assert.equal(next?.continued, waiting);
  assert.deepEqual(next?.previous, { adapter: 'claude', values: { model: 'a', effort: 'high' } },
    'A waiting message chose a: the next one keeps a, not the answered b');
  assert.deepEqual(continuation([answered], 'first')?.previous.values, { model: 'b', effort: null });
});

test('a failed last Run leaves the one before it; another agent or a sessionless ended Run starts anew', () => {
  const before = run('first', 'succeeded', { model: 'b' });
  assert.deepEqual(continuation([before, run('first', 'failed', { model: 'a' })], 'first')?.previous.values, { model: 'b' });
  assert.equal(continuation([before, run('second', 'succeeded', {})], 'first'), null);
  assert.equal(continuation([run('first', 'succeeded', { model: 'b' }, null)], 'first'), null);
  const starting = run('first', 'running', { model: 'b' }, null);
  assert.equal(continuation([starting], 'first')?.continued, starting, 'A first turn still running is continued');
});

test('what a conversation goes on from does not count a Run that failed to launch, whichever agent it was', () => {
  const before = run('first', 'succeeded', { model: 'b' });
  const runs = [before, run('second', 'failed', { model: 'x' }, null)];
  assert.equal(resumable(runs)?.continued, before);
  assert.equal(continuation(runs, 'first')?.continued, before);
  assert.equal(continuation(runs, 'second'), null);
});
