/**
 * How full an agent's conversation is against its model's context window, in one shape for every adapter. Each adapter
 * translates what its agent reports into a `ContextUpdate`; the Run's activity keeps the merged latest (`AgentContext`),
 * and the screen reads only that.
 */
import { z } from 'zod';

const tokens = z.number().int().nonnegative().safe();
const limit = tokens.positive();
/**
 * How full a Run's conversation is, as its agent last said. Its window belongs to the model, not to the Run: an adapter
 * reports it in its updates, and the model's own record keeps it (resolveContextLimits).
 */
export const agentContextSchema = z.object({
  /** The main conversation's last model call: input, cache reads and writes, and output. Null while unknown (just after a compaction). */
  usedTokens: tokens.nullable(),
  /** The latest figure is a compaction's own, not a model call's. */
  compacted: z.boolean(),
  observedAt: z.iso.datetime({ offset: true }),
}).strict();
export type AgentContext = z.infer<typeof agentContextSchema>;
/**
 * What one observation says: the fill, the model's window when the agent names it, and with a compaction, how full the
 * conversation was before it when the agent says so (`compactedFrom`; else the last fill read stands for it). A field
 * an observation leaves out keeps its last value.
 */
export const contextUpdateSchema = agentContextSchema.omit({ observedAt: true }).extend({ windowTokens: limit, compactedFrom: tokens }).partial().strict();
export type ContextUpdate = z.infer<typeof contextUpdateSchema>;

/** The latest fill after one more observation (the window is the model's: see resolveContextLimits). */
export function mergeContext(previous: AgentContext | null, update: ContextUpdate, observedAt: string): AgentContext {
  const { usedTokens = previous?.usedTokens ?? null, compacted = previous?.compacted ?? false } = update;
  return { usedTokens, compacted, observedAt };
}

/** One model's context window, as a person writes it, as an agent reported it, or as shipped. */
export const modelContextSchema = z.object({ window: limit.optional() }).strict();
export type ModelContext = z.infer<typeof modelContextSchema>;
/** A model's key in each record: the chosen candidate, or `-` when none was chosen. */
export const modelKey = (model: string | null | undefined): string => model || '-';

/** Where a resolved limit came from, in the order they are looked at: what a person wrote wins over what the agent said. */
export const CONTEXT_SOURCES = ['setting', 'reported', 'default'] as const;
export type ContextSource = (typeof CONTEXT_SOURCES)[number];
export type ContextLimits = { windowTokens: number | null; windowFrom: ContextSource | null };

/** The one place a model's window is decided. */
export function resolveContextLimits(layers: Partial<Record<ContextSource, ModelContext | undefined>>): ContextLimits {
  for (const source of CONTEXT_SOURCES) {
    const value = layers[source]?.window;
    if (value !== undefined) return { windowTokens: value, windowFrom: source };
  }
  return { windowTokens: null, windowFrom: null };
}

/** A working Run's fill as the screen reads it: the Run's own figure with its model's resolved limits. */
export const contextViewSchema = agentContextSchema.extend({
  windowTokens: limit.nullable(), windowFrom: z.enum(CONTEXT_SOURCES).nullable(),
}).strict();
export type ContextView = z.infer<typeof contextViewSchema>;

/** Percent of the window used: only when both are known, never above 100. */
export function contextPercent(context: Pick<ContextView, 'usedTokens' | 'windowTokens'>): number | null {
  const { usedTokens, windowTokens } = context;
  return usedTokens === null || windowTokens === null ? null : Math.min(100, usedTokens / windowTokens * 100);
}

/** The disjoint counters of one model call summed; null when one is missing. */
export function callTokens(...counts: unknown[]): number | null {
  return counts.every(count => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)
    ? (counts as number[]).reduce((total, count) => total + count, 0) : null;
}
