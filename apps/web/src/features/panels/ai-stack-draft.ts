import type { AiRow } from '@alpacawork/contract';
import { agentChoiceRows, type AgentDraft, type AgentsDraft } from './agent-settings-draft';

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
export const writeStack = (rows: readonly StackRowDraft[]): AiRow[] => rows.map(row => ({ agent: row.agent, values: { ...row.values } }));

const asValue = (candidate: string) => candidate === '-' ? null : candidate;
/** The choices a row of `agent` shows: those the launch uses, less the ones its chosen model leaves out. */
export function rowChoices(agent: AgentDraft, values: Readonly<Record<string, string | null>>) {
  const omitted = new Set(agent.without?.[values.model ?? ''] ?? []);
  return agentChoiceRows(agent).filter(choice => !omitted.has(choice.key))
    .map(choice => ({ key: choice.key, values: choice.values.map(asValue) }));
}
/** A row of `agent` on each choice's first value: what a newly added row, or a row switched to the agent, starts on. */
export function firstValues(agent: AgentDraft): Record<string, string | null> {
  const values: Record<string, string | null> = {};
  for (const choice of rowChoices(agent, values)) values[choice.key] = choice.values[0]!;
  // The first model may leave rows out, which were filled above before it was known.
  const kept = new Set(rowChoices(agent, values).map(choice => choice.key));
  return Object.fromEntries(Object.entries(values).filter(([key]) => kept.has(key)));
}
/** Sets one choice of a row; a model that leaves other choices out drops their values, and fills those it brings in. */
export function withRowValue(agent: AgentDraft, row: StackRowDraft, key: string, value: string | null): StackRowDraft {
  const values = { ...row.values, [key]: value };
  const choices = rowChoices(agent, values);
  return { ...row, values: Object.fromEntries(choices.map(choice => [choice.key,
    Object.hasOwn(values, choice.key) ? values[choice.key]! : choice.values[0]!])) };
}
export const withRowAgent = (agent: AgentDraft, row: StackRowDraft): StackRowDraft => ({ ...row, agent: agent.name, values: firstValues(agent) });

const same = (a: StackRowDraft, b: StackRowDraft) => a.agent === b.agent && JSON.stringify(Object.entries(a.values).sort()) === JSON.stringify(Object.entries(b.values).sort());
/**
 * The row "Add a fallback" adds: the first enabled agent and model not in the stack yet, so the new row is one that can
 * take over; when every model is in it, the first enabled agent as it starts.
 */
export function newStackRow(agents: readonly AgentDraft[], rows: readonly StackRowDraft[]): StackRowDraft | null {
  const enabled = agents.filter(agent => agent.enabled !== false);
  for (const agent of enabled) {
    const models = rowChoices(agent, {}).find(choice => choice.key === 'model')?.values ?? [undefined];
    for (const model of models) {
      const base = firstValues(agent);
      const row = { id: nextId(), agent: agent.name, values: model === undefined ? base : withRowValue(agent, { id: '', agent: agent.name, values: base }, 'model', model).values };
      if (!rows.some(each => each.agent === row.agent && each.values.model === row.values.model)) return row;
    }
  }
  return enabled[0] ? { id: nextId(), agent: enabled[0].name, values: firstValues(enabled[0]) } : null;
}
/** The earlier row a row repeats: launched the same, it never runs, as the one above already stopped. */
export const repeatedRow = (rows: readonly StackRowDraft[], index: number): number | null => {
  const found = rows.slice(0, index).findIndex(row => same(row, rows[index]!));
  return found === -1 ? null : found;
};
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
    const choices = rowChoices(agent, row.values);
    return Object.entries(row.values).flatMap(([key, value]) => {
      const choice = choices.find(each => each.key === key);
      return choice?.values.includes(value) ? [] : [{ rowId: row.id, kind: 'value' as const, key, value }];
    });
  });
}
