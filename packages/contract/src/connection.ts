/**
 * How local clients reach serve: a JSON file naming loopback HTTP. Node only, so not in the index.
 * `runManager` is the Run manager entry of the release serving now; a manager that outlived an older serve
 * launches the next Run with it, so a hot release does not keep old code alive through chains of Runs.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { PROBLEM_CODE, Problem } from '@alpacawork/core';
import { META_DIRECTORY } from '@alpacawork/raw';

export const connectionSchema = z.object({ url: z.url(), publicUrl: z.url().nullable(), generation: z.uuid(),
  runManager: z.string().refine(isAbsolute, 'an absolute path') }).strict();
export const connectionPath = (root: string): string => join(root, META_DIRECTORY, 'connection.json');
export function readConnection(filename: string): { url: URL; publicUrl: string | null; generation: string; runManager: string } {
  let bytes: string;
  try { bytes = readFileSync(filename, 'utf8'); }
  catch (error) { throw new Problem(PROBLEM_CODE.unavailable, 'serve is not running (no connection file)', undefined, { cause: error }); }
  const connection = connectionSchema.parse(JSON.parse(bytes));
  const url = new URL(connection.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
      url.pathname !== '/' || url.search || url.hash || url.username || url.password)
    throw new Problem(PROBLEM_CODE.unsafeEndpoint, 'Only loopback HTTP serve is supported');
  if (connection.publicUrl !== null) {
    const publicUrl = new URL(connection.publicUrl);
    if (publicUrl.protocol !== 'https:' || publicUrl.pathname !== '/' || publicUrl.search ||
        publicUrl.hash || publicUrl.username || publicUrl.password)
      throw new Problem(PROBLEM_CODE.unsafeEndpoint, 'Public URL must be an HTTPS origin');
  }
  return { url, publicUrl: connection.publicUrl, generation: connection.generation, runManager: connection.runManager };
}
