/** Alternate every operation between two built releases; preparation runs only between measurement pairs. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
const { values: args } = parseArgs({ options: {
  before: { type: 'string' }, after: { type: 'string' }, out: { type: 'string' },
  'search-only':{type:'boolean'}, catalog: {type:'boolean'}, detail: { type: 'boolean', default: false }, 'expanded-list': { type: 'boolean', default: false }, rounds: { type: 'string', default: '6' }, height: { type: 'string', default: '900' },
} });
if (!args.before || !args.after || !args.out) throw new Error('--before, --after and --out required');
const out = resolve(args.out); mkdirSync(out, { recursive: true });
type Signal = { phase: 'ready' | 'done'; name: string } | null;
const trial = (release: string, label: string) => {
  const child = spawn(process.execPath, ['--import', './e2e/perf/guard.mjs', 'e2e/perf/phone-survey.ts',
    '--release', resolve(release), '--out', join(out, label), '--rounds', args.rounds!, '--height', args.height!, ...(args.catalog ? ['--catalog'] : args.detail ? ['--detail'] : []), ...(args['expanded-list'] ? ['--expanded-list'] : []), ...(args['search-only']?['--search-only']:[])],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const log = createWriteStream(join(out, label + '.log'));
  child.stdout!.pipe(log, { end: false }); child.stderr!.pipe(log, { end: false });
  const queue: Signal[] = [];
  let receiver: ((signal: Signal) => void) | undefined;
  let failure: Error | undefined, ended = false;
  const put = (signal: Signal) => { if (receiver) { const deliver = receiver; receiver = undefined; deliver(signal); } else queue.push(signal); };
  child.on('message', value => put(value as Signal));
  child.on('error', error => { failure = error; ended = true; put(null); });
  const exited = once(child, 'exit').then(([code]) => {
    if (code !== 0) failure = new Error(`${label} exited ${code}`);
    ended = true; put(null); log.end();
  }).catch(error => { failure = error; ended = true; put(null); log.end(); });
  return { child, exited, next: async () => {
    if (failure) throw failure;
    const signal = queue.length ? queue.shift()! : ended ? null : await new Promise<Signal>(done => { receiver = done; });
    if (failure) throw failure;
    return signal;
  } };
};
const trials = [trial(args.before, 'before'), trial(args.after, 'after')];
const expiry = setTimeout(() => { for (const { child } of trials) if (child.connected) child.disconnect(); }, 20 * 60_000);
const pairs: { name: string; first: number }[] = [];
try {
  for (let at = 0; ; at++) {
    const ready = await Promise.all(trials.map(trial => trial.next()));
    if (ready.every(signal => signal === null)) break;
    if (ready.some(signal => signal?.phase !== 'ready') || ready[0]?.name !== ready[1]?.name) throw new Error('Unpaired operations');
    const name = ready[0]!.name, round = /-(\d+)$/.exec(name);
    const first = round ? Number(round[1]) % 2 : at % 2;
    for (const index of [first, 1 - first]) {
      const trial = trials[index]!; trial.child.send('go');
      const done = await trial.next();
      if (done?.phase !== 'done' || done.name !== name) throw new Error('Missing operation completion');
    }
    pairs.push({ name, first });
    writeFileSync(join(out, 'pairs.json'), JSON.stringify(pairs, null, 2));
    console.log(name, 'paired');
    for (const { child } of trials) child.send('advance');
  }
  await Promise.all(trials.map(trial => trial.exited));
} finally {
  clearTimeout(expiry);
  for (const { child } of trials) if (child.connected) child.disconnect();
  await Promise.allSettled(trials.map(trial => trial.exited));
}
