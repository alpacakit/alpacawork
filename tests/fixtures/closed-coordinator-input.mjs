// Last-resort lifetime for this test-owned process; normal cleanup closes it first.
setTimeout(() => process.exit(124), 60000).unref();
/** Keep working after closing stdin, so the next write fails asynchronously with EPIPE. */
import { createInterface } from 'node:readline';
import { existsSync, writeFileSync, closeSync } from 'node:fs';
import { join } from 'node:path';
const event = value => process.stdout.write(JSON.stringify(value) + '\n');
createInterface({ input: process.stdin }).once('line', line => {
  const input = JSON.parse(line), prompt = input.message.content;
  const args = process.argv.slice(2), session = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
  event({ type: 'command_lifecycle', state: 'started', command_uuid: input.uuid, session_id: session });
  process.stdin.destroy(); closeSync(0);
  writeFileSync(join(process.env.ALPACAWORK_WORKSPACE, 'agent-started'), String(process.pid));
  // The first message is `hold:<gate>`, followed by the conversation's first instructions.
  const release = /^hold:(.+)$/m.exec(prompt)[1];
  const timer = setInterval(() => {
    if (!existsSync(release)) return;
    clearInterval(timer);
    event({ type: 'result', session_id: session, is_error: false, result: 'finished' });
    process.exit(0);
  }, 10);
});
