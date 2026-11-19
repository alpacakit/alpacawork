/**
 * Controlled local CLI that takes its instructions on stdin, one JSON line {"id","text"} each, like an agent
 * whose settings declare `input`. The text is a JSON plan. A round of work starts with an instruction and
 * ends when the file named by its `gate` exists; between steps it takes each instruction that arrived
 * (`input.taken`) or refuses it when that instruction's plan says `refuse` (`input.refused`). An instruction
 * that arrives between rounds starts the next round. After stdin closes it exits, first waiting for the
 * file named by `linger` when the first plan names one.
 */
import { appendFileSync, existsSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
const arg = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const root = arg('--root');
const session = args.includes('resume') ? args.at(-1) : 'synthetic-input-session';
const result = arg('-o');
if (!root || !realpathSync(root).startsWith(realpathSync(tmpdir()) + sep) || !basename(root).startsWith('alpacawork-'))
  throw new Error('Fake agent requires an isolated temporary alpacawork root');
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const note = value => appendFileSync(join(root, 'input-agent.jsonl'), `${JSON.stringify({ pid: process.pid, ...value })}\n`);
const waiting = [];
let open = true, linger = null;
const lines = createInterface({ input: process.stdin });
lines.on('line', line => waiting.push(JSON.parse(line)));
lines.on('close', () => { open = false; note({ stdin: 'closed' }); });
note({ started: true, session });
emit({ type: 'thread.started', thread_id: session });
const plan = input => { try { return JSON.parse(input.text); } catch { return {}; } };
for (;;) {
  const first = waiting.shift();
  if (!first) {
    if (!open) break;
    await delay(20);
    continue;
  }
  const work = plan(first);
  linger ??= work.linger ?? '';
  emit({ type: 'input.taken', id: first.id });
  note({ taken: first.text });
  while (work.gate && !existsSync(join(root, work.gate))) {
    for (const next of waiting.splice(0)) {
      if (plan(next).refuse) { emit({ type: 'input.not_sent', evidence: 'transfer_not_started', id: next.id, message: 'refused by plan' }); note({ refused: next.text }); }
      else { emit({ type: 'input.taken', id: next.id }); note({ taken: next.text }); }
    }
    await delay(20);
  }
  writeFileSync(result, `reply to ${first.text}`);
  emit({ type: 'turn.completed' });
}
while (linger && !existsSync(join(root, linger))) await delay(20);
