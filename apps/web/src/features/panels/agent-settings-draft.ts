import { isMap, isNode, isScalar, isSeq, parseDocument, type Document, type Pair, type YAMLMap } from 'yaml';
import { AGENT_ADAPTERS, LAUNCH_MODES, type BuiltinAdapterId, type LaunchMode } from '@alpacawork/contract/agent-adapters';
import { agentSettingsSchema, agentSettingSchemaFor, agentSettingShapeSchema, agentSettingOverrides,
  compileAgentSetting, parseParamValues, resolveAgentSetting, sameSettingValues, settingAdapter, type ResolvedAgentSetting,
  type WrittenAgentSetting } from '@alpacawork/contract/agent-settings';
import { completeOptionReferences, missingOptionParams, parseLaunchOptions, optionReferences, InvalidLaunchOptions } from '@alpacawork/contract/launch-options';
import { selectionOffer, type SelectionOffer } from '@alpacawork/contract/agent-selection';
import { ZodError } from 'zod';
import { agentDraftIssueDependsOnUnreadableParam } from './agent-settings-issues';

/** `written` marks a value as read from config.yaml and untouched since: written down, it no longer follows the
 * adapter's default even when it equals it, until the field is edited or restored. */
export type ParamRowDraft = { id: string; originalKey?: string; key: string; values: string; written?: true };
export type AgentOptionsDraft = { base?: string; start: string; resume: string };
export type AgentDraft = {
  id: string; originalName?: string; name: string; adapter?: BuiltinAdapterId; enabled?: boolean; command?: string;
  params: ParamRowDraft[]; env?: string[]; envWritten?: true; without?: WrittenAgentSetting['without']; options?: AgentOptionsDraft;
};
/** The source is a snapshot for comment-preserving writes; the entries alone own unsaved input. */
export type AgentsDraft = { source: string; agents: AgentDraft[]; root?: 'agents' };
export type AgentDraftIssue = {
  agentId?: string; rowId?: string; field: 'yaml' | 'name' | 'adapter' | 'enabled' | 'command' | 'key' | 'values' | 'env' | 'without' | 'options' | LaunchMode | 'base';
  message: string; index?: number; path?: PropertyKey[]; code?: string;
};
export type DraftResult<T> = { ok: true; value: T } | { ok: false; issues: AgentDraftIssue[] };

function toDraft(name: string, setting: WrittenAgentSetting, id: string, existing: boolean): AgentDraft {
  const adapter = settingAdapter(name, setting);
  const effective = adapter === null ? setting : resolveAgentSetting(adapter, setting);
  return { id, ...(existing ? { originalName: name } : {}), name, adapter: setting.adapter, enabled: setting.enabled,
    ...(setting.command === undefined ? {} : { command: setting.command }),
    params: Object.entries(effective.params ?? {}).map(([key, values], index) => ({ id: `${id}-param-${index}`,
      originalKey: key, key, values: values.join(', '), ...(existing && Object.hasOwn(setting.params ?? {}, key) ? { written: true as const } : {}) })),
    env: effective.env?.slice(), ...(existing && setting.env !== undefined ? { envWritten: true as const } : {}), without: setting.without && structuredClone(setting.without),
    options: setting.options && { ...setting.options } };
}
export function newAgentDraft(name: string, adapter: BuiltinAdapterId, id: string): AgentDraft {
  return toDraft(name, name === adapter ? {} : { adapter }, id, false);
}
export const draftAdapter = (agent: AgentDraft) => settingAdapter(agent.name, agent);
export function draftOptions(agent: AgentDraft): Record<LaunchMode, string> | undefined {
  const adapter = draftAdapter(agent);
  return agent.options ?? (adapter ? AGENT_ADAPTERS[adapter].options : undefined);
}
function defaultDraftParam(agent: AgentDraft, key: string): readonly string[] | undefined {
  const adapter = draftAdapter(agent);
  if (adapter === null) return undefined;
  const params = AGENT_ADAPTERS[adapter].defaultParams;
  return Object.hasOwn(params, key) ? params[key] : undefined;
}
export function isDefaultParam(agent: AgentDraft, key: string): boolean {
  return defaultDraftParam(agent, key) !== undefined;
}
/** Whether the row follows the adapter's default, so an update that changes the default changes it too. */
export function followsDefaultParam(agent: AgentDraft, row: ParamRowDraft): boolean {
  if (row.written) return false;
  try { return sameSettingValues(parseParamValues(row.values), defaultDraftParam(agent, row.key)); }
  catch (error) {
    if (!(error instanceof ZodError)) throw error;
    return false;
  }
}
export function resetDraftParam(agent: AgentDraft, rowId: string): AgentDraft {
  const row = agent.params.find(candidate => candidate.id === rowId);
  const values = row && defaultDraftParam(agent, row.key);
  if (!row || values === undefined) return agent;
  return { ...agent, params: agent.params.map(candidate => candidate === row ? editDraftParam(row, { values: values.join(', ') }) : candidate) };
}
/** Any edit of a row makes its value decide again whether it follows the default. */
export function editDraftParam(row: ParamRowDraft, change: Partial<Pick<ParamRowDraft, 'key' | 'values'>>): ParamRowDraft {
  const { written: _written, ...rest } = row;
  return { ...rest, ...change };
}
/**
 * What a launch of the agent offers to choose, as the contract reads it (`SelectionOffer`): the AI stacks' rows are read
 * and checked against it by the contract's own rules, as serve checks them. Null while the agent's settings do not read.
 */
export function agentOffer(agent: AgentDraft): SelectionOffer | null {
  const read = agentSettingSchemaFor(agent.name).safeParse(settingInput(agent).input);
  return read.success ? selectionOffer(compileAgentSetting(agent.name, read.data)) : null;
}
export function editDraftEnv(agent: AgentDraft, env: string[]): AgentDraft {
  const { envWritten: _written, ...rest } = agent;
  return { ...rest, env };
}
export function followsDefaultEnv(agent: AgentDraft): boolean {
  const adapter = draftAdapter(agent);
  if (adapter === null || agent.envWritten) return false;
  const defaults = AGENT_ADAPTERS[adapter].defaultEnv;
  return sameSettingValues(agent.env ?? defaults, defaults);
}
export function resetDraftEnv(agent: AgentDraft): AgentDraft {
  const adapter = draftAdapter(agent);
  return adapter === null ? agent : editDraftEnv(agent, [...AGENT_ADAPTERS[adapter].defaultEnv]);
}
/** Automatically discovered rows get deterministic identities, distinct from existing rows. */
export function updateDraftOptions(agent: AgentDraft, options: AgentOptionsDraft): AgentDraft {
  const params = Object.fromEntries(agent.params.map(row => [row.key, true]));
  const additions = missingOptionParams(params, options.start, options.resume);
  const ids = new Set(agent.params.map(row => row.id));
  return { ...agent, options, params: [...agent.params, ...additions.map(key => {
    let id = `${agent.id}-auto-${key}`;
    while (ids.has(id)) id += '-';
    ids.add(id);
    return { id, key, values: '' };
  })] };
}
export function beginDraftOptionsEdit(agent: AgentDraft, base?: string): AgentDraft {
  const options = draftOptions(agent);
  return options ? updateDraftOptions(agent, { ...options, base }) : agent;
}
export function resetDraftOptions(agent: AgentDraft): AgentDraft {
  const { options: _options, ...rest } = agent;
  return rest;
}
export function unusedParamReason(agent: AgentDraft, key: string): 'adapter' | 'options' | null {
  const options = draftOptions(agent);
  if (options && completeOptionReferences(options.start, options.resume).includes(key)) return null;
  return agent.options ? 'options' : 'adapter';
}
export function isOptionalDraftParam(agent: AgentDraft, key: string): boolean {
  const options = draftOptions(agent);
  if (!options) return false;
  try {
    const refs = LAUNCH_MODES.map(mode => optionReferences(parseLaunchOptions(options[mode])));
    return refs.some(ref => ref.all.has(key)) && !refs.some(ref => ref.required.has(key));
  } catch (error) {
    if (!(error instanceof InvalidLaunchOptions)) throw error;
    return false;
  }
}

function fieldIssue(agent: AgentDraft, path: PropertyKey[], message: string, code?: string): AgentDraftIssue {
  const [field, key, index] = path;
  const row = field === 'params' ? agent.params.find(row => row.key === key) : undefined;
  const target = field === 'params' ? (row ? 'values' : 'key')
    : field === 'options' ? (key === 'start' || key === 'resume' || key === 'base' ? key : 'options')
    : field === 'adapter' || field === 'enabled' || field === 'command' || field === 'env' || field === 'without' ? field : 'name';
  return { agentId: agent.id, rowId: row?.id, field: target, message, code, path: [agent.name, ...path],
    ...(field === 'env' && typeof key === 'number' ? { index: key } : typeof index === 'number' ? { index } : {}) };
}
/** `root` selects the API's agents: block; the mapping form is also useful for isolated components. */
export function readAgentsDraft(source: string, root?: 'agents'): DraftResult<AgentsDraft> {
  const doc = parseDocument(source);
  if (doc.errors.length) return { ok: false, issues: doc.errors.map(error => ({ field: 'yaml', message: error.message })) };
  let data: unknown;
  try { const value = doc.toJS(); data = root ? value?.[root] : value; }
  catch (error) { return { ok: false, issues: [{ field: 'yaml', message: String(error) }] }; }
  // Each agent's shape is read on its own below: errors within one are editable in its rows.
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return { ok: false, issues: [{ field: 'yaml', message: 'Expected an agents mapping' }] };
  const agents: AgentDraft[] = [];
  for (const [name, input] of Object.entries(data)) {
    const setting = agentSettingShapeSchema.safeParse(input);
    if (!setting.success) return { ok: false, issues: setting.error.issues.map(issue => ({ field: 'yaml', message: `${name}: ${issue.message}` })) };
    agents.push(toDraft(name, setting.data, `agent-${agents.length}`, true));
  }
  return { ok: true, value: { source, agents, ...(root ? { root } : {}) } };
}

/** One agent's setting as its draft writes it, and the issues of its rows that do not read (their values left empty). */
function settingInput(agent: AgentDraft) {
  const issues: AgentDraftIssue[] = [];
  const params: [string, string[]][] = [];
  const keys = new Set<string>();
  const unreadable = new Set<string>();
  for (const row of agent.params) {
    if (keys.has(row.key)) issues.push({ agentId: agent.id, rowId: row.id, field: 'key', message: 'Duplicate param name' });
    keys.add(row.key);
    try { params.push([row.key, parseParamValues(row.values)]); }
    catch (error) {
      if (!(error instanceof ZodError)) throw error;
      unreadable.add(row.key);
      // Retain the row for contextual validation; its candidate errors are already attached below.
      params.push([row.key, []]);
      error.issues.forEach(issue => issues.push({ agentId: agent.id, rowId: row.id, field: 'values', message: issue.message,
        ...(typeof issue.path[0] === 'number' ? { index: issue.path[0] } : {}) }));
    }
  }
  const input = { ...(agent.adapter === undefined ? {} : { adapter: agent.adapter }),
    ...(agent.enabled === undefined ? {} : { enabled: agent.enabled }),
    ...(agent.command === undefined ? {} : { command: agent.command }), params: Object.fromEntries(params),
    ...(agent.env === undefined ? {} : { env: agent.env }), ...(agent.without === undefined ? {} : { without: agent.without }),
    ...(agent.options === undefined ? {} : { options: agent.options }) };
  return { input, unreadable, issues };
}
/** Only representation errors live here (duplicate rows/names cannot be represented by a record).
 * All domain validation belongs to the shared schemas and parseParamValues. */
function draftSettings(draft: AgentsDraft): DraftResult<Record<string, ResolvedAgentSetting>> {
  const issues: AgentDraftIssue[] = [];
  const entries: [string, ResolvedAgentSetting][] = [];
  const names = new Set<string>();
  for (const agent of draft.agents) {
    if (names.has(agent.name)) issues.push({ agentId: agent.id, field: 'name', message: 'Duplicate agent name' });
    names.add(agent.name);
    const { input, unreadable, issues: rows } = settingInput(agent);
    issues.push(...rows);
    const result = agentSettingSchemaFor(agent.name).safeParse(input);
    if (!result.success) for (const issue of result.error.issues) {
      // Zod reports record-key failures on params.<key>, as invalid_key.
      const mapped = fieldIssue(agent, issue.path, issue.message, issue.code);
      if (issue.code === 'invalid_key' && issue.path[0] === 'params') mapped.field = 'key';
      if (!agentDraftIssueDependsOnUnreadableParam(mapped, unreadable)) issues.push(mapped);
    }
    else entries.push([agent.name, result.data]);
  }
  if (issues.length) return { ok: false, issues };
  const settings = Object.fromEntries(entries);
  const result = agentSettingsSchema.safeParse(settings);
  if (!result.success) return { ok: false, issues: result.error.issues.map(issue => {
    const agent = draft.agents.find(agent => agent.name === issue.path[0]);
    return agent ? fieldIssue(agent, issue.path.slice(1), issue.message, issue.code) : { field: 'yaml', message: issue.message };
  }) };
  return { ok: true, value: result.data };
}
export function validateAgentsDraft(draft: AgentsDraft): AgentDraftIssue[] {
  const result = draftSettings(draft);
  return result.ok ? [] : result.issues;
}

/** Update existing nodes rather than replacing the map; unchanged nodes keep their comments and style. */
function syncMap(doc: Document, map: YAMLMap, entries: { key: string; originalKey?: string | null; value: unknown }[]): void {
  const previous = new Map(map.items.map(pair => [isScalar(pair.key) ? pair.key.value : pair.key, pair]));
  const ordered: Pair[] = [];
  for (const entry of entries) {
    // null denotes a newly added form row/profile, which must never reuse a renamed source node.
    const pair = entry.originalKey === null ? undefined : previous.get(entry.originalKey ?? entry.key);
    if (!pair) { const node = doc.createPair(entry.key, entry.value); ordered.push(node); continue; }
    if (isScalar(pair.key)) pair.key.value = entry.key;
    const current = pair.value;
    if (isMap(current) && entry.value && typeof entry.value === 'object' && !Array.isArray(entry.value)) {
      syncMap(doc, current, Object.entries(entry.value).map(([key, value]) => ({ key, value })));
    } else if (isSeq(current) && Array.isArray(entry.value)) {
      const old = [...current.items];
      current.items = entry.value.map(value => old.find(node => isScalar(node) && node.value === value) ?? doc.createNode(value));
    } else if (isScalar(current) && (entry.value === null || typeof entry.value !== 'object')) current.value = entry.value;
    else {
      const node = doc.createNode(entry.value);
      if (isNode(current)) {
        node.comment = current.comment; node.commentBefore = current.commentBefore;
      }
      pair.value = node;
    }
    ordered.push(pair);
  }
  if (map.flow && map.items.length === 0 && ordered.length > 0) map.flow = false;
  map.items = ordered;
}
export function writeAgentsDraft(draft: AgentsDraft): DraftResult<string> {
  const result = draftSettings(draft);
  if (!result.ok) return result;
  const doc: Document = parseDocument(draft.source);
  if (doc.errors.length) return { ok: false, issues: doc.errors.map(error => ({ field: 'yaml', message: error.message })) };
  if (!draft.root && !isMap(doc.contents)) doc.contents = doc.createNode({});
  const map = draft.root ? doc.get(draft.root, true) : doc.contents;
  if (!isMap(map)) return { ok: false, issues: [{ field: 'yaml', message: 'Expected an agents mapping' }] };
  const settings = Object.fromEntries(draft.agents.map(agent =>
    [agent.name, agentSettingOverrides(draftAdapter(agent)!, result.value[agent.name]!)]));
  // Params need row identities for renamed keys. Synchronize them first, before the enclosing maps.
  for (const agent of draft.agents) {
    const written = settings[agent.name]!.params;
    const node = map.get(agent.originalName ?? agent.name, true);
    if (written && isMap(node)) {
      const params = node.get('params', true);
      if (isMap(params)) syncMap(doc, params, agent.params.filter(row => Object.hasOwn(written, row.key))
        .map(row => ({ key: row.key, originalKey: row.originalKey ?? null, value: written[row.key] })));
    }
  }
  syncMap(doc, map, draft.agents.map(agent => ({ key: agent.name, originalKey: agent.originalName ?? null, value: settings[agent.name] })));
  return { ok: true, value: doc.toString() };
}
