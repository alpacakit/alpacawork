/**
 * Accounts for machine and Run load from normalized OS readings for the host status tab.
 * CPU shares are of the whole machine (all cores = 100) and come from tick deltas between two samples,
 * because ps's %CPU on Linux is an average since each process started.
 * A Run's weight is its agent process and every descendant: agents start each shell command in its own
 * session, so neither the process group nor the session of the agent holds the Run's tests and builds.
 */
import { posix } from 'node:path';
import { measureHost, type HostMeasurement, type ProcessStat } from '@alpacawork/core/host-measurement';
import type { HostSampleDTO } from '@alpacawork/contract';

export type { HostFacts, ProcessStat } from '@alpacawork/core';
export type RunLoad = HostSampleDTO['runs'][number];
/** A running Run as the control store knows it; `pid` is its agent process. */
export type RunRoot = Pick<RunLoad, 'runId' | 'taskId' | 'title' | 'model' | 'role'> & { pid: number };
/** `cpu` is null on the first sample, which has no earlier ticks to compare with. */
export type HostSample = HostSampleDTO;
type OutsideLoad = HostSample['outside'];
const { basename, normalize } = posix;

const INTERPRETERS = new Set(['node', 'MainThread', 'python', 'python3', 'bun', 'deno', 'sh', 'bash', 'dash', 'zsh']);
const RUNNERS = new Set(['pnpm', 'npm', 'npx', 'yarn']);
/** The kernel keeps 15 characters of a program name in `comm`. */
const COMM_LIMIT = 15;

/**
 * A readable name for a process: the script or package an interpreter runs, the command a runner runs, and the
 * whole program name where the kernel's 15-character `comm` cut it.
 */
export function commandName(comm: string, argv: readonly string[], executable: string | null = null): string {
  if (!INTERPRETERS.has(comm)) {
    if (comm.length < COMM_LIMIT) return comm;
    const program = executable === null ? argvProgram(argv[0] ?? '') : basename(executable.replace(/ \(deleted\)$/, ''));
    return program.startsWith(comm) ? program : comm;
  }
  const args = argv.slice(1);
  const index = args.findIndex(arg => !arg.startsWith('-'));
  // Package bins run as `node_modules/.bin/../<pkg>/...`.
  const script = args[index] === undefined ? undefined : normalize(args[index]!);
  if (script === undefined) return comm === 'MainThread' ? 'node' : comm;
  const pkg = /\/node_modules\/(@[^/]+\/[^/]+|[^/]+)\//.exec(script)?.[1];
  const name = pkg ? pkg.replace(/^@([^/]+)\/.*$/, '$1') : basename(script).replace(/\.(c|m)?(js|ts)$|\.py$/, '');
  if (!RUNNERS.has(name)) return name;
  // A runner's own flags may take a value (`--filter <pkg>`), so the command is the first word not after a flag.
  const rest = args.slice(index + 1);
  const command = rest.find((arg, at) => !arg.startsWith('-') && !(rest[at - 1]?.startsWith('-') && !rest[at - 1]!.includes('=')));
  return command ? `${name} ${command}` : name;
}

function argvProgram(first: string): string {
  const name = basename(first);
  // A rewritten process title can include flags with paths of their own.
  return /\s-/.test(first) || /\s/.test(name) ? '' : name;
}

function runTrees(processes: ReadonlyMap<number, ProcessStat>, roots: readonly RunRoot[], previous: ReadonlyMap<string, string>) {
  const children = new Map<number, number[]>();
  for (const process of processes.values()) {
    const parent = processes.get(process.ppid);
    if (!parent || parent.startTime === null || process.startTime === null || parent.startTime > process.startTime) continue;
    const list = children.get(process.ppid);
    if (list) list.push(process.pid); else children.set(process.ppid, [process.pid]);
  }
  const claimed = new Map<number, Pick<RunRoot, 'runId' | 'taskId'>>();
  const rootKeys = new Map<string, string>();
  const trees = roots.map(root => {
    const rootProcess = processes.get(root.pid);
    const key = rootProcess ? processKey(rootProcess) : null;
    const recorded = previous.get(root.runId);
    if (recorded !== undefined) rootKeys.set(root.runId, recorded);
    else if (key !== null) rootKeys.set(root.runId, key);
    const { pid: _rootPid, ...identity } = root;
    if (key === null || recorded !== undefined && recorded !== key) return { identity, tree: null };

    const tree: ProcessStat[] = [];
    for (const pending = [root.pid]; pending.length > 0;) {
      const pid = pending.pop()!;
      const process = processes.get(pid);
      if (!process || claimed.has(pid)) continue;
      claimed.set(pid, { runId: root.runId, taskId: root.taskId });
      tree.push(process);
      pending.push(...children.get(pid) ?? []);
    }
    return { identity, tree };
  });
  return { trees, claimed, rootKeys };
}

/** Keeps the previous sample's ticks so each sample reports what happened since the last one. */
export class HostSampler {
  private previousCpu: { total: number; idle: number } | null = null;
  private previousTicks = new Map<string, number>();
  private previousProcessTime: number | null = null;
  private roots = new Map<string, string>();
  private names = new Map<string, string>();
  constructor(private readonly measurement: Extract<HostMeasurement, { supported: true }>) {}

  private processName({ comm, pid, startTime }: ProcessStat): string {
    if (INTERPRETERS.has(comm)) return commandName(comm, this.measurement.argv(pid, startTime));
    if (comm.length < COMM_LIMIT) return comm;
    const executable = this.measurement.executable?.(pid, startTime) ?? null;
    return commandName(comm, executable === null ? this.measurement.argv(pid, startTime) : [], executable);
  }

  sample(roots: readonly RunRoot[], at = Date.now()): HostSample {
    const { cpuTicks, processTime, processes, memory, disk } = this.measurement.read();
    const elapsed = this.previousCpu ? cpuTicks.total - this.previousCpu.total : 0;
    const idle = this.previousCpu ? cpuTicks.idle - this.previousCpu.idle : 0;
    const validInterval = elapsed > 0 && idle >= 0 && idle <= elapsed;
    const cpu = validInterval ? 100 * (1 - idle / elapsed) : null;

    const ticks = new Map<string, number>();
    const share = new Map<number, number | null>();
    for (const process of processes.values()) {
      const key = processKey(process);
      if (key !== null && process.ticks !== null) ticks.set(key, process.ticks);
      const before = key === null ? undefined : this.previousTicks.get(key);
      // A newly started process's lifetime belongs to this interval; a newly visible older process's does not.
      const startedInInterval = process.startTime !== null && this.previousProcessTime !== null &&
        processTime >= this.previousProcessTime && process.startTime >= this.previousProcessTime;
      const delta = process.ticks === null ? null : before !== undefined ? process.ticks - before : startedInInterval ? process.ticks : null;
      share.set(process.pid, validInterval && delta !== null && delta >= 0 ? clampPercent(100 * delta / elapsed) : null);
    }
    const names = new Map<string, string>();
    const nameOf = (process: ProcessStat) => {
      const key = processKey(process);
      const name = (key === null ? undefined : names.get(key) ?? this.names.get(key)) ?? this.processName(process);
      if (key !== null) names.set(key, name);
      return name;
    };

    const { trees, claimed, rootKeys } = runTrees(processes, roots, this.roots);
    const runs = trees.map(({ identity, tree }) => ({ ...identity, ...(tree ? weigh(tree, share, nameOf) :
      { cpu: null, memoryBytes: null, processes: 0, heaviest: null }) }));

    const outside = [...processes.values()].filter(process => !claimed.has(process.pid));
    const byName = new Map<string, number>();
    for (const process of outside) {
      if (share.get(process.pid) == null || share.get(process.pid) === 0) continue;
      const name = nameOf(process);
      byName.set(name, (byName.get(name) ?? 0) + share.get(process.pid)!);
    }
    const outsideLoad: OutsideLoad = {
      cpu: total(outside.map(process => share.get(process.pid) ?? null)),
      memoryBytes: total(outside.map(process => process.rssBytes)),
      names: [...byName].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([name]) => name),
    };
    this.previousCpu = cpuTicks;
    this.previousProcessTime = processTime;
    this.roots = rootKeys;
    this.previousTicks = ticks;
    this.names = names;
    return {
      at, cpu, memory, disk, gpus: [],
      runs: runs.sort((a, b) => (b.cpu ?? -1) - (a.cpu ?? -1) || (b.memoryBytes ?? -1) - (a.memoryBytes ?? -1)),
      outside: outsideLoad,
    };
  }

  async readGpus(runs: () => readonly RunRoot[]): Promise<HostSample['gpus']> {
    const reading = await this.measurement.readGpus?.();
    if (!reading || reading.gpus.length === 0) return [];
    const { gpus, processes } = reading;
    const { claimed } = runTrees(processes, runs(), this.roots);
    return gpus.map(({ processes: gpuProcesses, ...gpu }) => ({
      ...gpu,
      users: gpuProcesses ? [...gpuProcesses.entries].sort((a, b) => b.memoryBytes - a.memoryBytes || a.pid - b.pid)
        .slice(0, 2).map(({ pid, name, memoryBytes }) => {
          const process = processes.get(pid);
          // The PID may have been reused since the GPU probe. Only name or attribute the process if it already existed.
          if (process?.startTime == null || process.startTime > gpuProcesses.since) {
            return { name, memoryBytes, runId: null, taskId: null };
          }
          const owner = claimed.get(pid);
          const key = processKey(process);
          const label = (key === null ? undefined : this.names.get(key)) ?? this.processName(process);
          return { name: label || name, memoryBytes, runId: owner?.runId ?? null, taskId: owner?.taskId ?? null };
        }) : null,
    }));

  }
}

/** A Run tree's totals and its heaviest command: the name taking the most CPU (memory breaks ties), with how many run. */
export function weigh(tree: readonly ProcessStat[], share: ReadonlyMap<number, number | null>, nameOf: (process: ProcessStat) => string):
  Pick<RunLoad, 'cpu' | 'memoryBytes' | 'processes' | 'heaviest'> {
  const groups = new Map<string, { cpu: number | null; memory: number | null; count: number }>();
  for (const process of tree) {
    const name = nameOf(process);
    const group = groups.get(name) ?? { cpu: 0, memory: 0, count: 0 };
    group.cpu = total([group.cpu, share.get(process.pid) ?? null]);
    group.memory = total([group.memory, process.rssBytes]);
    group.count += 1;
    groups.set(name, group);
  }
  const top = [...groups].sort((a, b) => (b[1].cpu ?? -1) - (a[1].cpu ?? -1) || (b[1].memory ?? -1) - (a[1].memory ?? -1))[0];
  return {
    cpu: total(tree.map(process => share.get(process.pid) ?? null)),
    memoryBytes: total(tree.map(process => process.rssBytes)),
    processes: tree.length,
    heaviest: top ? { name: top[0], count: top[1].count } : null,
  };
}

const processKey = (process: ProcessStat): string | null => process.startTime === null ? null : `${process.pid}:${process.startTime}`;
/** One unknown operand makes the aggregate unknown; zero is reserved for a known empty set. */
const total = (values: readonly (number | null)[]): number | null => values.some(value => value === null)
  ? null : (values as readonly number[]).reduce((sum, value) => sum + value, 0);
const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

/** One replaceable source includes capability, facts and samples; tests never mix fake samples with the real OS. */
export type HostSource = { supported: false; platform: string } | {
  supported: true;
  /** Null while adapter initialization has failed; never fill hardware facts with guessed values. */
  facts: Extract<HostMeasurement, { supported: true }>['facts'] | null;
  sample(roots: readonly RunRoot[], at: number): HostSample;
  readGpus?(runs: () => readonly RunRoot[]): Promise<HostSample['gpus']>;
};

export function createHostSource(dataDirectory: string, factory: (directory: string) => HostMeasurement = measureHost): HostSource {
  let facts: Extract<HostMeasurement, { supported: true }>['facts'] | null = null;
  let sampler: HostSampler | null = null;
  const initialize = () => {
    const measurement = factory(dataDirectory);
    if (measurement.supported) { facts = measurement.facts; sampler = new HostSampler(measurement); }
    return measurement;
  };
  let initialFailure: { error: unknown } | null = null;
  try {
    const measurement = initialize();
    if (measurement.supported === false) return measurement;
  } catch (error) { initialFailure = { error }; }
  return {
    supported: true, get facts() { return facts; },
    readGpus: runs => sampler?.readGpus(runs) ?? Promise.resolve([]),
    sample(roots, at) {
      // Initialization is part of measurement failure, so it cannot prevent serve from starting.
      // Surface the first failure once; the monitor's next scheduled sample retries initialization.
      if (initialFailure) { const { error } = initialFailure; initialFailure = null; throw error; }
      if (!sampler && !initialize().supported) throw new Error('Host resource adapter is unavailable');
      return sampler!.sample(roots, at);
    },
  };
}
