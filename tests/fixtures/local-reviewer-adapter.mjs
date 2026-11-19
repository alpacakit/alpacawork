/** Synthetic native adapter boundary around the local shell reviewer; no provider executable. */
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
const [root, script, ...args] = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const resumed = args.includes('--resume'), session = resumed ? option('--resume') : option('--session-id');
const lines = createInterface({ input: process.stdin });
const input = await new Promise(done => lines.once('line', line => done(JSON.parse(line)))); lines.close();
const emit = row => process.stdout.write(JSON.stringify(row) + '\n');
emit({ type: 'command_lifecycle', state: 'started', command_uuid: input.uuid, session_id: session });
const child = spawn('/bin/sh', [script, '--root', root, '--session', session, ...(resumed ? ['--resume'] : []), input.message.content],
  { stdio: ['ignore', 'pipe', 'inherit'] });
let result = ''; child.stdout.on('data', chunk => result += chunk);
const code = await new Promise(done => child.once('exit', done));
if (code === 0) emit({ type: 'result', session_id: session, is_error: false, result });
process.exit(code ?? 1);
