import type { SelectionOffer } from "@alpacawork/contract/agent-selection";
import type { WorkspaceInfo } from "@/data/types";

/**
 * The one place the screen's launch choices read the server's agent data: each enabled agent, the AI stack's first
 * first, with its choices (the contract's AgentChoice rows) and the rows each model omits (`without`). That is the
 * offer the contract's selection rule reads (resolveOfferedSelection), so the choices decide by the same rule as
 * admission.
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
