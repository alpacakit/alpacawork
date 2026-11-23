import { InvalidAgentSelection, offeredChoices, resolveOfferedSelection, type AgentChoice, type SelectionOffer, type SelectionProblem } from "@alpacawork/contract/agent-selection";
import type { Selection } from "@alpacawork/contract/agent-settings";

/**
 * What a new placement's launch choice shows. `choices`: the rows the chosen model leaves active, in the offer's order,
 * and a row whose chosen value the settings no longer offer (to be chosen again, even one the model leaves out).
 * `shown`: each active row's value, what the placement is sent with; a row to choose again has none. `problems`: the
 * chosen values the settings no longer offer (contract SelectionProblem), never filled with a default.
 */
export type LaunchSelection = { choices: AgentChoice[]; shown: Selection; problems: SelectionProblem[] };

/** A kind's model candidates as the choice names them: written order, no "none". */
export function modelCandidates(offer: SelectionOffer): string[] {
  return offeredChoices(offer).find(choice => choice.key === "model")?.candidates.filter((value): value is string => value !== null) ?? [];
}

/**
 * The person's changes on the contract's own rule (resolveOfferedSelection): a value the settings offer is taken; one
 * they no longer offer stays to be chosen again, never quietly replaced; a row the settings dropped has nothing to choose.
 */
export function launchSelection(offer: SelectionOffer, changes: Readonly<Record<string, string | null>> = {}): LaunchSelection {
  const chosen: Selection = {}, problems: SelectionProblem[] = [];
  for (const [key, value] of Object.entries(changes)) {
    try { resolveOfferedSelection(offer, { [key]: value }); chosen[key] = value; } catch (error) {
      if (!(error instanceof InvalidAgentSelection)) throw error;
      if (error.candidates.length) problems.push({ key, previous: value, candidates: error.candidates,
        reason: value === null ? "null_required" : "invalid_value", recovery: "select_value" });
    }
  }
  const resolved = resolveOfferedSelection(offer, chosen), open = new Set(problems.map(problem => problem.key));
  const choices = resolved.choices.filter(choice => choice.active || open.has(choice.key));
  const shown = Object.fromEntries(choices.filter(choice => choice.active && !open.has(choice.key))
    .map(choice => [choice.key, resolved.values[choice.key]!]));
  return { choices, shown, problems };
}

/** A selection goes only with no value to choose again. */
export const selectionReady = (selection: Pick<LaunchSelection, "problems">): boolean => selection.problems.length === 0;

/** What to say about them: when the conversation cannot go on, only that, since choosing again would not let it go. */
export function problemsToSay(problems: readonly SelectionProblem[]): SelectionProblem[] {
  const ended = problems.filter(problem => problem.recovery === "new_conversation");
  return ended.length ? ended : [...problems];
}
