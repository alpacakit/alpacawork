/**
 * Decides when the machine is tight and keeps each tight stretch as one episode.
 * Each measure enters and leaves on its own held thresholds, so a value hovering at the line does not flap;
 * an episode lasts from the first measure turning tight until none is.
 */
import { heaviestText, type HostKind } from '@alpacawork/contract';
import type { RunLoad } from './measure.js';
import type { EpisodeDraft } from './store.js';

interface PressureReading { cpu: number | null; memoryFreePercent: number; diskFreeBytes: number }

const GB = 1024 ** 3;
const DISK_WARNING_BYTES = 50 * GB;
interface Limit { line: number; tight: (value: number) => boolean; tightFor: number; calm: (value: number) => boolean; calmFor: number }
/** Fixed for now (requirements: no threshold settings). Durations are milliseconds. */
export const PRESSURE_LIMITS: Record<HostKind, Limit> = {
  cpu: { line: 90, tight: v => v >= 90, tightFor: 120_000, calm: v => v < 75, calmFor: 120_000 },
  memory: { line: 10, tight: v => v < 10, tightFor: 60_000, calm: v => v >= 15, calmFor: 120_000 },
  disk: { line: DISK_WARNING_BYTES, tight: v => v < DISK_WARNING_BYTES, tightFor: 0, calm: v => v >= DISK_WARNING_BYTES + 5 * GB, calmFor: 0 },
};
const KINDS = Object.keys(PRESSURE_LIMITS) as HostKind[];

interface Track { tight: boolean; since: number | null }


export class Pressure {
  private tracks = Object.fromEntries(KINDS.map(kind => [kind, { tight: false, since: null }])) as Record<HostKind, Track>;
  /** The open episode, if the machine is tight now. */
  current: EpisodeDraft | null = null;

  /** Folds one sample in. Returns the episode it touched (the one that just ended included), or null while calm. */
  observe(at: number, reading: PressureReading, runs: readonly RunLoad[]): EpisodeDraft | null {
    const values: Record<HostKind, number | null> =
      { cpu: reading.cpu, memory: reading.memoryFreePercent, disk: reading.diskFreeBytes };
    for (const kind of KINDS) {
      const value = values[kind], track = this.tracks[kind], limit = PRESSURE_LIMITS[kind];
      if (value === null) continue;
      const crossing = track.tight ? limit.calm(value) : limit.tight(value);
      if (!crossing) { track.since = null; continue; }
      track.since ??= at;
      if (at - track.since >= (track.tight ? limit.calmFor : limit.tightFor)) { track.tight = !track.tight; track.since = null; }
    }
    const tight = KINDS.filter(kind => this.tracks[kind].tight);
    const episode = this.current;
    if (tight.length === 0) {
      if (!episode) return null;
      episode.end = at;
      this.current = null;
      return episode;
    }
    const open = episode ?? (this.current = { start: at, end: null, kinds: [...tight],
      peak: { cpu: reading.cpu, memoryFreePercent: reading.memoryFreePercent, diskFreeBytes: reading.diskFreeBytes }, runs: [] });
    for (const kind of tight) if (!open.kinds.includes(kind)) open.kinds.push(kind);
    const peak = open.peak;
    if (reading.cpu !== null) peak.cpu = Math.max(peak.cpu ?? 0, reading.cpu);
    peak.memoryFreePercent = Math.min(peak.memoryFreePercent, reading.memoryFreePercent);
    peak.diskFreeBytes = Math.min(peak.diskFreeBytes, reading.diskFreeBytes);
    for (const run of runs) {
      const heaviest = heaviestText(run.heaviest) || null;
      const seen = open.runs.find(item => item.runId === run.runId);
      if (!seen) {
        open.runs.push({ runId: run.runId, taskId: run.taskId, title: run.title, model: run.model, role: run.role,
          cpuPeak: run.cpu, memoryPeakBytes: run.memoryBytes, heaviest, firstSeen: at, lastSeen: at });
        continue;
      }
      if (run.cpu !== null && (seen.cpuPeak === null || run.cpu >= seen.cpuPeak)) { seen.cpuPeak = run.cpu; seen.heaviest = heaviest ?? seen.heaviest; }
      if (run.memoryBytes !== null) seen.memoryPeakBytes = Math.max(seen.memoryPeakBytes ?? 0, run.memoryBytes);
      seen.lastSeen = at;
    }
    open.runs.sort((a, b) => (b.cpuPeak ?? -1) - (a.cpuPeak ?? -1));
    return open;
  }

  /** Continues an episode a restarted server left open: its measures count as tight until they calm down. */
  resume(episode: EpisodeDraft): void {
    this.current = { ...episode, end: null };
    for (const kind of episode.kinds) this.tracks[kind] = { tight: true, since: null };
  }

  /** The measures tight now, in a stable order. */
  tightKinds(): HostKind[] { return KINDS.filter(kind => this.tracks[kind].tight); }
}
