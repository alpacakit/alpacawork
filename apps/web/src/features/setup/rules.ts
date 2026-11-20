import type { AgentAvailability } from "@alpacawork/contract";
import { AGENT_ADAPTERS, BUILTIN_ADAPTER_IDS, type BuiltinAdapterId } from "@alpacawork/contract/agent-adapters";
import { draftAdapter, newAgentDraft, type AgentDraft } from "@/features/panels/agent-settings-draft";
import { agentObservation, agentReadiness, takesRequests, type AgentObservations, type AgentReadiness } from "@/features/panels/agent-status";
import { firstEnabledAgent, withFirstAgent } from "@/features/panels/agent-settings-order";

/**
 * One agent row of the setup, as the last check saw it. `configured`: config.yaml lists it (a kind it does not list is
 * added there when it is switched on). `command` is the CLI it runs, named when it was not found.
 * The status is the agent's readiness (agentReadiness), or checking while the first check has not answered.
 */
export type StartAgent = { name: string; adapter: BuiltinAdapterId | null; status: AgentReadiness | "checking";
  signIn: string | null; command: string | null; configured: boolean };

const statusOf = (seen: AgentAvailability | undefined, checking: boolean): StartAgent["status"] =>
  !seen && checking ? "checking" : agentReadiness(seen);

/**
 * The agents the setup lists: config.yaml's in its order, then each kind alpacawork supports that config.yaml does not
 * list, as the check saw it on this PC (a kind with no CLI of its own, run from alpacawork's bundle, is listed only by
 * config.yaml). Those whose CLI is missing come last, so the ones that can be enabled stand together at the top.
 */
export function startAgents(agents: readonly AgentDraft[], observations: AgentObservations | undefined, checking: boolean): StartAgent[] {
  const configured = agents.map((agent): StartAgent => {
    const seen: AgentAvailability | undefined = agentObservation(agent, observations);
    const adapter = draftAdapter(agent) ?? null;
    return { name: agent.name, adapter, status: statusOf(seen, checking), signIn: seen?.nextAction ?? null,
      command: agent.command ?? (adapter ? AGENT_ADAPTERS[adapter].command : null), configured: true };
  });
  const listedKinds = new Set(configured.map(row => row.adapter));
  const others = BUILTIN_ADAPTER_IDS.flatMap((adapter): StartAgent[] => {
    const command = AGENT_ADAPTERS[adapter].command, seen = observations?.detected?.[adapter];
    if (!command || listedKinds.has(adapter) || !seen) return [];
    return [{ name: adapter, adapter, status: statusOf(seen, false), signIn: seen.nextAction ?? null, command, configured: false }];
  });
  const rows = [...configured, ...others];
  return [...rows.filter(row => row.status !== "missing"), ...rows.filter(row => row.status === "missing")];
}

/** The switches as the person left them: each listed agent's on/off, starting from config.yaml's `enabled`. */
export type AgentSwitches = Record<string, boolean>;

/** Whether a listed agent can take work once switched on. */
export const canWork = (row: Pick<StartAgent, "status">) => takesRequests(row.status);
/** The agents that would take work: listed, able to and switched on, in config order. */
export const usableAgents = (rows: readonly StartAgent[], on: AgentSwitches) =>
  rows.filter(row => canWork(row) && on[row.name]).map(row => row.name);

/** The agent requests go to first: the one picked when it is usable, else the first usable one. */
export const firstAgentOf = (usable: readonly string[], picked: string | null) =>
  picked && usable.includes(picked) ? picked : usable[0] ?? null;

/**
 * The agents config.yaml should hold for the choice made in the setup, or null when it already does: the switches as
 * `enabled` (only rows the screen lets the person switch; a row whose CLI is missing keeps what config.yaml says), a kind
 * config.yaml did not list added when it was switched on, and the first agent moved to the top of the order.
 */
export function chosenAgents(agents: readonly AgentDraft[], rows: readonly StartAgent[], on: AgentSwitches, first: string | null): AgentDraft[] | null {
  const switchable = new Set(rows.filter(row => row.configured && row.status !== "missing").map(row => row.name));
  let next = agents.map(agent => switchable.has(agent.name) && (agent.enabled ?? true) !== !!on[agent.name] ? { ...agent, enabled: !!on[agent.name] } : agent);
  const added = rows.filter(row => !row.configured && row.adapter && canWork(row) && on[row.name])
    .map(row => ({ ...newAgentDraft(row.name, row.adapter!, row.name), enabled: true }));
  next = [...next, ...added];
  if (first && firstEnabledAgent(next) !== first) next = withFirstAgent(next, next.find(agent => agent.name === first)?.id ?? "");
  const same = next.length === agents.length && next.every((agent, at) => agent === agents[at]);
  return same ? null : next;
}

/** Product names of the kinds setup finds; an agent config.yaml names otherwise keeps its own name. */
const PRODUCT_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", grok: "Grok Build", pi: "pi", copilot: "GitHub Copilot" };
export const agentDisplayName = (name: string) => PRODUCT_NAMES[name] ?? name;
