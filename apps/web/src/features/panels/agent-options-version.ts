import { optionsBase } from '@alpacawork/contract/agent-adapters';
import { draftAdapter, type AgentDraft } from './agent-settings-draft';

/** One contract-owned version for both new edits and the saved-versus-current comparison. */
export function agentOptionsVersion(agent: AgentDraft): { base?: string; changed?: boolean } {
  const adapter = draftAdapter(agent);
  if (!adapter) return {};
  const base = optionsBase(adapter);
  return { base, ...(agent.options?.base ? { changed: agent.options.base !== base } : {}) };
}
