import { z } from 'zod';
/** Admission's selection policy, also used by future browser controls. No configuration or I/O. */
import { selectionSchema, type Selection, type CompiledAgentSetting } from './agent-settings.js';

export const agentChoiceSchema = z.object({
  key: z.string().min(1), candidates: z.array(z.string().nullable()), initial: z.string().nullable(),
  required: z.boolean(), active: z.boolean(),
}).strict();
export const launchChoicesSchema = z.array(agentChoiceSchema);
export type AgentChoice = z.infer<typeof agentChoiceSchema>;
export { selectionProblemSchema, selectionRequiredReasonSchema } from '@alpacawork/core/selection';
import type { SelectionProblem } from '@alpacawork/core/selection';
export type { SelectionProblem } from '@alpacawork/core/selection';
export class SelectionRequired extends Error {
  readonly code = 'selection_required';
  constructor(readonly problems: SelectionProblem[]) { super('Previous selections require a new choice'); }
}
export class InvalidAgentSelection extends Error {
  readonly code = 'invalid_selection';
  constructor(readonly key: string, readonly value: unknown, readonly candidates: (string | null)[], message = 'Invalid explicit selection') {
    super(`${message}: ${key}`);
  }
}
export class AgentUnavailable extends Error {
  readonly code = 'agent_unavailable';
  constructor() { super('Disabled agent cannot accept a new launch'); }
}
/**
 * What choosing reads: the rows options reference, in resolved parameter order; the rows each model omits (`without`); and the
 * effective `params` keys, which distinguish a previous row the options stopped using from one removed. Built
 * from a compiled setting here, or received as the API's projection of one (a profile's choices and without).
 */
export type SelectionOffer = { choices: readonly AgentChoice[]; without?: Readonly<Record<string, readonly string[]>>; params?: readonly string[] };
export function selectionOffer(compiled: CompiledAgentSetting): SelectionOffer {
  const choices = Object.entries(compiled.setting.params).filter(([key]) => compiled.references.all.has(key)).map(([key, values]) => {
    // A leading `-` offers leaving a row out. An optional row with no values offers only that choice.
    const required = compiled.references.required.has(key);
    const candidates = values.length || required ? values.map(value => value === '-' ? null : value) : [null];
    return { key, candidates, initial: candidates[0] ?? null, required, active: true };
  });
  return { choices, without: compiled.setting.without, params: Object.keys(compiled.setting.params) };
}
function suppressedParams(offer: Pick<SelectionOffer, 'without'>, model: string | null) {
  const without = offer.without ?? {};
  return new Set(model !== null && Object.hasOwn(without, model) ? without[model] : []);
}
/** The offer's rows, each active unless `model` omits it. */
export function offeredChoices(offer: SelectionOffer, model: string | null = null): AgentChoice[] {
  const suppressed = suppressedParams(offer, model);
  return offer.choices.map(choice => ({ ...choice, active: !suppressed.has(choice.key) }));
}
export function agentChoices(compiled: CompiledAgentSetting, model: string | null = null): AgentChoice[] {
  return offeredChoices(selectionOffer(compiled), model);
}
/** The coordinator starts on the agent's initial values, with low effort where the first model supports it. */
export function coordinatorStartValues(offer: SelectionOffer): Selection {
  const { values, choices } = resolveOfferedSelection(offer);
  const effort = choices.find(choice => choice.key === 'effort');
  return effort?.active && effort.candidates.includes('low') ? { ...values, effort: 'low' } : values;
}
export type ResolvedAgentSelection = {
  /** Preserve latent values even when without makes them inactive. */
  values: Selection;
  /** Only these effective values go into the options resolver. */
  effective: Selection;
  choices: AgentChoice[];
};

/** Project selected values without revalidating candidates or filling in defaults for a saved Run. */
export function effectiveAgentValues(offer: Pick<SelectionOffer, 'without'>, values: Selection): Selection {
  const suppressed = suppressedParams(offer, values.model ?? null);
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, suppressed.has(key) ? null : value]));
}

/** Explicit commands → conversation's previous values → defaults for newly introduced keys.
 * A removed/unused old key requires a new conversation; never silently discard it.
 */
export function resolveAgentSelection(compiled: CompiledAgentSetting, explicit: Selection = {}, previous: Selection = {}): ResolvedAgentSelection {
  if (compiled.setting.enabled === false) throw new AgentUnavailable();
  return resolveOfferedSelection(selectionOffer(compiled), explicit, previous);
}
/** The same rule on an offer alone (an enabled agent's, as the screen receives it). */
export function resolveOfferedSelection(offer: SelectionOffer, explicit: Selection = {}, previous: Selection = {}): ResolvedAgentSelection {
  const parsed = selectionSchema.safeParse(explicit);
  if (!parsed.success) {
    const problem = parsed.error.issues[0]!;
    const key = String(problem.path[0] ?? '');
    throw new InvalidAgentSelection(key, Object.hasOwn(explicit, key) ? explicit[key] : undefined, [], problem.message);
  }
  const choices = offeredChoices(offer); const byKey = new Map(choices.map(choice => [choice.key, choice]));
  for (const [key, value] of Object.entries(explicit)) {
    const choice = byKey.get(key);
    if (!choice || !choice.candidates.includes(value)) throw new InvalidAgentSelection(key, value, choice?.candidates ?? []);
  }
  const problems: SelectionProblem[] = [];
  for (const [key, value] of Object.entries(previous)) {
    if (Object.hasOwn(explicit, key)) continue;
    const choice = byKey.get(key);
    if (!choice) problems.push({ key, previous: value, candidates: [],
      reason: offer.params?.includes(key) ? 'unused' : 'removed', recovery: 'new_conversation' });
    else if (!choice.candidates.includes(value)) problems.push({ key, previous: value, candidates: choice.candidates,
      reason: value === null ? 'null_required' : 'invalid_value', recovery: 'select_value' });
  }
  if (problems.length) throw new SelectionRequired(problems);
  const values: Selection = Object.fromEntries(choices.map(choice => [choice.key,
    Object.hasOwn(explicit, choice.key) ? explicit[choice.key]! : Object.hasOwn(previous, choice.key) ? previous[choice.key]! : choice.initial]));
  const activeChoices = offeredChoices(offer, values.model ?? null);
  return { values, effective: effectiveAgentValues(offer, values), choices: activeChoices };
}
