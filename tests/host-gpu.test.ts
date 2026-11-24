import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostSampler } from '@alpacawork/backend/test-dist/host/measure.js';
import { gpuStatus } from '@alpacawork/backend/test-dist/host/gpu-status.js';
import type { HostReading, ProcessStat } from '@alpacawork/core';
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

const facts = { hostname: 'fixture', os: 'fixture', cores: 4, memoryBytes: 1024 * MIB };
const reading: HostReading = {
  processTime: 100, cpuTicks: { total: 1000, idle: 500 },
  memory: { totalBytes: facts.memoryBytes, availableBytes: 512 * MIB },
  disk: { freeBytes: 1024 * MIB, totalBytes: 2048 * MIB }, processes: new Map(),
};

test('each card shows its two largest VRAM users with Run attribution only for the observed PID', async () => {
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
    read: () => reading, readGpus: async () => ({ processes, gpus }), argv: () => ['python3', '/work/fixture.py'] });
  const sample = await sampler.readGpus(() => [{ pid: 10, runId: 'R1', taskId: 'T1', title: 'fixture', role: 'owner', model: null }]);
  assert.deepEqual(sample.map(gpu => gpu.users), [
    [{ name: 'fixture', memoryBytes: 96 * MIB, runId: 'R1', taskId: 'T1' },
      { name: 'outside', memoryBytes: 48 * MIB, runId: null, taskId: null }],
    [{ name: 'original', memoryBytes: MIB, runId: null, taskId: null }],
  ]);
});

test('GPU status waits for one shared probe and retries failures while the last good values are still visible', async () => {
  const gpu = { ...board('GPU-a'), users: null };
  let now = 0, probes = 0;
  const read = gpuStatus(async () => {
    probes++;
    if (probes === 1 || probes === 5) return [gpu];
    if (probes === 2) throw new Error('GPU tool timed out');
    return [];
  }, () => now);
  assert.deepEqual(await Promise.all([read(), read()]), [[gpu], [gpu]]);
  assert.equal(probes, 1);
  now = 9_999;
  assert.deepEqual(await read(), [gpu]);
  assert.equal(probes, 1);
  for (now = 10_000; now < 30_000; now += 10_000) assert.deepEqual(await read(), [gpu]);
  assert.equal(probes, 3);
  assert.deepEqual(await read(), []);
  assert.equal(probes, 4);
  now = 89_999;
  assert.deepEqual(await read(), []);
  assert.equal(probes, 4);
  now = 90_000;
  assert.deepEqual(await read(), [gpu]);
  assert.equal(probes, 5);
});
