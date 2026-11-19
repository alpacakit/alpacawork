/** Client endpoint and installation facts share one user config directory. */
import { homedir } from 'node:os';
import { join } from 'node:path';

export function userConfigDirectory(env: Readonly<Record<string, string | undefined>>): string {
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'alpacawork');
}
/** What this PC keeps that is neither a setting nor data: telemetry marks and write pins. */
export function userStateDirectory(env: Readonly<Record<string, string | undefined>>): string {
  return join(env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local/state'), 'alpacawork');
}
