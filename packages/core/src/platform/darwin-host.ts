/** Darwin's native ABI translation. Run accounting and sampling live in the shared sampler. */
import { statfsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, hostname, release, totalmem } from 'node:os';
import type { CpuInfo } from 'node:os';
import type { HostMeasurement, HostReading, ProcessStat } from './host.js';

// Apple XNU bsd/sys/proc_info.h, LP64 (both arm64 and x86_64).
const BSD_BYTES = 136, TASK_ALL_BYTES = 232;
const TASK_ALL = 2, BSD_INFO = 3, ALL_PIDS = 1;
const MAX_PID_BYTES = 4 * 1024 * 1024;
const VM_BYTES = 152; // HOST_VM_INFO64 revision 1; only the stable prefix is consumed.

/** Low-level seam keeps fixture tests on exactly the buffers used at the native boundary. */
export interface DarwinHostNative {
  listPids(type: number, typeInfo: number, buffer: Buffer | null, bytes: number): number;
  pidInfo(pid: number, flavor: number, arg: number, buffer: Buffer, bytes: number): number;
  sysctl(name: string, buffer: Buffer, bytes: Buffer): number;
  timebase(buffer: Buffer): number;
  loadAverage(buffer: Buffer, count: number): number;
  hostSelf(): number;
  hostStatistics(host: number, flavor: number, buffer: Buffer, count: Buffer): number;
  releaseHost(host: number): number;
  errno(): number;
}
export interface DarwinHostDependencies {
  native: DarwinHostNative;
  cpuTimes(): CpuInfo['times'][];
  memoryBytes(): number;
  disk(path: string): { bavail: number; bsize: number; blocks: number };
  hostname(): string;
  release(): string;
  processTime(): number;
}

function loadNative(): DarwinHostNative {
  // Neither koffi nor Darwin libraries load while another OS imports the selector.
  const koffi: typeof import('koffi').default = createRequire(import.meta.url)('koffi');
  const lib = koffi.load('/usr/lib/libSystem.B.dylib');
  const listPids = lib.func('int proc_listpids(uint32_t, uint32_t, void *, int)');
  const pidInfo = lib.func('int proc_pidinfo(int, int, uint64_t, void *, int)');
  const sysctl = lib.func('int sysctlbyname(const char *, void *, void *, void *, size_t)');
  const hostSelf = lib.func('uint32_t mach_host_self(void)');
  const hostStatistics = lib.func('int host_statistics64(uint32_t, int, void *, void *)');
  const deallocate = lib.func('int mach_port_deallocate(uint32_t, uint32_t)');
  const taskSelf = koffi.decode(lib.symbol('mach_task_self_'), 'uint32_t') as number;
  const timebase = lib.func('int mach_timebase_info(void *)');
  const loadAverage = lib.func('int getloadavg(void *, int)');
  return {
    listPids: (type, info, buffer, bytes) => { koffi.errno(0); return listPids(type, info, buffer, bytes); },
    pidInfo: (pid, flavor, arg, buffer, bytes) => { koffi.errno(0); return pidInfo(pid, flavor, arg, buffer, bytes); },
    sysctl: (name, buffer, bytes) => sysctl(name, buffer, bytes, null, 0),
    timebase, loadAverage, hostSelf, hostStatistics,
    releaseHost: host => deallocate(taskSelf, host), errno: () => koffi.errno(),
  };
}

function nativeFailure(operation: string, code: number): Error {
  return new Error(`Darwin host measurement: ${operation} failed`, { cause: new Error(`native status ${code}`) });
}
function validNumber(value: number, name: string, positive = false): number {
  if (!Number.isFinite(value) || value < 0 || (positive && value === 0)) throw new Error(`Invalid Darwin ${name}`);
  return value;
}
function uint64(buffer: Buffer, offset: number): number {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Darwin integer exceeds safe precision');
  return Number(value);
}
function readSysctl(native: DarwinHostNative, name: string, size: number): Buffer {
  const buffer = Buffer.alloc(size), length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(size)); // size_t is 64-bit on supported Darwin hosts.
  if (native.sysctl(name, buffer, length) !== 0) throw nativeFailure(`sysctl ${name}`, native.errno());
  if (length.readBigUInt64LE() !== BigInt(size)) throw new Error(`Unexpected Darwin ${name} ABI size`);
  return buffer;
}
function readPids(native: DarwinHostNative): number[] {
  const needed = native.listPids(ALL_PIDS, 0, null, 0);
  if (needed <= 0) throw nativeFailure('proc_listpids sizing', native.errno());
  let size = Math.ceil(needed / 4) * 4 + 1024;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (size > MAX_PID_BYTES) throw new Error('Darwin process list exceeds bounded buffer');
    const buffer = Buffer.alloc(size), bytes = native.listPids(ALL_PIDS, 0, buffer, size);
    if (bytes <= 0) throw nativeFailure('proc_listpids', native.errno());
    if (bytes > size || bytes % 4 !== 0) throw new Error('Invalid Darwin process list byte count');
    if (bytes < size) {
      const pids = new Set<number>();
      for (let offset = 0; offset < bytes; offset += 4) {
        const pid = buffer.readInt32LE(offset);
        if (pid > 0) pids.add(pid); // PID 0 is kernel work, as on Linux.
      }
      return [...pids];
    }
    size *= 2;
  }
  throw new Error('Darwin process list kept growing beyond bounded attempts');
}
function readProcess(native: DarwinHostNative, pid: number, numer: number, denom: number): ProcessStat | null {
  let buffer = Buffer.alloc(TASK_ALL_BYTES);
  let count = native.pidInfo(pid, TASK_ALL, 0, buffer, buffer.length);
  let hasTask = true;
  if (count !== TASK_ALL_BYTES) {
    if (count > 0) throw new Error('Unexpected Darwin proc_taskallinfo ABI size');
    const errno = native.errno();
    if (errno === 3) return null; // ESRCH: process ended since enumeration.
    if (errno !== 1 && errno !== 13) throw nativeFailure(`proc_pidinfo(${pid})`, errno);
    // Protected processes remain visible; BSD information can still supply their identity and tree edge.
    hasTask = false;
    buffer = Buffer.alloc(BSD_BYTES);
    count = native.pidInfo(pid, BSD_INFO, 0, buffer, buffer.length);
    if (count !== BSD_BYTES) {
      if (count > 0) throw new Error('Unexpected Darwin proc_bsdinfo ABI size');
      const code = native.errno();
      if (code === 3) return null;
      if (code !== 1 && code !== 13) throw nativeFailure(`proc_pidinfo BSD(${pid})`, code);
      return { pid, ppid: 0, comm: String(pid), ticks: null, startTime: null, rssBytes: null };
    }
  }
  if (buffer.readUInt32LE(12) !== pid) throw new Error('Darwin process identity does not match requested PID');
  const usec = uint64(buffer, 128);
  if (usec >= 1_000_000) throw new Error('Invalid Darwin process start microseconds');
  const startTime = uint64(buffer, 120) * 1_000_000 + usec;
  if (!Number.isSafeInteger(startTime)) throw new Error('Darwin process start exceeds safe precision');
  const commBytes = buffer.subarray(48, 64), end = commBytes.indexOf(0);
  // Task counters are Mach absolute units (fill_taskprocinfo -> recount_times_mach), not nanoseconds.
  const ticks = hasTask ? Number((buffer.readBigUInt64LE(152) + buffer.readBigUInt64LE(160)) * BigInt(numer)) / denom / 1_000_000 : null;
  return { pid, ppid: buffer.readUInt32LE(16), comm: commBytes.subarray(0, end < 0 ? undefined : end).toString('utf8'),
    startTime, ticks, rssBytes: hasTask ? uint64(buffer, 144) : null };
}
function readMemory(native: DarwinHostNative, totalBytes: number, pageBytes: number): HostReading['memory'] {
  const buffer = Buffer.alloc(VM_BYTES), count = Buffer.alloc(4);
  count.writeUInt32LE(VM_BYTES / 4);
  const host = native.hostSelf();
  if (host === 0) throw nativeFailure('mach_host_self', 0);
  let failure: unknown;
  try {
    const status = native.hostStatistics(host, 4, buffer, count);
    if (status !== 0) throw nativeFailure('host_statistics64', status);
    if (count.readUInt32LE() < 24 || count.readUInt32LE() > VM_BYTES / 4) throw new Error('Unexpected Darwin VM statistics ABI size');
    // A conservative reclaimable estimate. speculative_count is already contained in free_count;
    // purgeable pages can overlap other queues and compressed pages are not immediately free RAM.
    const availableBytes = (buffer.readUInt32LE(0) + buffer.readUInt32LE(8)) * pageBytes;
    if (availableBytes > totalBytes) throw new Error('Darwin available memory exceeds total memory');
    return { totalBytes, availableBytes, swapUsedBytes: uint64(readSysctl(native, 'vm.swapusage', 32), 16) };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const status = native.releaseHost(host);
    if (status !== 0 && !failure) throw nativeFailure('mach_port_deallocate(host)', status);
  }
}

export function darwinHostMeasurement(dataDirectory: string, injected?: DarwinHostDependencies): HostMeasurement {
  try {
    const deps: DarwinHostDependencies = injected ?? { native: loadNative(), cpuTimes: () => cpus().map(cpu => cpu.times),
      memoryBytes: totalmem, disk: statfsSync, hostname, release, processTime: () => Date.now() * 1000 };
    const { native } = deps;
    const timebase = Buffer.alloc(8), status = native.timebase(timebase);
    if (status !== 0) throw nativeFailure('mach_timebase_info', status);
    const numer = validNumber(timebase.readUInt32LE(0), 'timebase numerator', true);
    const denom = validNumber(timebase.readUInt32LE(4), 'timebase denominator', true);
    const pageBytes = validNumber(readSysctl(native, 'hw.pagesize', 4).readUInt32LE(), 'page size', true);
    const memoryBytes = validNumber(deps.memoryBytes(), 'total memory', true);
    const coreCount = deps.cpuTimes().length;
    if (coreCount === 0) throw new Error('Darwin returned no CPU counters');
    return {
      supported: true, facts: { hostname: deps.hostname(), os: `macOS (Darwin ${deps.release()})`, cores: coreCount, memoryBytes }, argv: () => [],
      read() {
        try {
          const cpuTimes = deps.cpuTimes();
          if (cpuTimes.length === 0) throw new Error('Darwin returned no CPU counters');
          const cpuTicks = { total: 0, idle: 0 };
          for (const times of cpuTimes) {
            cpuTicks.total += Object.values(times).reduce((sum, value) => sum + validNumber(value, 'CPU counter'), 0);
            cpuTicks.idle += validNumber(times.idle, 'idle CPU counter');
          }
          const loadBytes = Buffer.alloc(24);
          const loadCount = native.loadAverage(loadBytes, 3);
          if (loadCount !== 3) throw nativeFailure('getloadavg', loadCount);
          const values = [loadBytes.readDoubleLE(0), loadBytes.readDoubleLE(8), loadBytes.readDoubleLE(16)];
          if (values.length !== 3 || values.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Invalid Darwin load averages');
          const disk = deps.disk(dataDirectory), memory = readMemory(native, memoryBytes, pageBytes);
          const processTime = validNumber(deps.processTime(), 'process snapshot time', true);
          const processes = new Map<number, ProcessStat>();
          for (const pid of readPids(native)) {
            const process = readProcess(native, pid, numer, denom);
            if (process) processes.set(pid, process);
          }
          return { cpuTicks, memory, load: [values[0]!, values[1]!, values[2]!], processTime, processes,
            disk: { freeBytes: validNumber(disk.bavail * disk.bsize, 'disk available bytes'), totalBytes: validNumber(disk.blocks * disk.bsize, 'disk total bytes', true) } };
        } catch (cause) { throw new Error('Could not read Darwin host resources', { cause }); }
      },
    };
  } catch (cause) { throw new Error('Could not initialize Darwin host measurement', { cause }); }
}
