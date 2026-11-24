import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsHostMeasurement, type WindowsHostNative } from '../packages/core/dist/platform/windows-host.js';

const FILETIME_EPOCH = 116_444_736_000_000_000n;
function time(out: Buffer, ms: number, epoch = false) {
  out.writeBigUInt64LE(BigInt(Math.round(ms * 10_000)) + (epoch ? FILETIME_EPOCH : 0n));
}
function fixture(pointerBytes: 4 | 8 = 8) {
  const state = { error: 0, cores: 4, closed: [] as number[], opened: [] as number[], rows: [0, 10, 11, 12],
    denied: new Set([11]), gone: new Set([12]), timesDenied: false, memoryDenied: false,
    exited: false, creationMs: 1_700_000_000_000, fail: '', snapshot: 99, enumerationFailure: false, index: -1 };
  const fail = (operation: string) => {
    if (state.fail === operation) { state.error = 123; return true; }
    return false;
  };
  function row(entry: Buffer): number {
    if (state.index >= state.rows.length) { state.error = state.enumerationFailure ? 123 : 18; return 0; }
    assert.equal(entry.readUInt32LE(), pointerBytes === 8 ? 568 : 556);
    const pid = state.rows[state.index]!;
    entry.writeUInt32LE(pid, 8);
    entry.writeUInt32LE(4, pointerBytes === 8 ? 32 : 24);
    entry.fill(0, pointerBytes === 8 ? 44 : 36);
    entry.write(`仕事${pid}.exe\0`, pointerBytes === 8 ? 44 : 36, 'utf16le');
    return 1;
  }
  const native: WindowsHostNative = {
    pointerBytes,
    GetLastError: () => state.error,
    GetActiveProcessorCount(group) { assert.equal(group, 0xffff); return state.cores; },
    GetSystemTimes(idle, kernel, user) {
      if (fail('GetSystemTimes')) return 0;
      time(idle, 100.25); time(kernel, 300.5); time(user, 99.75); return 1;
    },
    GlobalMemoryStatusEx(out) {
      if (fail('GlobalMemoryStatusEx')) return 0;
      assert.equal(out.length, 64); assert.equal(out.readUInt32LE(), 64);
      out.writeBigUInt64LE(16_000_000_000n, 8); out.writeBigUInt64LE(6_000_000_000n, 16);
      // Commit usage must never be misrepresented as physical swap.
      out.writeBigUInt64LE(32_000_000_000n, 24); out.writeBigUInt64LE(11_000_000_000n, 32);
      return 1;
    },
    CreateToolhelp32Snapshot(flags, pid) { assert.equal(flags, 2); assert.equal(pid, 0); return state.snapshot; },
    Process32FirstW(_snapshot, entry) { state.index = 0; return row(entry); },
    Process32NextW(_snapshot, entry) { state.index++; return row(entry); },
    OpenProcess(access, inherit, pid) {
      assert.equal(access, 0x1000); assert.equal(inherit, 0); state.opened.push(pid);
      if (state.denied.has(pid)) { state.error = 5; return 0; }
      if (state.gone.has(pid)) { state.error = 87; return 0; }
      return pid;
    },
    GetExitCodeProcess(_handle, code) {
      if (fail('GetExitCodeProcess')) return 0;
      code.writeUInt32LE(state.exited ? 0 : 259); return 1;
    },
    GetProcessTimes(handle, creation, exit, kernel, user) {
      if (fail('GetProcessTimes')) return 0;
      if (state.timesDenied) { state.error = 5; return 0; }
      assert.equal(handle, 10);
      time(creation, state.creationMs, true);
      time(exit, 987); // Undefined for a live process: a nonzero buffer must not imply exit.
      time(kernel, 10.25); time(user, 5.5); return 1;
    },
    K32GetProcessMemoryInfo(_handle, out, size) {
      if (fail('K32GetProcessMemoryInfo')) return 0;
      if (state.memoryDenied) { state.error = 5; return 0; }
      assert.equal(size, pointerBytes === 8 ? 72 : 40); assert.equal(out.readUInt32LE(), size);
      if (pointerBytes === 8) out.writeBigUInt64LE(5_000_000_000n, 16);
      else out.writeUInt32LE(500_000_000, 12);
      return 1;
    },
    CloseHandle(handle) { state.closed.push(Number(handle)); return fail('CloseHandle') ? 0 : 1; },
  };
  return { native, state };
}
function subject(native: WindowsHostNative) {
  const host = windowsHostMeasurement('C:\\work', native, path => {
    assert.equal(path, 'C:\\work');
    return { bavail: 9_000_000, blocks: 50_000_000, bsize: 1_000 };
  }, () => []);
  assert.equal(host.supported, true);
  if (!host.supported) throw new Error('Expected supported reader');
  return host;
}

test('Windows reader translates 64-bit SDK buffers, units, epoch, quota and protected processes', () => {
  const { native, state } = fixture();
  const host = subject(native);
  const before = Date.now(), reading = host.read();
  assert.deepEqual(reading.cpuTicks, { total: 400.25, idle: 100.25 }); // Kernel already includes idle.
  assert.deepEqual(reading.memory, { totalBytes: 16_000_000_000, availableBytes: 6_000_000_000, swapUsedBytes: null });
  assert.deepEqual(reading.disk, { totalBytes: 50_000_000_000, freeBytes: 9_000_000_000 });
  assert.equal(reading.load, null);
  assert.ok(reading.processTime >= before && reading.processTime <= Date.now());
  assert.equal(host.facts.cores, 4); assert.equal(host.facts.memoryBytes, 16_000_000_000);
  assert.deepEqual(host.argv(10), []);
  assert.deepEqual(reading.processes.get(10), { pid: 10, ppid: 4, comm: '仕事10.exe', ticks: 15.75,
    startTime: 1_700_000_000_000, rssBytes: 5_000_000_000 });
  assert.deepEqual(reading.processes.get(11), { pid: 11, ppid: 4, comm: '仕事11.exe', ticks: null, startTime: null, rssBytes: null });
  assert.equal(reading.processes.has(0), false); assert.equal(reading.processes.has(12), false);
  assert.deepEqual(state.opened, [10, 11, 12]); assert.deepEqual(state.closed, [10, 99]);
});

test('Windows 32-bit pointer layout keeps DWORD and SIZE_T offsets distinct', () => {
  const { native, state } = fixture(4);
  assert.equal(subject(native).read().processes.get(10)?.rssBytes, 500_000_000);
  assert.deepEqual(state.closed, [10, 99]);
});

for (const field of ['timesDenied', 'memoryDenied'] as const) {
  test(`Windows individual ${field} keeps enumerated row and unknown metric`, () => {
    const { native, state } = fixture(); state[field] = true;
    const row = subject(native).read().processes.get(10)!;
    assert.ok(row);
    if (field === 'timesDenied') { assert.equal(row.ticks, null); assert.equal(row.startTime, null); assert.equal(row.rssBytes, 5_000_000_000); }
    else { assert.equal(row.ticks, 15.75); assert.equal(row.rssBytes, null); }
    assert.deepEqual(state.closed, [10, 99]);
  });
}

test('Windows process exit after opening the handle is omitted and both handles close', () => {
  const { native, state } = fixture(); state.exited = true;
  assert.equal(subject(native).read().processes.has(10), false);
  assert.deepEqual(state.closed, [10, 99]);
});

for (const operation of ['GetSystemTimes', 'GlobalMemoryStatusEx', 'GetProcessTimes', 'K32GetProcessMemoryInfo', 'GetExitCodeProcess']) {
  test(`Windows ${operation} fault is explicit and releases acquired handles`, () => {
    const { native, state } = fixture();
    const host = subject(native); state.fail = operation;
    assert.throws(() => host.read(), { code: 'WIN32_123' });
    assert.deepEqual(state.closed, ['GetProcessTimes', 'K32GetProcessMemoryInfo', 'GetExitCodeProcess'].includes(operation) ? [10, 99] : []);
  });
}

test('Windows enumeration failure is a fault, rather than successful incomplete inventory', () => {
  const { native, state } = fixture(); state.enumerationFailure = true;
  assert.throws(() => subject(native).read(), { code: 'WIN32_123' });
  assert.deepEqual(state.closed, [10, 99]);
});

test('Windows empty inventory is valid and snapshot is closed', () => {
  const { native, state } = fixture(); state.rows = [];
  assert.equal(subject(native).read().processes.size, 0); assert.deepEqual(state.closed, [99]);
});

test('Windows INVALID_HANDLE_VALUE is never treated as an owned snapshot', () => {
  const { native, state } = fixture(); state.snapshot = -1; state.error = 5;
  assert.throws(() => subject(native).read(), { code: 'WIN32_5' }); assert.deepEqual(state.closed, []);
});

test('Windows more than 64 logical processors fails explicitly instead of reporting one group as the whole machine', () => {
  const { native, state } = fixture(); state.cores = 128;
  assert.throws(() => subject(native), /at most 64 logical processors/); assert.deepEqual(state.closed, []);
});

test('Windows snapshot cleanup still runs when closing a process handle fails', () => {
  const { native, state } = fixture(); state.fail = 'CloseHandle';
  assert.throws(() => subject(native).read(), { code: 'WIN32_123' });
  assert.deepEqual(state.closed, [10, 99]);
});


test('Windows omits a PID reopened as a new process after the parent/name snapshot', () => {
  const { native, state } = fixture(); state.creationMs = Date.now() + 60_000;
  assert.equal(subject(native).read().processes.has(10), false);
  assert.deepEqual(state.closed, [10, 99]);
});


test('Windows delegates disk measurement to Node statfs and preserves a disk failure', () => {
  const { native, state } = fixture();
  const diskError = Object.assign(new Error('disk access denied'), { code: 'EACCES' });
  const host = windowsHostMeasurement('C:\\work', native, () => { throw diskError; });
  if (!host.supported) throw new Error('Expected supported reader');
  assert.throws(() => host.read(), error => error === diskError);
  assert.deepEqual(state.closed, []);
});
