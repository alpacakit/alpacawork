import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { HostSampler } from '@alpacawork/backend/test-dist/host/measure.js';
import type { HostReading, ProcessStat } from '@alpacawork/core';
import { readAmdGpus } from '../packages/core/dist/platform/amd-gpu.js';
import { pollGpus } from '../packages/core/dist/platform/gpu.js';
import { parseNvidiaGpus, withNvidiaProcesses } from '../packages/core/dist/platform/nvidia-gpu.js';

const MIB = 1024 ** 2;
const board = (id: string) => ({ id, name: 'Fixture GPU', utilization: 12, memory: { usedBytes: 256 * MIB, totalBytes: 1024 * MIB } });

test('NVIDIA CSV reads per-card counters and distinguishes empty compute use from unknown use', () => {
  const gpus = parseNvidiaGpus([
    'GPU-a, Fixture GPU, 12, 256, 1024',
    'GPU-b, Fixture GPU, 0, 0, 1024',
    'GPU-c, "Fixture GPU, Test Edition", [Not Supported], [N/A], 1024',
  ].join('\r\n'));
  assert.deepEqual(gpus[0], { ...board('GPU-a'), processes: null });
  assert.deepEqual(gpus[1]?.memory, { usedBytes: 0, totalBytes: 1024 * MIB });
  assert.deepEqual(gpus[2], { id: 'GPU-c', name: 'Fixture GPU, Test Edition', utilization: null, memory: null, processes: null });

  const withUsers = withNvidiaProcesses(gpus, [
    'GPU-a, 41, 128, /bin/fixture',
    'GPU-c, 41, [N/A], fixture.exe',
    'GPU-a, 41, 32, /bin/fixture',
    String.raw`GPU-a, 42, 16, C:\Tools\fixture.exe`,
  ].join('\r\n'), 100);
  assert.deepEqual(withUsers.map(gpu => gpu.processes), [
    { since: 100, entries: [{ pid: 41, name: 'fixture', memoryBytes: 160 * MIB }, { pid: 42, name: 'fixture.exe', memoryBytes: 16 * MIB }] },
    { since: 100, entries: [] },
    null,
  ]);
});

test('AMD sysfs reads byte counters and skips unrelated cards, connectors and unreadable cards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-amd-'));
  const card = (name: string, values: Record<string, string>) => {
    const device = join(dir, name, 'device');
    mkdirSync(device, { recursive: true });
    for (const [attribute, value] of Object.entries(values)) writeFileSync(join(device, attribute), value + '\n');
  };
  try {
    const metrics = { gpu_busy_percent: '39', mem_info_vram_used: '1234', mem_info_vram_total: '5678' };
    card('card0', { vendor: '0x1002', product_name: 'Fixture Radeon', ...metrics });
    card('card1', { vendor: '0x10de', ...metrics });
    card('card2', { vendor: '0x1002', gpu_busy_percent: '101' });
    card('card3', { vendor: '0x1002', gpu_busy_percent: '0', mem_info_vram_used: '1234' });
    card('card0-DP-1', { vendor: '0x1002', ...metrics });
    assert.deepEqual((await readAmdGpus(dir)).map(gpu => [gpu.name, gpu.utilization, gpu.memory, gpu.processes]), [
      ['Fixture Radeon', 39, { usedBytes: 1234, totalBytes: 5678 }, null],
      ['AMD GPU (card3)', 0, null, null],
    ]);
  } finally { rmSync(dir, { force: true, recursive: true }); }
});

const facts = { hostname: 'fixture', os: 'fixture', cores: 4, memoryBytes: 1024 * MIB };
const reading: HostReading = {
  processTime: 100, cpuTicks: { total: 1000, idle: 500 }, load: null, gpus: [],
  memory: { totalBytes: facts.memoryBytes, availableBytes: 512 * MIB, swapUsedBytes: null },
  disk: { freeBytes: 1024 * MIB, totalBytes: 2048 * MIB }, processes: new Map(),
};

test('each card shows its two largest VRAM users with Run attribution only for the observed PID', () => {
  const process = (pid: number, comm: string, ppid: number, startTime = 10): ProcessStat =>
    ({ pid, comm, ppid, startTime, ticks: 0, rssBytes: 0 });
  const processes = new Map([
    [10, process(10, 'agent', 1)], [11, process(11, 'python3', 10)],
    [20, process(20, 'outside', 1)], [30, process(30, 'reused', 10, 95)],
  ]);
  const gpus = [
    { ...board('GPU-a'), processes: { since: 90, entries: [
      { pid: 20, memoryBytes: 48 * MIB, name: 'fallback' },
      { pid: 10, memoryBytes: 4 * MIB, name: 'fallback' },
      { pid: 11, memoryBytes: 96 * MIB, name: 'fallback' },
    ] } },
    { ...board('GPU-b'), processes: { since: 90, entries: [{ pid: 30, memoryBytes: MIB, name: 'original' }] } },
  ];
  const sampler = new HostSampler({ supported: true, facts,
    read: () => ({ ...reading, processes, gpus }), argv: () => ['python3', '/work/fixture.py'] });
  const sample = sampler.sample([{ pid: 10, runId: 'R1', taskId: 'T1', title: 'fixture', role: 'owner', model: null }]);
  assert.deepEqual(sample.gpus.map(gpu => gpu.users), [
    [{ name: 'fixture', memoryBytes: 96 * MIB, runId: 'R1', taskId: 'T1' },
      { name: 'outside', memoryBytes: 48 * MIB, runId: null, taskId: null }],
    [{ name: 'original', memoryBytes: MIB, runId: null, taskId: null }],
  ]);
});

test('missing, failed and pending probes leave normal host samples available', async () => {
  const pending = new Promise<HostReading['gpus']>(() => {});
  for (const probe of [async () => [], async () => { throw new Error('GPU tool failed'); }, () => pending]) {
    let probes = 0, tick = 0;
    const readGpus = pollGpus(() => { probes++; return probe(); });
    const sampler = new HostSampler({ supported: true, facts, argv: () => [],
      read() {
        tick++;
        return { ...reading, gpus: readGpus(reading.processTime), cpuTicks: { total: 1000 + 100 * tick, idle: 500 + 25 * tick } };
      } });
    assert.deepEqual(sampler.sample([]).gpus, []);
    await setImmediate();
    const next = sampler.sample([]);
    assert.deepEqual(next.gpus, []);
    assert.equal(next.cpu, 75);
    assert.deepEqual(next.memory, reading.memory);
    assert.deepEqual(next.disk, reading.disk);
    await setImmediate();
    assert.equal(probes, 1);
  }
});
