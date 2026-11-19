/** fd 3 and all manager behavior stay real; only its interval clock is stepped. */
import { mock } from 'node:test';
import { readFileSync, watchFile, unwatchFile, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { manageRun } from '@alpacawork/backend/test-dist/runs/manager.js';
import { runIdSchema } from '@alpacawork/contract/fields';
import { installInputManagerClock } from './input-manager-clock.ts';
import { POLL_INTERVAL_MS } from '@alpacawork/backend/test-dist/poll-interval.js';

const [root, rawId, attempt] = process.argv.slice(2);
if (!root || !rawId) throw new Error('Expected fixture root and Run ID');
const id = runIdSchema.parse(rawId);
const clock = join(root, `clock-${id}`), ack = `${clock}.ack`;
let ticks = 0;
const restore = installInputManagerClock();
mock.timers.enable({ apis: ['setInterval'] });
const interval = globalThis.setInterval;
globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
  const timer = interval(...args);
  writeFileSync(ack, '0'); // The manager has installed its polling interval.
  return timer;
}) as typeof setInterval;
watchFile(clock, { interval: 10 }, () => {
  const next = Number(readFileSync(clock, 'utf8'));
  if (next <= ticks) return;
  mock.timers.tick((next - ticks) * POLL_INTERVAL_MS);
  ticks = next;
  writeFileSync(ack, String(ticks));
});
try { await manageRun(root, id, attempt!); }
finally { unwatchFile(clock); globalThis.setInterval = interval; mock.timers.reset(); restore(); }
