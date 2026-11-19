/** A diagnostic entry point for the same replay used by the backend test. Timings belong to run.ts. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { coreDriver } from '../../tests/helpers/projection/core-driver.ts';
import { routingDriver } from '../../tests/helpers/projection/routing-driver.ts';
import { auditReplay } from '../../tests/helpers/projection/harness.ts';

const args = process.argv.slice(2);
function option(name: string, fallback?: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing ${name} value`);
  return value;
}
const seed = Number(option('--seed', '901')), steps = Number(option('--steps', '200'));
if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isSafeInteger(steps) || steps < 1 || steps > 2000)
  throw new Error('Use an unsigned 32-bit seed and between 1 and 2000 steps');
for (let index = 0; index < args.length; index += 2)
  if (!['--seed', '--steps', '--output'].includes(args[index]!)) throw new Error(`Unknown option ${args[index]}`);
const output = option('--output');
const fixture = await coreDriver();
let routing: Awaited<ReturnType<typeof routingDriver>> | undefined;
try {
  routing = await routingDriver();
  const result = await auditReplay({ ...fixture.driver, routing: routing.adapter }, seed, steps);
  const metadata = { sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), node: process.version };
  if (output) {
    const path = resolve(output); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ metadata, ...result }, null, 2) + '\n');
  }
  const { issues, ...summary } = result;
  console.log(JSON.stringify({ metadata, ...summary, issues: issues.length, output: output && resolve(output) }));
  process.exitCode = issues.length || result.written !== steps || result.routingSteps !== steps || result.publicationSteps !== steps ? 1 : 0;
} finally { routing?.close(); await fixture.close(); }
