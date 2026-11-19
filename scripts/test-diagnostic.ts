/** Explicit sequential edition build + real-path checks; never overlap this with another checkout build. */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { buildRelease } from '@alpacawork/backend/test-dist/release/build.js';
import { buildHistoricalRelease } from './helpers/legacy-producer.ts';
const { values } = parseArgs({ options: { out: { type: 'string' }, ref: { type: 'string', default: 'HEAD' }, 'old-ref': { type: 'string' },
  rounds: { type: 'string', default: '3' } } });
if (!values.out) throw Error('--out is required (use a fresh directory to preserve failures)');
if (!values['old-ref']) throw Error('--old-ref is required: a commit of this repository to build as the old shape to compare against');
if (spawnSync('git', ['rev-parse', '--quiet', '--verify', `${values['old-ref']}^{commit}`]).status !== 0)
  throw Error(`--old-ref ${values['old-ref']} is not a commit of this repository`);
const out = resolve(values.out); mkdirSync(out, { recursive: false });
const releases = join(out, 'releases'); mkdirSync(releases);
const say = (line: string) => console.error(line);
const production = await buildRelease(process.cwd(), releases, values.ref!, say, 'production');
const diagnostic = await buildRelease(process.cwd(), releases, values.ref!, say, 'diagnostic');
const oldRef = values['old-ref'];
// Only the old-shape comparison uses a historical producer. A new builder requires a target-owned assembler.
const old = await buildHistoricalRelease({ repo: process.cwd(), releases, producerRef: oldRef, targetRef: oldRef, workRoot: join(out, 'legacy-driver') });
writeFileSync(join(out, 'builds.json'), JSON.stringify({ production, diagnostic, old, ref: values.ref, node: process.version }, null, 2));
/** One check under the queue and the perf guard; a failing check ends the whole run with its status. */
async function runStage(stage: 'e2e' | 'node', script: string, args: string[]) {
  const child = spawn(process.execPath, ['scripts/testing/queue.ts', stage, '--', process.execPath, '--import', './e2e/perf/guard.mjs', script, ...args], { stdio: 'inherit' });
  const status = await new Promise<number>(done => child.once('exit', code => done(code ?? 1)));
  if (status) process.exit(status);
}
await runStage('e2e', 'e2e/perf/diagnostic-cold.ts', ['--release', diagnostic, '--out', join(out, 'cold'), '--rounds', values.rounds!]);
await runStage('e2e', 'e2e/perf/diagnostic-bfcache.ts', ['--release', diagnostic, '--out', join(out, 'bfcache')]);
await runStage('e2e', 'e2e/perf/diagnostic-check.ts', ['--production', production, '--diagnostic', diagnostic, '--old', old, '--out', out, '--rounds', values.rounds!]);
