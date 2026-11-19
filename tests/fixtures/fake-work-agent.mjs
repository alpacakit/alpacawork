// Last-resort lifetime for this test-owned process; normal cleanup closes it first.
setTimeout(() => process.exit(124), 150000).unref();
/** Real manager stdout, with test-owned gates for a visible operation and its end. */
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const args = process.argv.slice(2), session = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
const input = createInterface({ input: process.stdin });
const first = await new Promise(done => input.once('line', line => done(JSON.parse(line))));
input.close();
const prompt = first.message.content;
process.stdout.write(JSON.stringify({ type: 'command_lifecycle', state: 'started', command_uuid: first.uuid, session_id: session }) + '\n');
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const finish = () => emit({ type: 'result', session_id: session, is_error: false, result: 'Finished checking the work display.' });
if (prompt.includes('Reply only with: ready')) { finish(); process.exit(0); }
const start = (id, command) => emit({ type: 'assistant', parent_tool_use_id: null,
  message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const end = id => emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } });
const wait = async stage => {
  const deadline = Date.now() + 120_000;
  while (!existsSync(join(process.env.ALPACAWORK_WORKSPACE, `work-${stage}`))) {
    if (Date.now() > deadline) throw new Error(`work gate timed out: ${stage}`);
    await delay(25);
  }
};
start('one', 'alpacawork task new --title test');
await wait('end'); end('one');
await wait('unknown'); start('two', 'echo alpacawork task new');
await wait('update'); end('two'); start('three', 'alpacawork task update --task T1 --title changed');
await wait('finish'); end('three'); finish();
