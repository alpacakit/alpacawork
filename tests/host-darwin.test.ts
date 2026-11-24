/** Darwin buffer fixtures execute the real adapter without loading a Darwin library on Linux. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { darwinHostMeasurement, type DarwinHostDependencies, type DarwinHostNative } from '../packages/core/dist/platform/darwin-host.js';

function bsd(pid: number, ppid = 1, usec = 123456): Buffer {
  const bytes = Buffer.alloc(232);
  bytes.writeUInt32LE(pid, 12); bytes.writeUInt32LE(ppid, 16);
  bytes.write('worker', 48);
  bytes.writeBigUInt64LE(1_700_000_000n, 120); bytes.writeBigUInt64LE(BigInt(usec), 128);
  bytes.writeBigUInt64LE(8192n, 144);
  bytes.writeBigUInt64LE(48_000_000n, 152); bytes.writeBigUInt64LE(24_000_000n, 160);
  return bytes;
}
function fixture(options: { pageBytes?: number; numer?: number; denom?: number; pids?: number[]; rows?: Map<number, Buffer> } = {}) {
  let errno = 0;
  const released: number[] = [];
  const calls: string[] = [];
  const pids = options.pids ?? [41];
  const rows = options.rows ?? new Map([[41, bsd(41)]]);
  const native: DarwinHostNative = {
    listPids(type, info, buffer, size) {
      calls.push('list'); assert.equal(type, 1); assert.equal(info, 0);
      if (!buffer) { assert.equal(size, 0); return pids.length * 4; }
      assert.equal(size, buffer.length);
      pids.forEach((pid, index) => buffer.writeInt32LE(pid, index * 4));
      return pids.length * 4;
    },
    pidInfo(pid, flavor, arg, buffer, size) {
      assert.equal(arg, 0); assert.equal(size, buffer.length);
      assert.equal(flavor, 2); assert.equal(size, 232);
      const row = rows.get(pid);
      if (!row) { errno = 3; return 0; }
      row.copy(buffer); return 232;
    },
    sysctl(name, buffer, length) {
      assert.equal(Number(length.readBigUInt64LE()), buffer.length);
      assert.equal(name, 'hw.pagesize'); assert.equal(buffer.length, 4);
      buffer.writeUInt32LE(options.pageBytes ?? 16384);
      return 0;
    },
    timebase(buffer) { assert.equal(buffer.length, 8); buffer.writeUInt32LE(options.numer ?? 125, 0); buffer.writeUInt32LE(options.denom ?? 3, 4); return 0; },
    hostSelf: () => 77,
    hostStatistics(host, flavor, buffer, count) {
      assert.equal(host, 77); assert.equal(flavor, 4); assert.equal(buffer.length, 152); assert.equal(count.readUInt32LE(), 38);
      buffer.writeUInt32LE(100, 0); buffer.writeUInt32LE(200, 8);
      buffer.writeUInt32LE(20, 92); // speculative is a subset of free: adding it would fail the result check.
      buffer.writeUInt32LE(40, 88); // purgeable may overlap and is excluded from this conservative estimate.
      return 0;
    },
    releaseHost(host) { released.push(host); return 0; }, errno: () => errno,
  };
  const deps: DarwinHostDependencies = { native,
    cpuTimes: () => [{ user: 100, nice: 10, sys: 30, idle: 850, irq: 10 }, { user: 200, nice: 0, sys: 20, idle: 770, irq: 10 }],
    memoryBytes: () => 8 * 1024 ** 3,
    disk(path) { assert.equal(path, '/workspace'); return { bavail: 30, blocks: 100, bsize: 4096 }; },
    hostname: () => 'darwin-fixture', release: () => '24.0.0',
    processTime() { calls.push('time'); return 1_700_000_001_000_000; },
  };
  function source() {
    const value = darwinHostMeasurement('/workspace', deps);
    assert.equal(value.supported, true);
    if (!value.supported) throw new Error('unsupported fixture');
    return value;
  }
  return { deps, native, source, released, calls, setErrno: (value: number) => { errno = value; } };
}

test('Darwin translates the LP64 task/BSD ABI, Mach timebase, all-core ms and native page size', () => {
  const f = fixture(), source = f.source(), reading = source.read();
  assert.deepEqual(source.facts, { hostname: 'darwin-fixture', os: 'macOS (Darwin 24.0.0)', cores: 2, memoryBytes: 8 * 1024 ** 3 });
  assert.deepEqual(reading.cpuTicks, { total: 2000, idle: 1620 });
  assert.deepEqual(reading.processes.get(41), { pid: 41, ppid: 1, comm: 'worker', startTime: 1_700_000_000_123_456, ticks: 3000, rssBytes: 8192 });
  assert.deepEqual(reading.memory, { totalBytes: 8 * 1024 ** 3, availableBytes: 300 * 16384 });
  assert.deepEqual(reading.disk, { freeBytes: 30 * 4096, totalBytes: 100 * 4096 });
  assert.equal(reading.processTime, 1_700_000_001_000_000);
  assert.ok(f.calls.indexOf('time') < f.calls.indexOf('list'));
  assert.deepEqual(source.argv(41), []);
  assert.deepEqual(f.released, [77]);
});

test('Darwin x86 timebase and 4KiB pages use the same normalized contract', () => {
  const f = fixture({ numer: 1, denom: 1, pageBytes: 4096 }), reading = f.source().read();
  assert.equal(reading.processes.get(41)?.ticks, 72);
  assert.equal(reading.memory.availableBytes, 300 * 4096);
});

test('Darwin protected task keeps BSD identity and relations while CPU and RSS are unknown', () => {
  const f = fixture();
  f.native.pidInfo = (pid, flavor, _arg, buffer, size) => {
    if (flavor === 2) { f.setErrno(1); return 0; }
    assert.equal(flavor, 3); assert.equal(size, 136);
    bsd(pid, 8).copy(buffer); return 136;
  };
  assert.deepEqual(f.source().read().processes.get(41), { pid: 41, ppid: 8, comm: 'worker', startTime: 1_700_000_000_123_456, ticks: null, rssBytes: null });
});

test('Darwin a fully protected listed process stays present; only exit races are omitted', () => {
  const f = fixture({ pids: [41, 42, 43] });
  f.native.pidInfo = (pid, _flavor, _arg, buffer) => {
    if (pid === 41) { bsd(pid).copy(buffer); return 232; }
    f.setErrno(pid === 42 ? 13 : 3); return 0;
  };
  const processes = f.source().read().processes;
  assert.equal(processes.size, 2);
  assert.deepEqual(processes.get(42), { pid: 42, ppid: 0, comm: '42', startTime: null, ticks: null, rssBytes: null });
  assert.equal(processes.has(43), false);
});

test('Darwin propagates enumeration, unexpected process and truncated native failures with cause', () => {
  for (const fault of ['list', 'process', 'truncated'] as const) {
    const f = fixture();
    if (fault === 'list') f.native.listPids = () => { f.setErrno(5); return 0; };
    else f.native.pidInfo = () => { f.setErrno(5); return fault === 'truncated' ? 16 : 0; };
    assert.throws(() => f.source().read(), error => error instanceof Error && error.message === 'Could not read Darwin host resources' && error.cause instanceof Error);
  }
});

test('Darwin releases the host port when memory statistics fail', () => {
  for (const fault of ['statistics', 'truncated', 'cleanup'] as const) {
    const f = fixture();
    if (fault === 'statistics') f.native.hostStatistics = () => 5;
    if (fault === 'truncated') f.native.hostStatistics = (_host, _flavor, _buffer, count) => { count.writeUInt32LE(2); return 0; };
    if (fault === 'cleanup') f.native.releaseHost = host => { f.released.push(host); return 5; };
    assert.throws(() => f.source().read(), { message: 'Could not read Darwin host resources' });
    assert.deepEqual(f.released, [77]);
  }
});

test('Darwin rejects absent CPU, invalid timebase and unexpected sysctl ABI at initialization', () => {
  for (const fault of ['CPU', 'timebase', 'sysctl'] as const) {
    const f = fixture();
    if (fault === 'CPU') f.deps.cpuTimes = () => [];
    if (fault === 'timebase') f.native.timebase = buffer => { buffer.fill(0); return 0; };
    if (fault === 'sysctl') f.native.sysctl = (_name, _buffer, size) => { size.writeBigUInt64LE(1n); return 0; };
    assert.throws(() => f.source(), error => error instanceof Error && error.message === 'Could not initialize Darwin host measurement' && error.cause instanceof Error);
  }
});

test('Darwin bounds full process buffers instead of silently truncating an unstable list', () => {
  const f = fixture(); let attempts = 0;
  f.native.listPids = (_type, _info, buffer, size) => {
    if (!buffer) return 4;
    attempts++; return size;
  };
  assert.throws(() => f.source().read(), error => error instanceof Error && error.cause instanceof Error && /bounded attempts/.test(error.cause.message));
  assert.equal(attempts, 4);
});

test('Darwin rejects mismatched process identity and memory values outside physical RAM', () => {
  const mismatch = fixture({ rows: new Map([[41, bsd(42)]]) });
  assert.throws(() => mismatch.source().read(), { message: 'Could not read Darwin host resources' });
  const memory = fixture();
  memory.native.hostStatistics = (_host, _flavor, buffer) => { buffer.writeUInt32LE(0xffffffff, 0); return 0; };
  assert.throws(() => memory.source().read(), { message: 'Could not read Darwin host resources' });
  assert.deepEqual(memory.released, [77]);
});
