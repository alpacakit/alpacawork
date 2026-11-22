import { InvalidAgentSelection, offeredChoices, resolveOfferedSelection, SelectionRequired, type AgentChoice, type SelectionOffer, type SelectionProblem } from "@alpacawork/contract/agent-selection";
import type { Selection } from "@alpacawork/contract/agent-settings";

/**
 * Where a send's values start from. `new`: a launch with no conversation behind it; `hints` are the person's last
 * choices for the agent (coordinatorStart), a convenience that the config may have outgrown. `continue`: the
 * conversation's previous launch values (its Run's launch.values). Hints never stand in for them.
 */
export type SelectionBasis = { kind: "new"; hints: Readonly<Record<string, string | null>> }
  | { kind: "continue"; previous: Selection };

/**
 * What a picker shows and what its send carries. `choices`: the rows the shown model leaves active, in the offer's order.
 * `shown`: each active row's value; a row to choose again has none. `send`: for a new launch, what is shown (the launch
 * is what the person saw); going on, only the values changed here, never a copy of the conversation's previous values.
 * `problems`: previous values the config no longer offers (contract SelectionProblem), never filled with a default.
 */
export type LaunchSelection = {
  choices: AgentChoice[];
  shown: Selection;
  send: Selection;
  problems: SelectionProblem[];
};

/** Values the current choices still offer; the rest are stale (an older config, another tab) and dropped. */
function offeredValues(offer: SelectionOffer, values: Readonly<Record<string, string | null>>): Selection {
  const choices = new Map(offeredChoices(offer).map(choice => [choice.key, choice]));
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => choices.get(key)?.candidates.includes(value)));
}

/**
 * Where a new coordinator conversation starts for one agent: the values the person last chose for it that the agent
 * still offers; for a row never chosen or no longer offered, the value the agent's first row in the AI stack names
 * (`initial`); else the lightest effort (`low`) when the agent offers it, else the row's first value. It names every
 * row, so the coordinator starts on what the person sees.
 */
export function coordinatorStart(offer: SelectionOffer, remembered: Readonly<Record<string, string | null>> | undefined,
  initial: Readonly<Record<string, string | null>> = {}): Selection {
  const first = Object.fromEntries(offeredChoices(offer).flatMap(choice => choice.candidates.length ? [[choice.key, choice.candidates[0] ?? null]] : []));
  return offeredValues(offer, { ...first, effort: "low", ...offeredValues(offer, initial), ...offeredValues(offer, remembered ?? {}) });
}

/** A kind's model candidates as the picker names them: written order, no "none". */
export function modelCandidates(offer: SelectionOffer): string[] {
  return offeredChoices(offer).find(choice => choice.key === "model")?.candidates.filter((value): value is string => value !== null) ?? [];
}

/**
 * The person's own changes, checked by the contract's own rule for an explicit value. One the settings no longer offer
 * stays as a value to choose again, never quietly replaced; only a row the settings dropped has nothing to choose.
 */
function checkChanges(offer: SelectionOffer, changes: Readonly<Record<string, string | null>>) {
  const chosen: Selection = {}; const unsettled: SelectionProblem[] = [];
  for (const [key, value] of Object.entries(changes)) {
    try { resolveOfferedSelection(offer, { [key]: value }); chosen[key] = value; } catch (error) {
      if (!(error instanceof InvalidAgentSelection)) throw error;
      if (error.candidates.length) unsettled.push({ key, previous: value, candidates: error.candidates,
        reason: value === null ? "null_required" : "invalid_value", recovery: "select_value" });
    }
  }
  return { chosen, unsettled };
}

/** The admission rule itself (contract), applied to what the screen knows; no second copy of its order. Hints
 * that went stale fall back quietly (they were never chosen for this launch); the person's changes do not. */
export function launchSelection(offer: SelectionOffer, basis: SelectionBasis, changes: Readonly<Record<string, string | null>> = {}): LaunchSelection {
  const { chosen, unsettled } = checkChanges(offer, changes);
  const explicit = basis.kind === "new" ? { ...offeredValues(offer, basis.hints), ...chosen } : chosen;
  const settle = (problems: readonly SelectionProblem[]) => new Set(problems.map(problem => problem.key));
  const previous = Object.fromEntries(Object.entries(basis.kind === "continue" ? basis.previous : {})
    .filter(([key]) => !settle(unsettled).has(key)));
  let problems: SelectionProblem[] = [...unsettled];
  let resolved;
  try { resolved = resolveOfferedSelection(offer, explicit, previous); } catch (error) {
    if (!(error instanceof SelectionRequired)) throw error;
    problems = [...unsettled, ...error.problems];
    const open = settle(error.problems);
    resolved = resolveOfferedSelection(offer, explicit, Object.fromEntries(Object.entries(previous).filter(([key]) => !open.has(key))));
  }
  // A row to choose again shows none rather than today's first.
  const open = settle(problems);
  for (const key of open) delete resolved.values[key];
  // The rows the chosen model uses, and a row the contract asks to choose again even when the model leaves it out: it
  // can be settled there, then it goes back out of sight. Only active rows' values are shown and launched.
  const choices = resolved.choices.filter(choice => choice.active || open.has(choice.key));
  const shown = Object.fromEntries(choices.filter(choice => choice.active && Object.hasOwn(resolved.values, choice.key))
    .map(choice => [choice.key, resolved.values[choice.key]!]));
  return { choices, shown, send: basis.kind === "new" ? shown : chosen, problems };
}

/** The one rule every send meets: a selection with a value to settle does not go (the picker opens instead). */
export const selectionReady = (selection: Pick<LaunchSelection, "problems">): boolean => selection.problems.length === 0;

/** What to say about them: when the conversation cannot go on, only that, since choosing again would not let it go. */
export function problemsToSay(problems: readonly SelectionProblem[]): SelectionProblem[] {
  const ended = problems.filter(problem => problem.recovery === "new_conversation");
  return ended.length ? ended : [...problems];
}
