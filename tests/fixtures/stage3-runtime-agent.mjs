/** Synthetic stdin bridge for the isolated stage 3 manager and store checks. */
import { writeFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';

const [resultPath, resultCase] = process.argv.slice(2);
const root = process.env.ADAPTER_FIXTURE_ROOT;
if (!root || !isAbsolute(root) || !resultPath || !isAbsolute(resultPath)) throw new Error('Synthetic fixture root and result path required');
const rel = relative(root, resultPath);
if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Result must remain inside the fixture root');
process.stdin.once('data', bytes => {
  const input = JSON.parse(String(bytes));
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'synthetic-session' }));
  console.log(JSON.stringify({ type: 'input.taken', id: input.id }));
  if (resultCase === 'present') writeFileSync(resultPath, JSON.stringify({ allowed: process.env.ADAPTER_FIXTURE,
    hidden: process.env.ADAPTER_HIDDEN, run: process.env.ALPACAWORK_RUN, argv: process.argv.slice(4) }));
  else if (resultCase !== 'missing') throw new Error('Unknown synthetic result case');
  console.log(JSON.stringify({ type: 'turn.completed' }));
  process.stdin.destroy();
});
