/** One client endpoint selection shared by HTTP commands and local deploy. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { userConfigDirectory } from './config-path.js';
import { DEFAULT_SERVER_ORIGIN } from '@alpacawork/contract/default-server';
import { PROBLEM_CODE, Problem } from '@alpacawork/core';

type ServerSource = '--server' | 'ALPACAWORK_SERVER' | 'client.json' | 'installation.json' | 'default';
type SelectedServer = { server: string; source: ServerSource };

export function clientConfigPath(env: NodeJS.ProcessEnv): string {
  return join(userConfigDirectory(env), 'client.json');
}

export function validateServer(value: string): string {
  if (!/^https?:\/\/[^/?#]+\/?$/i.test(value))
    throw new Problem(PROBLEM_CODE.invalidInput, 'Server must be an HTTP origin');
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Problem(PROBLEM_CODE.invalidInput, 'Invalid server URL'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\./.test(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol) || (!loopback && url.protocol !== 'https:') ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.host)
    throw new Problem(PROBLEM_CODE.invalidInput, 'Server must be an HTTP origin; non-loopback requires HTTPS');
  return url.origin;
}

export async function selectServer(option: string | undefined, env: NodeJS.ProcessEnv, installedServer?: string): Promise<SelectedServer> {
  if (option !== undefined) return { server: validateServer(option), source: '--server' };
  if (env.ALPACAWORK_SERVER !== undefined)
    return { server: validateServer(env.ALPACAWORK_SERVER), source: 'ALPACAWORK_SERVER' };
  let source: string;
  try { source = await readFile(clientConfigPath(env), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return installedServer === undefined ? { server: DEFAULT_SERVER_ORIGIN, source: 'default' }
        : { server: validateServer(installedServer), source: 'installation.json' };
    throw new Problem(PROBLEM_CODE.invalidInput, 'Cannot read client config');
  }
  try {
    const value: unknown = JSON.parse(source);
    if (typeof value !== 'object' || value === null || Array.isArray(value) ||
        typeof (value as { server?: unknown }).server !== 'string') throw new Error('server');
    return { server: validateServer((value as { server: string }).server), source: 'client.json' };
  } catch {
    throw new Problem(PROBLEM_CODE.invalidInput, 'Invalid client config');
  }
}

