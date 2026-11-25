/** Windows SDK boundary. All public CPU counters are cumulative milliseconds across all cores. */
import { createRequire } from 'node:module';
import { statfsSync } from 'node:fs';
import { hostname, release } from 'node:os';
import type { HostMeasurement, HostReading, ProcessStat } from './host.js';
import { nvidiaGpuReader } from './nvidia-gpu.js';

// The Windows LLP64 ABI has 32-bit DWORD/LONG even when pointers are 64-bit.
type Handle = number | bigint;
export interface WindowsHostNative {
  pointerBytes: 4 | 8;
  GetActiveProcessorCount(group: number): number;
  GetSystemTimes(idle: Buffer, kernel: Buffer, user: Buffer): number;
  GlobalMemoryStatusEx(memory: Buffer): number;
  CreateToolhelp32Snapshot(flags: number, pid: number): Handle;
  Process32FirstW(snapshot: Handle, entry: Buffer): number;
  Process32NextW(snapshot: Handle, entry: Buffer): number;
  OpenProcess(access: number, inherit: number, pid: number): Handle;
  GetExitCodeProcess(process: Handle, code: Buffer): number;
  GetProcessTimes(process: Handle, creation: Buffer, exit: Buffer, kernel: Buffer, user: Buffer): number;
  K32GetProcessMemoryInfo(process: Handle, counters: Buffer, size: number): number;
  CloseHandle(handle: Handle): number;
  GetLastError(): number;
}

let nativeCache: WindowsHostNative | undefined;
function loadNative(): WindowsHostNative {
  if (nativeCache) return nativeCache;
  // Do not load a Windows DLL, or even Koffi, when this module is imported on another OS.
  const koffi = createRequire(import.meta.url)('koffi') as typeof import('koffi');
  const kernel = koffi.load('kernel32.dll');
  nativeCache = {
    pointerBytes: koffi.sizeof('void *') as 4 | 8,
    GetActiveProcessorCount: kernel.func('uint32_t __stdcall GetActiveProcessorCount(uint16_t group)'),
    GetSystemTimes: kernel.func('int32_t __stdcall GetSystemTimes(void *idle, void *kernel, void *user)'),
    GlobalMemoryStatusEx: kernel.func('int32_t __stdcall GlobalMemoryStatusEx(void *memory)'),
    CreateToolhelp32Snapshot: kernel.func('uintptr_t __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)'),
    Process32FirstW: kernel.func('int32_t __stdcall Process32FirstW(uintptr_t snapshot, void *entry)'),
    Process32NextW: kernel.func('int32_t __stdcall Process32NextW(uintptr_t snapshot, void *entry)'),
    OpenProcess: kernel.func('uintptr_t __stdcall OpenProcess(uint32_t access, int32_t inherit, uint32_t pid)'),
    GetExitCodeProcess: kernel.func('int32_t __stdcall GetExitCodeProcess(uintptr_t process, void *code)'),
    GetProcessTimes: kernel.func('int32_t __stdcall GetProcessTimes(uintptr_t process, void *creation, void *exit, void *kernel, void *user)'),
    K32GetProcessMemoryInfo: kernel.func('int32_t __stdcall K32GetProcessMemoryInfo(uintptr_t process, void *counters, uint32_t size)'),
    CloseHandle: kernel.func('int32_t __stdcall CloseHandle(uintptr_t handle)'),
    GetLastError: kernel.func('uint32_t __stdcall GetLastError()'),
  };
  return nativeCache;
}

const ACCESS_DENIED = 5, NO_MORE_FILES = 18, INVALID_PARAMETER = 87, PARTIAL_COPY = 299;
function winError(operation: string, code: number): Error {
  return Object.assign(new Error(`${operation}: Windows error ${code}`), { code: `WIN32_${code}` });
}
function check(api: WindowsHostNative, result: number, operation: string): void {
  if (!result) throw winError(operation, api.GetLastError());
}
function uint64(buffer: Buffer, offset = 0): number {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Windows byte count exceeds safe integer range');
  return Number(value);
}
function filetimeMs(buffer: Buffer): number {
  const value = buffer.readBigUInt64LE();
  // Divide before converting to retain the sub-ms part without losing precision to the FILETIME epoch.
  const whole = value / 10_000n;
  if (whole > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Windows FILETIME exceeds safe millisecond range');
  return Number(whole) + Number(value % 10_000n) / 10_000;
}
function memoryReading(api: WindowsHostNative): HostReading['memory'] {
  const memory = Buffer.alloc(64); // MEMORYSTATUSEX: two DWORDs followed by seven DWORDLONGs.
  memory.writeUInt32LE(memory.length);
  check(api, api.GlobalMemoryStatusEx(memory), 'GlobalMemoryStatusEx');
  const totalBytes = uint64(memory, 8), availableBytes = uint64(memory, 16);
  if (totalBytes <= 0 || availableBytes > totalBytes) throw new Error('GlobalMemoryStatusEx: invalid physical memory counts');
  return { totalBytes, availableBytes };
}
function processesReading(api: WindowsHostNative, processTime: number): ReadonlyMap<number, ProcessStat> {
  const snapshot = api.CreateToolhelp32Snapshot(2 /* TH32CS_SNAPPROCESS */, 0);
  const invalidHandle = (1n << BigInt(api.pointerBytes * 8)) - 1n;
  if (BigInt(snapshot) === invalidHandle || BigInt(snapshot) === -1n || BigInt(snapshot) === 0n) {
    throw winError('CreateToolhelp32Snapshot', api.GetLastError());
  }
  try {
    const rows = new Map<number, ProcessStat>();
    // PROCESSENTRY32W's ULONG_PTR is aligned after the first three DWORDs.
    const entry = Buffer.alloc(api.pointerBytes === 8 ? 568 : 556);
    const parentOffset = api.pointerBytes === 8 ? 32 : 24;
    const nameOffset = api.pointerBytes === 8 ? 44 : 36;
    entry.writeUInt32LE(entry.length);
    let next = api.Process32FirstW(snapshot, entry);
    for (let count = 0; ; count++) {
      if (!next) {
        const code = api.GetLastError();
        if (code !== NO_MORE_FILES) throw winError('Process32FirstW/Process32NextW', code);
        return rows;
      }
      if (count >= 1_000_000) throw new Error('Toolhelp process enumeration exceeded safety bound');
      const pid = entry.readUInt32LE(8);
      if (pid !== 0) {
        const name = entry.subarray(nameOffset, nameOffset + 520).toString('utf16le');
        const row: ProcessStat = { pid, ppid: entry.readUInt32LE(parentOffset), comm: name.split('\0', 1)[0] ?? '',
          ticks: null, startTime: null, rssBytes: null };
        if (readProcess(api, row, processTime)) rows.set(pid, row);
      }
      entry.writeUInt32LE(entry.length);
      next = api.Process32NextW(snapshot, entry);
    }
  } finally {
    check(api, api.CloseHandle(snapshot), 'CloseHandle(process snapshot)');
  }
}
function readProcess(api: WindowsHostNative, row: ProcessStat, processTime: number): boolean {
  // Current Windows permits both APIs with QUERY_LIMITED_INFORMATION; no VM_READ is needed.
  const handle = api.OpenProcess(0x1000, 0, row.pid);
  if (BigInt(handle) === 0n) {
    const code = api.GetLastError();
    if (code === INVALID_PARAMETER) return false; // PID vanished since the snapshot.
    if (code === ACCESS_DENIED) return true; // Protected process remains visible, with unknown values.
    throw winError(`OpenProcess(${row.pid})`, code);
  }
  try {
    const creation = Buffer.alloc(8), exit = Buffer.alloc(8), kernel = Buffer.alloc(8), user = Buffer.alloc(8);
    if (api.GetProcessTimes(handle, creation, exit, kernel, user)) {
      row.startTime = filetimeMs(creation) - 11_644_473_600_000; // FILETIME epoch (1601) -> Unix epoch ms.
      // A PID could have been reused after the Toolhelp snapshot: its parent/name no longer describe this handle.
      if (row.startTime > processTime) return false;
      row.ticks = filetimeMs(kernel) + filetimeMs(user);
    } else {
      const code = api.GetLastError();
      if (code !== ACCESS_DENIED) throw winError(`GetProcessTimes(${row.pid})`, code);
    }
    const counters = Buffer.alloc(api.pointerBytes === 8 ? 72 : 40); // PROCESS_MEMORY_COUNTERS
    counters.writeUInt32LE(counters.length);
    if (api.K32GetProcessMemoryInfo(handle, counters, counters.length)) {
      const offset = api.pointerBytes === 8 ? 16 : 12; // WorkingSetSize, following PeakWorkingSetSize.
      row.rssBytes = api.pointerBytes === 8 ? uint64(counters, offset) : counters.readUInt32LE(offset);
    } else {
      const code = api.GetLastError();
      // A process may exit while its handle is still open; keep the row, with unknown RSS.
      if (code !== ACCESS_DENIED && code !== PARTIAL_COPY && code !== INVALID_PARAMETER) {
        throw winError(`K32GetProcessMemoryInfo(${row.pid})`, code);
      }
    }
    // GetProcessTimes.exit is undefined for a live process: use its documented liveness API instead.
    const exitCode = Buffer.alloc(4);
    if (api.GetExitCodeProcess(handle, exitCode)) {
      if (exitCode.readUInt32LE() !== 259 /* STILL_ACTIVE */) return false;
    } else {
      const code = api.GetLastError();
      if (code !== ACCESS_DENIED) throw winError(`GetExitCodeProcess(${row.pid})`, code);
    }
    return true;
  } finally {
    check(api, api.CloseHandle(handle), `CloseHandle(process ${row.pid})`);
  }
}

/** Native injection is for SDK-boundary contract tests on hosts without Windows. */
export function windowsHostMeasurement(dataDirectory: string, native?: WindowsHostNative,
  readDisk: (path: string) => { bavail: number; bsize: number; blocks: number } = statfsSync): HostMeasurement {
  const api = native ?? loadNative();
  const cores = api.GetActiveProcessorCount(0xffff /* ALL_PROCESSOR_GROUPS */);
  if (!cores) throw winError('GetActiveProcessorCount', api.GetLastError());
  if (cores > 64) throw new Error('Windows host measurement requires at most 64 logical processors: GetSystemTimes covers only one processor group');
  const memory = memoryReading(api);
  return {
    supported: true,
    facts: { hostname: hostname(), os: `Windows ${release()}`, cores, memoryBytes: memory.totalBytes },
    argv: () => [], // No supported Win32 API reads another process's argv without reading its private memory.
    readGpus: nvidiaGpuReader(Date.now, () => processesReading(api, Date.now())),
    read() {
      const idle = Buffer.alloc(8), kernel = Buffer.alloc(8), user = Buffer.alloc(8);
      check(api, api.GetSystemTimes(idle, kernel, user), 'GetSystemTimes');
      const idleMs = filetimeMs(idle), totalMs = filetimeMs(kernel) + filetimeMs(user);
      if (idleMs > totalMs) throw new Error('GetSystemTimes: idle exceeds total CPU time');
      // Node/libuv supports Windows statfs, including space available under the caller's quota.
      const fs = readDisk(dataDirectory);
      const disk = { freeBytes: fs.bavail * fs.bsize, totalBytes: fs.blocks * fs.bsize };
      if (!Number.isSafeInteger(disk.totalBytes) || !Number.isSafeInteger(disk.freeBytes) ||
        disk.totalBytes <= 0 || disk.freeBytes < 0 || disk.freeBytes > disk.totalBytes) {
        throw new Error('statfs: invalid disk counts');
      }
      const memory = memoryReading(api);
      const processTime = Date.now(); // Immediately before the process snapshot, in the startTime coordinate.
      const processes = processesReading(api, processTime);
      return { cpuTicks: { total: totalMs, idle: idleMs }, processTime, processes,
        memory, disk };
    },
  };
}
