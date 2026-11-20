import type { Selection } from "@alpacawork/contract/agent-settings";
import type { SelectionOffer } from "@alpacawork/contract/agent-selection";
import type { CoordinatorConversation } from "@alpacawork/contract/coordinator";
import { useMemo } from "react";
import type { WorkspaceInfo } from "@/data/types";
import { useAgentObservations } from "@/data/queries";
import { useFrameSelector } from "@/data/workspace-store";
import { agentReadiness, takesRequests, type AgentObservations } from "@/features/panels/agent-status";

/**
 * The one place the screen's launch pickers read the server's agent data: each enabled agent, in config order, with
 * its choices (the contract's AgentChoice rows) and the rows each model omits (`without`). That is the offer the
 * contract's selection rule reads (resolveOfferedSelection), so the pickers decide by the same rule as admission.
 */
export type AgentOffer = { key: string; offer: SelectionOffer };
type Profile = WorkspaceInfo["profiles"][number];

const offers = new WeakMap<readonly Profile[], AgentOffer[]>();
export function agentOffers(profiles: readonly Profile[]): AgentOffer[] {
  let known = offers.get(profiles);
  if (!known) {
    known = profiles.map(({ key, choices, without }) => ({ key, offer: { choices, without } }));
    offers.set(profiles, known);
  }
  return known;
}

/** The enabled agents that can take requests (takesRequests): one the server saw signed out or without its CLI is not
 * offered, as if the settings did not enable it. Before the check answers, or when it cannot, every enabled one is. */
export function workingOffers(offers: readonly AgentOffer[], observations: AgentObservations | undefined): AgentOffer[] {
  return offers.filter(item => takesRequests(agentReadiness(observations?.availability?.[item.key])));
}

const NO_PROFILES: Profile[] = [];
/** What every launch picker offers: the enabled agents that can take requests, in config order. */
export function useAgentOffers(): AgentOffer[] {
  const enabled = agentOffers(useFrameSelector(data => data?.info.profiles) ?? NO_PROFILES);
  const observations = useAgentObservations();
  return useMemo(() => workingOffers(enabled, observations), [enabled, observations]);
}

/** The conversation's previous launch values (its latest saved Run's launch.values); null before any Run, or when that
 * Run cannot be read: then nothing is known to go on from, and a send carries only what is changed here. */
export function conversationSelection(conversation: CoordinatorConversation | null): Selection | null {
  return conversation?.previousValues ?? null;
}
