/** The actual normalized reader -> sampler -> wire/episode path, without an OS in the accounting. */
import { test } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { HostSampler } from '@alpacawork/backend/test-dist/host/measure.js';
import { Pressure } from '@alpacawork/backend/test-dist/host/pressure.js';
import { HostStore } from '@alpacawork/backend/test-dist/host/store.js';
import { hostEpisodeSchema, hostSampleSchema } from '@alpacawork/contract';
import { selectHostMeasurement } from '@alpacawork/core/host-measurement';
import type { HostReading, ProcessStat } from '@alpacawork/core';
import { parseCpuTicks, parseMeminfo, parseProcessStat } from '../packages/core/dist/platform/linux-host.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeWorkspace } from '@alpacawork/backend/test-dist/control/initialize.js';
import { receiverClock } from './helpers/receiver-clock.ts';

const processRow = (pid: number, startTime: number | null, ticks: number | null, ppid = 1, rssBytes: number | null = 100): ProcessStat =>
  ({ pid, ppid, comm: 'worker', startTime, ticks, rssBytes });
const root = { runId: 'R1', taskId: 'T1', title: 'fixture', role: 'owner' as const, model: null, pid: 10 };
function fixture() {
  let reading: HostReading = { processTime: 100, cpuTicks: { total: 1000, idle: 500 },
    memory: { totalBytes: 1000, availableBytes: 500 },
    disk: { freeBytes: 100 * 1024 ** 3, totalBytes: 1000 * 1024 ** 3 }, processes: new Map([[10, processRow(10, 10, 100)]]) };
  const sampler = new HostSampler({ supported: true, facts: { hostname: 'fixture', os: 'fixture', cores: 4, memoryBytes: 1000 },
    argv: () => [], read: () => reading });
  return { sample: () => sampler.sample([root], reading.processTime), next(rows: ProcessStat[], cpu = { total: reading.cpuTicks.total + 100, idle: reading.cpuTicks.idle + 20 }) {
    reading = { ...reading, processTime: reading.processTime + 10, cpuTicks: cpu, processes: new Map(rows.map(row => [row.pid, row])) };
  } };
}

test('newborn CPU is counted, old newly visible CPU is unknown, and recovery takes a fresh baseline', () => {
  const f = fixture();
  assert.equal(f.sample().runs[0]!.cpu, null);
  f.next([processRow(10, 10, 110), processRow(11, 105, 20, 10)]);
  assert.equal(f.sample().runs[0]!.cpu, 30, 'newborn lifetime is inside the measured interval');
  f.next([processRow(10, 10, 120), processRow(11, 105, 30, 10), processRow(12, 50, 5000, 10)]);
  assert.equal(f.sample().runs[0]!.cpu, null, 'old newly visible lifetime must not be attributed to this interval');
  f.next([processRow(10, 10, 130), processRow(11, 105, 40, 10), processRow(12, 50, 5010, 10)]);
  assert.equal(f.sample().runs[0]!.cpu, 30);
  f.next([processRow(10, 10, null, 1, null)]);
  const missing = f.sample().runs[0]!;
  assert.equal(missing.cpu, null); assert.equal(missing.memoryBytes, null);
  f.next([processRow(10, 10, 10000)]);
  assert.equal(f.sample().runs[0]!.cpu, null, 'a recovered counter cannot reuse its lifetime as interval CPU');
  f.next([processRow(10, 10, 10010)]);
  assert.equal(f.sample().runs[0]!.cpu, 10);
});

test('reused parents, unknown identities and reused Run roots never acquire unrelated processes', () => {
  const f = fixture(); f.sample();
  f.next([processRow(10, 10, 110), processRow(11, 105, 20, 10), processRow(12, 5, 50, 11), processRow(13, null, 20, 10)]);
  assert.equal(f.sample().runs[0]!.processes, 2, 'a child predating its current parent and unidentified child are excluded');
  f.next([processRow(10, 115, 10), processRow(14, 116, 10, 10)]);
  const { pid: _pid, ...identity } = root;
  assert.deepEqual(f.sample().runs[0], { ...identity, cpu: null, memoryBytes: null, processes: 0, heaviest: null });
});

test('counter rollback produces an unknown interval and then recovers', () => {
  const f = fixture(); f.sample();
  f.next([processRow(10, 10, 110)], { total: 500, idle: 200 });
  const reset = f.sample(); assert.equal(reset.cpu, null); assert.equal(reset.runs[0]!.cpu, null);
  f.next([processRow(10, 10, 120)], { total: 600, idle: 250 });
  const good = f.sample(); assert.equal(good.cpu, 50); assert.equal(good.runs[0]!.cpu, 10);
});

test('Linux parsers detect missing host counters and unsupported platforms remain unavailable', () => {
  assert.throws(() => parseCpuTicks('cpu 1 2 bad'), /Invalid/);
  assert.throws(() => parseMeminfo('MemTotal: 1000 kB\n'), /Missing/);
  assert.equal(parseProcessStat('2 (worker) S 1'), null);
  const fields = Array.from({ length: 22 }, () => '0');
  fields[1] = '1'; fields[11] = '3'; fields[12] = '2'; fields[19] = '5'; fields[21] = '2';
  assert.equal(parseProcessStat(`10 (worker) ${fields.join(' ')}`, 16384)!.rssBytes, 32768);
  assert.deepEqual(selectHostMeasurement('not-an-os')('unused'), { supported: false, platform: 'not-an-os' });
});

test('unknown Run peaks survive a real episode store, resume and later known observations', async () => {
  const area = mkdtempSync(join(tmpdir(), 'host-gaps-'));
  await initializeWorkspace(area);
  const f = fixture(), pressure = new Pressure();
  const load = f.sample().runs[0]!;
  const episode = pressure.observe(1000, { cpu: 95, memoryFreePercent: 50, diskFreeBytes: 1 }, [{ ...load, memoryBytes: null }])!;
  assert.equal(episode.runs[0]!.cpuPeak, null); assert.equal(episode.runs[0]!.memoryPeakBytes, null);
  let store = new HostStore(area);
  try {
    const id = store.saveEpisode(null, episode, 1000);
    store.close(); store = new HostStore(area);
    const saved = store.lastOpen()!.episode;
    assert.equal(hostEpisodeSchema.parse(saved).runs[0]!.cpuPeak, null);
    pressure.resume(saved);
    pressure.observe(2000, { cpu: 95, memoryFreePercent: 50, diskFreeBytes: 1 }, [{ ...load, cpu: 12, memoryBytes: 200 }]);
    store.saveEpisode(id, pressure.current!, 2000);
    assert.equal(store.episode(id)!.runs[0]!.cpuPeak, 12);
    assert.equal(store.episode(id)!.runs[0]!.memoryPeakBytes, 200);
  } finally { store.close(); rmSync(area, { recursive: true, force: true }); }
});

test('selected Linux source measures a real busy child and resident memory in machine CPU units', { skip: process.platform !== 'linux', timeout: 15_000 }, async () => {
  const { spawn } = await import('node:child_process');
  const { createHostSource } = await import('@alpacawork/backend/test-dist/host/measure.js');
  const child = spawn(process.execPath, ['-e', `const memory = Buffer.alloc(96 * 1024 ** 2, 1); console.log('ready'); for (;;) { Math.sqrt(Math.random()); if (memory[0] !== 1) process.exit(1); }`],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const stopped = once(child, 'exit');
  try {
    await once(child.stdout!, 'data');
    const source = createHostSource(tmpdir()); assert.ok(source.supported);
    const roots = [{ ...root, pid: child.pid! }];
    source.sample(roots, Date.now());
    await new Promise(resolve => setTimeout(resolve, 750));
    const sample = source.sample(roots, Date.now());
    const run = sample.runs[0]!;
    assert.ok(run.cpu !== null && run.cpu > 0 && run.cpu < 90, `whole-machine CPU share: ${run.cpu}`);
    assert.ok(run.memoryBytes !== null && run.memoryBytes >= 80 * 1024 ** 2, `resident bytes: ${run.memoryBytes}`);
    assert.equal(run.processes, 1);
    hostSampleSchema.parse(sample);
  } finally { child.kill('SIGKILL'); await stopped; }
});

test('adapter initialization failure enters the monitor error path and its next tick can recover real facts', async () => {
  const { createHostSource } = await import('@alpacawork/backend/test-dist/host/measure.js');
  const { HostMonitor } = await import('@alpacawork/backend/test-dist/host/monitor.js');
  const { hostStatusSchema } = await import('@alpacawork/contract');
  const area = mkdtempSync(join(tmpdir(), 'host-init-fault-'));
  await initializeWorkspace(area);
  let attempts = 0;
  const facts = { hostname: 'real-fixture', os: 'fixture', cores: 4, memoryBytes: 1000 };
  const source = createHostSource(area, () => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('native initialization denied'), { code: 'EACCES' });
    return { supported: true, facts, argv: () => [], read: () => ({ processTime: 100,
      cpuTicks: { total: 1000, idle: 500 }, memory: { totalBytes: 1000, availableBytes: 500 },
      processes: new Map(), disk: { freeBytes: 100 * 1024 ** 3, totalBytes: 1000 * 1024 ** 3 } }) };
  });
  const monitor = new HostMonitor({ root: area, source, runs: () => [], parallel: () => null, noticeChanged: () => {}, episodeStarted: () => {} });
  try {
    monitor.tick(1000);
    const failed = hostStatusSchema.parse(await monitor.status()); assert.ok(failed.supported);
    assert.equal(failed.facts, null); assert.equal(failed.sample, null);
    assert.match(failed.error!.message, /initialization denied/); assert.equal(attempts, 1);
    monitor.tick(11000);
    const recovered = hostStatusSchema.parse(await monitor.status()); assert.ok(recovered.supported);
    assert.deepEqual(recovered.facts, facts); assert.ok(recovered.sample); assert.equal(recovered.error, null);
    assert.equal(attempts, 2);
  } finally { monitor.close(); rmSync(area, { recursive: true, force: true }); }
});

test('real host API remains available during native initialization failure and publishes recovered facts', { timeout: 20_000 }, async t => {
  const clock = receiverClock(t);
  const { createHostSource } = await import('@alpacawork/backend/test-dist/host/measure.js');
  const { startServer } = await import('@alpacawork/backend/test-dist/receiver/server.js');
  const { hostStatusSchema } = await import('@alpacawork/contract');
  const area = mkdtempSync(join(tmpdir(), 'host-init-api-'));
  await initializeWorkspace(area);
  let attempts = 0;
  const facts = { hostname: 'recovered-host', os: 'native fixture', cores: 4, memoryBytes: 1000 };
  const source = createHostSource(area, () => {
    if (++attempts === 1) throw new Error('Could not initialize Darwin host measurement', { cause: new Error('native symbol unavailable') });
    return { supported: true, facts, argv: () => [], read: () => ({ processTime: 100,
      cpuTicks: { total: 1000, idle: 500 }, memory: { totalBytes: 1000, availableBytes: 500 },
      processes: new Map(), disk: { freeBytes: 100 * 1024 ** 3, totalBytes: 1000 * 1024 ** 3 } }) };
  });
  const app = await startServer(area, 0, { hostSource: source });
  const read = async () => {
    const response = await fetch(new URL('api/host/status', app.url)); assert.equal(response.status, 200);
    const body = hostStatusSchema.parse(await response.json()); assert.ok(body.supported); return body;
  };
  try {
    const initial = await read(); assert.equal(initial.facts, null); assert.equal(initial.sample, null);
    assert.match(initial.error!.message, /initialize Darwin/); assert.equal(attempts, 1);
    await clock.advance(10_000); // the monitor's interval
    const recovered = await read();
    assert.ok(recovered.sample); assert.deepEqual(recovered.facts, facts); assert.equal(recovered.error, null);
    assert.equal(attempts, 2);
  } finally { await app.close(); rmSync(area, { recursive: true, force: true }); }
});
