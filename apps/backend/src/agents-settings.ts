/** config.yaml is input; each run keeps its own immutable launch snapshot. */
import { randomUUID } from 'node:crypto';
import { parseConfig, requireConfigBytes } from './config.js';
import { z } from 'zod';
import { Problem, PROBLEM_CODE, ExecutableUnavailable, redactSecrets, faultReason } from '@alpacawork/core';
import { CONFIG_FILE } from '@alpacawork/raw';
import type { AgentLaunch } from '@alpacawork/contract/agent-launch';
import type { RunRecord } from '@alpacawork/contract/run';
import { attachmentBytes, checkAgentsConfigText, DEFAULT_LIMITS, limitsShape,
  compileAgentSetting, prepareAgentLaunch, prepareCoordinatorLaunch,
  aiStackSchema, agentChoices, SelectionRequired, InvalidAgentSelection, AgentUnavailable, ConversationAdapterMismatch,
  type AiRow, type AgentSetting, type ResolvedAgentSetting, type Selection, type LaunchAdmission } from '@alpacawork/contract';
import { AGENT_ADAPTERS, builtinAdapterIdSchema } from '@alpacawork/contract/agent-adapters';
import { stringify } from 'yaml';
import { commandPrefix, launchCommand } from './agents/availability.js';
import type { DetectedSetupAgent } from './installation/setup-ai.js';
import { FileWriter } from './raw/storage.js';

export const AGENTS_TEMPLATE = stringify({ agents: { claude: {}, codex: {} } });

/**
 * Creation only: lists the adapters whose sign-in was confirmed, all enabled. Any other is left out rather than written
 * disabled, so the setup screen switches it from its own later check (on once signed in) instead of a stale `false`.
 */
export function initialAgentsTemplate(detected: readonly DetectedSetupAgent[]): string {
  return stringify({ agents: Object.fromEntries(detected.filter(agent => agent.status === 'ready').map(agent => [agent.id, {}])) });
}

const settingsSchema = z.object({
  limits: z.object(Object.fromEntries(Object.entries(limitsShape).map(([key, rule]) =>
    [key, rule.default(DEFAULT_LIMITS[key as keyof typeof DEFAULT_LIMITS])])) as
    { [K in keyof typeof limitsShape]: z.ZodDefault<z.ZodNumber> }).strict().prefault({}),
}).strict();
export type AgentsSettings = z.infer<typeof settingsSchema> & { agents: Record<string, ResolvedAgentSetting>; aiStack?: AiRow[] };
export const agentFields = (key: string, agent: AgentSetting) => agentChoices(compileAgentSetting(key, agent));
/** The selection data is one projection of the validated setting, in its original order. */
export function agentProfile(key: string, agent: AgentSetting) {
  const compiled = compileAgentSetting(key, agent);
  return { key, choices: agentChoices(compiled), without: compiled.setting.without };
}
export type AgentsSettingsResult = { ok: true; config: AgentsSettings } | { ok: false; error: Problem };

function invalid(error: unknown): Problem {
  return new Problem(PROBLEM_CODE.invalidSettings,
    `Invalid ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`, undefined,
    { cause: error, reason: faultReason(error) });
}
export function parseAgentsSettings(text: string): AgentsSettings {
  try {
    const { values } = parseConfig(text);
    const checked = checkAgentsConfigText(text);
    if (checked.agents === null) throw new Problem(PROBLEM_CODE.invalidSettings, checked.issues.map(issue =>
      `${issue.line === null ? '?' : issue.line}: ${issue.path}: ${issue.message}`).join('; '), undefined,
      { reason: { kind: 'config_invalid', path: CONFIG_FILE, issues: checked.issues.map(issue => ({
        code: issue.kind, path: issue.path, line: issue.line ?? undefined, diagnostic: redactSecrets(issue.message) })) } });
    const aiStack = values.aiStack === undefined ? undefined : aiStackSchema.parse(values.aiStack).map(row => {
      const setting = Object.hasOwn(checked.agents, row.agent) ? checked.agents[row.agent] : undefined;
      if (!setting) throw new Error(`The AI stack names an undefined agent: ${row.agent}`);
      const prepared = prepareAgentLaunch(compileAgentSetting(row.agent, setting), { mode: 'start', path: '/bin', explicit: row.values });
      return { agent: row.agent, values: prepared.launch.values };
    });
    return { ...settingsSchema.parse({ limits: values.limits }), agents: checked.agents, aiStack };
  } catch (error) { throw invalid(error); }
}
/**
 * The last text parsed and its settings. Serve reads config.yaml for each project's tree, each routing and each settle;
 * the file is small to read, while parsing and checking it costs more than the rest of a quiet project's read.
 */
let lastParsed: { text: string; config: AgentsSettings } | undefined;
export function readAgentsSettings(root: string): AgentsSettingsResult {
  let writer: FileWriter | undefined;
  try {
    writer = new FileWriter(root);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(requireConfigBytes(writer));
    if (lastParsed?.text !== text) lastParsed = { text, config: parseAgentsSettings(text) };
    return { ok: true, config: lastParsed.config };
  } catch (error) {
    return { ok: false, error: error instanceof Problem && error.code === PROBLEM_CODE.invalidSettings ? error : invalid(error) };
  } finally { writer?.close(); }
}
/** limits.attachment_mib in bytes; a missing or broken config.yaml keeps the default, as every other limit does. */
export const attachmentLimitOf = (settings: AgentsSettingsResult) => attachmentBytes(settings.ok ? settings.config.limits : DEFAULT_LIMITS);
export const attachmentLimit = (root: string) => attachmentLimitOf(readAgentsSettings(root));
/** The refusal names the limit a person can change in settings. */
export const fileTooLarge = (limit: number) => new Problem(PROBLEM_CODE.tooLarge, `File exceeds ${limit / 1024 / 1024} MiB`, undefined,
  { reason: { kind: 'file_exceeds_mib', limit: String(limit / 1024 / 1024) } });
/** Session assignment is an adapter capability, independent of edited argv. */
export const assignedSession = (launch: AgentLaunch, provider: string): RunRecord['session'] =>
  AGENT_ADAPTERS[builtinAdapterIdSchema.parse(launch.adapter)].system.start.includes('session') ? { provider, id: randomUUID() } : null;

/** All admission failures are translated once to the existing business refusal envelope. */
function admission<T>(run: () => T): T {
  try { return run(); } catch (error) {
    if (error instanceof SelectionRequired)
      throw new Problem(PROBLEM_CODE.invalidInput, error.message, undefined, { reason: { kind: 'selection_required', problems: error.problems } });
    if (error instanceof InvalidAgentSelection)
      throw new Problem(PROBLEM_CODE.invalidInput, error.message, undefined, { reason: { kind: 'invalid_selection', name: error.key,
        value: typeof error.value === 'string' ? error.value : null } });
    if (error instanceof AgentUnavailable)
      throw new Problem(PROBLEM_CODE.invalidInput, error.message, undefined, { reason: { kind: 'agent_unavailable' } });
    if (error instanceof ConversationAdapterMismatch)
      throw new Problem(PROBLEM_CODE.invalidInput, error.message, undefined, { reason: { kind: 'new_conversation_required', previous: error.previous, current: error.current } });
    throw error;
  }
}
/** Share lookup and the tagged admission; coordinator restart facts stay in its own preparation. */
function snapshotAdmission(config: AgentsSettings, agentName: string, mode: 'start' | 'resume', path: string,
  selected: Selection, previous?: Pick<RunRecord['launch'], 'adapter' | 'values'> | { values: Selection }) {
  const setting = Object.hasOwn(config.agents, agentName) ? config.agents[agentName] : undefined;
  if (!setting) return { ok: false as const, code: 'not_found' as const };
  let input: LaunchAdmission;
  if (mode === 'resume') {
    if (!previous || !('adapter' in previous)) return { ok: false as const, code: 'not_resumable' as const };
    input = { mode, path, explicit: selected, previous: { adapter: previous.adapter, values: previous.values } };
  } else input = { mode, path, explicit: selected, ...(previous ? { initial: previous.values } : {}) };
  return { ok: true as const, compiled: compileAgentSetting(agentName, setting), input };
}
export function launchSnapshot(config: AgentsSettings, agentName: string, mode: 'start' | 'resume', path: string,
  selected: Selection = {}, previous?: Pick<RunRecord['launch'], 'adapter' | 'values'> | { values: Selection }) {
  const prepared = snapshotAdmission(config, agentName, mode, path, selected, previous);
  if (!prepared.ok) return prepared;
  const result = admission(() => prepareAgentLaunch(prepared.compiled, prepared.input));
  pinCommand(result.launch, prepared.compiled.setting);
  return { ok: true as const, launch: result.launch };
}
/** Freezes the coordinator's start alternative on resume. */
export function coordinatorLaunchSnapshot(config: AgentsSettings, agentName: string, mode: 'start' | 'resume', path: string,
  selected: Selection = {}, previous?: Pick<RunRecord['launch'], 'adapter' | 'values'>) {
  const prepared = snapshotAdmission(config, agentName, mode, path, selected, previous);
  if (!prepared.ok) return prepared;
  const result = admission(() => prepareCoordinatorLaunch(prepared.compiled, prepared.input));
  const prefix = pinCommand(result.launch, prepared.compiled.setting);
  if (result.restartArgv) result.restartArgv = [...prefix, ...result.restartArgv.slice(AGENT_ADAPTERS[prepared.compiled.adapter].prefix.length)];
  return { ok: true as const, ...result };
}

function pinCommand(launch: RunRecord['launch'], setting: AgentSetting): string[] {
  const adapter = builtinAdapterIdSchema.parse(launch.adapter);
  let command: string | undefined;
  try { command = launchCommand(adapter, setting, launch.path); }
  catch (error) {
    if (!(error instanceof ExecutableUnavailable)) throw error;
    throw new Problem(PROBLEM_CODE.invalidInput, error.message, undefined,
    { reason: { kind: 'agent_command_unavailable', path: setting.command ?? AGENT_ADAPTERS[adapter].command ?? '', detail: error.detail } }); }
  const prefix = commandPrefix(adapter, command);
  launch.argv = [...prefix, ...launch.argv.slice(AGENT_ADAPTERS[adapter].prefix.length)];
  return prefix;
}

/** Placement selects a profile; executable resolution belongs to Run admission. */
export function validateAgentSelection(config: AgentsSettings, key: string, selected: Selection): void {
  admission(() => prepareAgentLaunch(compileAgentSetting(key, config.agents[key]), { mode: 'start', path: process.env.PATH || '/bin', explicit: selected }));
}
