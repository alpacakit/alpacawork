import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecrets } from '@alpacawork/core';
import { openBrowser } from '@alpacawork/cli-kit';
import { serverText, type ServerLocale } from '@alpacawork/i18n/server';
import type { InstallationResult } from './public-setup.js';
import type { DetectedSetupAgent } from './setup-ai.js';

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
export function setupResult(result: InstallationResult, agents: readonly DetectedSetupAgent[], language: ServerLocale, browserOpened = false): string | null {
  if (!result.installed) return null;
  const t = serverText(language), ready = agents.filter(agent => agent.status === 'ready');
  return [
    result.operation === 'change' ? t('server:setup.changed', { version: result.version }) : result.operation === 'update' ? t('server:setup.updated', { version: result.version }) : t('server:setup.completed', { version: result.version }),
    ...(ready.length ? [t('server:setup.agents.ready', { names: ready.map(agent => setupAgentName(agent.id)).join(t('server:setup.listSeparator')) })] : []),
    ...agents.filter(agent => agent.status === 'signed_out').map(agent => t('server:setup.agents.signIn', { name: setupAgentName(agent.id), action: agent.nextAction ?? '' })),
    ...(browserOpened ? [t('server:setup.browserOpened')] : []),
    ...(result.url ? ['', '  ' + t('server:setup.open', { url: result.url })] : []),
  ].join('\n');
}
export async function openSetupBrowser(url: string, env: Readonly<NodeJS.ProcessEnv>, options: {
  noOpen?: boolean; platform?: string; launch?: (command: string, args: string[]) => Promise<void>;
} = {}): Promise<boolean> {
  if (options.noOpen) return false;
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.username || parsed.password) return false;
  return await openBrowser(parsed.href, env, options) === 'opened';
}
