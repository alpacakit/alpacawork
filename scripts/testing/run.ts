import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir, constants } from 'node:os';
import { basename, dirname, join, normalize, resolve } from 'node:path';
import { linuxPidfd } from '../lib/pidfd.ts';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

type Identity = { born: string; parent: number; state: string };
export type Stage = { process: ChildProcess; result: number | null; log: number; started: number; owner: string; known: Map<number, string>; cursor: number; pending: Buffer };
const OWNER_ENV = 'ALPACAWORK_STAGE_OWNER';
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const token = () => randomUUID().replaceAll('-', '');
export const psStartIdentity = (value: string) => value.trim().split(/\s+/).join(' ');
function linuxIdentity(pid: number): Identity | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    return { born: fields[19]!, parent: Number(fields[1]), state: fields[0]! };
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
    throw error;
  }
}
type ProcessQuery = (args: string[]) => { status: number | null; stdout: string };
const query: ProcessQuery = args => {
  const result = spawnSync('ps', args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  if (result.error) throw result.error;
  return result;
};

// One owner tracks each stage through detached sessions, reparenting and PID reuse.
export class ProcessTracker {
  private readonly linuxStarted: string | undefined;
  private readonly startedWall = Math.floor(Date.now() / 1000);
  private readonly pidfd: { open: (pid: number, flags: number) => number; send: (fd: number, signal: number, info: null, flags: number) => number; errno: () => number } | undefined;
  private readonly linux: boolean;
  private readonly ps: ProcessQuery;
  private readonly kill: (pid: number, signal: NodeJS.Signals) => unknown;
  constructor(linux = process.platform === 'linux', ps: ProcessQuery = query,
    kill: (pid: number, signal: NodeJS.Signals) => unknown = process.kill) {
    this.linux = linux; this.ps = ps; this.kill = kill;
    this.linuxStarted = linux ? linuxIdentity(process.pid)!.born : undefined;
    if (linux) this.pidfd = linuxPidfd();
  }
  discover(stages: Stage[]): Map<number, Identity> {
    const rows = this.ps(['-U', String(process.getuid!()), '-o', 'pid=,ppid=,stat=,lstart=']);
    if (rows.status !== 0) throw new Error('could not list stage processes');
    const processes = new Map<number, Identity>(), owners = new Map<number, string>(), candidates: number[] = [];
    for (const row of rows.stdout.trim().split('\n').filter(Boolean)) {
      const match = row.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) throw new Error('invalid process identity row');
      const pid = Number(match[1]);
      const identity = this.linux ? linuxIdentity(pid) : { born: psStartIdentity(match[4]!), parent: Number(match[2]), state: match[3]! };
      if (!identity) continue;
      processes.set(pid, identity);
      if (this.linuxStarted !== undefined ? Number(identity.born) >= Number(this.linuxStarted) : Date.parse(identity.born) / 1000 >= this.startedWall) candidates.push(pid);
    }
    if (this.linux) {
      for (const pid of candidates) {
        try {
          const entry = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find(entry => entry.startsWith(OWNER_ENV + '='));
          if (entry) owners.set(pid, entry.slice(OWNER_ENV.length + 1));
        } catch (error) {
          if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        }
      }
    } else if (candidates.length) {
      const result = this.ps(['-E', '-ww', '-p', candidates.join(','), '-o', 'pid=,command=']);
      if (result.status !== 0 && result.status !== 1) throw new Error('could not read process ownership markers');
      for (const row of result.stdout.trim().split('\n')) {
        const match = row.trim().match(/^(\d+)\s+(.+)$/);
        const owner = match?.[2]?.match(/(?:^| )ALPACAWORK_STAGE_OWNER=([a-f0-9/]+)(?: |$)/)?.[1];
        if (owner) owners.set(Number(match![1]), owner);
      }
    }
    for (const stage of stages) {
      const owned = new Set<number>();
      for (const [pid, identity] of processes) if (stage.known.get(pid) === identity.born || owners.get(pid)?.startsWith(stage.owner)) owned.add(pid);
      if (stage.result === null && stage.process.pid && processes.has(stage.process.pid)) owned.add(stage.process.pid);
      let changed = true;
      while (changed) {
        changed = false;
        for (const [pid, identity] of processes) if (owned.has(identity.parent) && !owned.has(pid)) { owned.add(pid); changed = true; }
      }
      for (const pid of owned) stage.known.set(pid, processes.get(pid)!.born);
    }
    return processes;
  }
  signalOwned(pid: number, born: string, signal: NodeJS.Signals): void {
    let fd: number | undefined;
    try {
      if (this.linux) {
        if (this.pidfd) {
          const opened = this.pidfd.open(pid, 0);
          if (opened >= 0) fd = opened;
          else if (this.pidfd.errno() === 3) return;
          else if (![22, 38].includes(this.pidfd.errno())) throw new Error(`pidfd_open failed: ${this.pidfd.errno()}`);
        }
        if (linuxIdentity(pid)?.born !== born) return;
        if (fd !== undefined) {
          if (this.pidfd!.send(fd, constants.signals[signal], null, 0) < 0 && this.pidfd!.errno() !== 3) throw new Error(`pidfd_send_signal failed: ${this.pidfd!.errno()}`);
          return;
        }
      } else {
        const current = this.ps(['-p', String(pid), '-o', 'lstart=']);
        if (current.status !== 0 || psStartIdentity(current.stdout) !== born) return;
      }
      this.kill(pid, signal);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  async stop(stages: Stage[]): Promise<void> {
    if (!stages.length) return;
    const deadline = performance.now() + 5000, terminated = new Set<string>();
    while (true) {
      const processes = this.discover(stages), live = new Map<number, string>();
      for (const stage of stages) for (const [pid, born] of stage.known) {
        const current = processes.get(pid);
        if (current?.born === born && !current.state.startsWith('Z')) live.set(pid, born);
      }
      if (!live.size) break;
      const force = performance.now() >= deadline;
      for (const [pid, born] of live) if (force || !terminated.has(`${pid}:${born}`)) {
        this.signalOwned(pid, born, force ? 'SIGKILL' : 'SIGTERM'); terminated.add(`${pid}:${born}`);
      }
      if (performance.now() >= deadline + 5000) throw new Error(`could not stop stage processes: ${[...live.keys()].sort((a, b) => a - b)}`);
      await sleep(50);
    }
    while (stages.some(stage => stage.result === null)) await sleep(10);
  }
}

type Mode = 'all' | 'quick' | 'smoke' | 'build' | 'typecheck';
type Options = { mode: Mode; node: string[]; e2e: string[]; area: string[]; kind: 'production' | 'diagnostic' };
function parseArgs(argv: string[]): Options {
  const options: Options = { mode: 'all', node: [], e2e: [], area: [], kind: 'production' };
  let positional = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (['-h', '--help'].includes(arg)) {
      console.log('Usage: node scripts/testing/run.ts [all|quick|smoke|build|typecheck] [--node tests/NAME.test.ts] [--e2e e2e/NAME.check.ts] [--area AREA] [--kind production|diagnostic]\nFresh build, then staged checks. quick success is not all success.\nquick: type/pure Node/smoke; smoke: browser smoke only. --node, --e2e and --area are quick-only and repeatable. --kind is build-only.\nAll modes except typecheck build fresh. Logs and browser evidence: .local/test-runs/<unique run>/. Do not overlap builds/checks in this checkout.');
      process.exit(0);
    }
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split(/=(.*)/s);
      if (!['node', 'e2e', 'area', 'kind'].includes(key!)) throw new Error(`unrecognized argument: ${arg}`);
      const value = inline ?? argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`expected value for --${key}`);
      if (key === 'kind') {
        if (!['production', 'diagnostic'].includes(value)) throw new Error(`invalid --kind: ${value}`);
        options.kind = value as Options['kind'];
      } else options[key as 'node' | 'e2e' | 'area'].push(value);
    } else {
      if (positional || !['all', 'quick', 'smoke', 'build', 'typecheck'].includes(arg)) throw new Error(`invalid mode: ${arg}`);
      options.mode = arg as Mode; positional = true;
    }
  }
  if (options.kind !== 'production' && options.mode !== 'build') throw new Error('--kind is build-only');
  if (options.mode !== 'quick' && (options.node.length || options.e2e.length || options.area.length)) throw new Error('--node, --e2e and --area are quick-only');
  for (const [paths, folder, suffix] of [[options.node, 'tests', '.test.ts'], [options.e2e, 'e2e', '.check.ts']] as const) for (const value of paths) {
    if (value.split('/').includes('..') || dirname(normalize(value)) !== folder || !basename(value).endsWith(suffix) || !existsSync(value) || !statSync(value).isFile()) throw new Error(`expected an existing exact ${folder}/*${suffix} file: ${value}`);
  }
  return options;
}

type Command = [string, string[]];
const unique = (values: string[]) => [...new Set(values)];
const timestamp = () => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`; };
export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: Options;
  try { args = parseArgs(argv); } catch (error) { console.error(`scripts/testing/run.ts: ${(error as Error).message}`); return 2; }
  process.env.ALPACAWORK_TELEMETRY_DISABLED = '1';
  const { mode } = args, label = ['all', 'quick', 'smoke'].includes(mode) ? 'test-' + mode : mode;
  const artifacts = ['all', 'quick', 'smoke'].includes(mode) ? resolve('.local/test-runs', label + '-' + timestamp() + '-' + token()) : undefined;
  if (artifacts) { mkdirSync(artifacts, { recursive: true }); console.log(`${label}: evidence ${artifacts}`); }
  const gitEnvironment = { ...process.env };
  function checkoutState() {
    const git = (...a: string[]) => spawnSync('git', a, { encoding: 'utf8', env: gitEnvironment }).stdout?.trim() ?? '';
    let installed = false;
    try { installed = readFileSync('node_modules/.pnpm/lock.yaml').equals(readFileSync('pnpm-lock.yaml')); } catch {}
    return { sha: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'), clean: installed && git('status', '--porcelain') === '' };
  }
  const tested = artifacts ? checkoutState() : undefined, testedStarted = Date.now();
  let completed = false, interrupted: NodeJS.Signals | undefined, status = 1, cleanupSucceeded = false;
  const active = new Map<string, Stage>(), failed: string[] = [];
  const interrupt = (signal: NodeJS.Signals) => { interrupted ??= signal; };
  const onInt = () => interrupt('SIGINT'), onTerm = () => interrupt('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  const checkInterrupt = () => { if (interrupted) throw new Error('interrupted'); };
  const parentOwner = process.env[OWNER_ENV] ?? '';
  let tracker: ProcessTracker;
  let scratch: string | undefined, runQueue: string | undefined;
  function progress(name: string, stage: Stage) {
    const data = Buffer.alloc(65536);
    while (true) {
      const size = readSync(stage.log, data, 0, data.length, stage.cursor);
      if (!size) break;
      stage.cursor += size; stage.pending = Buffer.concat([stage.pending, data.subarray(0, size)]);
      let end: number;
      while ((end = stage.pending.indexOf(10)) >= 0) {
        const line = stage.pending.subarray(0, end).toString('utf8'); stage.pending = stage.pending.subarray(end + 1);
        if (line.startsWith('Waiting for test queue:') || line.startsWith('Running test queue:')) console.log(`${label}: ${name}: ${line}`);
      }
    }
  }
  async function finish(name: string, cancelled = false) {
    const stage = active.get(name)!;
    while (stage.result === null) await sleep(10);
    await tracker.stop([stage]);
    progress(name, stage);
    console.log(`\n${label}: output ${name}${cancelled ? ' (interrupted)' : ''}`);
    try {
      const data = Buffer.alloc(65536); let cursor = 0, size: number;
      while ((size = readSync(stage.log, data, 0, data.length, cursor)) > 0) {
        cursor += size;
        if (!process.stdout.write(data.subarray(0, size))) await new Promise<void>(done => process.stdout.once('drain', done));
      }
    } finally { closeSync(stage.log); active.delete(name); }
    console.log(`\n${label}: ${name} ${((performance.now() - stage.started) / 1000).toFixed(1)}s`);
    if (stage.result && !cancelled) { failed.push(name); console.error(`${label}: ${name} failed (exit ${stage.result})`); }
  }
  async function run(stages: Command[]) {
    for (const [name, command] of stages) {
      checkInterrupt(); console.log(`${label}: starting ${name}`);
      const log = openSync(join(artifacts ?? scratch!, name + '.log'), 'w+'), started = performance.now(), owner = parentOwner + token() + '/';
      const child = spawn(command[0]!, command.slice(1), { stdio: ['ignore', log, log], detached: true,
        env: { ...process.env, [OWNER_ENV]: owner, ...(artifacts ? { PLAYWRIGHT_JSON_OUTPUT_NAME: join(artifacts, name + '.json') } : {}) } });
      const stage: Stage = { process: child, result: null, log, started, owner, known: new Map(), cursor: 0, pending: Buffer.alloc(0) };
      let startError: Error | undefined;
      const startedOK = await new Promise<boolean>(done => {
        child.once('spawn', () => done(true));
        child.once('error', error => { startError = error; done(false); });
      });
      if (!startedOK) { closeSync(log); failed.push(name); console.log(`${label}: ${name} ${((performance.now() - started) / 1000).toFixed(1)}s`); console.error(`${label}: ${name} could not start: ${startError!.message}`); continue; }
      child.once('exit', (code, signal) => { stage.result = code ?? -(constants.signals[signal!] ?? 1); });
      active.set(name, stage);
    }
    while (active.size) {
      checkInterrupt(); tracker.discover([...active.values()]);
      for (const [name, stage] of active) { progress(name, stage); if (stage.result !== null) await finish(name); }
      if (active.size) await sleep(100);
    }
  }
  const queue = ['node', 'scripts/testing/queue.ts'];
  try {
    const roots = spawnSync('node', ['scripts/test-runtime-roots.mjs'], { stdio: 'inherit' });
    if (roots.error) throw roots.error;
    if (roots.status !== 0) throw new Error(`runtime entrance check failed (exit ${roots.status})`);
    const { DIR, SETTINGS, loadSettings, collectScratch, playwrightBrowsers } = await import('./queue.ts');
    tracker = new ProcessTracker();
    scratch = mkdtempSync(join(tmpdir(), 'aw-run-'));
    if (artifacts) {
      for (const [key, [value]] of Object.entries(loadSettings())) if (value) process.env[key] = value;
      const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
      process.env.PLAYWRIGHT_BROWSERS_PATH ||= playwrightBrowsers(process.env, cache);
      process.env.COREPACK_HOME ||= join(cache, 'node/corepack');
      process.env.COREPACK_ENABLE_NETWORK = '0'; process.env.COREPACK_DEFAULT_TO_LATEST = '0';
      for (const [key, name] of [['HOME', 'h'], ['TMPDIR', 't'], ['XDG_CONFIG_HOME', 'c'], ['XDG_CACHE_HOME', 'cache'], ['XDG_STATE_HOME', 's'], ['XDG_DATA_HOME', 'd'], ['XDG_RUNTIME_DIR', 'r']]) {
        const directory = join(scratch, name!); mkdirSync(directory, { mode: 0o700 }); process.env[key!] = directory;
      }
      runQueue = DIR; process.env.ALPACAWORK_TEST_QUEUE_DIR = runQueue;
      console.log(`${label}: isolated root ${scratch}`);
    }
    const workspace = 'pnpm-workspace.yaml', backup = join(scratch, workspace);
    if (mode === 'all') copyFileSync(workspace, backup);
    try {
      if (mode === 'build') {
        await run([['packages', ['pnpm', 'build:packages']]]);
        if (!failed.length) await run([['apps', ['pnpm', args.kind === 'diagnostic' ? 'build:apps:diagnostic' : 'build:apps']], ['web', ['pnpm', args.kind === 'diagnostic' ? 'build:web:diagnostic' : 'build:web']]]);
      } else if (mode === 'typecheck') {
        await run([['cli', ['tsc', '-p', 'apps/cli/tsconfig.json', '--noEmit']], ['agent-cli', ['tsc', '-p', 'apps/agent-cli/tsconfig.json', '--noEmit']],
          ['node', ['tsc', '-p', 'tsconfig.tests.json']], ['diagnostic', ['tsc', '-p', 'apps/backend/tsconfig.diagnostic.json']],
          ['web', ['tsc', '-p', 'apps/web/tsconfig.json']], ['e2e', ['tsc', '-p', 'tsconfig.e2e.json']]]);
      } else {
        const value = execFileSync(queue[0]!, [...queue.slice(1), 'setting', 'ALPACAWORK_TEST_WORKERS'], { encoding: 'utf8' }).trim() || SETTINGS.ALPACAWORK_TEST_WORKERS![0];
        process.env.ALPACAWORK_TEST_WORKERS = value; console.log(`${label}: ${value} workers`);
        await run([['build', ['pnpm', 'build']]]);
        const playwright = [...queue, 'e2e', '--', 'playwright', 'test', '-c', 'e2e'], selection = ['--test-list', join(artifacts!, 'browser-selection.txt')];
        if (!failed.length) {
          if (mode === 'quick' || mode === 'smoke') {
            const listing = [...playwright, '--workers=8', '--list', '--reporter=json'];
            await run([['browser-list', listing]]);
            if (!failed.length) await run([['smoke-prepare', ['node', 'scripts/test-smoke.ts', 'prepare', artifacts!, ...unique([...args.e2e, ...args.area])]]]);
            if (!failed.length) await run([['browser-selected', [...listing, ...selection]]]);
            if (!failed.length) await run([['smoke-check', ['node', 'scripts/test-smoke.ts', 'check', artifacts!]]]);
          }
          if (!failed.length) {
            const browser = [...playwright, '--workers=8', '--reporter=line,json', '--output', join(artifacts!, 'browser-output'), ...(mode === 'all' ? [] : selection)];
            let stages: Command[] = [['e2e', browser]];
            if (mode !== 'smoke') {
              stages.unshift(['typecheck', [...queue, 'typecheck', '--', 'pnpm', 'typecheck:built']]);
              if (mode === 'all') {
                const nodeCommand = JSON.parse(readFileSync('package.json', 'utf8')).scripts['test:node'];
                stages.unshift(['node', ['sh', '-c', nodeCommand]]);
                stages.push(['web', ['pnpm', 'test:web']], ['web-utc', ['env', 'TZ=UTC', 'pnpm', 'test:web',
                  'tests/task-domain.test.tsx', 'tests/time-rules.test.tsx', 'tests/time-view-rows.test.tsx', 'tests/report-feed.test.tsx',
                  'tests/coordinator-read-line.test.tsx', 'tests/coordinator-consumer.test.tsx', 'tests/offline-mark.test.tsx', 'tests/coordinator-delivery-migration.test.tsx']],
                ['i18n', [...queue, 'typecheck', '--', 'pnpm', 'i18n:check']], ['acceptance', ['pnpm', 'test:acceptance:run']],
                ['e2e-fixtures', ['pnpm', 'test:e2e:fixtures']], ['e2e-offline', ['pnpm', 'test:e2e:offline']]);
              } else {
                const pure = ['tests/platform-inputs.test.ts', 'tests/home-rows.test.ts', 'tests/working.test.ts', 'tests/task-policy.test.ts', 'tests/return-rules.test.ts', 'tests/problem-rules.test.ts', 'tests/embla-arrival.test.ts', 'tests/release-notes.test.ts'];
                stages.push(['node', [...queue, 'node', '--', 'node', '--test', '--test-concurrency=8', ...unique([...pure, ...args.node])]]);
              }
            }
            await run(stages);
          }
        }
      }
      checkInterrupt();
      if (failed.length) console.error(`${label}: failed stages: ${failed.join(', ')}`);
      status = failed.length ? 1 : 0; completed = true;
    } finally {
      try { await tracker.stop([...active.values()]); for (const name of [...active.keys()]) await finish(name, true); }
      finally {
        try { if (mode === 'all') copyFileSync(backup, workspace); }
        finally { if (artifacts && runQueue) await collectScratch(runQueue); }
      }
    }
    cleanupSucceeded = true;
  } catch (error) {
    if (interrupted) { status = 128 + constants.signals[interrupted]; console.error(`${label}: interrupted`); }
    else { status = 1; console.error(`${label}: ${(error as Error).message}`); }
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm);
  }
  if (artifacts && completed && cleanupSucceeded && !interrupted && status === (failed.length ? 1 : 0)) {
    writeFileSync(join(artifacts, 'result.json'), JSON.stringify({ sha: tested!.sha, tree: tested!.tree,
      clean: tested!.clean && JSON.stringify(checkoutState()) === JSON.stringify(tested), mode, node: args.node, e2e: args.e2e, area: args.area,
      passed: !failed.length, failed, seconds: Math.round((Date.now() - testedStarted) / 1000), finished: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') }, null, 1) + '\n');
  }
  return status;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
