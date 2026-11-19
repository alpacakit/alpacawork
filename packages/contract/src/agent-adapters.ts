/** Browser-safe descriptions. Runtime protocol interpretation belongs to backend/agent-cli.
 * Defaults apply when a profile omits the corresponding setting.
 * Bridge flags: agent-cli/src/<id>.ts.
 */
import { z } from 'zod';
import type { SystemVariableName } from './agent-variables.js';
import { fingerprintOptions } from './options-base.js';

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
  defaultWithout: Readonly<Record<string, readonly string[]>>;
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
  referenceUrl: string;
};
const bridge = <Id extends BridgeAdapterId>(id: Id, defaultParams: AdapterDescription['defaultParams'], start: string, resume: string,
  referenceUrl: string, defaultEnv: readonly string[] = [], fixedEnv: readonly string[] = [],
  overrides: Partial<Pick<AdapterDescription, 'command' | 'auth' | 'defaultWithout'>> = {}): AdapterDescription & { id: Id } =>
  ({ id, command: id, auth: null, defaultWithout: {}, ...overrides, defaultParams, prefix: ['alpacawork-agent', id], options: { start, resume },
    system: { start: ['result'], resume: ['result', 'session'] }, fixedEnv, defaultEnv, referenceUrl });
const me = '[--model {model}] [--effort {effort}]';
const result = '-o {result}';

export const AGENT_ADAPTERS: Readonly<{ [Id in BuiltinAdapterId]: AdapterDescription & { id: Id } }> = {
  claude: {
    id: 'claude', command: 'claude', auth: { args: ['auth', 'status'], ready: 0, signedOut: 1, nextAction: 'claude auth login' },
    defaultParams: { model: ['opus', 'fable'], effort: ['medium', 'high', 'low', 'xhigh', 'max'] }, defaultWithout: {},
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
  { auth: { args: ['login', 'status'], ready: 0, signedOut: 1, nextAction: 'codex login' } }),
  grok: bridge('grok', { model: ['grok-4.7'], effort: ['high', 'low', 'medium', 'xhigh'] },
    `${me} ${result}`, `${me} ${result} --session {session}`, 'https://docs.x.ai/build/cli/reference', ['XAI_API_KEY'], ['GROK_HOME']),
  copilot: bridge('copilot', { model: [] }, `[-m {model}] ${result}`, `[-m {model}] ${result} resume {session}`,
    'https://docs.github.com/en/copilot/reference/copilot-cli-reference', [], [],
    { command: null, auth: { args: ['--auth-status'], ready: 0, signedOut: 1, nextAction: 'gh auth login' } }),
  pi: bridge('pi', { model: [], effort: ['high', 'low', 'medium', 'xhigh', 'max', 'minimal', 'off'] },
    '[--model {model}] [--thinking {effort}] -o {result}',
    '[--model {model}] [--thinking {effort}] -o {result} --session {session}',
    'https://pi.dev/docs/latest/cli', [], ['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR']),
};
// Keep descriptors immutable even when imported by a mutable form draft.
for (const adapter of Object.values(AGENT_ADAPTERS)) {
  for (const values of Object.values(adapter.defaultParams)) Object.freeze(values);
  for (const values of Object.values(adapter.defaultWithout)) Object.freeze(values);
  if (adapter.auth) { Object.freeze(adapter.auth.args); Object.freeze(adapter.auth); }
  Object.freeze(adapter.defaultParams); Object.freeze(adapter.defaultWithout); Object.freeze(adapter.prefix); Object.freeze(adapter.options);
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
