import { problemErrorSchema } from './problem.js';
/** Host status wire contract: the settings tab's read, one tight episode's minutes, and the index's small tight state. */
import { z } from 'zod';
import { runIdSchema, taskIdSchema } from './fields.js';
import { runRoleSchema } from './run-contract.js';

export const hostKindSchema = z.enum(['cpu', 'memory', 'disk']);
export type HostKind = z.infer<typeof hostKindSchema>;
const percent = z.number().finite();
const bytes = z.number().finite().nonnegative();
const at = z.number().int().nonnegative();

/**
 * While the machine is tight: published in the index for the banner, so it changes only when a stretch starts or
 * ends, its measures change, or a minute passes (`cpu` and the others are the values at that moment).
 */
export const hostNoticeSchema = z.object({
  since: z.string(), kinds: z.array(hostKindSchema).min(1),
  cpu: percent.nullable(), memoryFreePercent: percent, diskFreeBytes: bytes,
}).strict();
export type HostNotice = z.infer<typeof hostNoticeSchema>;

const heaviestSchema = z.object({ name: z.string(), count: z.number().int().positive() }).strict();
/** A coordinator's Run has no Task (`taskId` null) and an empty title: the reader names it in its own language. */
const runIdentity = { runId: runIdSchema, taskId: taskIdSchema.nullable(), title: z.string(), model: z.string().nullable(), role: runRoleSchema };
export const hostRunLoadSchema = z.object({ ...runIdentity,
  cpu: percent.nullable(), memoryBytes: bytes.nullable(), processes: z.number().int().nonnegative(), heaviest: heaviestSchema.nullable() }).strict();
export const hostEpisodeSchema = z.object({
  /** 0 for an open episode the record could not keep; it has no minute values to read. */
  id: z.number().int().nonnegative(), start: at, end: at.nullable(), kinds: z.array(hostKindSchema).min(1),
  peak: z.object({ cpu: percent.nullable(), memoryFreePercent: percent, diskFreeBytes: bytes }).strict(),
  runs: z.array(z.object({ ...runIdentity, cpuPeak: percent.nullable(), memoryPeakBytes: bytes.nullable(),
    heaviest: z.string().nullable(), firstSeen: at, lastSeen: at }).strict()),
}).strict();
export type HostEpisode = z.infer<typeof hostEpisodeSchema>;

const gpuPercent = z.number().min(0).max(100).nullable();
const hostGpuSchema = z.object({
  id: z.string(),
  name: z.string(),
  utilization: gpuPercent,
  memory: z.object({ usedBytes: bytes, totalBytes: bytes.positive() }).strict().nullable(),
  /** The two largest reported VRAM users per GPU. Null when process memory is unavailable. */
  users: z.array(z.object({
    name: z.string(), memoryBytes: bytes, runId: runIdSchema.nullable(), taskId: taskIdSchema.nullable(),
  }).strict()).max(2).nullable(),
}).strict();

export const hostSampleSchema = z.object({
  at, cpu: percent.nullable(),
  memory: z.object({ totalBytes: bytes, availableBytes: bytes }).strict(),
  disk: z.object({ freeBytes: bytes, totalBytes: bytes }).strict(),
  gpus: z.array(hostGpuSchema),
  runs: z.array(hostRunLoadSchema),
  outside: z.object({ cpu: percent.nullable(), memoryBytes: bytes.nullable(), names: z.array(z.string()) }).strict(),
}).strict();
export type HostSampleDTO = z.infer<typeof hostSampleSchema>;

/** `GET /api/host/status`: everything the Machine status tab draws. OS-independent normalized measurements. */
export const hostStatusSchema = z.discriminatedUnion('supported', [
  z.object({ supported: z.literal(false), platform: z.string() }).strict(),
  z.object({
    supported: z.literal(true),
    facts: z.object({ hostname: z.string(), os: z.string(), cores: z.number().int().positive(), memoryBytes: bytes }).strict().nullable(),
    parallel: z.number().int().positive().nullable(),
    /** Null until the first sample. */
    sample: hostSampleSchema.nullable(),
    /** The last hour, one point per sample. */
    history: z.array(z.object({ at, cpu: percent.nullable(), memoryFreePercent: percent }).strict()),
    current: hostEpisodeSchema.nullable(),
    /** Newest first, the last 90 days, the current one included. */
    episodes: z.array(hostEpisodeSchema),
    limits: z.object({ cpu: percent, memoryFreePercent: percent, diskFreeBytes: bytes }).strict(),
    /** Why the last sample or the record failed; the values shown are then the last good ones. */
    error: problemErrorSchema.nullable(),
  }).strict(),
]);
export type HostStatus = z.infer<typeof hostStatusSchema>;

export const hostEpisodeInput = z.object({ id: z.coerce.number().int().positive() }).strict();
/** `GET /api/host/episode?id=`: the minute values around one episode, for its line. */
export const hostEpisodeMinutesSchema = z.object({
  from: at, to: at,
  minutes: z.array(z.object({ at, cpuAverage: percent.nullable(), cpuMax: percent.nullable(),
    memoryFreeAverage: percent, memoryFreeMin: percent }).strict()),
}).strict();
export type HostEpisodeMinutes = z.infer<typeof hostEpisodeMinutesSchema>;

/** "vitest ×4": a Run's heaviest command and how many of it run; the one form the tab and the record share. */
export function heaviestText(heaviest: { name: string; count: number } | null): string {
  if (!heaviest) return '';
  return heaviest.count > 1 ? `${heaviest.name} ×${heaviest.count}` : heaviest.name;
}
