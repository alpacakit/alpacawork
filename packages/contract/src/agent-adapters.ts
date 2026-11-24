/** Browser-safe descriptions. Runtime protocol interpretation belongs to backend/agent-cli.
 * Defaults apply when a profile omits the corresponding setting.
 * Bridge flags: agent-cli/src/<id>.ts.
 */
import { z } from 'zod';
import type { SystemVariableName } from './agent-variables.js';
import { fingerprintOptions } from './options-base.js';
import type { ModelContext } from './agent-context.js';

export const BUILTIN_ADAPTER_IDS = ['claude', 'codex', 'grok', 'pi', 'copilot'] as const;
export const unavailableAgentKind = (id: unknown) => `Agent kind "${String(id)}" is unavailable in this version; select a supported adapter or remove this profile from config.yaml`;
export const builtinAdapterIdSchema = z.enum(BUILTIN_ADAPTER_IDS, { error: issue => unavailableAgentKind(issue.input) });
export type BuiltinAdapterId = z.infer<typeof builtinAdapterIdSchema>;
export type BridgeAdapterId = Exclude<BuiltinAdapterId, 'claude'>;
export const LAUNCH_MODES = ['start', 'resume'] as const;
export type LaunchMode = (typeof LAUNCH_MODES)[number];
export type AdapterDescription = {
  id: BuiltinAdapterId;
  defaultParams: Readonly<Record<string, readonly string[]>>;
  prefix: readonly string[];
  options: Readonly<Record<LaunchMode, string>>;
  /** Values supplied by the adapter/session policy, independent of edited options.
   * Claude owns an assigned session; bridges discover it on start and receive it on resume.
   * All use stdin for instructions, so prompt/prompt_file are never option variables here.
   */
  system: Readonly<Record<LaunchMode, readonly SystemVariableName[]>>;
  fixedEnv: readonly string[];
  defaultEnv: readonly string[];
  /** Executable on the server PATH; null means the runtime is bundled. */
  command: string | null;
  auth: { args: readonly string[]; ready: number; signedOut: number; nextAction: string } | null;
  /** Whether it reports its account's plan limits without a conversation (the backend adapter's `limits`; a bridge's `--limits`). */
  limits: boolean;
  /** Whether it compacts a conversation on request (with the conversation's own model), whether it takes words on what
   * the summary should keep in focus, and whether it needs a chosen model (not its automatic choice) to compact. Null: it
   * cannot, and a request to compact one of its conversations is refused. */
  compaction: { instructions: boolean; needsModel: boolean } | null;
  /** Each model's context window as shipped, by model candidate (or `-`): used until the agent itself says it, and
   * for an agent that never does (agent-context resolveContextLimits). */
  contextDefaults: Readonly<Record<string, ModelContext>>;
  referenceUrl: string;
};
const bridge = <Id extends BridgeAdapterId>(id: Id, defaultParams: AdapterDescription['defaultParams'], start: string, resume: string,
  referenceUrl: string, defaultEnv: readonly string[] = [], fixedEnv: readonly string[] = [],
  overrides: Partial<Pick<AdapterDescription, 'command' | 'auth' | 'limits' | 'compaction' | 'contextDefaults'>> = {}): AdapterDescription & { id: Id } =>
  ({ id, command: id, auth: null, limits: false, compaction: { instructions: true, needsModel: false }, contextDefaults: {}, ...overrides, defaultParams, prefix: ['alpacawork-agent', id], options: { start, resume },
    system: { start: ['result'], resume: ['result', 'session'] }, fixedEnv, defaultEnv, referenceUrl });
const me = '[--model {model}] [--effort {effort}]';
const result = '-o {result}';

export const AGENT_ADAPTERS: Readonly<{ [Id in BuiltinAdapterId]: AdapterDescription & { id: Id } }> = {
  claude: {
    id: 'claude', command: 'claude', limits: true, compaction: { instructions: true, needsModel: false },
    // As Claude Code 2.1.330 reported them on one account (a turn's `modelUsage.contextWindow`); a plan with another
    // window corrects them with its first turn's report.
    contextDefaults: { opus: { window: 1_000_000 }, fable: { window: 1_000_000 } }, auth: { args: ['auth', 'status'], ready: 0, signedOut: 1, nextAction: 'claude auth login' },
    defaultParams: { model: ['opus', 'fable'], effort: ['medium', 'high', 'low', 'xhigh', 'max'] },
    prefix: ['claude'], fixedEnv: ['CLAUDE_CONFIG_DIR'], defaultEnv: ['ANTHROPIC_API_KEY'],
    system: { start: ['session'], resume: ['session'] },
    options: {
      start: '[--model {model}] [--effort {effort}] -p --session-id {session} --input-format stream-json --output-format stream-json --verbose --permission-mode bypassPermissions --permission-prompts none',
      resume: '[--model {model}] [--effort {effort}] -p --resume {session} --input-format stream-json --output-format stream-json --verbose --permission-mode bypassPermissions --permission-prompts none',
    }, referenceUrl: 'https://code.claude.com/docs/en/cli-reference',
  },
  codex: bridge('codex', {
    model: ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra'], effort: ['high', 'low', 'medium', 'xhigh', 'max', 'ultra'], fast: ['-', 'fast'],
  }, '[-m {model}] [-c model_reasoning_effort={effort}] [-c service_tier={fast}] -s danger-full-access -o {result}',
  '[-m {model}] [-c model_reasoning_effort={effort}] [-c service_tier={fast}] -s danger-full-access resume -o {result} -- {session}',
  'https://learn.chatgpt.com/docs/cli/reference', ['OPENAI_API_KEY'], ['CODEX_HOME'],
  { auth: { args: ['login', 'status'], ready: 0, signedOut: 1, nextAction: 'codex login' }, limits: true,
    compaction: { instructions: false, needsModel: false },
    // As Codex 0.170.0 reports them: a model's window less the share it keeps for compaction (`modelContextWindow`).
    contextDefaults: { 'gpt-6.2-sol': { window: 475_000 }, 'gpt-6.2-astra': { window: 258_400 }, 'gpt-6.1-terra': { window: 475_000 } } }),
  grok: bridge('grok', { model: ['grok-4.7'], effort: ['high', 'low', 'medium', 'xhigh'] },
    `${me} ${result}`, `${me} ${result} --session {session}`, 'https://docs.x.ai/build/cli/reference', ['XAI_API_KEY'], ['GROK_HOME'],
    { compaction: { instructions: false, needsModel: false } }),
  copilot: bridge('copilot', { model: [] }, `[-m {model}] ${result}`, `[-m {model}] ${result} resume {session}`,
    'https://docs.github.com/en/copilot/reference/copilot-cli-reference', [], [],
    // On Auto, Copilot has no model to compact with until a turn of the process picks one, and compaction comes first.
    { command: null, auth: { args: ['--auth-status'], ready: 0, signedOut: 1, nextAction: 'gh auth login' }, limits: true,
      compaction: { instructions: true, needsModel: true } }),
  pi: bridge('pi', { model: [], effort: ['high', 'low', 'medium', 'xhigh', 'max', 'minimal', 'off'] },
    '[--model {model}] [--thinking {effort}] -o {result}',
    '[--model {model}] [--thinking {effort}] -o {result} --session {session}',
    'https://pi.dev/docs/latest/cli', [], ['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR']),
};
// Keep descriptors immutable even when imported by a mutable form draft.
for (const adapter of Object.values(AGENT_ADAPTERS)) {
  for (const values of Object.values(adapter.defaultParams)) Object.freeze(values);
  if (adapter.auth) { Object.freeze(adapter.auth.args); Object.freeze(adapter.auth); }
  if (adapter.compaction) Object.freeze(adapter.compaction);
  Object.freeze(adapter.defaultParams); Object.freeze(adapter.prefix); Object.freeze(adapter.options);
  for (const names of Object.values(adapter.system)) Object.freeze(names);
  Object.freeze(adapter.system);
  Object.freeze(adapter.fixedEnv); Object.freeze(adapter.defaultEnv); Object.freeze(adapter);
}
Object.freeze(AGENT_ADAPTERS);
export const defaultParamKeys = (id: BuiltinAdapterId): string[] => Object.keys(AGENT_ADAPTERS[id].defaultParams);

/** SHA-256 lowercase hex of UTF-8 JSON.stringify([default start, default resume]).
 * A content fingerprint, not a runtime protocol or trust version.
 */
export const optionsBase = (id: BuiltinAdapterId): string => fingerprintOptions(AGENT_ADAPTERS[id].options);
