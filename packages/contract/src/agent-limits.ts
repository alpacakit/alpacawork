/**
 * Plan usage limits an agent's account is under, in one shape for every adapter. Each adapter translates its provider's
 * own report into `limitWindow`; the server keeps the latest per adapter, and the screen reads only this shape.
 */
import { z } from 'zod';
import { builtinAdapterIdSchema } from './agent-adapters.js';

export const LIMIT_KINDS = ['session', 'weekly', 'monthly', 'other'] as const;
export const limitWindowSchema = z.object({
  /** What the window is to the reader: a 5-hour session, a week, a month, or another length (`minutes`). */
  kind: z.enum(LIMIT_KINDS),
  /** The window's length when the provider says it. */
  minutes: z.number().int().positive().nullable(),
  /** The model a window applies to alone ("Fable"); null for the whole account. */
  model: z.string().min(1).max(64).nullable(),
  usedPercent: z.number().min(0).max(100),
  resetsAt: z.iso.datetime({ offset: true }).nullable(),
}).strict();
export type LimitWindow = z.infer<typeof limitWindowSchema>;
/** What a bridge's `--limits` prints: one JSON line. */
export const bridgeLimitsSchema = z.object({ windows: z.array(limitWindowSchema) }).strict();

export const agentLimitsSchema = z.object({
  adapter: builtinAdapterIdSchema,
  /** ok: read at `observedAt` (a later failed read keeps it); unsupported: the agent reports no limits; unavailable: never read (signed out, no executable…). */
  state: z.enum(['ok', 'unsupported', 'unavailable']),
  windows: z.array(limitWindowSchema),
  observedAt: z.iso.datetime({ offset: true }).nullable(),
}).strict();
export type AgentLimits = z.infer<typeof agentLimitsSchema>;
/** In the order the screen lists them: the task stack's agents first, then the other enabled ones. */
export const agentLimitsResponseSchema = z.object({ agents: z.array(agentLimitsSchema) }).strict();
export type AgentLimitsResponse = z.infer<typeof agentLimitsResponseSchema>;

const MINUTE_KINDS: [number, LimitWindow['kind']][] = [[300, 'session'], [10_080, 'weekly']];
/** Calendar months vary from 28 to 31 days. */
const isMonth = (minutes: number) => minutes >= 28 * 1440 && minutes <= 31 * 1440;

/** One provider window, from the facts every provider gives in some form; null when they do not make a valid one. */
export function limitWindow(input: { minutes?: number | null; kind?: LimitWindow['kind']; model?: string | null;
  usedPercent: unknown; resetsAt?: unknown }): LimitWindow | null {
  const minutes = typeof input.minutes === 'number' && Number.isSafeInteger(input.minutes) && input.minutes > 0 ? input.minutes : null;
  const kind = input.kind ?? (minutes === null ? 'other'
    : MINUTE_KINDS.find(([length]) => length === minutes)?.[1] ?? (isMonth(minutes) ? 'monthly' : 'other'));
  const percent = typeof input.usedPercent === 'number' && Number.isFinite(input.usedPercent)
    ? Math.min(100, Math.max(0, input.usedPercent)) : null;
  if (percent === null) return null;
  const parsed = limitWindowSchema.safeParse({ kind, minutes, model: input.model || null,
    usedPercent: Math.round(percent * 10) / 10, resetsAt: resetTime(input.resetsAt) });
  return parsed.success ? parsed.data : null;
}

/** Providers give a reset as epoch seconds or as an ISO time. */
export function resetTime(value: unknown): string | null {
  const ms = typeof value === 'number' && Number.isFinite(value) ? value * 1000
    : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_MS) return null;
  const iso = new Date(ms).toISOString();
  // A year past 9999 prints with a sign, which no reader takes as a time: drop the time, not what it came with.
  return isoTime.safeParse(iso).success ? iso : null;
}
const MAX_DATE_MS = 8.64e15;
const isoTime = z.iso.datetime({ offset: true });
