import { resolve } from 'node:path';
import { test } from 'node:test';
import { ProcessTracker, type Stage } from '../scripts/testing/run.ts';

// Exercise the real outer runner and queue with executable fixtures. No product
// build, browser, or agent is needed to verify admission, selection and teardown.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, existsSync, cpSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { RUNTIME_EXTERNAL_ROOTS } from '../scripts/runtime-roots.mjs';

const repository = resolve('.');
const fixtureProgram = String.raw`#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { spawn } from 'node:child_process';
const name = basename(process.argv[1]), args = process.argv.slice(2);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function execute(command, argv) {
  const child = spawn(command, argv, { stdio: 'inherit', env: process.env });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  await new Promise(resolve => child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGTERM' ? 143 : 1); resolve(); }));
}
const realScript = name === 'node' && ['scripts/test-runtime-roots.mjs', 'scripts/testing/queue.ts', 'scripts/testing/run.ts', 'scripts/test-smoke.ts'].includes(args[0]);
if (realScript && args[0] !== 'scripts/test-smoke.ts') {
  await execute(process.env.PROBE_REAL_NODE, args);
} else {
  appendFileSync('calls.jsonl', JSON.stringify({ name, args, workers: process.env.ALPACAWORK_TEST_WORKERS, env: Object.fromEntries(['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'ALPACAWORK_TEST_QUEUE_DIR', 'PLAYWRIGHT_BROWSERS_PATH', 'COREPACK_HOME', 'COREPACK_ENABLE_NETWORK', 'COREPACK_DEFAULT_TO_LATEST', 'TZ'].map(key => [key, process.env[key]])) }) + '\n');
  if (name === 'pnpm') {
    if (args[0] === 'build' && process.env.PROBE_QUEUE_BUILD) {
      const program = "const fs = require('node:fs');fs.writeFileSync('build-scratch', process.env.TMPDIR);fs.writeFileSync('build.pid', String(process.pid));setTimeout(() => {}, 120000)";
      const child = spawn(process.env.PROBE_REAL_NODE, ['scripts/testing/queue.ts', 'build', '--', process.env.PROBE_REAL_NODE, '-e', program], { stdio: 'inherit', env: process.env });
      writeFileSync('build-wrapper.pid', String(child.pid));
      await new Promise(resolve => child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGKILL' ? 137 : 1); resolve(); }));
    } else if (args[0] === 'build:packages') {
      if (process.env.PROBE_HOLD_BUILD) { writeFileSync('build.pid', String(process.pid)); while (!existsSync('release-build')) await wait(25); }
      if (process.env.PROBE_DETACHED === 'build') {
        const child = spawn(process.env.PROBE_REAL_NODE, ['-e', "process.on('SIGTERM',()=>{});setTimeout(()=>{},120000)"], { detached: true, stdio: 'ignore' });
        child.unref(); writeFileSync('detached.pid', String(child.pid)); await wait(100);
      }
      process.exitCode = Number(process.env.PROBE_BUILD_EXIT || 0);
    } else if (['build:apps', 'build:web', 'build:apps:diagnostic', 'build:web:diagnostic', 'i18n:check'].includes(args[0])) {
      process.exitCode = 0;
    } else {
      const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
      await execute('/bin/sh', ['-c', scripts[args[0]] + ' "$@"', 'pnpm-script', ...args.slice(1)]);
    }
  } else if (realScript) {
    await execute(process.env.PROBE_REAL_NODE, args);
  } else if (name === 'node') {
    if (args.includes('--test') && process.env.PROBE_HOLD_NODE) { writeFileSync('node-ready', String(process.pid)); while (!existsSync('release-node')) await wait(25); }
    if (args.some(arg => arg.includes('acceptance/'))) process.exitCode = Number(process.env.PROBE_ACCEPTANCE_EXIT || 0);
    if (args.includes('e2e/fixture-regression.test.ts')) process.exitCode = Number(process.env.PROBE_FIXTURE_EXIT || 0);
  } else if (name === 'playwright') {
    if (args.includes('--list')) {
      const report = JSON.parse(readFileSync('full-list.json', 'utf8'));
      if (args.includes('--test-list')) { const selected = readFileSync(args[args.indexOf('--test-list') + 1], 'utf8').trim().split('\n'); report.suites = report.suites.filter(s => selected.includes(s.title)); }
      writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify(report));
    } else if (process.env.PROBE_HOLD_BROWSER) {
      writeFileSync('browser-ready', String(process.pid)); while (!existsSync('release-browser')) await wait(25);
    } else if (process.env.PROBE_TERM) {
      const child = spawn(process.env.PROBE_REAL_NODE, ['-e', "process.on('SIGTERM',()=>{});setTimeout(()=>{},120000)"], { detached: true, stdio: 'ignore' });
      child.unref(); writeFileSync('detached.pid', String(child.pid)); await wait(100); writeFileSync('ready', 'ready'); await wait(120000);
    }
  }
}
`;

type Call = { name: string; args: string[]; workers: string; env: Record<string, string> };
function fixture(extraEnv: Record<string, string> = {}, mutate?: (source: string) => string) {
  const root = mkdtempSync(join(tmpdir(), 'test-all-fixture-'));
  for (const dir of ['scripts/testing', 'scripts/lib', 'bin', 'e2e', 'tests/acceptance']) mkdirSync(join(root, dir), { recursive: true });
  const source = readFileSync(join(repository, 'scripts/testing/run.ts'), 'utf8');
  writeFileSync(join(root, 'scripts/testing/run.ts'), mutate ? mutate(source) : source);
  for (const name of ['test-smoke.ts', 'test-smoke.txt', 'test-runtime-roots.mjs', 'runtime-roots.mjs']) copyFileSync(join(repository, 'scripts', name), join(root, 'scripts', name));
  copyFileSync(join(repository, 'scripts/testing/queue.ts'), join(root, 'scripts/testing/queue.ts'));
  if (existsSync(join(repository, 'scripts/lib'))) cpSync(join(repository, 'scripts/lib'), join(root, 'scripts/lib'), { recursive: true });
  for (const { name, from } of RUNTIME_EXTERNAL_ROOTS) {
    const entry = join(root, from, 'node_modules', name);
    mkdirSync(entry, { recursive: true });
    writeFileSync(join(entry, 'package.json'), JSON.stringify({ name, main: 'index.cjs' }));
    writeFileSync(join(entry, 'index.cjs'), '');
  }
  const koffi = createRequire(import.meta.url).resolve('koffi');
  rmSync(join(root, 'node_modules/koffi'), { recursive: true, force: true });
  symlinkSync(resolve(koffi, '..'), join(root, 'node_modules/koffi'));
  copyFileSync(join(repository, 'package.json'), join(root, 'package.json'));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'fixture sentinel\n');
  for (const file of ['tests/related.test.ts', 'tests/task-policy.test.ts', 'tests/acceptance/probe.test.ts', 'e2e/related.check.ts', 'e2e/hold.check.ts']) writeFileSync(join(root, file), '');
  const lines = readFileSync(join(root, 'scripts/test-smoke.txt'), 'utf8').split('\n').filter(l => l && !l.startsWith('#'));
  // A suite title can contain the native delimiter in this synthetic reporter;
  // the flattened selector is still the exact real manifest entry.
  const suites = [...lines, 'related.check.ts › related'].map((line, i) => ({ title: line,
    specs: [{ id: 'id-' + i, title: line.split(' › ').slice(1).join(' › '), file: line.split(' › ')[0], tests: [{ projectName: '', expectedStatus: 'passed' }] }] }));
  writeFileSync(join(root, 'full-list.json'), JSON.stringify({ errors: [], suites }));
  for (const command of ['pnpm', 'node', 'playwright', 'vitest', 'tsc']) writeFileSync(join(root, 'bin', command), fixtureProgram, { mode: 0o755 });
  const env = { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH, PROBE_REAL_NODE: process.execPath,
    ALPACAWORK_TEST_QUEUE_DIR: join(root, 'queue'), ALPACAWORK_TEST_WORKERS: 'auto', ALPACAWORK_TEST_MAX_PARALLEL: 'auto',
    ALPACAWORK_TEST_AUTO_MAX_WORKERS: '5', ALPACAWORK_TEST_QUEUE_CPUS: '32', ALPACAWORK_TEST_QUEUE_LOAD: '0',
    ALPACAWORK_TEST_QUEUE_TOTAL_MIB: '65536', ALPACAWORK_TEST_QUEUE_AVAILABLE_MIB: '65536', ...extraEnv };
  let child: ChildProcess | undefined;
  return { root,
    start(args: string[]) {
      child = spawn(process.execPath, ['scripts/testing/run.ts', ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout!.on('data', data => output += data);
      child.stderr!.on('data', data => output += data);
      const done = new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        child!.on('error', reject);
        child!.on('close', code => resolve({ code, output }));
      });
      return { child, done, output: () => output };
    },
    results() {
      const runs = join(root, '.local/test-runs');
      return readdirSync(runs).flatMap(run => {
        const result = join(runs, run, 'result.json');
        return existsSync(result) ? [JSON.parse(readFileSync(result, 'utf8'))] : [];
      });
    },
    calls(): Call[] { return readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); },
    dispose() {
      if (child && child.exitCode === null) child.kill('SIGKILL');
      for (const name of ['detached.pid', 'build.pid', 'browser-ready', 'node-ready']) {
        try { process.kill(Number(readFileSync(join(root, name), 'utf8')), 'SIGKILL'); } catch {}
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'fixture did not become ready');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
function alive(pid: number) {
  try {
    if (process.platform === 'linux' && readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.startsWith('Z ')) return false;
    process.kill(pid, 0); return true;
  } catch { return false; }
}
function admissionMatches(calls: Call[]) {
  for (const call of calls.filter(c => ['node', 'playwright', 'vitest'].includes(c.name) && !c.args.includes('scripts/test-smoke.ts'))) {
    const flag = call.name === 'node' ? '--test-concurrency=' : call.name === 'playwright' ? '--workers=' : '--maxWorkers=';
    assert.ok(call.args.includes(flag + call.workers), JSON.stringify(call));
    assert.ok(Number(call.workers) >= 1 && Number(call.workers) <= 5);
  }
}

test('a missing runtime entrance fails before any build or check starts', { timeout: 10_000 }, async t => {
  const f = fixture(); t.after(() => f.dispose());
  const { name, from } = RUNTIME_EXTERNAL_ROOTS[1]!;
  rmSync(join(f.root, from, 'node_modules', name), { recursive: true });
  const result = await f.start(['all']).done;
  assert.equal(result.code, 1, result.output);
  assert.ok(result.output.includes(`Test dependency entrance missing: ${name} from ${from}:`), result.output);
  assert.doesNotMatch(result.output, /starting /);
  assert.equal(existsSync(join(f.root, 'calls.jsonl')), false);
  assert.equal(existsSync(join(f.root, 'queue')), false);
});

test('all offers Node first with a low CPU budget and keeps the original package command', { timeout: 20_000 }, async t => {
  const f = fixture({ ALPACAWORK_TEST_QUEUE_CPUS: '8', ALPACAWORK_TEST_AUTO_MAX_WORKERS: '16' });
  t.after(() => f.dispose());
  const result = await f.start(['all']).done;
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /test-all: build [\d.]+s\n[\s\S]*?test-all: starting node\ntest-all: starting typecheck\n/);
  const node = f.calls().find(c => c.name === 'node' && c.args.includes('tests/related.test.ts'))!;
  assert.ok(node, result.output);
  assert.ok(Number(node.workers) >= 1 && Number(node.workers) <= 6, JSON.stringify(node));
  assert.ok(node.args.includes(`--test-concurrency=${node.workers}`));
});

test('all runs every built suite once and an acceptance-only failure fails the outer runner', { timeout: 30_000 }, async t => {
  const f = fixture({ PROBE_ACCEPTANCE_EXIT: '27', TZ: 'Asia/Tokyo' }); t.after(() => f.dispose());
  const result = await f.start(['all']).done;
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /acceptance failed \(exit 27\)/);
  assert.match(result.output, /failed stages: acceptance\n/);
  assert.deepEqual(f.results().map(result => [result.mode, result.passed, result.failed]), [['all', false, ['acceptance']]]);
  for (const stage of ['build', 'typecheck', 'web', 'web-utc', 'i18n', 'node', 'acceptance', 'e2e', 'e2e-fixtures', 'e2e-offline'])
    assert.equal(result.output.split(`test-all: starting ${stage}\n`).length - 1, 1, stage);
  assert.doesNotMatch(result.output, /starting (browser-list|smoke)/);
  const calls = f.calls();
  const web = calls.filter(c => c.name === 'vitest');
  assert.equal(web.length, 2);
  const normal = web.find(c => c.env.TZ === 'Asia/Tokyo')!;
  const utc = web.find(c => c.env.TZ === 'UTC')!;
  assert.ok(normal, 'the normal-zone Web suite must remain');
  assert.ok(utc, 'the UTC representatives must remain');
  const webArgs = (call: Call) => ['run', '--config', 'apps/web/vitest.config.ts', `--maxWorkers=${call.workers}`];
  assert.deepEqual(normal.args, webArgs(normal), 'normal-zone Web must still run every file');
  assert.deepEqual(utc.args, [...webArgs(utc),
    'tests/task-domain.test.tsx', 'tests/time-rules.test.tsx',
    'tests/time-view-rows.test.tsx', 'tests/report-feed.test.tsx',
    'tests/coordinator-read-line.test.tsx', 'tests/coordinator-consumer.test.tsx',
    'tests/offline-mark.test.tsx', 'tests/coordinator-delivery-migration.test.tsx',
  ], 'UTC must select exactly the approved eight files, including the current failure');
  for (const call of calls.filter(c => c !== utc && !(c.name === 'pnpm' && c.args[0] === 'test:web' && c.env.TZ === 'UTC')))
    assert.equal(call.env.TZ, 'Asia/Tokyo', `UTC leaked into ${call.name} ${call.args.join(' ')}`);
  assert.equal(calls.filter(c => c.name === 'pnpm' && c.args[0] === 'build').length, 1);
  const acceptance = calls.find(c => c.name === 'node' && c.args.some(arg => arg.includes('acceptance/')))!;
  assert.ok(acceptance.args.includes('--test-concurrency=1'));
  assert.ok(acceptance.args.includes('--test-timeout=300000'));
  assert.equal(calls.filter(c => c.name === 'playwright').length, 2); // the standard browser run and the offline one
  // Any failed stage fails all (one rule); the fixture-regression capture still runs with its guard, two at a time.
  const capture = calls.find(c => c.name === 'node' && c.args.includes('e2e/fixture-regression.test.ts'))!;
  assert.ok(capture.args.includes('e2e/guard.test.ts'));
  assert.ok(capture.args.includes('--test-concurrency=2'));
  admissionMatches(calls);
  assert.equal(readFileSync(join(f.root, 'pnpm-workspace.yaml'), 'utf8'), 'fixture sentinel\n');
});

test('quick selects pure and explicit Node files and unions related browser files with smoke once', { timeout: 30_000 }, async t => {
  const f = fixture(); t.after(() => f.dispose());
  const result = await f.start(['quick', '--node', 'tests/related.test.ts', '--node', 'tests/task-policy.test.ts',
    '--e2e', 'e2e/hold.check.ts', '--e2e', 'e2e/related.check.ts']).done;
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(f.results().map(result => [result.mode, result.passed, result.node, result.e2e]),
    [['quick', true, ['tests/related.test.ts', 'tests/task-policy.test.ts'], ['e2e/hold.check.ts', 'e2e/related.check.ts']]]);
  assert.doesNotMatch(result.output, /test-quick: starting (acceptance|web|web-utc|i18n)\n/);
  const calls = f.calls();
  const node = calls.find(c => c.name === 'node' && c.args.includes('--test'))!;
  for (const file of ['task-policy', 'return-rules', 'problem-rules', 'related']) assert.equal(node.args.filter(a => a === `tests/${file}.test.ts`).length, 1);
  // The fake runner cannot detect a default target deleted by an upstream change.
  for (const file of node.args.filter(a => a.startsWith('tests/') && a !== 'tests/related.test.ts'))
    assert.ok(existsSync(resolve(import.meta.dirname, '..', file)), `quick default target is missing: ${file}`);
  const browser = calls.filter(c => c.name === 'playwright' && !c.args.includes('--list'));
  assert.equal(browser.length, 1);
  const selection = readFileSync(browser[0]!.args[browser[0]!.args.indexOf('--test-list') + 1]!, 'utf8').trim().split('\n');
  assert.equal(selection.length, 8);
  assert.equal(new Set(selection).size, 8);
  admissionMatches(calls);
});

test('quick overlaps independent Node and browser checks through the shared policy', { timeout: 20_000 }, async t => {
  const f = fixture({ PROBE_HOLD_BROWSER: '1', PROBE_HOLD_NODE: '1' }); t.after(() => f.dispose());
  const run = f.start(['quick']);
  await until(() => existsSync(join(f.root, 'browser-ready')) && existsSync(join(f.root, 'node-ready')));
  writeFileSync(join(f.root, 'release-browser'), 'go');
  writeFileSync(join(f.root, 'release-node'), 'go');
  const result = await run.done;
  assert.equal(result.code, 0, result.output);
  admissionMatches(f.calls());
});

test('all caps actual Node at 16 and Web/browser at 8 even when auto permits 32', { timeout: 20_000 }, async t => {
  const f = fixture({ ALPACAWORK_TEST_AUTO_MAX_WORKERS: '32', ALPACAWORK_TEST_QUEUE_CPUS: '128' });
  t.after(() => f.dispose());
  const result = await f.start(['all']).done;
  assert.equal(result.code, 0, result.output);
  const calls = f.calls().filter(c => ['node', 'playwright', 'vitest'].includes(c.name));
  const caps: Record<string, number> = { node: 16, playwright: 8, vitest: 8 };
  for (const [name, cap] of Object.entries(caps)) assert.ok(calls.some(c => c.name === name && c.workers === String(cap)), name);
  for (const call of calls) {
    assert.ok(Number(call.workers) <= caps[call.name]!, JSON.stringify(call));
    const flag = call.name === 'node' ? '--test-concurrency=' : call.name === 'playwright' ? '--workers=' : '--maxWorkers=';
    assert.ok(call.args.includes(flag + call.workers), JSON.stringify(call));
  }
});

test('--area belongs to quick and reaches the selection step with the related files', { timeout: 30_000 }, async t => {
  const refused = fixture(); t.after(() => refused.dispose());
  const result = await refused.start(['smoke', '--area', 'files']).done;
  assert.notEqual(result.code, 0);
  assert.match(result.output, /quick-only/);
  const unknown = fixture(); t.after(() => unknown.dispose());
  const missing = await unknown.start(['quick', '--area', 'no-such-area']).done;
  assert.equal(missing.code, 1, missing.output);
  assert.match(missing.output, /related browser area has no cases: no-such-area/);
});

test('build failure is a barrier and no checks start', { timeout: 15_000 }, async t => {
  const f = fixture({ PROBE_BUILD_EXIT: '23' }); t.after(() => f.dispose());
  const result = await f.start(['quick']).done;
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /packages failed \(exit 23\)/);
  assert.match(result.output, /build failed \(exit 1\)/);
  assert.deepEqual(f.calls().map(c => [c.name, c.args]), [['pnpm', ['build']], ['pnpm', ['build:packages']]]);
});

test('an unstartable build and cleanup failure both fail the outer runner', { timeout: 15_000 }, async t => {
  const missing = fixture({}, s => s.replace("['pnpm', 'build']", "['missing-test-executable-364']"));
  const cleanup = fixture({}, s => s.replace('if (!stages.length) return;', 'if (!stages.length) return; throw new Error("injected cleanup failure");'));
  t.after(() => { missing.dispose(); cleanup.dispose(); });
  const a = await missing.start(['all']).done;
  assert.equal(a.code, 1); assert.match(a.output, /could not start/);
  const b = await cleanup.start(['all']).done;
  assert.equal(b.code, 1); assert.match(b.output, /injected cleanup failure/);
  assert.deepEqual(cleanup.results(), [], 'cleanup failure must not certify a test verdict');
});

test('successful wrappers still clean detached children', { timeout: 20_000 }, async t => {
  const f = fixture({ PROBE_DETACHED: 'build' }); t.after(() => f.dispose());
  const result = await f.start(['quick']).done;
  assert.equal(result.code, 0, result.output);
  const pid = Number(readFileSync(join(f.root, 'detached.pid'), 'utf8'));
  assert.equal(alive(pid), false, `detached child ${pid} survives`);
});

test('TERM propagates nonzero and cleans detached TERM-ignoring queue descendants', { timeout: 30_000 }, async t => {
  const f = fixture({ PROBE_TERM: '1' }); t.after(() => f.dispose());
  const { child, done } = f.start(['smoke']);
  await until(() => { try { return readFileSync(join(f.root, 'ready'), 'utf8') === 'ready'; } catch { return false; } });
  const pid = Number(readFileSync(join(f.root, 'detached.pid'), 'utf8'));
  child.kill('SIGTERM');
  const result = await done;
  assert.equal(result.code, 143, result.output);
  assert.equal(alive(pid), false, `detached queue descendant ${pid} survives`);
});


test('all, quick and smoke keep isolated user state and honor the shared queue parallel limit', { timeout: 30_000 }, async t => {
  // These are independent top-level invocations even when this test itself runs inside a Node stage.
  const first = fixture({ PROBE_HOLD_BUILD: '1', ALPACAWORK_STAGE_OWNER: '', ALPACAWORK_TEST_MAX_PARALLEL: '1' });
  const shared = { ALPACAWORK_TEST_QUEUE_DIR: join(first.root, 'queue'), PROBE_HOLD_BUILD: '1', ALPACAWORK_STAGE_OWNER: '', ALPACAWORK_TEST_MAX_PARALLEL: '1' };
  const second = fixture(shared);
  const third = fixture(shared);
  t.after(() => { third.dispose(); second.dispose(); first.dispose(); });
  const firstRun = first.start(['all']);
  await until(() => existsSync(join(first.root, 'build.pid')));
  const runs = [firstRun, second.start(['quick']), third.start(['smoke'])];
  const fixtures = [first, second, third];
  await until(() => runs.slice(1).every(run => run.output().includes('Waiting for test queue:')));
  for (const f of fixtures.slice(1)) assert.equal(existsSync(join(f.root, 'build.pid')), false);
  const environments = fixtures.map(f => f.calls()[0]!.env);
  const isolated = ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
    'XDG_DATA_HOME', 'XDG_RUNTIME_DIR'];
  for (const key of isolated) {
    assert.equal(new Set(environments.map(env => env[key])).size, 3, key);
    for (const env of environments) {
      assert.ok(env[key]!.startsWith(env.HOME!.slice(0, -1)), JSON.stringify(env));
      assert.notEqual(env[key], process.env[key]);
    }
  }
  for (const env of environments) {
    assert.equal(env.ALPACAWORK_TEST_QUEUE_DIR, shared.ALPACAWORK_TEST_QUEUE_DIR);
    assert.equal(env.COREPACK_ENABLE_NETWORK, '0');
    assert.equal(env.COREPACK_DEFAULT_TO_LATEST, '0');
    assert.ok(env.COREPACK_HOME);
  }
  // Release each admitted build. Enqueue order between the two newly started callers is immaterial here;
  // the queue unit test checks FIFO, while this boundary must keep exactly one real build admitted.
  const pending = [...fixtures];
  while (pending.length) {
    await until(() => pending.some(f => existsSync(join(f.root, 'build.pid'))));
    const admitted = pending.filter(f => existsSync(join(f.root, 'build.pid')));
    assert.equal(admitted.length, 1, 'only one held build is admitted');
    const f = admitted[0]!;
    const build = f.calls().find(call => call.name === 'pnpm' && call.args[0] === 'build:packages')!;
    assert.equal(build.env.ALPACAWORK_TEST_QUEUE_DIR, f.calls()[0]!.env.ALPACAWORK_TEST_QUEUE_DIR);
    writeFileSync(join(f.root, 'release-build'), 'go');
    pending.splice(pending.indexOf(f), 1);
  }
  const results = await Promise.all(runs.map(run => run.done));
  for (const result of results) {
    assert.equal(result.code, 0, result.output);
    assert.doesNotMatch(result.output, /full test run queue/);
  }
  for (const f of fixtures) {
    const calls = f.calls().filter(call => call.name === 'pnpm');
    for (const command of ['build', 'build:packages', 'build:apps', 'build:web'])
      assert.equal(calls.filter(call => call.args[0] === command).length, 1, command + ' nested once');
  }
  for (const env of environments) {
    assert.equal(existsSync(env.HOME!), false, 'run HOME removed after children exit');
    assert.equal(existsSync(env.ALPACAWORK_TEST_QUEUE_DIR!), true, 'shared queue retained');
  }
});


test('the outer runner collects the final scratch after a queue wrapper is killed', { timeout: 20_000 }, async t => {
  const f = fixture({ PROBE_QUEUE_BUILD: '1' }); t.after(() => f.dispose());
  const { done } = f.start(['all']);
  await until(() => existsSync(join(f.root, 'build.pid')));
  const scratch = readFileSync(join(f.root, 'build-scratch'), 'utf8');
  const wrapper = Number(readFileSync(join(f.root, 'build-wrapper.pid'), 'utf8'));
  const child = Number(readFileSync(join(f.root, 'build.pid'), 'utf8'));
  assert.equal(existsSync(scratch), true);
  process.kill(wrapper, 'SIGKILL');
  const result = await done;
  assert.equal(result.code, 1, result.output);
  assert.equal(alive(child), false, 'stage child has stopped');
  assert.equal(existsSync(scratch), false, 'last stage scratch was collected without another admission');
});

function macStage(): Stage {
  return { process: { pid: 101 } as ChildProcess, result: 0, log: -1, started: 0, owner: 'abcd/',
    known: new Map(), cursor: 0, pending: Buffer.alloc(0) };
}
test('macOS discovery and signalling share padded start identities and reject reused PIDs', () => {
  for (const born of ['Thu Oct 15 05:04:55 2099    ', '  Thu Oct  1 05:04:55 2099 \t']) {
    const stage = macStage(), sent: [number, NodeJS.Signals][] = [];
    let observed = born;
    const tracker = new ProcessTracker(false, args => {
      if (args.includes('pid=,ppid=,stat=,lstart=')) return { status: 0, stdout: ` 101 1 S ${born}\n 102 101 S ${born}\n` };
      if (args.includes('pid=,command=')) return { status: 0, stdout: '101 runner ALPACAWORK_STAGE_OWNER=abcd/\n' };
      assert.deepEqual(args, ['-p', '101', '-o', 'lstart=']);
      return { status: observed ? 0 : 1, stdout: observed };
    }, (pid, signal) => sent.push([pid, signal]));
    tracker.discover([stage]);
    assert.deepEqual([...stage.known.keys()], [101, 102]);
    assert.equal(stage.known.get(101), born.trim().split(/\s+/).join(' '));
    observed = born.trim().replace(/\s+/g, ' ') + '  \n';
    tracker.signalOwned(101, stage.known.get(101)!, 'SIGTERM');
    assert.deepEqual(sent, [[101, 'SIGTERM']]);
    for (const replacement of ['Thu Oct 15 05:04:56 2099', '']) {
      observed = replacement; tracker.signalOwned(101, stage.known.get(101)!, 'SIGKILL');
      assert.equal(sent.length, 1);
    }
  }
});
