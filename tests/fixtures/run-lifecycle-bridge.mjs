/** The real bridge runner around a scripted Runtime: its start waits for a file, then does what the test named. */
import { appendFileSync, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { run } from '../../apps/agent-cli/test-dist/run.js';

const [gate, mode, log] = process.argv.slice(2);
run(io => ({
  async start() {
    while (!existsSync(gate)) await delay(5);
    if (mode === 'reject') throw new Error('scripted start rejection');
    if (mode === 'fatal-pending') { io.fatal(new Error('scripted synchronous fatal')); return new Promise(() => {}); }
    if (mode === 'fatal-then-success') { io.fatal(new Error('scripted synchronous fatal')); await delay(20); return; }
  },
  async deliver(input) {
    appendFileSync(log, `${JSON.stringify(input)}\n`);
    if (mode === 'deliver-throw') throw new Error('scripted delivery failure');
    if (mode === 'deliver-uncertain') { setTimeout(() => io.started(input.id), 30); return { state: 'uncertain', message: 'scripted uncertain' }; }
    io.started(input.id);
    return { state: 'transferred' };
  },
  idle: () => true, turns: () => 1, failed: () => false, close() {},
}));
