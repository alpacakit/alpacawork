import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, closeSync, existsSync, openSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test, mock } from 'node:test';
import { collectScratch, readTicket, writeTicket, Facts, Policy, SETTINGS, parseMeminfo, parseVmStat, removeScratch, type Settings } from '../scripts/testing/queue.ts';

const queueScript = resolve('scripts/testing/queue.ts');
const hold = `const fs = require('node:fs');
for (const name of ['TMPDIR', 'HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR']) {
  fs.writeFileSync(require('node:path').join(process.env[name], 'stage-probe'), 'isolated');
}
fs.writeFileSync(process.env.TEST_START, String(process.pid));
fs.writeFileSync(process.env.TEST_INFO, JSON.stringify({ workers: process.env.ALPACAWORK_TEST_WORKERS, args: process.argv, env: process.env }));
const timer = setInterval(() => {
  if (fs.existsSync(process.env.TEST_RELEASE)) {
    clearInterval(timer); fs.writeFileSync(process.env.TEST_DONE, 'done'); process.exit(0);
  }
}, 25);`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'alpacawork-queue-test-'));
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, 'seed'), 'seed');
  execFileSync('git', ['-C', root, 'add', 'seed']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'seed']);
  const trees = ['one', 'two', 'three'].map(name => {
    const path = join(root, name);
    execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '--detach', path]);
    return path;
  });
  return { root, trees, queueDir: join(root, 'queue') };
}

// A queue under test sees only the settings a case gives it, not the caller's environment or .env.
function isolated() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ALPACAWORK_TEST_')));
}

function run(f: ReturnType<typeof fixture>, index: number, availableMiB: number, stage = 'web', maxParallel: number | 'auto' | null = 2,
  workers: number | 'auto' = 2, workerFlag?: string, machine: Record<string, string> = {}, executable = process.execPath, commandArgs = ['-e', hold]) {
  const start = join(f.root, `${index}-start`);
  const info = join(f.root, `${index}-info`);
  const release = join(f.root, `${index}-release`);
  const doneMarker = join(f.root, `${index}-done`);
  const command = [queueScript, stage, '--', executable, ...commandArgs, ...(workerFlag ? ['--', workerFlag] : [])];
  const child = spawn(process.execPath, command, {
    cwd: f.trees[index],
    env: { ...isolated(), ALPACAWORK_TEST_QUEUE_DIR: f.queueDir,
      ALPACAWORK_TEST_QUEUE_AVAILABLE_MIB: String(availableMiB),
      ALPACAWORK_TEST_QUEUE_ESTIMATE_MIB: '100',
      ALPACAWORK_TEST_QUEUE_NOTICE_SECONDS: '0.1',
      ...(maxParallel === null ? {} : { ALPACAWORK_TEST_MAX_PARALLEL: String(maxParallel) }),
      ALPACAWORK_TEST_WORKERS: String(workers),
      TEST_START: start, TEST_INFO: info, TEST_RELEASE: release, TEST_DONE: doneMarker, ...machine },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', chunk => { output += chunk; });
  child.stderr!.on('data', chunk => { output += chunk; });
  const done = new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('exit', code => done(code));
  });
  return { child, done, output: () => output, start, info, release, doneMarker };
}

async function until(condition: () => boolean, message: () => string) {
  const deadline = Date.now() + 8_000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(message());
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/** The child's files and the wrapper's admission notice arrive on independent channels. */
async function admitted(item: ReturnType<typeof run>) {
  await until(() => existsSync(item.info) && item.output().includes('Running test queue:'), item.output);
}

async function clean(f: ReturnType<typeof fixture>, runs: ReturnType<typeof run>[], queues = [f.queueDir]) {
  for (const item of runs) writeFileSync(item.release, 'go');
  for (const item of runs) if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill('SIGTERM');
  await Promise.allSettled(runs.map(item => item.done));
  for (const item of runs) if (existsSync(item.start)) {
    // A wrapper can exit before installing its forwarding handler, including on TERM. Its detached child still
    // needs the release file: removing the fixture early leaves the timer and inherited output pipes open forever.
    const pid = Number(readFileSync(item.start, 'utf8'));
    await until(() => {
      if (existsSync(item.doneMarker)) return true;
      try { process.kill(pid, 0); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; }
    }, () => `orphan child from ${item.start}`);
  }
  for (const queueDir of queues) if (existsSync(queueDir) && !lstatSync(queueDir).isSymbolicLink()) {
    await collectScratch(queueDir);
  }
  rmSync(f.root, { recursive: true, force: true });
}

test('three worktrees admit at most two stages and show the third its queue position', async () => {
  const f = fixture();
  const runs: ReturnType<typeof run>[] = [];
  try {
    runs.push(run(f, 0, 1000));
    await until(() => existsSync(runs[0]!.start), () => runs[0]!.output());
    runs.push(run(f, 1, 1000, 'node'));
    await until(() => existsSync(runs[1]!.start), () => runs[1]!.output());
    runs.push(run(f, 2, 1000, 'e2e'));
    await until(() => runs[2]!.output().includes('Waiting') && runs[2]!.output().includes('position 1'), () => runs[2]!.output());
    assert.equal(existsSync(runs[2]!.start), false);
    assert.match(runs[2]!.output(), /one.*web.*started/);
    assert.match(runs[2]!.output(), /two.*node.*started/);
    writeFileSync(runs[0]!.release, 'go');
    assert.equal(await runs[0]!.done, 0);
    await until(() => existsSync(runs[2]!.start), () => runs[2]!.output());
    writeFileSync(runs[1]!.release, 'go');
    writeFileSync(runs[2]!.release, 'go');
    assert.deepEqual(await Promise.all([runs[1]!.done, runs[2]!.done]), [0, 0]);
  } finally { await clean(f, runs); }
});

test('one stage starts when idle even below its memory estimate', async () => {
  const f = fixture();
  const runs: ReturnType<typeof run>[] = [];
  try {
    runs.push(run(f, 0, 1));
    await until(() => existsSync(runs[0]!.start), () => runs[0]!.output());
    writeFileSync(runs[0]!.release, 'go');
    assert.equal(await runs[0]!.done, 0);
  } finally { await clean(f, runs); }
});

test('an idle expanded stage reduces workers and frees the queue when memory is scarce', async () => {
  const f = fixture();
  const runs: ReturnType<typeof run>[] = [];
  try {
    runs.push(run(f, 0, 99, 'e2e', 2, 6, '--workers=6'));
    await until(() => existsSync(runs[0]!.start), () => runs[0]!.output());
    await until(() => existsSync(runs[0]!.info), () => runs[0]!.output());
    const started = JSON.parse(readFileSync(runs[0]!.info, 'utf8'));
    assert.equal(started.workers, '2');
    assert.deepEqual(started.args.slice(1), ['--workers=2']);
    runs.push(run(f, 1, 1000));
    await until(() => existsSync(runs[1]!.start), () => runs[1]!.output());
    writeFileSync(runs[0]!.release, 'go');
    writeFileSync(runs[1]!.release, 'go');
    assert.deepEqual(await Promise.all([runs[0]!.done, runs[1]!.done]), [0, 0]);
  } finally { await clean(f, runs); }
});

test('an expanded stage keeps its workers when memory is available', async () => {
  const f = fixture();
  const runs: ReturnType<typeof run>[] = [];
  try {
    runs.push(run(f, 0, 1000, 'web', 2, 6, '--maxWorkers=6'));
    await until(() => existsSync(runs[0]!.start), () => runs[0]!.output());
    await until(() => existsSync(runs[0]!.info), () => runs[0]!.output());
    const started = JSON.parse(readFileSync(runs[0]!.info, 'utf8'));
    assert.equal(started.workers, '6');
    assert.deepEqual(started.args.slice(1), ['--maxWorkers=6']);
    writeFileSync(runs[0]!.release, 'go');
    assert.equal(await runs[0]!.done, 0);
  } finally { await clean(f, runs); }
});

test('an expanded stage waits for running work before reducing workers', async () => {
  const f = fixture();
  const runs: ReturnType<typeof run>[] = [];
  try {
    runs.push(run(f, 0, 150));
    await until(() => existsSync(runs[0]!.start), () => runs[0]!.output());
    runs.push(run(f, 1, 99, 'node', 2, 6, '--test-concurrency=6'));
    await until(() => runs[1]!.output().includes('memory limit'), () => runs[1]!.output());
    assert.equal(existsSync(runs[1]!.start), false);
    writeFileSync(runs[0]!.release, 'go');
    assert.equal(await runs[0]!.done, 0);
    await until(() => existsSync(runs[1]!.start), () => runs[1]!.output());
    await until(() => existsSync(runs[1]!.info), () => runs[1]!.output());
    const started = JSON.parse(readFileSync(runs[1]!.info, 'utf8'));
    assert.equal(started.workers, '2');
    assert.deepEqual(started.args.slice(1), ['--test-concurrency=2']);
    writeFileSync(runs[1]!.release, 'go');
    assert.equal(await runs[1]!.done, 0);
  } finally { await clean(f, runs); }
});

test('build starts when idle even if later test stages use more workers', async () => {
  const f = fixture();
  const runs: ReturnType<typeof run>[] = [];
  try {
    runs.push(run(f, 0, 1, 'build', 2, 6));
    await until(() => existsSync(runs[0]!.start), () => runs[0]!.output());
    writeFileSync(runs[0]!.release, 'go');
    assert.equal(await runs[0]!.done, 0);
  } finally { await clean(f, runs); }
});

test('a running stage with a one-slot setting constrains later default arrivals', async () => {
  const f = fixture();
  const runs: ReturnType<typeof run>[] = [];
  try {
    runs.push(run(f, 0, 1000, 'web', 1));
    await until(() => existsSync(runs[0]!.start), () => runs[0]!.output());
    runs.push(run(f, 1, 1000, 'node', 2));
    await until(() => runs[1]!.output().includes('Waiting'), () => runs[1]!.output());
    assert.equal(existsSync(runs[1]!.start), false);
    writeFileSync(runs[0]!.release, 'go');
    assert.equal(await runs[0]!.done, 0);
    await until(() => existsSync(runs[1]!.start), () => runs[1]!.output());
    writeFileSync(runs[1]!.release, 'go');
    assert.equal(await runs[1]!.done, 0);
  } finally { await clean(f, runs); }
});

test('a default request keeps its own limit of two without capping a chosen larger one', async () => {
  const f = fixture();
  const runs: ReturnType<typeof run>[] = [];
  try {
    runs.push(run(f, 0, 1000, 'web', null));
    await until(() => existsSync(runs[0]!.start), () => runs[0]!.output());
    runs.push(run(f, 1, 1000, 'node', 3));
    await until(() => existsSync(runs[1]!.start), () => runs[1]!.output());
    runs.push(run(f, 2, 1000, 'e2e', 3));
    await until(() => existsSync(runs[2]!.start), () => runs[2]!.output());
    writeFileSync(runs[2]!.release, 'go');
    assert.equal(await runs[2]!.done, 0);
    for (const marker of [runs[2]!.start, runs[2]!.info, runs[2]!.release, runs[2]!.doneMarker]) rmSync(marker, { force: true });
    runs[2] = run(f, 2, 1000, 'e2e', null);
    await until(() => runs[2]!.output().includes('parallel limit'), () => runs[2]!.output());
    assert.equal(existsSync(runs[2]!.start), false);
  } finally { await clean(f, runs); }
});

test('later arrivals cannot overtake a memory-blocked older request', async () => {
  const f = fixture();
  const runs: ReturnType<typeof run>[] = [];
  try {
    runs.push(run(f, 0, 150));
    await until(() => existsSync(runs[0]!.start), () => runs[0]!.output());
    runs.push(run(f, 1, 150, 'e2e'));
    await until(() => runs[1]!.output().includes('position 1'), () => runs[1]!.output());
    assert.equal(existsSync(runs[1]!.start), false);
    assert.match(runs[1]!.output(), /memory/i);
    runs.push(run(f, 2, 1000, 'web'));
    await until(() => runs[2]!.output().includes('position 2'), () => runs[2]!.output());
    assert.equal(existsSync(runs[2]!.start), false);
    writeFileSync(runs[0]!.release, 'go');
    assert.equal(await runs[0]!.done, 0);
    await until(() => existsSync(runs[1]!.start), () => runs[1]!.output());
    await until(() => existsSync(runs[2]!.start), () => runs[2]!.output());
    writeFileSync(runs[1]!.release, 'go');
    writeFileSync(runs[2]!.release, 'go');
    assert.deepEqual(await Promise.all([runs[1]!.done, runs[2]!.done]), [0, 0]);
  } finally { await clean(f, runs); }
});

test('a killed owner and a killed waiter leave no permanent queue entries', async () => {
  const f = fixture();
  const runs: ReturnType<typeof run>[] = [];
  try {
    runs.push(run(f, 0, 150));
    await until(() => existsSync(runs[0]!.start), () => runs[0]!.output());
    runs.push(run(f, 1, 150));
    await until(() => runs[1]!.output().includes('Waiting'), () => runs[1]!.output());
    runs[1]!.child.kill('SIGKILL');
    await runs[1]!.done;
    runs.push(run(f, 2, 150));
    await until(() => runs[2]!.output().includes('position 1'), () => runs[2]!.output());
    process.kill(Number(readFileSync(runs[0]!.start, 'utf8')), 'SIGKILL');
    assert.notEqual(await runs[0]!.done, 0);
    await until(() => existsSync(runs[2]!.start), () => runs[2]!.output());
    writeFileSync(runs[2]!.release, 'go');
    assert.equal(await runs[2]!.done, 0);
  } finally { await clean(f, runs); }
});

test('a wrapper killed during a stage leaves its child holding the slot', async () => {
  const f = fixture();
  const runs: ReturnType<typeof run>[] = [];
  try {
    runs.push(run(f, 0, 1000, 'web', 1));
    await until(() => existsSync(runs[0]!.start), () => runs[0]!.output());
    runs[0]!.child.kill('SIGKILL');
    await runs[0]!.done;
    runs.push(run(f, 1, 1000, 'node', 1));
    await until(() => runs[1]!.output().includes('Waiting'), () => runs[1]!.output());
    assert.equal(existsSync(runs[1]!.start), false);
    assert.match(runs[1]!.output(), new RegExp(`child PID ${readFileSync(runs[0]!.start, 'utf8')}`));
    writeFileSync(runs[0]!.release, 'go');
    await until(() => existsSync(runs[1]!.start), () => runs[1]!.output());
    writeFileSync(runs[1]!.release, 'go');
    assert.equal(await runs[1]!.done, 0);
  } finally { await clean(f, runs); }
});

test('a grandchild keeps the ticket and scratch after its wrapper and direct child exit', async () => {
  const f = fixture();
  const runs: ReturnType<typeof run>[] = [];
  try {
    // The shell exits immediately; its background Node child inherits the ticket as an ordinary fd.
    runs.push(run(f, 0, 1000, 'web', 1, 2, undefined, { TEST_NODE: process.execPath, TEST_HOLD: hold },
      '/bin/sh', ['-c', '"$TEST_NODE" -e "$TEST_HOLD" &']));
    await admitted(runs[0]!);
    assert.equal(await runs[0]!.done, 0);
    const scratch = JSON.parse(readFileSync(runs[0]!.info, 'utf8')).env.TMPDIR as string;
    assert.equal(existsSync(scratch), true);
    runs.push(run(f, 1, 1000, 'node', 1));
    await until(() => runs[1]!.output().includes('Waiting'), runs[1]!.output);
    assert.equal(existsSync(runs[1]!.start), false);
    writeFileSync(runs[0]!.release, 'go');
    await admitted(runs[1]!);
    assert.equal(existsSync(scratch), false);
  } finally { await clean(f, runs); }
});

test('Ctrl-C stops a running stage and makes its slot available', async () => {
  const f = fixture();
  const runs: ReturnType<typeof run>[] = [];
  try {
    runs.push(run(f, 0, 1000, 'web', 1));
    await until(() => existsSync(runs[0]!.start), () => runs[0]!.output());
    runs.push(run(f, 1, 1000, 'node', 1));
    await until(() => runs[1]!.output().includes('Waiting'), () => runs[1]!.output());
    runs[0]!.child.kill('SIGINT');
    assert.equal(await runs[0]!.done, 130);
    await until(() => existsSync(runs[1]!.start), () => runs[1]!.output());
    writeFileSync(runs[1]!.release, 'go');
    assert.equal(await runs[1]!.done, 0);
  } finally { await clean(f, runs); }
});

test('a symlink cannot substitute for the shared queue directory', async () => {
  const f = fixture();
  const runs: ReturnType<typeof run>[] = [];
  try {
    symlinkSync(f.trees[0]!, f.queueDir);
    runs.push(run(f, 0, 1000));
    assert.notEqual(await runs[0]!.done, 0);
    assert.equal(existsSync(runs[0]!.start), false);
  } finally { await clean(f, runs); }
});

test('available memory parsing works for Linux and macOS reports', () => {
  assert.equal(parseMeminfo('MemTotal: 12000000 kB\nMemAvailable: 8192000 kB\n', 'MemAvailable'), 8000);
  const report = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100000.\nPages inactive: 200000.\nPages speculative: 10000.\n';
  assert.equal(parseVmStat(report), 4843);
});

function settingsIn(cwd: string, env: Record<string, string> = {}) {
  return execFileSync(process.execPath, [queueScript, 'settings'], { cwd, env: { ...isolated(), ...env }, encoding: 'utf8' });
}

test('settings come from the environment, then the worktree .env, then the main checkout .env, then defaults', () => {
  const f = fixture();
  try {
    assert.match(settingsIn(f.trees[0]!), /^ALPACAWORK_TEST_WORKERS=auto  # default/m);
    assert.match(settingsIn(f.trees[0]!), /^ALPACAWORK_TEST_MAX_PARALLEL=2  # default/m);
    writeFileSync(join(f.root, '.env'), '# shared by every worktree\nALPACAWORK_TEST_WORKERS=8\nexport ALPACAWORK_TEST_MAX_PARALLEL="auto" # comment\n');
    writeFileSync(join(f.trees[0]!, '.env'), 'ALPACAWORK_TEST_WORKERS=12\n');
    assert.match(settingsIn(f.trees[0]!), /^ALPACAWORK_TEST_WORKERS=12  # .*one\/\.env/m);
    assert.match(settingsIn(f.trees[0]!), /^ALPACAWORK_TEST_MAX_PARALLEL=auto  # .*queue-test-[^/]+\/\.env/m);
    assert.match(settingsIn(f.trees[1]!), /^ALPACAWORK_TEST_WORKERS=8  # /m);
    assert.match(settingsIn(f.trees[0]!, { ALPACAWORK_TEST_WORKERS: '3' }), /^ALPACAWORK_TEST_WORKERS=3  # environment/m);
    const setting = (cwd: string) => execFileSync(process.execPath, [queueScript, 'setting', 'ALPACAWORK_TEST_WORKERS'],
      { cwd, env: isolated(), encoding: 'utf8' });
    assert.equal(setting(f.trees[0]!), '12\n');
    rmSync(join(f.root, '.env'));
    assert.equal(setting(f.trees[1]!), '\n');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a .env setting reaches the runner and a bad value stops before queueing', async () => {
  const f = fixture();
  const runs: ReturnType<typeof run>[] = [];
  try {
    writeFileSync(join(f.trees[0]!, '.env'), 'ALPACAWORK_TEST_WORKERS=5\n');
    const env = { ...isolated(), ALPACAWORK_TEST_QUEUE_DIR: f.queueDir, ALPACAWORK_TEST_QUEUE_AVAILABLE_MIB: '1000',
      ALPACAWORK_TEST_QUEUE_ESTIMATE_MIB: '100' };
    const workersGiven = (cwd: string) => execFileSync(process.execPath, [queueScript, 'web', '--', process.execPath, '-e',
      'console.log(process.env.ALPACAWORK_TEST_WORKERS)', '--', '--maxWorkers=64'], { cwd, env, encoding: 'utf8' });
    assert.equal(workersGiven(f.trees[0]!).trim(), '5');
    writeFileSync(join(f.trees[1]!, '.env'), 'ALPACAWORK_TEST_MAX_PARALLEL=many\n');
    assert.throws(() => workersGiven(f.trees[1]!), /ALPACAWORK_TEST_MAX_PARALLEL must be a positive whole number or auto/);
    writeFileSync(join(f.trees[2]!, '.env'), 'ALPACAWORK_TEST_RESERVE_CPUS=inf\n');
    assert.throws(() => workersGiven(f.trees[2]!), /ALPACAWORK_TEST_RESERVE_CPUS must be a finite number/);
  } finally { await clean(f, runs); }
});

const machine = (cpus: number, load: number) => ({ ALPACAWORK_TEST_QUEUE_CPUS: String(cpus), ALPACAWORK_TEST_QUEUE_LOAD: String(load),
  ALPACAWORK_TEST_QUEUE_TOTAL_MIB: '4000', ALPACAWORK_TEST_QUEUE_POWER: 'mains' });

test('auto parallel admits past two while CPUs are free and holds the next at the CPU limit', async () => {
  const f = { ...fixture() };
  f.trees.push(...['four', 'five'].map(name => {
    const path = join(f.root, name);
    execFileSync('git', ['-C', f.root, 'worktree', 'add', '-q', '--detach', path]);
    return path;
  }));
  const runs: ReturnType<typeof run>[] = [];
  try {
    // 16 CPUs, a quarter reserved, load 0: 12 free, so four stages of three workers fit and a fifth waits.
    for (const index of [0, 1, 2, 3]) {
      runs.push(run(f, index, 2000, 'web', 'auto', 3, '--maxWorkers=64', machine(16, 0)));
      await admitted(runs[index]!);
    }
    // The runner starts before the wrapper fsyncs its ticket and publishes this line.
    await until(() => runs[3]!.output().includes('Running test queue:'), () => runs[3]!.output());
    assert.match(runs[3]!.output(), /slot 4; workers 3; estimate 100 MiB; available memory 2000 MiB, reserve 1000 MiB; load 0\.0 of 16 CPUs, reserve 4/);
    runs.push(run(f, 4, 2000, 'web', 'auto', 3, '--maxWorkers=64', machine(16, 0)));
    await until(() => runs[4]!.output().includes('cpu limit'), () => runs[4]!.output());
    assert.equal(existsSync(runs[4]!.start), false);
    writeFileSync(runs[0]!.release, 'go');
    assert.equal(await runs[0]!.done, 0);
    await until(() => existsSync(runs[4]!.start), () => runs[4]!.output());
  } finally { await clean(f, runs); }
});

test('auto workers follow the free CPUs, keep to their maximum, and a running fixed limit still caps auto arrivals', async () => {
  const f = fixture();
  const runs: ReturnType<typeof run>[] = [];
  try {
    // 16 CPUs, reserve 4, load 7: 5 free.
    runs.push(run(f, 0, 2000, 'node', 'auto', 'auto', '--test-concurrency=64', machine(16, 7)));
    await admitted(runs[0]!);
    assert.equal(JSON.parse(readFileSync(runs[0]!.info, 'utf8')).workers, '5');
    await until(() => runs[0]!.output().includes('Running test queue:'), () => runs[0]!.output());
    assert.match(runs[0]!.output(), /slot 1; workers 5 \(auto\);/);
    // Load 0 leaves 12 free less the 5 just given, but the maximum is 8 and then 7 are free.
    runs.push(run(f, 1, 2000, 'e2e', 2, 'auto', '--workers=64', machine(16, 0)));
    await admitted(runs[1]!);
    assert.equal(JSON.parse(readFileSync(runs[1]!.info, 'utf8')).workers, '7');
    runs.push(run(f, 2, 2000, 'web', 'auto', 'auto', '--maxWorkers=64', machine(64, 0)));
    await until(() => runs[2]!.output().includes('parallel limit'), () => runs[2]!.output());
    writeFileSync(runs[1]!.release, 'go');
    assert.equal(await runs[1]!.done, 0);
    await admitted(runs[2]!);
    assert.equal(JSON.parse(readFileSync(runs[2]!.info, 'utf8')).workers, '8');
  } finally { await clean(f, runs); }
});

test('auto keeps the memory reserve and starts a lone stage with one worker under full load', async () => {
  const f = fixture();
  const runs: ReturnType<typeof run>[] = [];
  try {
    runs.push(run(f, 0, 1150, 'web', 'auto', 'auto', undefined, { ...machine(8, 20), ALPACAWORK_TEST_RESERVE_MIB: '1000' }));
    await until(() => existsSync(runs[0]!.info), () => runs[0]!.output());
    assert.equal(JSON.parse(readFileSync(runs[0]!.info, 'utf8')).workers, '1');
    runs.push(run(f, 1, 1150, 'web', 'auto', 'auto', undefined, { ...machine(8, 0), ALPACAWORK_TEST_RESERVE_MIB: '1000' }));
    await until(() => runs[1]!.output().includes('memory limit'), () => runs[1]!.output());
    assert.equal(existsSync(runs[1]!.start), false);
  } finally { await clean(f, runs); }
});

test('auto starts a lone stage short of memory with two workers and gives two at most on battery', async () => {
  const f = fixture();
  const runs: ReturnType<typeof run>[] = [];
  try {
    // The real node estimate: 16 GiB with 4.5 GiB free leaves no room past the quarter reserve.
    const settings = Object.fromEntries(Object.entries(SETTINGS).map(([name, [value]]) => [name, [value, 'default']])) as Settings;
    const facts = new Facts();
    facts.read = { available: 4600, total: 16384, cpus: 12, load: 0, battery: false };
    const policy = new Policy('node', settings, 16);
    assert.equal((policy.decide([], facts) as [number, number])[0], 2);
    facts.read.load = 12;
    assert.equal((policy.decide([], facts) as [number, number])[0], 1);
    runs.push(run(f, 0, 100000, 'node', null, 'auto', '--test-concurrency=16',
      { ...machine(16, 0), ALPACAWORK_TEST_QUEUE_POWER: 'battery' }));
    await admitted(runs[0]!);
    assert.equal(JSON.parse(readFileSync(runs[0]!.info, 'utf8')).workers, '2');
    assert.match(runs[0]!.output(), /on battery/);
  } finally { await clean(f, runs); }
});

test('a command takes no more workers than its own flag allows, and a command that is no runner takes two', async () => {
  const f = fixture();
  const runs: ReturnType<typeof run>[] = [];
  try {
    runs.push(run(f, 0, 2000, 'node', 'auto', 'auto', '--test-concurrency=1', machine(16, 0)));
    await until(() => existsSync(runs[0]!.info), () => runs[0]!.output());
    assert.equal(JSON.parse(readFileSync(runs[0]!.info, 'utf8')).workers, '1');
    runs.push(run(f, 1, 2000, 'e2e', 'auto', 8, undefined, machine(16, 0)));
    await until(() => existsSync(runs[1]!.info), () => runs[1]!.output());
    assert.equal(JSON.parse(readFileSync(runs[1]!.info, 'utf8')).workers, '2');
  } finally { await clean(f, runs); }
});

test('a killed wrapper keeps its child slot and reaps its read-only scratch after the child exits', async () => {
  const f = fixture();
  const runs: ReturnType<typeof run>[] = [];
  try {
    runs.push(run(f, 0, 1000, 'web', 1));
    await until(() => existsSync(runs[0]!.start), () => runs[0]!.output());
    const scratch = JSON.parse(readFileSync(join(f.queueDir, '00000000000000000001.ticket')).subarray(32).toString()).scratch.path as string;
    const readonly = join(scratch, 'distribution', 'readonly');
    mkdirSync(readonly, { recursive: true });
    writeFileSync(join(readonly, 'kept-until-exit'), 'fixture');
    chmodSync(readonly, 0o555);
    chmodSync(join(scratch, 'distribution'), 0o555);
    chmodSync(scratch, 0o555);
    runs[0]!.child.kill('SIGKILL');
    await runs[0]!.done;
    runs.push(run(f, 1, 1000, 'node', 1));
    await until(() => runs[1]!.output().includes('Waiting'), () => runs[1]!.output());
    assert.equal(existsSync(runs[1]!.start), false);
    assert.equal(existsSync(readonly), true);
    assert.match(runs[1]!.output(), new RegExp(`child PID ${readFileSync(runs[0]!.start, 'utf8')}`));
    writeFileSync(runs[0]!.release, 'go');
    await until(() => existsSync(runs[1]!.start), () => runs[1]!.output());
    assert.equal(existsSync(scratch), false);
    writeFileSync(runs[1]!.release, 'go');
    assert.equal(await runs[1]!.done, 0);
  } finally { await clean(f, runs); }
});

for (const ending of ['normal exit', 'child SIGKILL'] as const)
test(`mode-000 scratch is reclaimed after ${ending}, preserves outside links and admits the next run`, async () => {
  const f = fixture();
  const runs: ReturnType<typeof run>[] = [];
  const outside = join(f.root, 'outside');
  const directories: string[] = [];
  mkdirSync(outside);
  const kept = join(outside, 'keep');
  writeFileSync(kept, 'outside fixture');
  chmodSync(kept, 0o444);
  chmodSync(outside, 0o555);
  try {
    runs.push(run(f, 0, 1000, 'web', 1, 2, undefined, {}, process.execPath));
    await admitted(runs[0]!);
    const scratch = JSON.parse(readFileSync(runs[0]!.info, 'utf8')).env.TMPDIR as string;
    const distribution = join(scratch, 'distribution'), locked = join(distribution, 'locked');
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, 'fixture'), 'remove with stage');
    symlinkSync(outside, join(locked, 'outside-link'));
    linkSync(kept, join(locked, 'outside-hardlink'));
    directories.push(scratch, distribution, locked);
    for (const directory of [...directories].reverse()) chmodSync(directory, 0o000);
    runs.push(run(f, 1, 1000, 'node', 1, 2, undefined, {}, process.execPath));
    await until(() => runs[1]!.output().includes('Waiting'), runs[1]!.output);
    assert.equal(existsSync(runs[1]!.start), false);
    if (ending === 'normal exit') writeFileSync(runs[0]!.release, 'go');
    else process.kill(Number(readFileSync(runs[0]!.start, 'utf8')), 'SIGKILL');
    assert.equal(await runs[0]!.done, ending === 'normal exit' ? 0 : 137, runs[0]!.output());
    await admitted(runs[1]!);
    assert.equal(existsSync(scratch), false);
    assert.equal(readFileSync(kept, 'utf8'), 'outside fixture');
    assert.equal(statSync(kept).mode & 0o777, 0o444);
    assert.equal(statSync(outside).mode & 0o777, 0o555);
    writeFileSync(runs[1]!.release, 'go');
    assert.equal(await runs[1]!.done, 0);
    assert.deepEqual(readdirSync(f.queueDir).filter(name => name.endsWith('.ticket')), []);
  } finally {
    // A failing regression check must still leave its own fixture removable.
    for (const directory of directories) if (existsSync(directory)) chmodSync(directory, 0o700);
    chmodSync(outside, 0o755);
    await clean(f, runs);
  }
});

test('concurrent stages isolate every writable user location and retain the original browser cache', async () => {
  const f = fixture();
  const runs: ReturnType<typeof run>[] = [];
  const names = ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR'];
  const original = Object.fromEntries(names.map(name => [name, join(f.root, `caller-${name}`)]));
  for (const path of Object.values(original)) mkdirSync(path, { mode: 0o700 });
  const scratches: string[] = [];
  try {
    for (const index of [0, 1]) {
      runs.push(run(f, index, 1000, index === 0 ? 'node' : 'e2e', 2, 2, undefined, { ...original,
        ALPACAWORK_E2E_PORT: '11223', ALPACAWORK_E2E_ISOLATED_PORT: '11224',
        PLAYWRIGHT_BROWSERS_PATH: '', COREPACK_HOME: '', COREPACK_ENABLE_NETWORK: '1', COREPACK_DEFAULT_TO_LATEST: '1', ALPACAWORK_RUNTIME_LEASE_FD: '99', ALPACAWORK_RUN_CLI: '/caller/cli' }));
      await admitted(runs[index]!);
      const { env } = JSON.parse(readFileSync(runs[index]!.info, 'utf8'));
      scratches.push(env.TMPDIR);
      // The queue makes the scratch under the resolved /tmp (a link on macOS) so its cleanup can refuse links.
      assert.equal(dirname(env.TMPDIR), realpathSync('/tmp'));
      assert.match(basename(env.TMPDIR), /^aw-q-[^/]+$/);
      if (index === 1) {
        assert.equal(env.ALPACAWORK_E2E_PORT, '0');
        assert.equal(env.ALPACAWORK_E2E_ISOLATED_PORT, '0');
      }
      // Playwright's own default: macOS keeps browsers under Library/Caches whatever XDG_CACHE_HOME says.
      assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, process.platform === 'darwin'
        ? join(original.HOME!, 'Library', 'Caches', 'ms-playwright') : join(original.XDG_CACHE_HOME!, 'ms-playwright'));
      assert.equal(env.COREPACK_HOME, join(original.XDG_CACHE_HOME!, 'node', 'corepack'));
      assert.equal(env.COREPACK_ENABLE_NETWORK, '0');
      assert.equal(env.COREPACK_DEFAULT_TO_LATEST, '0');
      assert.equal(env.ALPACAWORK_RUNTIME_LEASE_FD, undefined);
      assert.equal(env.ALPACAWORK_RUN_CLI, undefined);
      for (const name of names) {
        assert.equal(env[name].startsWith(`${env.TMPDIR}/`), true, name);
        assert.equal(readFileSync(join(env[name], 'stage-probe'), 'utf8'), 'isolated');
      }
      assert.equal(statSync(env.XDG_RUNTIME_DIR).mode & 0o777, 0o700);
    }
    assert.notEqual(scratches[0], scratches[1]);
    assert.match(runs[1]!.output(), /slot 2;/);
    for (const path of Object.values(original)) assert.deepEqual(readdirSync(path), []);
    for (const item of runs) writeFileSync(item.release, 'go');
    assert.deepEqual(await Promise.all(runs.map(item => item.done)), [0, 0]);
    for (const path of scratches) assert.equal(existsSync(path), false);
  } finally { await clean(f, runs); }
});

test('a stage\'s process that left its session and its ticket stops with the stage', { skip: process.platform !== 'linux' }, async () => {
  const f = fixture();
  const pidFile = join(f.root, 'escaped-pid');
  // What a Run started in a systemd scope looks like from here: a new session holding none of the stage's descriptors.
  const escape = `const {spawn} = require('node:child_process');
const child = spawn('sleep', ['300'], {detached:true, stdio:'ignore'});
require('node:fs').writeFileSync(process.argv[1], String(child.pid)); child.unref();`;
  const queue = spawn(process.execPath, [queueScript, 'node', '--', process.execPath, '-e', escape, pidFile], { cwd: f.trees[0],
    env: { ...isolated(), ALPACAWORK_TEST_QUEUE_DIR: f.queueDir, ALPACAWORK_TEST_QUEUE_AVAILABLE_MIB: '1000',
      ALPACAWORK_TEST_QUEUE_ESTIMATE_MIB: '100', ALPACAWORK_TEST_MAX_PARALLEL: '1', ALPACAWORK_TEST_WORKERS: '1' },
    stdio: 'ignore' });
  let pid: number | undefined;
  try {
    assert.equal(await new Promise(done => queue.once('exit', done)), 0);
    pid = Number(readFileSync(pidFile, 'utf8'));
    // Killed before the wrapper exits; whoever adopted it reaps it.
    await until(() => { try { process.kill(pid!, 0); return false; } catch { return true; } }, () => `escaped PID ${pid} still runs`);
  } finally {
    if (pid) try { process.kill(pid, 'SIGKILL'); } catch { /* Stopped. */ }
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('SIGTERM stops a stage, removes its scratch and frees its slot', async () => {
  const f = fixture();
  const runs: ReturnType<typeof run>[] = [];
  try {
    runs.push(run(f, 0, 1000, 'web', 1));
    await admitted(runs[0]!);
    const { env } = JSON.parse(readFileSync(runs[0]!.info, 'utf8'));
    runs.push(run(f, 1, 1000, 'node', 1));
    await until(() => runs[1]!.output().includes('Waiting'), runs[1]!.output);
    runs[0]!.child.kill('SIGTERM');
    assert.equal(await runs[0]!.done, 143);
    assert.equal(existsSync(env.TMPDIR), false);
    await admitted(runs[1]!);
    writeFileSync(runs[1]!.release, 'go');
    assert.equal(await runs[1]!.done, 0);
  } finally { await clean(f, runs); }
});

test('explicit tool caches and the default HOME caches remain offline inputs after isolation', () => {
  const f = fixture();
  try {
    const get = (env: Record<string, string>) => JSON.parse(execFileSync(process.execPath, [queueScript, 'node', '--', process.execPath, '-e',
      'console.log(JSON.stringify({ browser: process.env.PLAYWRIGHT_BROWSERS_PATH, corepack: process.env.COREPACK_HOME, network: process.env.COREPACK_ENABLE_NETWORK, latest: process.env.COREPACK_DEFAULT_TO_LATEST }))'],
      { cwd: f.trees[0], encoding: 'utf8', env: { ...isolated(), ALPACAWORK_TEST_QUEUE_DIR: f.queueDir,
        HOME: join(f.root, 'caller-home'), XDG_CACHE_HOME: '', PLAYWRIGHT_BROWSERS_PATH: '', COREPACK_HOME: '',
        COREPACK_ENABLE_NETWORK: '1', COREPACK_DEFAULT_TO_LATEST: '1', ...env } }));
    assert.deepEqual(get({ PLAYWRIGHT_BROWSERS_PATH: '/fixture/browser-cache', COREPACK_HOME: '/fixture/corepack-cache' }),
      { browser: '/fixture/browser-cache', corepack: '/fixture/corepack-cache', network: '0', latest: '0' });
    assert.deepEqual(get({}), { browser: join(f.root, 'caller-home', ...(process.platform === 'darwin' ? ['Library', 'Caches'] : ['.cache']), 'ms-playwright'),
      corepack: join(f.root, 'caller-home', '.cache', 'node', 'corepack'), network: '0', latest: '0' });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('scratch cleanup repairs read-only directories, preserves external links and refuses replacement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'alpacawork-scratch-test-'));
  const scratch = mkdtempSync(join(root, 'aw-q-'));
  const info = statSync(scratch);
  const entry = { scratch: { path: scratch, dev: info.dev, ino: info.ino } };
  const outside = join(root, 'outside'), nested = join(scratch, 'readonly');
  mkdirSync(outside); writeFileSync(join(outside, 'keep'), 'kept');
  chmodSync(join(outside, 'keep'), 0o444); chmodSync(outside, 0o555);
  mkdirSync(nested); writeFileSync(join(nested, 'file'), 'fixture');
  symlinkSync(outside, join(nested, 'link')); linkSync(join(outside, 'keep'), join(nested, 'hardlink'));
  chmodSync(nested, 0o555); chmodSync(scratch, 0o555);
  try {
    const uid = process.getuid!();
    const mocked = mock.method(process, 'getuid', () => uid + 1);
    try { await assert.rejects(removeScratch(entry), /another user/); }
    finally { mocked.mock.restore(); }
    assert.equal(existsSync(nested), true);
    await removeScratch(entry);
    assert.equal(existsSync(scratch), false);
    assert.equal(statSync(outside).mode & 0o777, 0o555);
    assert.equal(statSync(join(outside, 'keep')).mode & 0o777, 0o444);
    symlinkSync(outside, scratch);
    await assert.rejects(removeScratch(entry), /identity changed/);
    assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'kept');
  } finally { chmodSync(outside, 0o755); rmSync(root, { recursive: true, force: true }); }
});

test('shared queue admits mixed stages under the existing resource policy', async () => {
  const f = fixture();
  const runs: ReturnType<typeof run>[] = [];
  try {
    runs.push(run(f, 0, 1000, 'build', 2));
    await admitted(runs[0]!);
    runs.push(run(f, 1, 1000, 'node', 2));
    await admitted(runs[1]!);
    assert.equal(readdirSync(f.queueDir).filter(name => name.endsWith('.ticket')).length, 2);
    runs.push(run(f, 2, 1000, 'web', 2));
    await until(() => runs[2]!.output().includes('parallel limit'), runs[2]!.output);
    assert.equal(existsSync(runs[2]!.start), false);
    writeFileSync(runs[0]!.release, 'go');
    assert.equal(await runs[0]!.done, 0);
    await admitted(runs[2]!);
    for (const item of runs.slice(1)) writeFileSync(item.release, 'go');
    assert.deepEqual(await Promise.all(runs.slice(1).map(item => item.done)), [0, 0]);
  } finally { await clean(f, runs); }
});

for (const stage of ['e2e', 'build', 'typecheck']) test(`a nested fixture keeps its explicit private queue for ${stage}`, async () => {
  const parent = fixture(), nested = fixture();
  const parentRuns: ReturnType<typeof run>[] = [], nestedRuns: ReturnType<typeof run>[] = [];
  try {
    parentRuns.push(run(parent, 0, 1000, 'node', 1));
    await admitted(parentRuns[0]!);
    nestedRuns.push(run(nested, 0, 1000, stage, 1));
    await admitted(nestedRuns[0]!);
    assert.equal(JSON.parse(readFileSync(nestedRuns[0]!.info, 'utf8')).env.ALPACAWORK_TEST_QUEUE_DIR, nested.queueDir);
    for (const f of [parent, nested]) assert.equal(readdirSync(f.queueDir).filter(name => name.endsWith('.ticket')).length, 1);
    for (const item of [...parentRuns, ...nestedRuns]) writeFileSync(item.release, 'go');
    assert.deepEqual(await Promise.all([...parentRuns, ...nestedRuns].map(item => item.done)), [0, 0]);
  } finally {
    await clean(nested, nestedRuns);
    await clean(parent, parentRuns);
  }
});

test('ticket device and inode integers keep uint64 precision for every queue reader', () => {
  const root = mkdtempSync(join(tmpdir(), 'alpacawork-ticket-test-'));
  const file = join(root, 'ticket'), fd = openSync(file, 'wx+', 0o600);
  try {
    const scratch = { path: '/tmp/aw-q-precision', dev: 9007199254740993n, ino: 18446744073709551615n };
    writeTicket(fd, { pid: 1, worktree: root, stage: 'node', requested: '2026-01-01T00:00:00+00:00', started: null,
      state: 'waiting', estimate_mib: 3500, scratch });
    const raw = readFileSync(file, 'utf8').slice(32);
    assert.match(raw, /"dev":9007199254740993[,}]/);
    assert.match(raw, /"ino":18446744073709551615[,}]/);
    assert.deepEqual(readTicket(fd).scratch, scratch);
  } finally { closeSync(fd); rmSync(root, { recursive: true, force: true }); }
});

test('numeric settings preserve Unicode decimal digits and float separators while rejecting invalid forms', () => {
  const base = Object.fromEntries(Object.entries(SETTINGS).map(([name, [value]]) => [name, [value, 'default']])) as Settings;
  const policy = (name: string, value: string) => new Policy('node', { ...base, [name]: [value, 'environment'] }, 16);
  for (const [name, value, field, expected] of [
    ['ALPACAWORK_TEST_WORKERS', '１２', 'workers', 12],
    ['ALPACAWORK_TEST_WORKERS', '١٢', 'workers', 12],
    ['ALPACAWORK_TEST_WORKERS', '𝟙𝟚', 'workers', 12],
    ['ALPACAWORK_TEST_MAX_PARALLEL', '۱۲', 'limit', 12],
    ['ALPACAWORK_TEST_AUTO_MAX_WORKERS', '１２', 'autoMax', 12],
    ['ALPACAWORK_TEST_RESERVE_MIB', '1_024', 'reserveMiB', 1024],
    ['ALPACAWORK_TEST_RESERVE_MIB', '１_０２４.９', 'reserveMiB', 1024],
    ['ALPACAWORK_TEST_RESERVE_CPUS', '1_0.5', 'reserveCpus', 10.5],
    ['ALPACAWORK_TEST_RESERVE_CPUS', '١_٠.٥', 'reserveCpus', 10.5],
    ['ALPACAWORK_TEST_RESERVE_CPUS', '\u0085+.٥e١_٠\u3000', 'reserveCpus', 5e9],
  ] as const) assert.equal(policy(name, value)[field], expected, `${name}=${value}`);
  for (const [name, values] of [
    ['ALPACAWORK_TEST_WORKERS', ['1_2', '１_２', '+12', ' 12 ', '²', '0']],
    ['ALPACAWORK_TEST_RESERVE_CPUS', ['1__0.5', '١__٠.٥', '_1', '1_', '1_.5', '1._5', '1e_2', 'inf', '-Infinity', 'NaN', '1e999', '-1', '0x10']],
  ] as const) for (const value of values) assert.throws(() => policy(name, value), undefined, `${name}=${value}`);
});
