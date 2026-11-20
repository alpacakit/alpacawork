import { spawn } from 'node:child_process';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecrets } from '@alpacawork/core';
import { AGENT_CHECK_READ_MS, serverSettingsSchema, type AgentAvailability } from '@alpacawork/contract';
import { AGENT_ADAPTERS, BUILTIN_ADAPTER_IDS } from '@alpacawork/contract/agent-adapters';
import { settingAdapter } from '@alpacawork/contract/agent-settings';
import { serverText, type ServerLocale } from '@alpacawork/i18n/server';
import type { InstallationResult } from './public-setup.js';

type SetupAgentReadiness = [name: string, observation: AgentAvailability];

/** The setup screen lists saved agents first, then external adapters without a saved profile. */
export async function readSetupAgentReadiness(url: string): Promise<SetupAgentReadiness[]> {
  try {
    const response = await fetch(new URL('/api/config/get?check=true', url), {
      redirect: 'error', signal: AbortSignal.timeout(AGENT_CHECK_READ_MS),
    });
    if (!response.ok) return [];
    const { agents, availability, detected, error } = serverSettingsSchema.parse(await response.json());
    if (error || !availability || !detected) return [];
    const configured = new Set(Object.entries(agents).map(([name, setting]) => settingAdapter(name, setting)));
    return [...Object.entries(availability), ...BUILTIN_ADAPTER_IDS.flatMap((id): SetupAgentReadiness[] => {
      const observation = detected[id];
      return AGENT_ADAPTERS[id].command && !configured.has(id) && observation ? [[id, observation]] : [];
    })];
  } catch {
    // Setup is already complete. Without a server answer there is no readiness to report.
    return [];
  }
}

export const setupAgentName = (name: string): string => ({ claude: 'Claude Code', codex: 'Codex', grok: 'Grok Build', pi: 'pi', copilot: 'GitHub Copilot' }[name] ?? name);
/** A lazy logger: inspection and cancellation before Enter create nothing. */
export function setupLog(env: Readonly<NodeJS.ProcessEnv>) {
  const directory = join(env.XDG_STATE_HOME ?? join(env.HOME!, '.local/state'), 'alpacawork');
  const path = join(directory, 'setup.log');
  return Object.assign((line: string) => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    appendFileSync(path, `${new Date().toISOString()} ${redactSecrets(line)}\n`, { mode: 0o600 });
  }, { path });
}
export function setupResult(result: InstallationResult, agents: readonly SetupAgentReadiness[], language: ServerLocale, browserOpened = false): string | null {
  if (!result.installed) return null;
  const t = serverText(language), ready = agents.filter(([, observation]) => observation.status === 'ready');
  return [
    result.operation === 'change' ? t('server:setup.changed', { version: result.version }) : result.operation === 'update' ? t('server:setup.updated', { version: result.version }) : t('server:setup.completed', { version: result.version }),
    ...(ready.length ? [t('server:setup.agents.ready', { names: ready.map(([name]) => setupAgentName(name)).join(t('server:setup.listSeparator')) })] : []),
    ...agents.flatMap(([name, { status, nextAction }]) => status === 'signed_out' && nextAction
      ? [t('server:setup.agents.signIn', { name: setupAgentName(name), action: nextAction })] : []),
    ...(browserOpened ? [t('server:setup.browserOpened')] : []),
    ...(result.url ? ['', '  ' + t('server:setup.open', { url: result.url })] : []),
  ].join('\n');
}
export async function openSetupBrowser(url: string, env: Readonly<NodeJS.ProcessEnv>, options: {
  noOpen?: boolean; platform?: string; launch?: (command: string, args: string[]) => Promise<void>;
} = {}): Promise<boolean> {
  if (options.noOpen || env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return false;
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.username || parsed.password) return false;
  const platform = options.platform ?? process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'linux' ? 'xdg-open' : null;
  if (!command) return false;
  const launch = options.launch ?? ((command, args) => new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: 'ignore', detached: true, shell: false });
    const timeout = setTimeout(() => reject(new Error('Browser launcher did not finish')), 5_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('spawn', () => child.unref());
    child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('Browser launcher failed')); });
  }));
  try { await launch(command, [parsed.href]); return true; } catch { return false; }
}
