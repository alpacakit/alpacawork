import type { Selection } from "@alpacawork/contract/agent-settings";
import type { SelectionOffer } from "@alpacawork/contract/agent-selection";
import type { CoordinatorConversation } from "@alpacawork/contract/coordinator";
import type { WorkspaceInfo } from "@/data/types";

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

/** The conversation's previous launch values (its latest saved Run's launch.values); null before any Run, or when that
 * Run cannot be read: then nothing is known to go on from, and a send carries only what is changed here. */
export function conversationSelection(conversation: CoordinatorConversation | null): Selection | null {
  return conversation?.previousValues ?? null;
}
