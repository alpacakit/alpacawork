/** Names owned by the process boundary. Settings and admission use this same rule.
 * Fixed conversation names belong to adapter descriptions; their values are never inspected here.
 */
import { z } from 'zod';

export const environmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$(?![\s\S])/);
export const BASE_AGENT_ENVIRONMENT_NAMES: readonly string[] = Object.freeze(('HOME USER LOGNAME SHELL TMPDIR LANG TZ SSH_AUTH_SOCK PATH ' +
  'HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS COREPACK_ENABLE_NETWORK').split(' '));
const baseEnv = new Set(BASE_AGENT_ENVIRONMENT_NAMES);
const internalEnv = new Set(['NODE_OPTIONS', 'NODE_PATH', 'CODEX_SQLITE_HOME']);
export const isProcessEnvironmentName = (name: string): boolean => baseEnv.has(name) || internalEnv.has(name) ||
  name.startsWith('LC_') || name.startsWith('ALPACAWORK_') || name.startsWith('PEPE_');
/** Non-basic environment names held in configuration or an admission snapshot. */
export const agentEnvironmentNamesSchema = z.array(environmentNameSchema).superRefine((names, ctx) => {
  const seen = new Set<string>();
  names.forEach((name, index) => {
    if (seen.has(name)) ctx.addIssue({ code: 'custom', path: [index], message: 'Duplicate environment name' });
    if (isProcessEnvironmentName(name)) ctx.addIssue({ code: 'custom', path: [index],
      message: 'Environment name is owned by the process boundary' });
    seen.add(name);
  });
});
