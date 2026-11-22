import type { AiRow, ServerSettings } from "@alpacawork/contract";
import type { AgentDraft, AgentsDraft } from "@/features/panels/agent-settings-draft";
import { firstValues, readStack } from "@/features/panels/ai-stack-draft";
import { serverAgentsYaml } from "@/features/panels/server-agent-draft";
import { configYaml } from "@/features/panels/settings-draft";
import { chosenAgents, type AgentSwitches, type StartAgent } from "./rules";

/**
 * The AI stack once setup's choices apply, or null when the saved one already matches: the first AI chosen here is row 1
 * (the saved row of that agent moved up with its values, else a new row on the agent's first values), and rows of agents
 * that end up disabled go, since a stack row naming one cannot be saved. The other rows keep their order.
 */
export function setupStack(stack: readonly AiRow[], agents: readonly AgentDraft[], first: string | null): AiRow[] | null {
  const enabled = new Set(agents.filter(agent => agent.enabled !== false).map(agent => agent.name));
  let rows = stack.filter(row => enabled.has(row.agent));
  const firstAgent = first ? agents.find(agent => agent.name === first) : undefined;
  if (firstAgent) {
    const at = rows.findIndex(row => row.agent === firstAgent.name);
    const head = at === -1 ? { agent: firstAgent.name, values: firstValues(firstAgent) } : rows[at]!;
    rows = [head, ...rows.filter((_, index) => index !== at)];
  }
  return JSON.stringify(rows) === JSON.stringify(stack) ? null : rows;
}

/**
 * What leaving the agents step writes with config/set, or null when config.yaml already holds the choice: the agents
 * (the switches and their order, chosenAgents) and the AI stack, read and written as the server settings do, so the
 * first AI chosen here is the one a new conversation and a request start on.
 */
export function setupSave(loaded: ServerSettings, drafts: AgentsDraft, rows: readonly StartAgent[], on: AgentSwitches,
  first: string | null): { config: string; agents: string } | null {
  const chosen = chosenAgents(drafts.agents, rows, on, first);
  const agents = chosen ?? drafts.agents;
  const stack = setupStack(loaded.aiStack ?? [], agents, first);
  if (!chosen && !stack) return null;
  const yaml = serverAgentsYaml({ agents: { ok: true, value: { ...drafts, agents } } });
  if (!yaml.ok) throw new Error("Invalid agent settings");
  return { config: configYaml({ limits: loaded.limits, ...stack ? { aiStack: readStack(stack) } : {} }), agents: yaml.value };
}
