/**
 * How full an agent's conversation is against its model's context window, in one shape for every adapter. Each adapter
 * translates what its agent reports into a `ContextUpdate`; the Run's activity keeps the merged latest (`AgentContext`),
 * and the screen reads only that.
 */
import { z } from 'zod';

const tokens = z.number().int().nonnegative().safe();
export const agentContextSchema = z.object({
  /** The main conversation's last model call: input, cache reads and writes, and output. Null while unknown (just after a compaction). */
  usedTokens: tokens.nullable(),
  /** The window the agent itself measures against; null when it does not say. */
  windowTokens: tokens.positive().nullable(),
  /** Where the agent compacts by itself, when it says. */
  compactAtTokens: tokens.positive().nullable(),
  /** The latest figure is a compaction's own, not a model call's. */
  compacted: z.boolean(),
  observedAt: z.iso.datetime({ offset: true }),
}).strict();
export type AgentContext = z.infer<typeof agentContextSchema>;
/** What one observation says; a field it leaves out keeps its last value. */
export const contextUpdateSchema = agentContextSchema.omit({ observedAt: true }).partial().strict();
export type ContextUpdate = z.infer<typeof contextUpdateSchema>;

/** The latest context after one more observation. */
export function mergeContext(previous: AgentContext | null, update: ContextUpdate, observedAt: string): AgentContext {
  return { usedTokens: null, windowTokens: null, compactAtTokens: null, compacted: false, ...previous, ...update, observedAt };
}

/** Percent of the window used: only when both are known, never above 100. */
export function contextPercent(context: Pick<AgentContext, 'usedTokens' | 'windowTokens'>): number | null {
  const { usedTokens, windowTokens } = context;
  return usedTokens === null || windowTokens === null ? null : Math.min(100, usedTokens / windowTokens * 100);
}

/** The disjoint counters of one model call summed; null when one is missing. */
export function callTokens(...counts: unknown[]): number | null {
  return counts.every(count => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)
    ? (counts as number[]).reduce((total, count) => total + count, 0) : null;
}
