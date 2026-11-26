#!/usr/bin/env node
/** Report the newest clean quick/all run for a commit's tree as GitHub's `tests` status. */
import { execFileSync, spawnSync } from 'node:child_process';
import { globSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';

interface TestResult {
  tree: string;
  clean: boolean;
  mode: string;
  finished: string;
  passed: boolean;
  seconds: number;
  area: string[];
  node: string[];
  e2e: string[];
  web?: boolean;
  failed: string[];
}

const context = 'tests';
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();

function* results(): Generator<TestResult> {
  for (const line of git('worktree', 'list', '--porcelain').split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const directory = join(line.slice('worktree '.length), '.local', 'test-runs');
    for (const path of globSync('*/result.json', { cwd: directory })) {
      try { yield JSON.parse(readFileSync(join(directory, path), 'utf8')); }
      catch { /* Incomplete/unreadable records do not stand for a test result. */ }
    }
  }
}

export function describe(result: TestResult): string {
  const scope = [result.mode, ...(result.web ? ['web'] : []), ...result.area.map(area => `area ${area}`),
    ...[...result.node, ...result.e2e].map(path => basename(path))].join(' + ');
  const verdict = result.passed ? 'passed' : `failed (${result.failed.join(', ')})`;
  const description = `Maintainer machine: ${scope} ${verdict} in ${Math.floor(result.seconds / 60)}m ${result.seconds % 60}s`;
  const characters = Array.from(description);
  return characters.length <= 140 ? description : characters.slice(0, 139).join('') + '…';
}

function main(): void {
  const { values } = parseArgs({ options: {
    rev: { type: 'string', default: 'HEAD' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('Report a test result from this machine as the `tests` commit status on GitHub.\n\nUsage: node scripts/testing/post-status.ts [--rev HEAD] [--dry-run]');
    return;
  }
  const sha = git('rev-parse', values.rev + '^{commit}');
  const tree = git('rev-parse', values.rev + '^{tree}');
  const matching = [...results()].filter(result => result.tree === tree && result.clean && ['quick', 'all'].includes(result.mode));
  if (!matching.length) throw new Error(`post-test-status: no clean test run of ${sha.slice(0, 12)}'s content. Run pnpm test:quick (or the tests this change needs) in a clean checkout of it first.`);
  const result = matching.reduce((latest, next) => next.finished > latest.finished ? next : latest);
  const state = result.passed ? 'success' : 'failure', description = describe(result);
  console.log(`${sha.slice(0, 12)}: ${context} ${state} — ${description}`);
  if (values['dry-run']) return;
  const existing = spawnSync('gh', ['api', `repos/{owner}/{repo}/commits/${sha}`, '--silent']);
  if (existing.error) throw existing.error;
  if (existing.status !== 0) throw new Error(`post-test-status: ${sha.slice(0, 12)} is not on GitHub yet. Push it first.`);
  execFileSync('gh', ['api', '-X', 'POST', `repos/{owner}/{repo}/statuses/${sha}`, '--silent',
    '-f', `state=${state}`, '-f', `context=${context}`, '-f', `description=${description}`], { stdio: 'inherit' });
}

if (import.meta.main) {
  try { main(); }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
