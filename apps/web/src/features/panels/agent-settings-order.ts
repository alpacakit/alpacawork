import type { AgentDraft } from './agent-settings-draft';
import { enabledAgents } from '@alpacawork/contract/agent-settings';

/** The agent the pickers start on: the first enabled one in config order. */
export const firstEnabledAgent = (agents: readonly AgentDraft[]): string | undefined =>
  enabledAgents(Object.fromEntries(agents.map(agent => [agent.id, agent])))[0]?.[0];

/** Make `id` the agent the pickers start on by moving it to the top; the others keep their order. */
export function withFirstAgent(agents: readonly AgentDraft[], id: string): AgentDraft[] {
  const chosen = agents.find(agent => agent.id === id);
  return chosen ? [chosen, ...agents.filter(agent => agent.id !== id)] : [...agents];
}
