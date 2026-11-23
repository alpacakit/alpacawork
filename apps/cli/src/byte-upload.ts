import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { MAX_FILE_BYTES } from '@alpacawork/contract';
import { byteRequest, type Command } from '@alpacawork/contract/commands';
import { PROBLEM_CODE, Problem } from '@alpacawork/core';

export const tooLarge = (name: string, max: number) => new Problem(PROBLEM_CODE.tooLarge, `${name} exceeds ${max} bytes`);

/** A regular file's bytes; more than `max` is too large for the option `name` that names it. */
export async function boundedFile(path: string, max: number, name: string): Promise<Uint8Array> {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Problem(PROBLEM_CODE.invalidInput, 'Expected a regular file');
    if (stat.size > max) throw tooLarge(name, max);
    // Allocate for the observed size first, then grow up to the limit if the file grows during this read.
    const limit = max + 1;
    let buffer = Buffer.alloc(Math.min(limit, stat.size + 1));
    let offset = 0;
    for (;;) {
      if (offset === buffer.length) {
        if (buffer.length === limit) break;
        const grown = Buffer.alloc(limit);
        buffer.copy(grown, 0, 0, offset);
        buffer = grown;
      }
      const result = await handle.read(buffer, offset, buffer.length - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > max) throw tooLarge(name, max);
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}

/** Read a local upload and prepare the shared byte transport. */
export async function prepareByteUpload(binding: NonNullable<Command['file']>, input: Record<string, unknown>, file: unknown) {
  if (typeof file !== 'string') throw new Problem(PROBLEM_CODE.invalidInput, '--file is required');
  let bytes: Uint8Array;
  try { bytes = await boundedFile(file, MAX_FILE_BYTES, '--file'); }
  catch (error) {
    if (error instanceof Problem) throw error;
    throw new Problem(PROBLEM_CODE.invalidInput, 'Cannot read --file');
  }
  const { path, headers } = byteRequest(binding, input);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (binding.contentDigest) headers.set(binding.contentDigest, digest);
  headers.set('Content-Type', 'application/octet-stream');
  return { path, headers, bytes, digest };
}
