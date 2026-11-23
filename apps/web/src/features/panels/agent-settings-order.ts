import type { AgentDraft } from './agent-settings-draft';

/** Make `id` the agent a launch choice starts on by moving it to the top; the others keep their order. */
export function withFirstAgent(agents: readonly AgentDraft[], id: string): AgentDraft[] {
  const chosen = agents.find(agent => agent.id === id);
  return chosen ? [chosen, ...agents.filter(agent => agent.id !== id)] : [...agents];
}
