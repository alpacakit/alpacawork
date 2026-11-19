import { agentUsageSchema, type AgentUsage } from '@alpacawork/contract/agent-bridge';

/** Validation only. Each provider owns field meaning and scope; absence never means zero. */
export function measuredUsage(scope: AgentUsage['scope'], counters: Record<keyof AgentUsage['counters'], unknown>): AgentUsage | null {
  const parsed = agentUsageSchema.safeParse({ scope, counters });
  return parsed.success ? parsed.data : null;
}
export const usageRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Disjoint native token counters for one instruction; missing counters stay unmeasured. */
export function tokenUsage(value: unknown): AgentUsage | null {
  const usage = usageRecord(value);
  return measuredUsage('run', { input: usage.input_tokens, cacheRead: usage.cache_read_input_tokens,
    cacheWrite: usage.cache_creation_input_tokens, output: usage.output_tokens });
}
