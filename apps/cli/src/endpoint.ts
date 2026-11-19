import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PROBLEM_CODE, Problem } from '@alpacawork/core';

import { clientConfigPath, validateServer } from '@alpacawork/cli-kit';
export { clientConfigPath, selectServer } from '@alpacawork/cli-kit';

/** A live alpacawork serve exposes a generated identity at this read-only route. */
async function verifyServer(server: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(new URL('/api/identity', server), {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Problem(PROBLEM_CODE.invalidInput, `Server not reached: ${reason}`);
  }
  if (!response.ok || response.redirected || response.status >= 300 && response.status < 400)
    throw new Problem(PROBLEM_CODE.invalidInput, `Server did not provide alpacawork identity (HTTP ${response.status})`);
  let identity: unknown;
  try { identity = await response.json(); }
  catch { throw new Problem(PROBLEM_CODE.invalidInput, 'Server returned invalid alpacawork identity'); }
  if (typeof identity !== 'object' || identity === null ||
      typeof (identity as { generation?: unknown }).generation !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test((identity as { generation: string }).generation) ||
      typeof (identity as { root?: unknown }).root !== 'string')
    throw new Problem(PROBLEM_CODE.invalidInput, 'Server returned invalid alpacawork identity');
}

export async function saveServer(value: string, env: NodeJS.ProcessEnv): Promise<{ server: string; path: string }> {
  const server = validateServer(value);
  await verifyServer(server);
  const path = clientConfigPath(env);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.client-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ server }) + '\n'); }
    finally { await file.close(); }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return { server, path };
}

export async function unsetServer(env: NodeJS.ProcessEnv): Promise<{ path: string }> {
  const path = clientConfigPath(env);
  try { await unlink(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { path };
}
