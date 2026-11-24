/**
 * A responsible agent that reports its Task through the real CLI with its Run's credential, as the start text tells a
 * responsible to: a request `ask` asks the user the question of its body, any other request reports done.
 * It writes Claude's stream-json, so its Run keeps a session. A refused report fails the Run with the CLI's answer.
 */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const arg = name => args[args.indexOf(name) + 1];
const cli = arg('--cli'), session = arg('--session'), prompt = arg('--prompt');
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const fail = message => { throw new Error(message); };
emit({ type: 'system', subtype: 'init', session_id: session });

const task = /^\[alpacawork\] Request for task ([TP]\d+)\b/.exec(prompt)?.[1] ?? fail('The start text names no Task');
// alpacawork's start text carries the request text on the line after the request heading.
const lines = prompt.split('\n'), request = lines[lines.indexOf('## Request') + 1];

function alpacawork(argv, input = '') {
  const result = spawnSync(process.execPath, [cli, ...argv], { input, encoding: 'utf8', timeout: 30_000 });
  let body = null;
  try { body = JSON.parse(result.status === 0 ? result.stdout : result.stderr); } catch { /* Reported whole below. */ }
  return { ok: result.status === 0, body, text: result.stderr || result.stdout };
}
/** Reports on the Task as it is now: a change between the read and the report (its Run's start recorded) reads again. */
function report(argv, input) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const read = alpacawork(['task', 'get', '--task', task]);
    if (!read.ok) fail(read.text);
    const sent = alpacawork(['task', 'report', '--task', task, ...argv, '--expected-task-hash', read.body.task.hash,
      '--op-id', randomUUID()], input);
    if (sent.ok) return sent.body;
    if (sent.body?.error?.code !== 'conflict') fail(sent.text);
  }
  return fail(`${task} kept changing while it was reported`);
}

const reported = request === 'ask'
  ? report(['--state', 'waiting', '--ask-to', 'user', '--title', 'Which way?', '--description-file', '-'], 'The body asks which way to go.')
  : report(['--state', 'done', '--title', 'Done', '--description-file', '-'], 'The requested work is complete.');
emit({ type: 'result', is_error: false, result: reported.task.state, session_id: session });
