import { isDeepStrictEqual } from 'node:util';
import { compileAgentSetting, resolveAgentSelection, selectionOffer, type AiRow, type AiStackPrefix } from '@alpacawork/contract';
import { PROBLEM_CODE, Problem } from '@alpacawork/core';
import { validateAgentSelection, type AgentsSettings } from './agents-settings.js';

/** Expand explicitly named rows, stopping at the first boundary before reaching lower-priority settings. */
export function aiRows(config: AgentsSettings, ...prefixes: readonly (AiStackPrefix | undefined)[]): AiRow[] {
  const rows: AiRow[] = [];
  for (const prefix of prefixes) for (const row of prefix ?? []) {
    if (row === 'stop') return rows;
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
    rows.push({ agent: row.agent, values: resolveAgentSelection(compiled, values).values });
  }
  return [...rows, ...config.aiStack ?? []];
}

/** Snapshot the first launch and following rows, ignoring duplicated effective selections. */
export function freezeAiStack(config: AgentsSettings, first: AiRow, following = config.aiStack ?? []): AiRow[] | undefined {
  if (!following.length) return undefined;
  const seen = new Map<string, object[]>();
  return [first, ...following].flatMap(row => {
    const compiled = compileAgentSetting(row.agent, config.agents[row.agent]);
    const selection = resolveAgentSelection(compiled, row.values);
    const previous = seen.get(row.agent) ?? [];
    if (previous.some(values => isDeepStrictEqual(values, selection.effective))) return [];
    seen.set(row.agent, [...previous, selection.effective]);
    return [{ agent: row.agent, values: selection.values }];
  });
}
