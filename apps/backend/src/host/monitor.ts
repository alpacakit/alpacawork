/**
 * The serve's view of this machine: one sample every 10 s, the last hour in memory, tight episodes and minute values
 * in the host record. It publishes pressure samples, the small tight state for the index, and one push per episode.
 * A failing record never stops the sampling.
 */
import type { HostEpisodeMinutes, HostKind, HostNotice, HostStatus } from '@alpacawork/contract';
import { failure, errorBody, faultReason, Problem, PROBLEM_CODE, type ProblemReason } from '@alpacawork/core';
import { createHostSource, type HostSource, type HostSample, type RunLoad, type RunRoot } from './measure.js';
import { gpuStatus } from './gpu-status.js';
import { PRESSURE_LIMITS, Pressure } from './pressure.js';
import { EPISODE_RETENTION_MS, HostStore, type EpisodeDraft, type MinuteRow } from './store.js';

/** A failure as `status` shows it: its operation, and the cause's message after `prefix`. */
const hostFailure = (prefix: string, operation: Extract<ProblemReason, { kind: 'host_failure' }>['operation'], cause: unknown) =>
  errorBody(new Problem(PROBLEM_CODE.unavailable, `${prefix}${failure(cause).message}`, undefined,
    { reason: { kind: 'host_failure', operation, cause: faultReason(cause) } })).error;

const HOST_INTERVAL_MS = 10_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
/** Minutes shown around an episode on its line. */
const EPISODE_MARGIN_MS = 10 * MINUTE_MS;
/** A restart within this of the last sample (a release, a crash) continues the open episode instead of starting another. */
const RESUME_WINDOW_MS = 5 * MINUTE_MS;

export interface HostPressureObservation {
  at: number;
  episodeStart: number | null;
  kinds: readonly HostKind[];
  entered: readonly HostKind[];
  cpu: number | null;
  memoryFreePercent: number;
  diskFreeBytes: number;
  runs: readonly Pick<RunLoad, 'runId' | 'taskId' | 'cpu' | 'memoryBytes'>[];
}

interface HostMonitorOptions {
  root: string;
  /** Running Runs with their agent PIDs. */
  runs: () => RunRoot[];
  parallel: () => number | null;
  /** The tight state for the index changed. */
  noticeChanged: (notice: HostNotice | null) => void;
  /** A tight episode began; called once per episode. */
  episodeStarted: (episode: EpisodeDraft, sample: HostSample) => void;
  /** The episode that was tight ended or a new one began (null while calm). */
  episodeHeld?: (start: number | null) => void;
  /** Every pressure sample, including calm ones. Null invalidates a failed sample. */
  pressureObserved?: (observation: HostPressureObservation | null) => void;
  log?: (line: string) => void;
  /** Replace the entire measurement source, including its capability and facts. */
  source?: HostSource;
}

type HistoryPoint = Extract<HostStatus, { supported: true }>['history'][number];
interface Bucket { at: number; cpu: number[]; memory: number[] }

export class HostMonitor {
  private readonly source: HostSource;
  private readonly readGpuStatus?: () => Promise<HostSample['gpus']>;
  private readonly pressure = new Pressure();
  private store: HostStore | null | undefined;
  private storeError: ReturnType<typeof errorBody>['error'] | null = null;
  private sampleError: ReturnType<typeof errorBody>['error'] | null = null;
  private latest: HostSample | null = null;
  private history: HistoryPoint[] = [];
  private bucket: Bucket | null = null;
  private currentId: number | null = null;
  private noticeKey = '';
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastPrune = 0;
  private resumed = false;

  constructor(private readonly options: HostMonitorOptions) {
    this.source = options.source ?? createHostSource(options.root);
    const source = this.source;
    if (source.supported && source.readGpus) this.readGpuStatus = gpuStatus(() => source.readGpus!(options.runs));
  }

  start(): void {
    if (!this.source.supported || this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), HOST_INTERVAL_MS);
    this.timer.unref?.();
  }

  get supportsPressure(): boolean { return this.source.supported; }

  /** One sample; exposed for tests, which drive time themselves. */
  tick(now = Date.now()): void {
    if (!this.source.supported) return;
    let sample: HostSample;
    try {
      const runs = this.options.runs();
      sample = this.source.sample(runs, now);
      this.sampleError = null;
    }
    catch (error) {
      const next = hostFailure('', 'sample', error);
      if (this.sampleError?.message !== next.message) this.options.log?.(`Host sample failed: ${next.message}`);
      this.sampleError = next;
      this.publishPressure(null);
      return;
    }
    this.latest = sample;
    if (!this.resumed) this.resume(now);
    const memoryFreePercent = 100 * sample.memory.availableBytes / sample.memory.totalBytes;
    this.history.push({ at: sample.at, cpu: sample.cpu, memoryFreePercent });
    while (this.history.length && this.history[0]!.at <= now - HOUR_MS) this.history.shift();

    const previousKinds = this.pressure.tightKinds();
    const episode = this.pressure.observe(now, { cpu: sample.cpu, memoryFreePercent, diskFreeBytes: sample.disk.freeBytes }, sample.runs);
    const currentKinds = this.pressure.tightKinds();
    this.record(store => {
      if (episode) {
        try { this.currentId = store.saveEpisode(this.currentId, episode, now, currentKinds); }
        // An ended episode never takes another write, so a failed closing write cannot overwrite it with the next one.
        finally { if (episode.end !== null) this.currentId = null; }
      }
      this.foldMinute(store, now, sample.cpu, memoryFreePercent);
      if (now - this.lastPrune >= HOUR_MS) { store.prune(now); this.lastPrune = now; }
    });
    if (!previousKinds.length && this.pressure.current) {
      this.options.episodeHeld?.(this.pressure.current.start);
      // Recording the push writes push.json; a full disk (one reason to be tight) must not stop serve.
      try { this.options.episodeStarted(this.pressure.current, sample); }
      catch (error) { this.options.log?.(`Host push could not be recorded: ${failure(error).message}`); }
    } else if (previousKinds.length && !this.pressure.current) this.options.episodeHeld?.(null);

    // CPU can be unmeasured in an otherwise valid sample, for example the first sample after a restart.
    const kinds = sample.cpu === null ? currentKinds.filter(kind => kind !== 'cpu') : currentKinds;
    if (this.options.pressureObserved) {
      this.publishPressure({ at: sample.at, episodeStart: this.pressure.current?.start ?? null, kinds,
        entered: kinds.filter(kind => !previousKinds.includes(kind)), cpu: sample.cpu, memoryFreePercent,
        diskFreeBytes: sample.disk.freeBytes,
        runs: sample.runs.map(({ runId, taskId, cpu, memoryBytes }) => ({ runId, taskId, cpu, memoryBytes })) });
    }

    const notice = this.notice(sample, memoryFreePercent);
    const key = notice ? `${notice.since}|${notice.kinds.join()}|${Math.floor(now / MINUTE_MS)}` : '';
    if (key !== this.noticeKey) { this.noticeKey = key; this.options.noticeChanged(notice); }
  }

  /** The small state the index carries; null while calm. */
  notice(sample = this.latest, memoryFreePercent = sample ? 100 * sample.memory.availableBytes / sample.memory.totalBytes : 0): HostNotice | null {
    const current = this.pressure.current;
    if (!current || !sample) return null;
    return { since: new Date(current.start).toISOString(), kinds: this.pressure.tightKinds(),
      cpu: sample.cpu, memoryFreePercent, diskFreeBytes: sample.disk.freeBytes };
  }

  async status(now = Date.now()): Promise<HostStatus> {
    if (!this.source.supported) return this.source;
    const gpus = this.latest && this.readGpuStatus ? await this.readGpuStatus() : undefined;
    const sample = this.latest && gpus !== undefined ? { ...this.latest, gpus } : this.latest;
    const current = this.pressure.current;
    let episodes = this.read(store => store.episodes(now - EPISODE_RETENTION_MS)) ?? [];
    // Without a record the open episode is still shown, from memory, under an id no recorded episode has.
    if (current && !episodes.some(item => item.start === current.start)) episodes = [{ id: this.currentId ?? 0, ...current }, ...episodes];
    return {
      supported: true, facts: this.source.facts, parallel: this.options.parallel(), sample, history: this.history,
      current: current ? episodes.find(item => item.start === current.start) ?? null : null, tight: this.pressure.tightKinds(), episodes,
      limits: { cpu: PRESSURE_LIMITS.cpu.line, memoryFreePercent: PRESSURE_LIMITS.memory.line, diskFreeBytes: PRESSURE_LIMITS.disk.line },
      error: this.sampleError ?? this.storeError,
    };
  }

  /** The minute values from a little before an episode to a little after it (or now). */
  episodeMinutes(id: number, now = Date.now()): HostEpisodeMinutes | null {
    if (!this.source.supported) return null;
    const episode = this.read(store => store.episode(id));
    if (!episode) return null;
    const from = episode.start - EPISODE_MARGIN_MS, to = Math.min(now, (episode.end ?? now) + EPISODE_MARGIN_MS);
    return { from, to, minutes: this.read(store => store.minutes(from, to)) ?? [] };
  }

  close(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    const bucket = this.bucket;
    if (bucket) this.record(store => store.saveMinute(minuteRow(bucket)));
    this.store?.close();
    this.store = null;
  }

  private foldMinute(store: HostStore, now: number, cpu: number | null, memoryFreePercent: number) {
    const at = Math.floor(now / MINUTE_MS) * MINUTE_MS;
    if (this.bucket && this.bucket.at !== at) { store.saveMinute(minuteRow(this.bucket)); this.bucket = null; }
    this.bucket ??= { at, cpu: [], memory: [] };
    if (cpu !== null) this.bucket.cpu.push(cpu);
    this.bucket.memory.push(memoryFreePercent);
  }

  private open(): HostStore | null {
    if (this.store !== undefined) return this.store;
    try {
      this.store = new HostStore(this.options.root);
    } catch (error) {
      this.store = null;
      this.storeError = hostFailure('Host record unavailable: ', 'record_unavailable', error);
      this.options.log?.(this.storeError.message);
    }
    return this.store;
  }
  /** Once, at the first sample: continue the episode a restart interrupted, and end any older one left open. */
  private resume(now: number): void {
    this.resumed = true;
    this.record(store => {
      const open = store.lastOpen();
      if (open?.currentKinds && now >= open.lastAt && now - open.lastAt <= RESUME_WINDOW_MS) {
        this.pressure.resume(open.episode, open.currentKinds);
        this.currentId = open.id;
        this.options.episodeHeld?.(open.episode.start);
      }
      store.closeOpen(this.currentId);
    });
  }
  private publishPressure(observation: HostPressureObservation | null): void {
    try { this.options.pressureObserved?.(observation); }
    catch (error) { this.options.log?.(`Host pressure observation could not be published: ${failure(error).message}`); }
  }
  private record(write: (store: HostStore) => void): void {
    const store = this.open();
    if (!store) return;
    try { write(store); this.storeError = null; }
    catch (error) {
      const next = hostFailure('Host record failed: ', 'record', error);
      if (this.storeError?.message !== next.message) this.options.log?.(next.message);
      this.storeError = next;
    }
  }
  private read<T>(get: (store: HostStore) => T): T | null {
    const store = this.open();
    if (!store) return null;
    try { return get(store); }
    catch (error) { this.storeError = hostFailure('Host record failed: ', 'record', error); return null; }
  }
}

function minuteRow(bucket: Bucket): MinuteRow {
  const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  return { at: bucket.at,
    cpuAverage: bucket.cpu.length ? average(bucket.cpu) : null, cpuMax: bucket.cpu.length ? Math.max(...bucket.cpu) : null,
    memoryFreeAverage: average(bucket.memory), memoryFreeMin: Math.min(...bucket.memory) };
}
