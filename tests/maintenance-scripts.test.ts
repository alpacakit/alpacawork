import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import koffi from 'koffi';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { phoneResults } from './helpers/script-fixtures.ts';

const repo = resolve(import.meta.dirname, '..');
const run = (script: string, args: string[], cwd: string, env = process.env) => spawnSync(process.execPath,
  [join(repo, script), ...args], { cwd, env, encoding: 'utf8' });
function temporary(t: { after: (cleanup: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), 'alpacawork-script-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('status dry run selects the latest clean quick/all result across worktrees for the same tree', t => {
  const root = temporary(t), main = join(root, 'main'), other = join(root, 'other'), bin = join(root, 'bin');
  mkdirSync(main); mkdirSync(bin);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: main, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Fixture');
  git('worktree', 'add', '--detach', other);
  const sha = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
  const marker = join(root, 'gh-called');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH };
  const record = (worktree: string, name: string, extra = {}) => {
    const directory = join(worktree, '.local', 'test-runs', name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'result.json'), JSON.stringify({ tree, clean: true, mode: 'quick',
      finished: '2026-01-01T00:00:00Z', passed: true, seconds: 65, area: [], node: [], e2e: [], failed: [], ...extra }));
  };
  const args = ['--dry-run', '--rev', sha];
  assert.notEqual(run('scripts/testing/post-status.ts', args, main, env).status, 0);
  record(main, 'old');
  record(main, 'dirty', { clean: false, finished: '2026-01-03' });
  record(main, 'smoke', { mode: 'smoke', finished: '2026-01-03' });
  record(main, 'wrong-tree', { tree: 'unrelated', finished: '2026-01-03' });
  record(main, 'broken');
  writeFileSync(join(main, '.local/test-runs/broken/result.json'), '{');
  record(other, 'new', { finished: '2026-01-02', passed: false, failed: ['node'], node: ['tests/example.test.ts'] });
  const result = run('scripts/testing/post-status.ts', args, main, env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^${sha.slice(0, 12)}: tests failure`));
  assert.match(result.stdout, /example\.test\.ts failed \(node\) in 1m 5s/);
  record(other, 'long', { finished: '2026-01-04', area: ['😀'.repeat(150)] });
  const long = run('scripts/testing/post-status.ts', args, main, env);
  assert.equal(long.status, 0, long.stderr);
  const description = long.stdout.trim().split(' — ')[1];
  assert.equal(Array.from(description).length, 140);
  assert.equal(description.at(-1), '…');
  assert.equal(existsSync(marker), false, 'dry-run must never invoke gh');
});

test('phone summary retains outliers, partial series, warmups and supplementary windows', t => {
  const root = temporary(t);
  phoneResults(root);
  const result = run('scripts/perf/phone-survey-summary.ts', [root], repo);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(readFileSync(join(root, 'latency-summary.json'), 'utf8'));
  const open = summary.summary[0];
  assert.equal(open.operation, 'detail-open');
  assert.equal(open.n, 4); assert.equal(open.complete, true);
  assert.deepEqual(open.elapsedMs, { median: 101.5, min: 100, max: 11000 });
  assert.equal(open.samples.length, 4); assert.equal(open.scriptMs, null);
  const close = summary.summary.find((row: { operation: string }) => row.operation === 'input-close');
  assert.equal(close.n, 2); assert.equal(close.complete, false);
  assert.deepEqual(close.elapsedMs, { median: 3, min: 2.5, max: 3.5 });
  assert.equal(summary.warmups.length, 1); assert.equal(summary.supplementary.length, 1);
  assert.equal(readFileSync(join(root, 'latency-table.md'), 'utf8'), result.stdout);
  assert.match(result.stdout, /\|3 \[2–4\]\|3 \/ 4\|/);
  const invalid = join(root, 'detail/results.json');
  const input = JSON.parse(readFileSync(invalid, 'utf8')); input.profile = true;
  writeFileSync(invalid, JSON.stringify(input));
  assert.notEqual(run('scripts/perf/phone-survey-summary.ts', [root], repo).status, 0);
});

test('database range-lock expiry stops a fixture even while native lock acquisition blocks', t => {
  const root = temporary(t), path = join(root, 'database');
  writeFileSync(path, '');
  const libc = koffi.load(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6');
  const seek = libc.func('int64_t lseek(int fd, int64_t offset, int whence)');
  const lock = libc.func('int lockf(int fd, int command, int64_t length)');
  const fd = openSync(path, 'r+');
  try {
    assert.equal(Number(seek(fd, 1073741824, 0)), 1073741824);
    assert.equal(lock(fd, 1, 512), 0);
    const result = spawnSync(process.execPath, [join(repo, 'tests/fixtures/database-range-lock.ts'), path, 'hold', '1'],
      { encoding: 'utf8', timeout: 3000 });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, 'SIGALRM');
    assert.equal(result.stdout, '');
  } finally { closeSync(fd); }
});
