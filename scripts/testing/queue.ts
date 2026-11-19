#!/usr/bin/env node
/** FIFO admission and isolated temporary roots for resource-heavy stages across worktrees. */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { constants, closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { availableParallelism, homedir, loadavg, constants as osConstants } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { lock, tryLock, unlock, removeTreeAt } from '../lib/posix.ts';

export const STAGE_MIB: Record<string, number> = { web: 2300, node: 3500, e2e: 4000, build: 2000, typecheck: 2000 };
const WORKER_STAGES = new Set(['web', 'node', 'e2e']);
const STAGE_CPUS: Record<string, number> = { build: 2, typecheck: 3 };
const WORKER_MIB = 512, BATTERY_WORKERS = 2, LOAD_LAG_SECONDS = 60, PID_FIELD = 16;
export const SETTINGS: Record<string, [string, string]> = {
  ALPACAWORK_TEST_WORKERS: ['auto', 'workers for web, node and e2e: a number, or auto'],
  ALPACAWORK_TEST_MAX_PARALLEL: ['2', 'test stages running at once across worktrees: a number, or auto'],
  ALPACAWORK_TEST_AUTO_MAX_WORKERS: ['8', 'the most workers auto gives one stage'],
  ALPACAWORK_TEST_RESERVE_MIB: ['', 'memory left for other programs; unset leaves a quarter of the total under auto, none otherwise'],
  ALPACAWORK_TEST_RESERVE_CPUS: ['', 'CPUs left for other programs under auto; unset leaves a quarter of the cores'],
};
export const DIR = process.env.ALPACAWORK_TEST_QUEUE_DIR ?? `/tmp/alpacawork-test-queue-${process.getuid!()}`;
export type Settings = Record<string, [string, string]>;
type Count = number | 'auto';
export interface Scratch { path: string; dev: number | bigint; ino: number | bigint }
export interface Entry {
  pid: number; worktree: string; stage: string; requested: string; started: string | null;
  state: 'waiting' | 'running'; estimate_mib: number; max_parallel?: number; workers?: number; child_pid?: number; scratch?: Scratch;
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const hasCode = (error: unknown, code: string) => (error as NodeJS.ErrnoException)?.code === code;
const timestamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');

export function envFiles(): string[] {
  try {
    const [top, common, ...extra] = execFileSync('git', ['rev-parse', '--show-toplevel', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trimEnd().split('\n');
    if (!top || !common || extra.length) throw new Error('invalid git paths');
    return [...new Set([join(top, '.env'), join(dirname(resolve(common)), '.env')])];
  } catch { return [join(process.cwd(), '.env')]; }
}
export function readEnvFile(path: string): Record<string, string> {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch (error) { if (hasCode(error, 'ENOENT')) return {}; throw error; }
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith('#')) continue;
    const quoted = /^(["'])(.*?)\1(?:\s+#.*)?$/.exec(match[2]);
    values[match[1]] = quoted ? quoted[2] : match[2].replace(/(?:^|\s+)#.*$/, '');
  }
  return values;
}
export function loadSettings(): Settings {
  const files = envFiles().map(path => [path, readEnvFile(path)] as const);
  return Object.fromEntries(Object.entries(SETTINGS).map(([name, [defaultValue]]) => {
    if (process.env[name]) return [name, [process.env[name]!, 'environment']];
    const file = files.find(([, values]) => values[name]);
    return [name, file ? [file[1][name], file[0]] : [defaultValue, 'default']];
  }));
}
/** Python's numeric settings accept Unicode decimal digits; only floats accept digit separators. */
function numericSetting(value: string, kind: 'count' | 'amount'): number | null {
  const decimal = value.replace(/\p{Decimal_Number}/gu, digit => {
    const code = digit.codePointAt(0)!;
    let start = code;
    while (/\p{Decimal_Number}/u.test(String.fromCodePoint(start - 1))) start--;
    // Mathematical digit alphabets form adjacent ten-digit blocks.
    return String((code - start) % 10);
  });
  if (kind === 'count') return /^\d+$/.test(decimal) ? Number(decimal) : null;
  const text = decimal.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
  if (/^[+-]?(?:inf(?:inity)?|nan)$/i.test(text)) return Number.NaN;
  if (!/^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:e[+-]?\d(?:_?\d)*)?$/i.test(text)) return null;
  return Number(text.replaceAll('_', ''));
}
function countOrAuto(settings: Settings, name: string): Count {
  const value = settings[name][0];
  if (value === 'auto') return value;
  const number = numericSetting(value, 'count');
  if (number === null || number < 1 || !Number.isSafeInteger(number))
    throw new Error(`${name} must be a positive whole number or auto, not '${value}'`);
  return number;
}
function amount(settings: Settings, name: string, minimum: number): number | null {
  const value = settings[name][0];
  if (value === '') return null;
  const number = numericSetting(value, 'amount');
  if (number === null) throw new Error(`${name} must be a number, not '${value}'`);
  if (!Number.isFinite(number) || number < minimum)
    throw new Error(`${name} must be a finite number of at least ${minimum}, not '${value}'`);
  return number;
}
function testingOverride(name: string): string | undefined {
  return 'ALPACAWORK_TEST_QUEUE_DIR' in process.env ? process.env[name] : undefined;
}
function overrideNumber(name: string, integer = true): number | undefined {
  const raw = testingOverride(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value) || (integer && !Number.isInteger(value))) throw new Error(`invalid ${name}: ${raw}`);
  return value;
}
export function parseMeminfo(raw: string, field: string): number {
  const match = new RegExp(`^${field}:\\s+(\\d+) kB$`, 'm').exec(raw);
  if (!match) throw new Error(`${field} missing from /proc/meminfo`);
  return Math.floor(Number(match[1]) / 1024);
}
export function parseVmStat(raw: string): number {
  const header = /page size of (\d+) bytes/.exec(raw);
  if (!header) throw new Error('page size missing from vm_stat');
  const pages = Object.fromEntries([...raw.matchAll(/^Pages (free|inactive|speculative):\s+(\d+)\./gm)].map(m => [m[1], Number(m[2])]));
  if (Object.keys(pages).length !== 3) throw new Error('usable pages missing from vm_stat');
  return Math.floor(Object.values(pages).reduce((a, b) => a + b, 0) * Number(header[1]) / (1024 * 1024));
}
const output = (file: string, args: string[] = []) => execFileSync(file, args, { encoding: 'utf8', timeout: 5000 });
export function availableMiB(): number {
  const override = overrideNumber('ALPACAWORK_TEST_QUEUE_AVAILABLE_MIB');
  if (override !== undefined) return override;
  if (process.platform === 'linux') return parseMeminfo(readFileSync('/proc/meminfo', 'ascii'), 'MemAvailable');
  if (process.platform === 'darwin') return parseVmStat(output('vm_stat'));
  throw new Error(`unsupported platform: ${process.platform}`);
}
function totalMiB(): number {
  const override = overrideNumber('ALPACAWORK_TEST_QUEUE_TOTAL_MIB');
  if (override !== undefined) return override;
  if (process.platform === 'linux') return parseMeminfo(readFileSync('/proc/meminfo', 'ascii'), 'MemTotal');
  if (process.platform === 'darwin') return Math.floor(Number(output('sysctl', ['-n', 'hw.memsize'])) / (1024 * 1024));
  throw new Error(`unsupported platform: ${process.platform}`);
}
function onBattery(): boolean {
  const override = testingOverride('ALPACAWORK_TEST_QUEUE_POWER');
  if (override !== undefined) return override === 'battery';
  if (process.platform === 'darwin') return output('pmset', ['-g', 'batt']).split('\n')[0].includes('Battery Power');
  let names: string[];
  try { names = readdirSync('/sys/class/power_supply'); }
  catch (error) { if (hasCode(error, 'ENOENT')) return false; throw error; }
  for (const name of names) {
    const base = join('/sys/class/power_supply', name);
    try {
      if (readFileSync(join(base, 'type'), 'ascii').trim() !== 'Battery') continue;
      if (existsSync(join(base, 'scope')) && readFileSync(join(base, 'scope'), 'ascii').trim() === 'Device') continue;
      if (readFileSync(join(base, 'status'), 'ascii').trim() === 'Discharging') return true;
    } catch { /* An unreadable or removed supply does not report machine battery power. */ }
  }
  return false;
}

export class Facts {
  read: Record<string, number | boolean> = {};
  value<T extends number | boolean>(name: string, reader: () => T): T {
    if (!(name in this.read)) this.read[name] = reader();
    return this.read[name] as T;
  }
  available() { return this.value('available', availableMiB); }
  total() { return this.value('total', totalMiB); }
  cpus() { return this.value('cpus', () => overrideNumber('ALPACAWORK_TEST_QUEUE_CPUS') ?? availableParallelism()); }
  load() { return this.value('load', () => overrideNumber('ALPACAWORK_TEST_QUEUE_LOAD', false) ?? loadavg()[0]); }
  battery() { try { return this.value('battery', onBattery); } catch { return false; } }
  describe(policy: Policy): string {
    const parts: string[] = [];
    for (const [label, read] of [
      ['available memory', () => `${this.available()} MiB, reserve ${policy.memoryReserve(this)} MiB`],
      ['load', () => `${this.load().toFixed(1)} of ${this.cpus()} CPUs${policy.auto ? `, reserve ${policy.cpuReserve(this)}` : ''}${policy.workers === 'auto' && this.battery() ? ', on battery' : ''}`],
    ] as const) {
      try { parts.push(`${label} ${read()}`); }
      catch (error) { parts.push(`${label} unknown (${message(error)})`); }
    }
    return parts.join('; ');
  }
}
export class Policy {
  stage: string;
  commandLimit: number | null;
  workers: Count;
  limit: Count;
  limitSet: boolean;
  auto: boolean;
  autoMax: number;
  reserveMiB: number | null;
  reserveCpus: number | null;
  baseEstimate: number;
  perWorker: number;
  waitSeconds: number | null = 2 * 60 * 60;
  queueName = 'test queue';
  constructor(stage: string, settings: Settings, commandLimit: number | null = null) {
    this.stage = stage; this.commandLimit = commandLimit;
    this.workers = countOrAuto(settings, 'ALPACAWORK_TEST_WORKERS');
    this.limit = countOrAuto(settings, 'ALPACAWORK_TEST_MAX_PARALLEL');
    this.limitSet = settings.ALPACAWORK_TEST_MAX_PARALLEL[1] !== 'default';
    this.auto = this.workers === 'auto' || this.limit === 'auto';
    const most = countOrAuto(settings, 'ALPACAWORK_TEST_AUTO_MAX_WORKERS');
    if (most === 'auto') throw new Error('ALPACAWORK_TEST_AUTO_MAX_WORKERS must be a positive whole number');
    this.autoMax = commandLimit === null ? most : Math.min(most, commandLimit);
    const reserve = amount(settings, 'ALPACAWORK_TEST_RESERVE_MIB', 0);
    this.reserveMiB = reserve === null ? null : Math.trunc(reserve);
    this.reserveCpus = amount(settings, 'ALPACAWORK_TEST_RESERVE_CPUS', 0);
    const override = overrideNumber('ALPACAWORK_TEST_QUEUE_ESTIMATE_MIB');
    this.baseEstimate = override ?? STAGE_MIB[stage];
    this.perWorker = override === undefined && WORKER_STAGES.has(stage) ? WORKER_MIB : 0;
  }
  machine(facts: Facts) { return facts.describe(this); }
  estimate(workers: number) { return this.baseEstimate + Math.max(0, workers - 2) * this.perWorker; }
  memoryReserve(facts: Facts) { return this.reserveMiB ?? (this.auto ? Math.floor(facts.total() / 4) : 0); }
  room(facts: Facts, running: Entry[]) { return facts.available() - this.memoryReserve(facts) - running.reduce((n, e) => n + e.estimate_mib, 0); }
  minimalStart(workers: Count): [number, number] { return [workers === 'auto' ? 2 : Math.min(workers, 2), this.baseEstimate]; }
  cpuReserve(facts: Facts) { return this.reserveCpus ?? facts.cpus() / 4; }
  freeCpus(facts: Facts, running: Entry[]) {
    const now = Date.now();
    return facts.cpus() - this.cpuReserve(facts) - facts.load() - running.reduce((n, e) =>
      n + (e.workers ?? 2) * Math.exp(-Math.max(0, (now - Date.parse(e.started!)) / 1000) / LOAD_LAG_SECONDS), 0);
  }
  decide(running: Entry[], facts: Facts): [number, number] | string {
    const caps = running.flatMap(e => e.max_parallel === undefined ? [] : [e.max_parallel]);
    if (this.limit !== 'auto') caps.push(this.limit);
    if (caps.length && running.length >= Math.min(...caps)) return 'parallel limit';
    const workers = !WORKER_STAGES.has(this.stage) ? STAGE_CPUS[this.stage]
      : this.workers !== 'auto' && this.commandLimit !== null ? Math.min(this.workers, this.commandLimit) : this.workers;
    try { return workers === 'auto' ? this.decideAutoWorkers(running, facts) : this.decideFixedWorkers(workers, running, facts); }
    catch (error) { return running.length ? `machine measurement failed: ${message(error)}` : this.minimalStart(workers); }
  }
  decideFixedWorkers(workers: number, running: Entry[], facts: Facts): [number, number] | string {
    const estimate = this.estimate(workers);
    if (!running.length && workers <= 2 && !this.auto) return [workers, estimate];
    const room = this.room(facts, running);
    if (!running.length) return room >= estimate ? [workers, estimate] : this.minimalStart(workers);
    if (room < estimate) return 'memory limit';
    if (this.limit === 'auto' && this.freeCpus(facts, running) < workers) return 'cpu limit';
    return [workers, estimate];
  }
  decideAutoWorkers(running: Entry[], facts: Facts): [number, number] | string {
    const room = this.room(facts, running);
    const most = facts.battery() ? Math.min(this.autoMax, BATTERY_WORKERS) : this.autoMax;
    const byCpu = Math.trunc(this.freeCpus(facts, running));
    const byMemory = this.perWorker ? 2 + Math.floor((room - this.baseEstimate) / this.perWorker) : most;
    let workers = Math.min(most, byCpu, byMemory);
    if (!running.length) {
      workers = Math.max(1, Math.min(most, byCpu, Math.max(byMemory, 2)));
      return [workers, this.estimate(workers)];
    }
    if (workers < Math.min(2, most)) return byCpu <= byMemory ? 'cpu limit' : 'memory limit';
    if (room < this.estimate(workers)) return 'memory limit';
    return [workers, this.estimate(workers)];
  }
}

const RUNNERS: Record<string, [string, string, string | null]> = {
  e2e: ['playwright', '--workers', null], web: ['vitest', '--maxWorkers', null], node: ['node', '--test-concurrency', '--test'],
};
const WORKER_FLAGS = new Set(Object.values(RUNNERS).map(row => row[1]));
function knownRunner(command: string[], stage: string) {
  const runner = RUNNERS[stage];
  return command.length && runner && basename(command[0]) === runner[0] && (runner[2] === null || command.includes(runner[2])) ? runner : undefined;
}
function workerFlags(command: string[]): [number, string, string][] {
  return command.flatMap((arg, index) => {
    const equal = arg.indexOf('='), flag = equal < 0 ? arg : arg.slice(0, equal);
    return WORKER_FLAGS.has(flag) ? [[equal < 0 ? index + 1 : index, equal < 0 ? '' : `${flag}=`, equal < 0 ? command[index + 1] ?? '' : arg.slice(equal + 1)] as [number, string, string]] : [];
  });
}
export function commandLimit(command: string[], stage: string): number | null {
  for (const [, , value] of workerFlags(command)) if (/^\d+$/.test(value)) return Number(value);
  return knownRunner(command, stage) ? null : 2;
}
export function commandWithWorkers(command: string[], stage: string, workers: number): string[] {
  const adjusted = [...command], given = workerFlags(command);
  for (const [position, prefix, value] of given) if (/^\d+$/.test(value)) adjusted[position] = `${prefix}${Math.min(Number(value), workers)}`;
  const runner = knownRunner(command, stage);
  if (!given.length && runner) {
    const [, flag, anchor] = runner;
    if (anchor === null) adjusted.push(`${flag}=${workers}`);
    else adjusted.splice(adjusted.indexOf(anchor) + 1, 0, `${flag}=${workers}`);
  }
  return adjusted;
}

function checkedFile(path: string, flags: number): number {
  const fd = openSync(path, flags | constants.O_NOFOLLOW, 0o600);
  const info = fstatSync(fd);
  if (!info.isFile() || info.uid !== process.getuid!() || info.nlink !== 1) {
    closeSync(fd); throw new Error(`unsafe queue file: ${path}`);
  }
  return fd;
}
function queueDirectory(path: string): void {
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.uid !== process.getuid!() || (info.mode & 0o077)) throw new Error(`unsafe queue directory: ${path}`);
}
function readAt(fd: number, length: number): Buffer {
  const raw = Buffer.alloc(length);
  return raw.subarray(0, readSync(fd, raw, 0, length, 0));
}
export function readTicket(fd: number): Entry {
  const raw = readAt(fd, 4096), first = raw.subarray(0, PID_FIELD).toString(), second = raw.subarray(PID_FIELD, PID_FIELD * 2).toString();
  // The source text preserves uint64 inode/device values that JSON numbers would round.
  const entry = JSON.parse(raw.subarray(PID_FIELD * 2).toString(), (key: string, value: unknown, context?: { source: string }) => {
    return (key === 'dev' || key === 'ino') && typeof value === 'number' ? BigInt(context!.source) : value;
  }) as Entry;
  if (first === second && /^\d+$/.test(first) && Number(first)) entry.child_pid = Number(first);
  return entry;
}
function writeAt(fd: number, raw: Buffer): void {
  let position = 0;
  while (position < raw.length) position += writeSync(fd, raw, position, raw.length - position, position);
}
export function writeTicket(fd: number, entry: Entry): void {
  ftruncateSync(fd, 0);
  const json = JSON.stringify(entry, (_key, value) => typeof value === 'bigint'
    ? (JSON as unknown as { rawJSON(raw: string): unknown }).rawJSON(String(value)) : value);
  writeAt(fd, Buffer.from('0'.repeat(PID_FIELD * 2) + json));
  fsyncSync(fd);
}
async function stopEscaped(scratch: string): Promise<void> {
  if (!existsSync('/proc')) return;
  const marker = Buffer.from(`\0TMPDIR=${scratch}\0`), deadline = performance.now() + 10_000;
  for (;;) {
    const left: number[] = [];
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
      try {
        if (Buffer.concat([Buffer.from([0]), readFileSync(`/proc/${name}/environ`), Buffer.from([0])]).includes(marker)) left.push(Number(name));
      } catch { /* Ended, or another user's process. */ }
    }
    if (!left.length) return;
    if (performance.now() >= deadline) {
      console.error(`test queue: processes outlived their stage and could not be stopped: [${left.join(', ')}]`); return;
    }
    for (const pid of left) {
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) { if (!hasCode(error, 'ESRCH') && !hasCode(error, 'EPERM')) throw error; }
    }
    await delay(100);
  }
}
export async function removeScratch(entry: Pick<Entry, 'scratch'>): Promise<void> {
  if (!entry.scratch) return;
  const scratch = entry.scratch;
  if (!basename(scratch.path).startsWith('aw-q-')) throw new Error('invalid test scratch name');
  await stopEscaped(scratch.path);
  removeTreeAt(dirname(scratch.path), basename(scratch.path), scratch);
}
/** Playwright's own default browser folder, pinned before HOME and XDG_* move to scratch: macOS keeps it under Library/Caches. */
export function playwrightBrowsers(env: NodeJS.ProcessEnv, cache: string): string {
  return process.platform === 'darwin' ? join(env.HOME || homedir(), 'Library', 'Caches', 'ms-playwright') : join(cache, 'ms-playwright');
}
export function stageEnvironment(scratch: string, workers: number, stage: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ALPACAWORK_TEST_WORKERS: String(workers), TMPDIR: scratch };
  const cache = env.XDG_CACHE_HOME || join(env.HOME || homedir(), '.cache');
  env.PLAYWRIGHT_BROWSERS_PATH ||= playwrightBrowsers(env, cache);
  env.COREPACK_HOME ||= join(cache, 'node', 'corepack');
  env.COREPACK_ENABLE_NETWORK = '0'; env.COREPACK_DEFAULT_TO_LATEST = '0';
  if (stage === 'e2e') { env.ALPACAWORK_E2E_PORT = '0'; env.ALPACAWORK_E2E_ISOLATED_PORT = '0'; }
  for (const [name, child] of Object.entries({ HOME: 'home', XDG_CONFIG_HOME: 'config', XDG_CACHE_HOME: 'cache', XDG_STATE_HOME: 'state', XDG_DATA_HOME: 'data', XDG_RUNTIME_DIR: 'runtime' })) {
    const path = join(scratch, child);
    mkdirSync(path, { mode: 0o700 }); env[name] = path;
  }
  delete env.ALPACAWORK_RUNTIME_LEASE_FD; delete env.ALPACAWORK_RUN_CLI;
  return env;
}
/** Caller owns control.lock. A separately opened ticket can lock only after every inherited fd closes. */
async function liveEntries(queuePath: string): Promise<[string, Entry][]> {
  const entries: [string, Entry][] = [];
  for (const name of readdirSync(queuePath).sort()) {
    if (!/^\d{20}\.ticket$/.test(name)) continue;
    const path = join(queuePath, name);
    let fd: number;
    try { fd = checkedFile(path, constants.O_RDWR); }
    catch (error) { if (hasCode(error, 'ENOENT')) continue; throw error; }
    try {
      if (!tryLock(fd)) entries.push([name, readTicket(fd)]);
      else { await removeScratch(readTicket(fd)); unlinkSync(path); }
    } finally { closeSync(fd); }
  }
  return entries;
}
export async function collectScratch(queuePath = DIR): Promise<void> {
  if (!existsSync(queuePath)) return;
  queueDirectory(queuePath);
  const control = checkedFile(join(queuePath, 'control.lock'), constants.O_CREAT | constants.O_RDWR);
  try { await lock(control); try { await liveEntries(queuePath); } finally { unlock(control); } }
  finally { closeSync(control); }
}
function createTicket(control: number, stage: string, policy: Policy): [string, number, Entry] {
  const previous = readAt(control, 40).toString().trim(), sequence = BigInt(previous || '0') + 1n;
  ftruncateSync(control, 0); writeAt(control, Buffer.from(String(sequence))); fsyncSync(control);
  const name = `${String(sequence).padStart(20, '0')}.ticket`, fd = checkedFile(join(DIR, name), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR);
  try {
    if (!tryLock(fd)) throw new Error('new ticket is already locked');
    const entry: Entry = { pid: process.pid, worktree: process.cwd(), stage, requested: timestamp(), started: null, state: 'waiting', estimate_mib: policy.baseEstimate };
    if (policy.limitSet && policy.limit !== 'auto') entry.max_parallel = policy.limit;
    writeTicket(fd, entry);
    return [name, fd, entry];
  } catch (error) { closeSync(fd); throw error; }
}
function describe(entry: Entry): string {
  const owner = entry.child_pid ? `child PID ${entry.child_pid} (wrapper PID ${entry.pid})` : `wrapper PID ${entry.pid}`;
  return `${owner} ${entry.worktree} ${entry.stage} started ${entry.started}`;
}
export class QueueTimeout extends Error {}
export interface Admission { ticketFd: number; entry: Entry; workers: number; estimate: number; slot: number; facts: Facts; control: number }
/** The ticket owns its scratch until all inherited descriptors close. */
export async function admission<T>(stage: string, policy: Policy, action: (slot: Admission) => Promise<T>): Promise<T> {
  const interval = Number(process.env.ALPACAWORK_TEST_QUEUE_NOTICE_SECONDS ?? '15') * 1000;
  queueDirectory(DIR);
  const control = checkedFile(join(DIR, 'control.lock'), constants.O_CREAT | constants.O_RDWR);
  let ticketFd: number | undefined;
  try {
    let ticketName: string, entry: Entry;
    await lock(control);
    try { await liveEntries(DIR); [ticketName, ticketFd, entry] = createTicket(control, stage, policy); }
    finally { unlock(control); }
    const deadline = policy.waitSeconds === null ? null : performance.now() + policy.waitSeconds * 1000;
    let nextNotice = 0;
    let admitted: Admission | undefined;
    while (!admitted) {
      await lock(control);
      try {
        const entries = await liveEntries(DIR);
        const ahead = entries.filter(([name, value]) => name < ticketName && value.state === 'waiting');
        const running = entries.filter(([, value]) => value.state === 'running').map(([, value]) => value);
        const facts = new Facts(), decision = ahead.length ? 'earlier request' : policy.decide(running, facts);
        if (typeof decision !== 'string') {
          const [workers, estimate] = decision;
          entry.state = 'running'; entry.started = timestamp(); entry.estimate_mib = estimate; entry.workers = workers;
          const scratch = mkdtempSync(join(realpathSync('/tmp'), 'aw-q-')), info = lstatSync(scratch, { bigint: true });
          entry.scratch = { path: scratch, dev: info.dev, ino: info.ino };
          writeTicket(ticketFd, entry);
          admitted = { ticketFd, entry, workers, estimate, slot: running.length + 1, facts, control };
        } else {
          const now = performance.now();
          if (now >= nextNotice) {
            console.error(`Waiting for ${policy.queueName}: position ${ahead.length + 1}; ${decision}; ${policy.machine(facts)}; running: ${running.map(describe).join('; ') || 'none'}`);
            nextNotice = now + interval;
          }
        }
      } finally { unlock(control); }
      if (!admitted) {
        if (deadline !== null && performance.now() >= deadline) throw new QueueTimeout('Timed out after 2 hours waiting for test queue');
        await delay(500);
      }
    }
    return await action(admitted);
  } finally {
    try {
      if (ticketFd !== undefined) {
        await lock(control);
        try { closeSync(ticketFd); ticketFd = undefined; await liveEntries(DIR); }
        finally { unlock(control); }
      }
    } finally { closeSync(control); }
  }
}
export async function main(stage: string, command: string[]): Promise<number> {
  if (!(stage in STAGE_MIB)) throw new Error(`unknown stage: ${stage}`);
  const policy = new Policy(stage, loadSettings(), commandLimit(command, stage));
  return admission(stage, policy, async ({ ticketFd, entry, workers, estimate, slot, facts, control }) => {
    const env = stageEnvironment(entry.scratch!.path, workers, stage);
    let child: ChildProcess | undefined;
    const forward = (signal: NodeJS.Signals) => {
      if (child?.pid) try { process.kill(-child.pid, signal); }
      catch (error) { if (!hasCode(error, 'ESRCH')) throw error; }
    };
    const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    try {
      const [file, ...args] = commandWithWorkers(command, stage, workers);
      child = spawn(file, args, { env, detached: true, stdio: ['inherit', 'inherit', 'inherit', ticketFd] });
      const exited = new Promise<number>((resolve, reject) => {
        child!.once('error', reject);
        child!.once('exit', (code, signal) => resolve(code ?? 128 + (osConstants.signals[signal!] ?? 1)));
      });
      // Install the exit observer before any await: short commands may finish while control.lock is busy.
      if (child.pid) {
        await lock(control);
        try { const pid = String(child.pid).padStart(PID_FIELD, '0'); writeAt(ticketFd, Buffer.from(pid + pid)); fsyncSync(ticketFd); }
        finally { unlock(control); }
        entry.child_pid = child.pid;
        console.error(`Running test queue: ${describe(entry)}; slot ${slot}; workers ${workers}${policy.workers === 'auto' && WORKER_STAGES.has(stage) ? ' (auto)' : ''}; estimate ${estimate} MiB; ${facts.describe(policy)}; temporary ${entry.scratch!.path}`);
      }
      return await exited;
    } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
  });
}
export function showSettings(name?: string): number {
  const settings = loadSettings();
  if (name !== undefined) {
    if (!(name in settings)) throw new Error(`unknown setting: ${name}`);
    const [value, source] = settings[name]; console.log(source === 'default' ? '' : value);
  } else for (const [key, [value, source]] of Object.entries(settings)) console.log(`${key}=${value}  # ${source}: ${SETTINGS[key][1]}`);
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === 'settings' && args.length === 1) process.exitCode = showSettings();
    else if (args[0] === 'setting' && args.length === 2) process.exitCode = showSettings(args[1]);
    else if (args.length >= 3 && args[1] === '--') process.exitCode = await main(args[0], args.slice(2));
    else { console.error('usage: queue.ts STAGE -- command [args ...] | queue.ts settings | queue.ts setting NAME'); process.exitCode = 1; }
  } catch (error) { console.error(error instanceof QueueTimeout ? message(error) : `test queue error: ${message(error)}`); process.exitCode = error instanceof QueueTimeout ? 75 : 1; }
}
