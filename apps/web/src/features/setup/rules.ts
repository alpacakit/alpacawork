import { AGENT_NAMES } from "@/domain/agent-names";
import type { AgentAvailability } from "@alpacawork/contract";
import { AGENT_ADAPTERS, BUILTIN_ADAPTER_IDS, type BuiltinAdapterId } from "@alpacawork/contract/agent-adapters";
import { draftAdapter, newAgentDraft, type AgentDraft } from "@/features/panels/agent-settings-draft";
import { agentObservation, type AgentObservations } from "@/features/panels/agent-status";
import { withFirstAgent } from "@/features/panels/agent-settings-order";

/**
 * One agent row of the setup, as the last check saw it. `configured`: config.yaml lists it (leaving the step writes every
 * kind it does not list, on or off). `command` is the CLI it runs, named when it was not found.
 * ready: signed in, as the check confirmed. found: the CLI is here and nothing says it is signed out (this kind has no
 * sign-in check, or the check did not answer, or there is no answer for it), so it may be enabled and works once the
 * CLI itself is signed in. signedOut: the check saw it signed out. missing: its CLI is not on this PC, so it cannot be
 * enabled. checking: no answer yet.
 */
export type StartAgent = { name: string; adapter: BuiltinAdapterId | null; status: "ready" | "found" | "signedOut" | "missing" | "checking";
  signIn: string | null; command: string | null; configured: boolean };

const statusOf = (seen: AgentAvailability | undefined, checking: boolean): StartAgent["status"] =>
  !seen && checking ? "checking" : seen?.status === "ready" ? "ready" : seen?.status === "signed_out" ? "signedOut"
    : seen?.status === "not_found" ? "missing" : "found";

/**
 * Each of `unlisted` placed among `listed` where alpacawork's own order of kinds puts it: before the first listed one of
 * a later kind. `listed` keeps its order. A new config.yaml lists only the kinds signed in when it was made, so a kind
 * found signed in afterwards still takes its usual place (and is the default when that place is first).
 */
function placeByKind<T>(listed: readonly T[], unlisted: readonly T[], kind: (item: T) => BuiltinAdapterId | null | undefined): T[] {
  const rank = (item: T) => { const id = kind(item); return id ? BUILTIN_ADAPTER_IDS.indexOf(id) : BUILTIN_ADAPTER_IDS.length; };
  const placed = [...listed];
  for (const item of unlisted) {
    const at = placed.findIndex(each => listed.includes(each) && rank(each) > rank(item));
    placed.splice(at < 0 ? placed.length : at, 0, item);
  }
  return placed;
}

/**
 * The agents the setup lists: config.yaml's, and each kind alpacawork supports that config.yaml does not list, as the
 * check saw it on this PC (a kind with no CLI of its own, run from alpacawork's bundle, only when the check found it
 * signed in), in the order `placeByKind` gives. Those whose CLI is missing come last, so the ones that can be enabled
 * stand together at the top.
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
    if (listedKinds.has(adapter) || !seen || !command && seen.status !== "ready") return [];
    return [{ name: adapter, adapter, status: statusOf(seen, false), signIn: seen.nextAction ?? null, command, configured: false }];
  });
  const rows = placeByKind(configured, others, row => row.adapter);
  return [...rows.filter(row => row.status !== "missing"), ...rows.filter(row => row.status === "missing")];
}

/** The switches as the person left them: each listed agent's on/off, starting from config.yaml's `enabled`. */
export type AgentSwitches = Record<string, boolean>;

/** Whether a listed agent can take work once switched on. */
export const canWork = (row: Pick<StartAgent, "status">) => row.status === "ready" || row.status === "found";
/** The agents that would take work: listed, able to and switched on, in config order. */
export const usableAgents = (rows: readonly StartAgent[], on: AgentSwitches) =>
  rows.filter(row => canWork(row) && on[row.name]).map(row => row.name);

/**
 * The agent requests go to first: the one picked here when it is usable; until one is picked, the saved AI stack's first
 * row that is usable (so opening setup and going on leaves the stack as it is); else the first usable one.
 */
export const firstAgentOf = (usable: readonly string[], picked: string | null, saved: readonly { agent: string }[] = []) =>
  picked && usable.includes(picked) ? picked : saved.find(row => usable.includes(row.agent))?.agent ?? usable[0] ?? null;

/**
 * The agents config.yaml should hold for the choice made in the setup, or null when it already does: the switches as
 * `enabled` (only rows the screen lets the person switch; a row whose CLI is missing keeps what config.yaml says), every
 * kind alpacawork supports that config.yaml did not list added with its switch (off when it is not here or cannot take
 * work yet), placed as `placeByKind` places it, and the first agent moved to the top of the order. Once saved, every kind
 * is listed, so alpacawork's order no longer moves the person's choice of first agent when one is installed or signed in
 * later, or they come back.
 */
export function chosenAgents(agents: readonly AgentDraft[], rows: readonly StartAgent[], on: AgentSwitches, first: string | null): AgentDraft[] | null {
  const switchable = new Set(rows.filter(row => row.configured && row.status !== "missing").map(row => row.name));
  let next = agents.map(agent => switchable.has(agent.name) && (agent.enabled ?? true) !== !!on[agent.name] ? { ...agent, enabled: !!on[agent.name] } : agent);
  const listedKinds = new Set(agents.map(agent => draftAdapter(agent)));
  const added = BUILTIN_ADAPTER_IDS.filter(kind => !listedKinds.has(kind)).map(kind => {
    const row = rows.find(each => !each.configured && each.adapter === kind);
    return { ...newAgentDraft(kind, kind, kind), enabled: !!row && canWork(row) && !!on[row.name] };
  });
  next = placeByKind(next, added, agent => draftAdapter(agent));
  // At the very top, so no agent before it (off now, or signed in later) can take its place.
  const firstId = next.find(agent => agent.name === first)?.id;
  if (firstId && next[0]?.id !== firstId) next = withFirstAgent(next, firstId);
  const same = next.length === agents.length && next.every((agent, at) => agent === agents[at]);
  return same ? null : next;
}

/** Product names of the kinds setup finds; an agent config.yaml names otherwise keeps its own name. */
export const agentDisplayName = (name: string) => Object.hasOwn(AGENT_NAMES, name) ? AGENT_NAMES[name as keyof typeof AGENT_NAMES].product : name;
