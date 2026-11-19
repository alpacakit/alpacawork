/** The in-process release service owns each HTTP exchange through socket close. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Agent, request } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setup } from './helpers/release-switch-fixture.ts';

test('release fixture completes each probe before another serve can own its client socket', { timeout: 10000 }, async t => {
  const h = setup(t, { a: 'f1' }); await h.start('a');
  const { url } = JSON.parse(readFileSync(join(h.workspace, '.alpacawork/connection.json'), 'utf8'));
  const agent = new Agent({ keepAlive: true }); t.after(() => agent.destroy());
  const exchange = async (method: string) => {
    let closed!: Promise<unknown>;
    const response = new Promise<import('node:http').IncomingMessage>((done, reject) => {
      const req = request(new URL('/fixture/facts', url), { method, agent }, done);
      req.once('socket', socket => {
        closed = once(socket, 'close', { signal: AbortSignal.timeout(5000) });
        void closed.catch(() => {}); // The response and socket lifetimes are joined below.
      });
      req.once('error', reject); req.end();
    });
    const res = await response;
    const body = once(res, 'end'); res.resume();
    // Finishing the response body alone must not leave a pooled socket from the previous serve.
    await Promise.all([body, closed]);
  };
  await exchange('GET');
  await exchange('POST');
  assert.deepEqual(h.state.acceptedFacts, ['accepted after migration'], 'the mutation is sent exactly once');
});
