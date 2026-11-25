import { isDeepStrictEqual } from 'node:util';
import { compileAgentSetting, effectiveAgentValues, enabledAgents, resolveAgentSelection, selectionOffer,
  type AiRow, type AiStackPrefix, type Selection } from '@alpacawork/contract';
import { PROBLEM_CODE, Problem } from '@alpacawork/core';
import { validateAgentSelection, type AgentsSettings } from './agents-settings.js';

function resolveRow(config: AgentsSettings, row: Exclude<AiStackPrefix[number], 'stop'>): AiRow {
  const setting = Object.hasOwn(config.agents, row.agent) ? config.agents[row.agent] : undefined;
  if (!setting) throw new Problem(PROBLEM_CODE.invalidInput, `Agent ${row.agent} is not configured`, undefined,
    { reason: { kind: 'agent_not_configured', agent: row.agent } });
  const compiled = compileAgentSetting(row.agent, setting);
  const defaults = config.aiStack?.find(candidate => candidate.agent === row.agent)?.values;
  if (!defaults && row.values?.model === undefined && selectionOffer(compiled).choices.some(choice => choice.key === 'model'))
    throw new Problem(PROBLEM_CODE.invalidInput, `Choose a model for ${row.agent}`, undefined,
      { reason: { kind: 'invalid_selection', name: 'model', value: null } });
  const values = { ...defaults, ...row.values };
  validateAgentSelection(config, row.agent, values);
  return { agent: row.agent, values: resolveAgentSelection(compiled, values).values };
}

/**
 * The rows tasks run on when a request names none: the task stack, or with no stack the first enabled agent at its
 * default values. Placement picks its agent from it, and the screen's plan limits read it as the rows work goes on.
 */
export function defaultAiStack(config: Pick<AgentsSettings, 'agents' | 'aiStack'>): readonly AiRow[] {
  if (config.aiStack?.length) return config.aiStack;
  const first = enabledAgents(config.agents)[0];
  return first ? [{ agent: first[0], values: resolveAgentSelection(compileAgentSetting(...first)).values }] : [];
}

/** Expand explicitly named rows, stopping at the first boundary before reaching lower-priority settings. */
export function aiRows(config: AgentsSettings, ...prefixes: readonly (AiStackPrefix | undefined)[]): AiRow[] {
  return expandRows(config, prefixes, row => resolveRow(config, row));
}

function expandRows(config: AgentsSettings, prefixes: readonly (AiStackPrefix | undefined)[],
  resolve: (row: Exclude<AiStackPrefix[number], 'stop'>) => AiRow | undefined): AiRow[] {
  const rows: AiRow[] = [];
  for (const prefix of prefixes) for (const row of prefix ?? []) {
    if (row === 'stop') return rows;
    const value = resolve(row);
    if (value) rows.push(value);
  }
  return [...rows, ...config.aiStack ?? []];
}

/** A request with no alternatives may inherit a standing row, independently of obsolete alternatives. */
export function standingAiRows(config: AgentsSettings, placement: AiStackPrefix | undefined): AiRow[] {
  return expandRows(config, [placement], row => {
    try { return resolveRow(config, row); }
    catch (error) { if (!(error instanceof Problem)) throw error; }
  });
}

/** Snapshot the first launch and following rows, ignoring duplicated effective selections. */
export function freezeAiStack(config: AgentsSettings, first: AiRow, following = config.aiStack ?? []): AiRow[] | undefined {
  if (!following.length) return undefined;
  return distinctSelections(config, [first, ...following]).map(({ row, selection }) => ({ agent: row.agent, values: selection.values }));
}

/** Keep the first row for each effective launch, preserving the input representation. */
export function distinctAiRows(config: AgentsSettings, rows: readonly AiRow[]): AiRow[] {
  return distinctSelections(config, rows).map(({ row }) => row);
}

type AiLaunchIdentity = { agent: string; effective: Selection };

export function aiLaunchIdentity(config: AgentsSettings, row: AiRow): AiLaunchIdentity {
  const setting = Object.hasOwn(config.agents, row.agent) ? config.agents[row.agent] : undefined;
  return { agent: row.agent, effective: effectiveAgentValues(setting ?? {}, row.values) };
}

export function sameAiLaunch(left: AiLaunchIdentity, right: AiLaunchIdentity): boolean {
  return left.agent === right.agent && isDeepStrictEqual(left.effective, right.effective);
}

function distinctSelections(config: AgentsSettings, rows: readonly AiRow[]) {
  const seen: AiLaunchIdentity[] = [];
  return rows.flatMap(row => {
    const compiled = compileAgentSetting(row.agent, config.agents[row.agent]);
    const selection = resolveAgentSelection(compiled, row.values);
    const identity = { agent: row.agent, effective: selection.effective };
    if (seen.some(previous => sameAiLaunch(previous, identity))) return [];
    seen.push(identity);
    return [{ row, selection }];
  });
}
