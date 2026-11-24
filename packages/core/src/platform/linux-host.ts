/** Linux kernel readings translated once into the common measurement contract. */
import { readFileSync, readdirSync, readlinkSync, statfsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { cpus, hostname, totalmem } from 'node:os';
import type { HostFacts, HostReading, HostMeasurement, ProcessStat } from './host.js';
import { pollGpus } from './gpu.js';
import { readAmdGpus } from './amd-gpu.js';
import { readNvidiaGpus } from './nvidia-gpu.js';

/** Aggregate CPU ticks; guest time is already included in user and nice. */
export function parseCpuTicks(text: string): { total: number; idle: number } {
  const first = text.split('\n', 1)[0] ?? '';
  const fields = first.trim().split(/\s+/);
  const values = fields.slice(1, 9).map(Number);
  if (fields[0] !== 'cpu' || values.length < 8 || values.some(v => !Number.isFinite(v) || v < 0)) throw new Error('Invalid /proc/stat CPU counters');
  return { total: values.reduce((sum, v) => sum + v, 0), idle: values[3]! + values[4]! };
}

export function parseMeminfo(text: string): HostReading['memory'] {
  const kib = (key: string) => {
    const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, 'm').exec(text);
    if (!match) throw new Error(`Missing /proc/meminfo ${key}`);
    return Number(match[1]) * 1024;
  };
  const totalBytes = kib('MemTotal'), availableBytes = kib('MemAvailable'), swapTotal = kib('SwapTotal'), swapFree = kib('SwapFree');
  if (!(totalBytes > 0) || availableBytes > totalBytes || swapFree > swapTotal) throw new Error('Invalid /proc/meminfo counters');
  return { totalBytes, availableBytes, swapUsedBytes: swapTotal - swapFree };
}

/** Parse native tick fields; the adapter supplies page size and converts ticks to milliseconds. */
export function parseProcessStat(text: string, pageBytes = 4096): ProcessStat | null {
  const open = text.indexOf('('), close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const rest = text.slice(close + 2).trim().split(/\s+/);
  const field = (n: number) => Number(rest[n - 3]);
  const result = { pid: Number(text.slice(0, open)), ppid: field(4), comm: text.slice(open + 1, close),
    ticks: field(14) + field(15), startTime: field(22), rssBytes: field(24) * pageBytes };
  if (!Number.isSafeInteger(result.pid) || result.pid <= 0 || [result.ppid, result.ticks, result.startTime, result.rssBytes].some(v => !Number.isFinite(v) || v < 0)) return null;
  return result;
}

function readHostFacts(): HostFacts {
  let os = 'Linux';
  try {
    const release = readFileSync('/etc/os-release', 'utf8');
    const value = (key: string) => new RegExp(`^${key}="?([^"\\n]*)"?$`, 'm').exec(release)?.[1];
    os = [value('NAME'), value('VERSION_ID')].filter(Boolean).join(' ') || os;
  } catch { /* Optional distribution label, not a measurement. */ }
  return { hostname: hostname(), os, cores: cpus().length, memoryBytes: totalmem() };
}

/** These startup-only commands have no shell or descendants and are killed on timeout/output overflow. */
function getconf(key: string): number {
  const value = Number(execFileSync('/usr/bin/getconf', [key], { encoding: 'utf8', timeout: 1000,
    killSignal: 'SIGKILL', maxBuffer: 1024, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' } }).trim());
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid getconf ${key}`);
  return value;
}

function readProcesses(pageBytes: number, tickMs: number): Map<number, ProcessStat> {
  const processes = new Map<number, ProcessStat>();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = parseProcessStat(readFileSync(`/proc/${entry}/stat`, 'utf8'), pageBytes);
      if (!stat) throw new Error(`Invalid /proc/${entry}/stat`);
      if (stat.pid !== 2 && stat.ppid !== 2) processes.set(stat.pid, { ...stat, ticks: stat.ticks! * tickMs });
    } catch (error) {
      // Disappearance is a normal race; protected rows remain unknown rather than disappearing or zeroing.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        const pid = Number(entry);
        processes.set(pid, { pid, ppid: 0, comm: entry, ticks: null, startTime: null, rssBytes: null });
      } else if (code !== 'ENOENT' && code !== 'ESRCH') throw error;
    }
  }
  return processes;
}

function sameProcess(pid: number, startTime?: number | null): boolean {
  return startTime == null || parseProcessStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))?.startTime === startTime;
}

function readArgv(pid: number, startTime?: number | null): string[] {
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    return sameProcess(pid, startTime) ? argv : [];
  }
  catch { return []; } // Names can degrade to comm without fabricating CPU/RSS.
}

function readExecutable(pid: number, startTime?: number | null): string | null {
  try {
    const executable = readlinkSync(`/proc/${pid}/exe`);
    return sameProcess(pid, startTime) ? executable : null;
  } catch { return null; }
}

export function linuxHostMeasurement(dataDirectory: string): HostMeasurement {
  const pageBytes = getconf('PAGESIZE'), ticksPerSecond = getconf('CLK_TCK'), tickMs = 1000 / ticksPerSecond;
  const amd = pollGpus(() => readAmdGpus()), nvidia = pollGpus(readNvidiaGpus);
  return {
    supported: true, facts: readHostFacts(), argv: readArgv, executable: readExecutable,
    read() {
      const disk = statfsSync(dataDirectory);
      const load = readFileSync('/proc/loadavg', 'utf8').trim().split(/\s+/).slice(0, 3).map(Number);
      if (load.length !== 3 || load.some(v => !Number.isFinite(v) || v < 0)) throw new Error('Invalid /proc/loadavg');
      const cpu = parseCpuTicks(readFileSync('/proc/stat', 'utf8'));
      const processTime = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * ticksPerSecond;
      if (!Number.isFinite(processTime)) throw new Error('Invalid /proc/uptime');
      return {
        cpuTicks: { total: cpu.total * tickMs, idle: cpu.idle * tickMs }, processTime,
        processes: readProcesses(pageBytes, tickMs), memory: parseMeminfo(readFileSync('/proc/meminfo', 'utf8')),
        load: load as [number, number, number],
        disk: { freeBytes: disk.bavail * disk.bsize, totalBytes: disk.blocks * disk.bsize },
        gpus: [...nvidia(processTime), ...amd(processTime)],
      };
    },
  };
}
