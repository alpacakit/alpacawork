import { platform } from '@alpacawork/core';
import { BASE_AGENT_ENVIRONMENT_NAMES, agentEnvironmentNamesSchema } from '@alpacawork/contract/agent-environment';

const BASIC = new Set([...BASE_AGENT_ENVIRONMENT_NAMES, ...platform.run.environment]);
/** One implementation for serve → manager and manager → agent. Values are read here, never persisted. */
export function agentEnvironment(source: Readonly<Record<string, string | undefined>>, path: string,
  serverOrigin: string | undefined, names: readonly string[]): Record<string, string> {
  const allowed = new Set(agentEnvironmentNamesSchema.parse(names)), env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source))
    if (value !== undefined && (BASIC.has(name) || allowed.has(name) || name.startsWith('LC_'))) env[name] = value;
  env.PATH = path;
  if (serverOrigin !== undefined) env.ALPACAWORK_SERVER = serverOrigin;
  return env;
}
