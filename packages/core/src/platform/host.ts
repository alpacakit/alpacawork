/** Normalized readings supplied by the selected OS implementation, before Run accounting or monitoring. */
export interface HostFacts { hostname: string; os: string; cores: number; memoryBytes: number }
/** Null process fields mean the process was listed but its measurement could not be read. */
export interface ProcessStat { pid: number; ppid: number; comm: string; ticks: number | null; startTime: number | null; rssBytes: number | null }
export interface HostReading {
  /** Read immediately before the process snapshot, in the same clock coordinate as startTime. */
  processTime: number;
  /** Cumulative milliseconds, including every logical core; all cores together are 100%. */
  cpuTicks: { total: number; idle: number };
  processes: ReadonlyMap<number, ProcessStat>;
  memory: { totalBytes: number; availableBytes: number; swapUsedBytes: number | null };
  /** Null means this OS has no equivalent metric, rather than a load of zero. */
  load: [number, number, number] | null;
  disk: { freeBytes: number; totalBytes: number };
}
export type HostMeasurement = { supported: false; platform: string } | {
  supported: true;
  facts: HostFacts;
  read(): HostReading;
  argv(pid: number, startTime?: number | null): string[];
};
