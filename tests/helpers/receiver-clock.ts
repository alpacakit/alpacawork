import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { POLL_INTERVAL_MS } from '@alpacawork/backend/test-dist/poll-interval.js';

/**
 * Drive periodic callbacks and accelerate Date.now() by the same offset.
 * Wall time still advances Date.now(), including FileWriter's busy deadline;
 * new Date() timestamps, sockets, filesystem I/O and setTimeout remain real.
 * Explicit advances also accelerate Date.now()-based deadlines (such as the
 * receiver's four-second yielding bound), so this is a process-wide test clock.
 */
export function receiverClock(t: TestContext) {
  const realNow = Date.now;
  let offset = 0;
  t.mock.timers.enable({ apis: ['setInterval'] });
  t.mock.method(Date, 'now', () => realNow() + offset);
  const tick = (ms: number) => {
    offset += ms;
    t.mock.timers.tick(ms);
  };
  return {
    async advance(ms: number) {
      tick(ms);
      // Let the real asynchronous pass finish its filesystem/database work.
      await delay(0);
    },
    async until(check: () => boolean, message = 'receiver pass completes', timeoutMs = 5_000) {
      const deadline = performance.now() + timeoutMs;
      tick(POLL_INTERVAL_MS);
      while (!check() && performance.now() < deadline) {
        await delay(10);
        // Keep driving later intervals, including a pass deferred by its gap.
        if (!check()) tick(10);
      }
      assert.ok(check(), message);
    },
  };
}
