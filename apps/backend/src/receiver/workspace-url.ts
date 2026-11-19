/** Report only the URL published by this workspace's currently running serve. */
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import { connectionPath, readConnection } from '@alpacawork/contract/connection';

const identity = z.object({ generation: z.uuid(), root: z.string() });
const unavailable = { status: 'unavailable', localUrl: null, publicUrl: null } as const;
const unverified = { status: 'unverified', localUrl: null, publicUrl: null } as const;

export async function workspaceUrl(root: string) {
  const file = connectionPath(root);
  let connection;
  try {
    connection = readConnection(file);
  } catch (error) {
    return (error instanceof Error && 'cause' in error &&
      (error.cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') ? unavailable : unverified;
  }
  try {
    const response = await fetch(new URL('/api/identity', connection.url), {
      signal: AbortSignal.timeout(1500), redirect: 'error',
    });
    if (!response.ok) return unverified;
    const live = identity.parse(await response.json());
    const current = readConnection(file);
    if (current.generation !== connection.generation || current.url.href !== connection.url.href ||
        current.publicUrl !== connection.publicUrl) return unverified;
    if (live.generation !== connection.generation || realpathSync(live.root) !== realpathSync(root))
      return unavailable;
    return { status: 'serving', localUrl: connection.url.href, publicUrl: connection.publicUrl } as const;
  } catch (error) {
    return (error instanceof Error && 'cause' in error &&
      (error.cause as NodeJS.ErrnoException | undefined)?.code === 'ECONNREFUSED')
      ? unavailable : unverified;
  }
}
