/** Host status: /proc parsing, readable command names, Run weights, tight episodes, their record, push and route. */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostStatusSchema, type HostNotice, type HostSampleDTO } from '@alpacawork/contract';
import { commandName, HostSampler, createHostSource, weigh, type HostSource, type ProcessStat } from '@alpacawork/backend/test-dist/host/measure.js';
import { platform, type HostReading } from '@alpacawork/core';
import { linuxAdapter } from '../packages/core/dist/platform/linux.js';
import { parseCpuTicks, parseMeminfo, parseProcessStat } from '../packages/core/dist/platform/linux-host.js';
import { Pressure } from '@alpacawork/backend/test-dist/host/pressure.js';
import { HostMonitor } from '@alpacawork/backend/test-dist/host/monitor.js';
import { hostPushEvent } from '@alpacawork/backend/test-dist/host/alert.js';
import { HostStore } from '@alpacawork/backend/test-dist/host/store.js';
import { PushStore } from '@alpacawork/backend/test-dist/receiver/push.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { initializeWorkspace } from '@alpacawork/backend/test-dist/control/initialize.js';

const GB = 1024 ** 3;
const facts = { hostname: 'fixture-host', os: 'fixture OS', cores: 4, memoryBytes: 100 * GB };
const source = (sample: Extract<HostSource, { supported: true }>['sample']): Extract<HostSource, { supported: true }> =>
  ({ supported: true, facts, sample });


test('/proc readers take the fields the host status shows', () => {
  assert.deepEqual(parseCpuTicks('cpu  100 5 50 800 20 1 2 3 7 0\ncpu0 1 1 1 1\n'), { total: 981, idle: 820 });
  assert.deepEqual(parseMeminfo('MemTotal:       1000 kB\nMemFree:  10 kB\nMemAvailable:    250 kB\n'),
    { totalBytes: 1000 * 1024, availableBytes: 250 * 1024 });
  const fields = Array.from({ length: 50 }, (_, index) => String(index + 3));
  fields[4 - 3] = '77'; fields[14 - 3] = '30'; fields[15 - 3] = '12'; fields[22 - 3] = '555'; fields[24 - 3] = '10';
  assert.deepEqual(parseProcessStat(`4242 (Web (Content) x) ${fields.join(' ')}`),
    { pid: 4242, ppid: 77, comm: 'Web (Content) x', ticks: 42, startTime: 555, rssBytes: 40960 });
});

test('a command is named by what an interpreter or runner runs', () => {
  assert.equal(commandName('claude', ['claude', '-p']), 'claude');
  assert.equal(commandName('MainThread', ['node', '/w/node_modules/vitest/dist/workers/forks.js']), 'vitest');
  assert.equal(commandName('node', ['node', '/w/node_modules/@playwright/test/cli.js', 'test']), 'playwright');
  assert.equal(commandName('node', ['node', '/w/node_modules/.bin/../vitest/vitest.mjs', 'run']), 'vitest');
  assert.equal(commandName('node', ['node', '/home/u/.local/pnpm/pnpm.cjs', '--filter', 'x', 'build']), 'pnpm build');
  assert.equal(commandName('node', ['node', 'scripts/testing/queue.ts', 'web']), 'queue');
  assert.equal(commandName('MainThread', ['node']), 'node');
  assert.equal(commandName('openclaw-gatewa', [], '/usr/bin/openclaw-gateway'), 'openclaw-gateway');
  assert.equal(commandName('chrome-headless', [], '/opt/x/chrome-headless-shell'), 'chrome-headless-shell');
});

test('long names use the executable or a plain argv path without showing process-title arguments', () => {
  const executable = '/opt/Browser Builds/chrome-headless-shell Preview';
  const argv = [`${executable} --type=renderer --user-data-dir=/tmp/chrome-headless-profile`];
  assert.equal(commandName('chrome-headless', argv, `${executable} (deleted)`), 'chrome-headless-shell Preview');
  assert.equal(commandName('chrome-headless', argv), 'chrome-headless');
  assert.equal(commandName('systemd-journal', ['/usr/lib/System Services/systemd-journald']), 'systemd-journald');
});

test('a Run weighs its whole tree and names its heaviest command with a count', () => {
  const process = (pid: number, rssBytes: number): ProcessStat => ({ pid, ppid: 1, comm: 'x', ticks: 0, startTime: 0, rssBytes });
  const tree = [process(1, 300), process(2, 100), process(3, 100), process(4, 100)];
  const names = new Map([[1, 'claude'], [2, 'vitest'], [3, 'vitest'], [4, 'esbuild']]);
  const share = new Map([[1, 1], [2, 20], [3, 15], [4, 2]]);
  assert.deepEqual(weigh(tree, share, entry => names.get(entry.pid)!),
    { cpu: 38, memoryBytes: 600, processes: 4, heaviest: { name: 'vitest', count: 2 } });
});

const run = (cpu: number, taskId = 'T1', role: 'owner' | 'worker' = 'owner') => ({ runId: `R${taskId.slice(1)}${role === 'worker' ? 9 : 0}`, taskId,
  title: 'tests', model: 'opus', role, cpu, memoryBytes: GB, processes: 5, heaviest: { name: 'vitest', count: 4 } });
const at = (seconds: number) => seconds * 1000;

test('a tight stretch starts after its hold, stays through a dip, and ends after the calm hold', () => {
  const pressure = new Pressure();
  const calm = { memoryFreePercent: 50, diskFreeBytes: 500 * GB };
  for (let s = 0; s < 120; s += 10) assert.equal(pressure.observe(at(s), { cpu: 95, ...calm }, [run(40)]), null);
  const episode = pressure.observe(at(120), { cpu: 97, ...calm }, [run(40)]);
  assert.ok(episode);
  assert.equal(episode.start, at(120));
  pressure.observe(at(130), { cpu: 80, ...calm }, []); // between the lines: still tight
  for (let s = 140; s < 260; s += 10) assert.equal(pressure.observe(at(s), { cpu: 50, ...calm }, [])?.end, null);
  assert.equal(pressure.observe(at(260), { cpu: 50, ...calm }, [])?.end, at(260), 'the call that ends it returns it');
  assert.equal(pressure.current, null);
  assert.deepEqual({ ...episode, runs: episode.runs.map(item => item.heaviest) },
    { start: at(120), end: at(260), kinds: ['cpu'], peak: { cpu: 97, ...calm }, runs: ['vitest ×4'] });
});

test('the push names what was tight, for how long, and the heaviest Tasks once each', () => {
  const sample: HostSampleDTO = { at: 0, cpu: 98, memory: { totalBytes: 100 * GB, availableBytes: 40 * GB },
    disk: { freeBytes: 400 * GB, totalBytes: 900 * GB }, gpus: [], runs: [run(10, 'T2'), run(30, 'T1'), run(5, 'T1', 'worker'), run(20, 'T3'), run(1, 'T4')],
    outside: { cpu: 1, memoryBytes: GB, names: [] } };
  const event = hostPushEvent({ start: Date.parse('2026-10-15T00:00:00Z'), end: null, kinds: ['cpu'], peak: { cpu: 98, memoryFreePercent: 40, diskFreeBytes: 400 * GB }, runs: [] }, sample, 'ja');
  const { body, url, tag } = event.payload;
  assert.match(body, /CPU 98%.*2分/);
  assert.deepEqual(body.match(/\bT\d+\b/g), ['T1', 'T3', 'T2']);
  assert.match(body, /Run 5件/);
  assert.deepEqual({ url, tag }, { url: '/?settings=host', tag: `host:${Date.parse('2026-10-15T00:00:00Z')}` });
});

describe('the monitor and its record', () => {
  let area: string, root: string;
  beforeEach(async () => {
    area = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-host-')));
    root = join(area, 'root'); mkdirSync(root, { mode: 0o700 });
    await initializeWorkspace(root);
  });
  afterEach(() => rmSync(area, { recursive: true, force: true }));

  const sampleAt = (now: number, cpu: number): HostSampleDTO => ({ at: now, cpu,
    memory: { totalBytes: 100 * GB, availableBytes: 60 * GB },
    disk: { freeBytes: 400 * GB, totalBytes: 900 * GB }, gpus: [], runs: cpu > 50 ? [run(cpu - 10)] : [], outside: { cpu: 1, memoryBytes: GB, names: ['Xorg'] } });

  test('disk warns below 50 GB and stays tight until 55 GB without repeated starts', async () => {
    let freeBytes = 50 * GB;
    const started: number[] = [];
    const monitor = new HostMonitor({ root, runs: () => [], parallel: () => 12,
      noticeChanged: () => {}, episodeStarted: episode => started.push(episode.start),
      source: source((_runs, now) => ({ ...sampleAt(now, 20), disk: { freeBytes, totalBytes: 900 * GB } })) });
    const base = Date.parse('2026-10-15T00:00:00Z');
    try {
      monitor.tick(base);
      const status = hostStatusSchema.parse(await monitor.status(base));
      assert.ok(status.supported);
      assert.equal(status.limits.diskFreeBytes, 50 * GB, 'the displayed limit uses the warning threshold');
      assert.equal(monitor.notice(), null, 'exactly 50 GB does not start a warning');
      freeBytes = 50 * GB - 1;
      monitor.tick(base + at(10));
      assert.deepEqual(monitor.notice()?.kinds, ['disk'], 'one byte below 50 GB starts immediately');
      for (const [index, bytes] of [50 * GB, 40 * GB, 55 * GB - 1, 49 * GB].entries()) {
        freeBytes = bytes;
        monitor.tick(base + at(20 + index * 10));
        assert.deepEqual(monitor.notice()?.kinds, ['disk'], 'the warning stays active below 55 GB');
      }
      assert.deepEqual(started, [base + at(10)], 'crossing 50 GB again does not start another push');
      freeBytes = 55 * GB;
      monitor.tick(base + at(60));
      assert.equal(monitor.notice(), null, 'exactly 55 GB clears immediately');
      freeBytes = 50 * GB;
      monitor.tick(base + at(70));
      assert.equal(monitor.notice(), null);
      freeBytes = 40 * GB;
      monitor.tick(base + at(80));
      assert.deepEqual(monitor.notice()?.kinds, ['disk']);
      assert.deepEqual(started, [base + at(10), base + at(80)], 'a later disk shortage starts a new episode');
    } finally { monitor.close(); }
  });

  test('tells the index while tight, starts one push per episode, and keeps the episode and its minutes', async () => {
    const cpu = new Map<number, number>();
    const notices: (HostNotice | null)[] = [], started: number[] = [], held: (number | null)[] = [];
    const base = Date.parse('2026-10-15T00:00:00Z');
    const monitor = new HostMonitor({ root, runs: () => [], parallel: () => 12,
      noticeChanged: notice => notices.push(notice), episodeStarted: episode => started.push(episode.start),
      episodeHeld: start => held.push(start), source: source((_runs, now) => sampleAt(now, cpu.get(now) ?? 20)) });
    try {
      for (let s = 0; s <= 600; s += 10) {
        cpu.set(base + at(s), s >= 60 && s < 300 ? 96 : 20);
        monitor.tick(base + at(s));
      }
      assert.deepEqual(started, [base + at(180)], 'one start, after two minutes over the line');
      assert.deepEqual(held, [base + at(180), null]);
      assert.equal(notices.at(-1), null, 'the banner goes once it is calm');
      assert.ok(notices.length >= 3, 'the banner is refreshed at least once a minute while tight');
      const status = hostStatusSchema.parse(await monitor.status(base + at(600)));
      assert.ok(status.supported);
      assert.equal(status.current, null);
      assert.equal(status.parallel, 12);
      assert.deepEqual(status.facts, facts, 'facts come from the same substituted source');
      assert.equal(status.episodes.length, 1);
      assert.deepEqual([status.episodes[0]!.start, status.episodes[0]!.end, status.episodes[0]!.kinds], [base + at(180), base + at(420), ['cpu']]);
      assert.deepEqual(status.episodes[0]!.runs.map(item => [item.taskId, item.cpuPeak]), [['T1', 86]]);
      const minutes = monitor.episodeMinutes(status.episodes[0]!.id, base + at(600));
      assert.ok(minutes && minutes.minutes.some(row => row.cpuMax === 96));
    } finally { monitor.close(); }
  });

  test('a host push goes out while its episode is tight and is closed unsent once it is not', async () => {
    const sent: string[] = [];
    const store = await PushStore.open(root, { subject: 'https://localhost', sender: async (_device, payload) => { sent.push(payload.tag); return { status: 201 }; } });
    await store.subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/device-one', expirationTime: null,
      keys: { p256dh: 'BAAeFXiNM4nLLiGrGmHlXrcRxEiganHmMidSakDxHs8vMYDqt4vtd9nqOGW6MAH9rzXsFSETkMJd06dq3yX_kc8', auth: 'UUALvnVwjZoGLy-BHN4_LA' } }, 'Phone');
    const now = Date.now();
    const episode = (start: number) => ({ start, end: null, kinds: ['cpu' as const], peak: { cpu: 98, memoryFreePercent: 60, diskFreeBytes: 400 * GB }, runs: [] });
    const tight = hostPushEvent(episode(now - 1000), sampleAt(now, 98), 'en');
    await store.record(tight, now);
    store.holdHost(tight.key);
    await store.tick(now);
    const over = hostPushEvent(episode(now - 500), sampleAt(now, 98), 'en');
    await store.record(over, now + 1);
    store.holdHost(null);
    await store.tick(now + 1);
    await store.close();
    assert.deepEqual(sent, [tight.key]);
  });

  test('an episode left open by a stopped server ends at its last sample', () => {
    const store = new HostStore(root);
    const id = store.saveEpisode(null, { start: 1000, end: null, kinds: ['memory'],
      peak: { cpu: 10, memoryFreePercent: 5, diskFreeBytes: GB * 100 }, runs: [] }, 5000);
    store.closeOpen(null);
    assert.equal(store.episode(id)?.end, 5000);
    store.close();
  });

  test('a restart while tight continues the open episode without a second push', async () => {
    const base = Date.parse('2026-10-15T00:00:00Z');
    const store = new HostStore(root);
    const id = store.saveEpisode(null, { start: base, end: null, kinds: ['cpu'], peak: { cpu: 97, memoryFreePercent: 60, diskFreeBytes: 400 * GB }, runs: [] }, base + at(50));
    const stale = store.saveEpisode(null, { start: base - 86_400_000, end: null, kinds: ['cpu'], peak: { cpu: 97, memoryFreePercent: 60, diskFreeBytes: 400 * GB }, runs: [] }, base - 86_000_000);
    store.close();
    const started: number[] = [], held: (number | null)[] = [];
    const monitor = new HostMonitor({ root, runs: () => [], parallel: () => null, noticeChanged: () => {},
      episodeStarted: episode => started.push(episode.start), episodeHeld: start => held.push(start), source: source((_runs, now) => sampleAt(now, 96)) });
    try {
      monitor.tick(base + at(60));
      const status = hostStatusSchema.parse(await monitor.status(base + at(60)));
      assert.ok(status.supported);
      assert.deepEqual([status.current?.id, status.current?.start], [id, base]);
      assert.deepEqual(started, []);
      assert.deepEqual(held, [base]);
      assert.equal(status.episodes.find(item => item.id === stale)?.end, base - 86_000_000, 'an older open episode is ended');
    } finally { monitor.close(); }
  });
});

const gpus: HostSampleDTO['gpus'] = [
  { id: 'GPU-a', name: 'Fixture GPU', utilization: 100, memory: { usedBytes: GB, totalBytes: 4 * GB }, users: [] },
  { id: 'GPU-b', name: 'Fixture GPU', utilization: null, memory: null, users: null },
];
for (const platform of [null, 'darwin', 'win32']) {
  test(`GET /api/host/status uses the supplied ${platform ?? 'measured'} source`, async () => {
    let probes = 0;
    const hostSource: HostSource = platform ? { supported: false, platform } : {
      ...source((_runs, now) => ({ at: now, cpu: 20,
        memory: { totalBytes: 100 * GB, availableBytes: 60 * GB },
        disk: { freeBytes: 400 * GB, totalBytes: 900 * GB }, gpus: [], runs: [], outside: { cpu: 0, memoryBytes: 0, names: [] } })),
      readGpus: async () => { probes++; return gpus; },
    };
    const area = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-host-route-')));
    const root = join(area, 'root'); mkdirSync(root, { mode: 0o700 });
    await initializeWorkspace(root);
    const app = await startServer(root, 0, { hostSource });
    try {
      assert.equal(probes, 0, 'starting the monitor does not probe the GPU');
      const response = await fetch(new URL('api/host/status', app.url));
      assert.equal(response.status, 200);
      const status = hostStatusSchema.parse(await response.json());
      if (hostSource.supported) {
        assert.ok(status.supported && status.sample, 'serve starts sampling');
        assert.deepEqual(status.facts, facts);
        assert.equal(status.sample.cpu, 20);
        assert.deepEqual(status.sample.gpus, gpus);
        assert.equal(probes, 1);
        assert.equal(status.current, null);
      } else assert.deepEqual(status, hostSource);
    } finally { await app.close(); rmSync(area, { recursive: true, force: true }); }
  });
}

test('an unsupported source never samples, records, or notifies', async () => {
  const name = 'darwin';
  const area = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-host-unsupported-')));
  const root = join(area, 'no-workspace');
  let work = 0;
  const unexpected = (): never => { work++; assert.fail('unsupported monitoring must do no work'); };
  const monitor = new HostMonitor({ root, source: { supported: false, platform: name },
    runs: unexpected, parallel: unexpected, noticeChanged: unexpected, episodeStarted: unexpected, episodeHeld: unexpected });
  try {
    monitor.start(); monitor.tick();
    assert.deepEqual(hostStatusSchema.parse(await monitor.status()), { supported: false, platform: name });
    assert.equal(monitor.episodeMinutes(1), null);
    assert.equal(monitor.notice(), null);
    assert.equal(existsSync(root), false);
    assert.equal(work, 0, 'including failures caught by the monitor');
  } finally { monitor.close(); rmSync(area, { recursive: true, force: true }); }
});

test('normalized readings give CPU deltas, whole Run trees, and PID reuse on every OS', () => {
  let reading: HostReading = { processTime: 2, cpuTicks: { total: 1000, idle: 800 },
    processes: new Map([[10, { pid: 10, ppid: 1, comm: 'agent', ticks: 30, startTime: 1, rssBytes: 100 }]]),
    memory: { totalBytes: 1000, availableBytes: 500 }, disk: { freeBytes: 400, totalBytes: 900 } };
  const sampler = new HostSampler({ supported: true, facts, read: () => reading, argv: () => ['node', '/w/check.js'] });
  const roots = [{ runId: 'R1', taskId: 'T1', title: 'test', role: 'owner' as const, model: null, pid: 10 }];
  assert.equal(sampler.sample(roots, 0).cpu, null);
  reading = { ...reading, processTime: 3, cpuTicks: { total: 1100, idle: 820 }, processes: new Map([
    [10, { pid: 10, ppid: 1, comm: 'agent', ticks: 40, startTime: 1, rssBytes: 100 }],
    [11, { pid: 11, ppid: 10, comm: 'node', ticks: 20, startTime: 2, rssBytes: 200 }],
    [12, { pid: 12, ppid: 1, comm: 'other', ticks: 5, startTime: 3, rssBytes: 300 }],
  ]) };
  const sample = sampler.sample(roots, 10_000);
  assert.equal(sample.cpu, 80);
  assert.deepEqual(sample.runs[0], { runId: 'R1', taskId: 'T1', title: 'test', role: 'owner', model: null, cpu: 30, memoryBytes: 300, processes: 2, heaviest: { name: 'check', count: 1 } });
  assert.deepEqual(sample.outside, { cpu: 5, memoryBytes: 300, names: ['other'] });
  assert.deepEqual([sample.memory, sample.disk], [reading.memory, reading.disk]);
  reading = { ...reading, processTime: 4, cpuTicks: { total: 1200, idle: 900 }, processes: new Map([
    [10, { pid: 10, ppid: 1, comm: 'node', ticks: 7, startTime: 4, rssBytes: 50 }],
  ]) };
  assert.deepEqual(sampler.sample(roots, 20_000).runs[0], { runId: 'R1', taskId: 'T1', title: 'test', role: 'owner', model: null,
    cpu: null, memoryBytes: null, processes: 0, heaviest: null });
});

// Only the real /proc integration belongs to Linux; all monitoring/API scenarios above run on every host.
if (platform === linuxAdapter) test('the selected Linux source reads /proc and the workspace filesystem', () => {
  const source = createHostSource(tmpdir());
  assert.ok(source.supported);
  assert.ok(source.facts.cores > 0 && source.facts.memoryBytes > 0);
  const sample = source.sample([], Date.now());
  assert.equal(sample.cpu, null);
  assert.ok(sample.memory.totalBytes > 0 && sample.memory.availableBytes > 0 && sample.disk.totalBytes > 0);
  assert.ok(sample.outside.memoryBytes > 0);
});

test('a host sampling fault keeps operation, OS code, syscall and path in the public error', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'host-fault-')));
  const cause = Object.assign(new Error("ENOENT: no such file or directory, open '/proc/test'"),
    { code: 'ENOENT', syscall: 'open', path: '/proc/test' });
  const monitor = new HostMonitor({ root, runs: () => [], parallel: () => null, noticeChanged: () => {}, episodeStarted: () => {},
    source: { supported: true, facts: { hostname: 'test', os: 'Linux', cores: 1, memoryBytes: 100 }, sample: () => { throw cause; } } });
  try {
    monitor.tick(1000);
    const status = hostStatusSchema.parse(await monitor.status(1000));
    assert.equal(status.supported, true);
    if (!status.supported) return;
    assert.deepEqual(status.error?.reason, { kind: 'host_failure', operation: 'sample',
      cause: { kind: 'system_error', code: 'ENOENT', syscall: 'open', path: '/proc/test', diagnostic: cause.message } });
    assert.equal(status.error?.message, cause.message);
  } finally { monitor.close(); rmSync(root, { recursive: true, force: true }); }
});
