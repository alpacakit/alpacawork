import { BUILTIN_ADAPTER_IDS, type BuiltinAdapterId } from '@alpacawork/contract/agent-adapters';
import { claudeAdapter } from './adapters/claude.js';
import { bridgeAdapter } from './adapters/bridge.js';
import type { AgentAdapter } from './adapters/types.js';

/** Built-ins only. No name, basename, profile alias or external registry participates. */
export const AGENT_RUNTIME_ADAPTERS = Object.fromEntries(BUILTIN_ADAPTER_IDS.map(id =>
  [id, id === 'claude' ? claudeAdapter : bridgeAdapter(id)],
)) as Record<BuiltinAdapterId, AgentAdapter>;

/** Historical Run identifiers need not name a runtime shipped by this version. */
export const runtimeAdapter = (id: string): AgentAdapter | undefined =>
  Object.hasOwn(AGENT_RUNTIME_ADAPTERS, id) ? AGENT_RUNTIME_ADAPTERS[id as BuiltinAdapterId] : undefined;

export const unavailableRuntimeMessage = (id: string): string => `Agent kind "${id}" is unavailable in this version`;
export function requireRuntimeAdapter(id: string): AgentAdapter {
  const adapter = runtimeAdapter(id);
  if (!adapter) throw new Error(unavailableRuntimeMessage(id));
  return adapter;
}
