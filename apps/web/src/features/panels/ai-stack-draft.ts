import type { AiRow } from '@alpacawork/contract';
import { InvalidAgentSelection, coordinatorStartValues, offeredChoices, resolveOfferedSelection, type SelectionOffer } from '@alpacawork/contract/agent-selection';
import { agentOffer, type AgentDraft, type AgentsDraft } from './agent-settings-draft';

/**
 * One row of the AI stack as the settings edit it: an agent and the value of each of its choices (null is "none", a
 * written `-`). `id` keeps a row's identity while rows move. The first row is where owners and members start; each
 * next row takes over when the one above stops on a usage limit or capacity.
 */
export type StackRowDraft = { id: string; agent: string; values: Record<string, string | null> };
/**
 * Why a row cannot be saved as it is: its agent is not in the settings (`missing`) or not enabled (`disabled`), or one
 * of its values is not among the agent's choices (`value`, with the row's key and the value).
 */
export type StackIssue = { rowId: string; kind: 'missing' | 'disabled' } | { rowId: string; kind: 'value'; key: string; value: string | null }
  | { rowId: null; kind: 'empty' };

let sequence = 0;
const nextId = () => `stack-${sequence++}`;

export const readStack = (rows: readonly AiRow[] | undefined): StackRowDraft[] =>
  (rows ?? []).map(row => ({ id: nextId(), agent: row.agent, values: { ...row.values } }));
type Values = Record<string, string | null>;
/**
 * A row's values as it is saved and checked: the values of what its agent has to choose now. A row being edited keeps
 * every value it holds (a choice its agent's options stop naming while they are edited comes back with its value);
 * only what is saved leaves out a value whose choice is gone. Its agent's settings unread: the row as it is.
 */
function savedValues(agents: readonly AgentDraft[], row: StackRowDraft): Values {
  const agent = agents.find(each => each.name === row.agent), offer = agent && agentOffer(agent);
  if (!offer) return { ...row.values };
  const keys = new Set(offer.choices.map(choice => choice.key));
  return Object.fromEntries(Object.entries(row.values).filter(([key]) => keys.has(key)));
}
/** The stack as config/set receives it, and the one form its rows are checked in: each row's saved values. */
export const writeStack = (rows: readonly StackRowDraft[], agents: readonly AgentDraft[]): AiRow[] =>
  rows.map(row => ({ agent: row.agent, values: savedValues(agents, row) }));
/** The contract's refusal of a value, or nothing: the one check serve makes of a row's values. */
const refuses = (offer: SelectionOffer, values: Readonly<Values>): boolean => {
  try { resolveOfferedSelection(offer, values); return false; }
  catch (error) { if (error instanceof InvalidAgentSelection) return true; throw error; }
};
/** The row's values the contract refuses (a value its agent no longer offers, or a row it no longer has), by key. */
const refusedKeys = (offer: SelectionOffer, values: Readonly<Values>): string[] =>
  Object.entries(values).filter(([key, value]) => refuses(offer, { [key]: value })).map(([key]) => key);

/**
 * One choice a row shows: those its model uses that have something to choose, and any whose value the contract refuses
 * (to be chosen again, even one the model leaves out). `value`: the row's, else the choice's first.
 */
export type RowChoice = { key: string; candidates: (string | null)[]; value: string | null; refused: boolean };
export function rowChoices(agent: AgentDraft, values: Readonly<Values>): RowChoice[] {
  const offer = agentOffer(agent);
  if (!offer) return [];
  const refused = new Set(refusedKeys(offer, values));
  const model = offer.choices.find(choice => choice.key === 'model');
  const chosen = refused.has('model') || !model ? null : Object.hasOwn(values, 'model') ? values.model! : model.initial;
  return offeredChoices(offer, chosen)
    .filter(choice => refused.has(choice.key) || choice.active && choice.candidates.some(value => value !== null))
    .map(choice => ({ key: choice.key, candidates: choice.candidates, refused: refused.has(choice.key),
      value: Object.hasOwn(values, choice.key) ? values[choice.key]! : choice.initial }));
}
/** Where a new row of `agent`, or a row switched to it, starts: every value the contract starts a launch of it on. */
export function startValues(agent: AgentDraft): Values {
  const offer = agentOffer(agent);
  return offer ? resolveOfferedSelection(offer).values : {};
}
/** Sets one choice of a row. The others stay, those the chosen model leaves out too, as the contract keeps them. */
export const withRowValue = (row: StackRowDraft, key: string, value: string | null): StackRowDraft => ({ ...row, values: { ...row.values, [key]: value } });
export const withRowAgent = (agent: AgentDraft, row: StackRowDraft): StackRowDraft => ({ ...row, agent: agent.name, values: startValues(agent) });
/** Where the input's AI starts on `agent`: the contract's one rule (`coordinatorStartValues`), read from the agent's card. */
export function coordinatorStart(agent: AgentDraft): Values {
  const offer = agentOffer(agent);
  return offer ? coordinatorStartValues(offer) : {};
}
const sameValues = (a: Values | null, b: Values) => !!a && Object.keys(a).length === Object.keys(b).length
  && Object.entries(a).every(([key, value]) => Object.hasOwn(b, key) && b[key] === value);
/** What a row launches with (the contract's effective values); null while the contract refuses the row. */
function launched(agents: readonly AgentDraft[], row: StackRowDraft): Values | null {
  const agent = agents.find(each => each.name === row.agent), offer = agent && agentOffer(agent), values = savedValues(agents, row);
  if (!offer || refuses(offer, values)) return null;
  return resolveOfferedSelection(offer, values).effective;
}

/**
 * The row "Add a fallback AI" adds: a copy of the last row, to edit from there, so adding never picks a model the person
 * did not choose (one kept for important work, say). Until changed it repeats the row above and is said to go unused.
 * With no row, the first enabled agent on `start`'s values (the list's own start).
 */
export function newStackRow(agents: readonly AgentDraft[], rows: readonly StackRowDraft[],
  start: (agent: AgentDraft) => Values = startValues): StackRowDraft | null {
  const last = rows.at(-1);
  if (last) return { id: nextId(), agent: last.agent, values: { ...last.values } };
  const first = agents.find(agent => agent.enabled !== false);
  return first ? { id: nextId(), agent: first.name, values: start(first) } : null;
}
/** The earlier row a row repeats: launched with the same values, it never runs, as the one above already stopped. */
export function repeatedRow(rows: readonly StackRowDraft[], index: number, agents: readonly AgentDraft[]): number | null {
  const row = rows[index]!, launch = launched(agents, row);
  if (!launch) return null;
  const found = rows.slice(0, index).findIndex(earlier => earlier.agent === row.agent && sameValues(launched(agents, earlier), launch));
  return found === -1 ? null : found;
}
export function moveRow(rows: readonly StackRowDraft[], index: number, by: -1 | 1): StackRowDraft[] {
  const to = index + by;
  if (to < 0 || to >= rows.length) return [...rows];
  const next = [...rows];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}
/** Agents renamed in their cards keep their rows: each row follows its agent's new name. No rename: `rows` itself. */
export function followRenames(rows: StackRowDraft[], before: AgentsDraft, after: AgentsDraft): StackRowDraft[] {
  const renamed = new Map(before.agents.flatMap(was => {
    const now = after.agents.find(agent => agent.id === was.id);
    return now && now.name !== was.name ? [[was.name, now.name] as const] : [];
  }));
  return renamed.size ? rows.map(row => renamed.has(row.agent) ? { ...row, agent: renamed.get(row.agent)! } : row) : rows;
}

/** What keeps the stack from being saved: no row while an agent is enabled, or a row the agents' settings no longer run. */
export function stackIssues(rows: readonly StackRowDraft[], agents: readonly AgentDraft[]): StackIssue[] {
  // With no enabled agent there is nothing to put in it: the stack waits, empty, for one to be enabled.
  if (!rows.length) return agents.some(agent => agent.enabled !== false) ? [{ rowId: null, kind: 'empty' }] : [];
  return rows.flatMap((row): StackIssue[] => {
    const agent = agents.find(each => each.name === row.agent);
    if (!agent) return [{ rowId: row.id, kind: 'missing' }];
    if (agent.enabled === false) return [{ rowId: row.id, kind: 'disabled' }];
    const offer = agentOffer(agent), values = savedValues(agents, row);
    return offer ? refusedKeys(offer, values).map(key => ({ rowId: row.id, kind: 'value' as const, key, value: values[key]! })) : [];
  });
}
