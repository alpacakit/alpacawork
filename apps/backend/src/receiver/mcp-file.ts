import { createHash } from 'node:crypto';
import { closeSync, fstatSync, read, readSync } from 'node:fs';
import { promisify } from 'node:util';
import { basename, extname } from 'node:path';
import { type McpFileReadOptions } from '@alpacawork/contract/mcp';
import { taskFileRoute } from '@alpacawork/contract/task-file-route';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { openTaskFile } from '../control/task-files.js';

const readChunk = promisify(read);
const IMAGE_BYTES = 1024 * 1024;
const READ_JSON_CHARS = 40_000;
/** Reserve room for the largest possible restore ID appended by the MCP response adapter. */
const RESTORE_ROOM = ',"restoreId":"00000000-0000-0000-0000-000000000000"'.length;
const TEXT_TYPES = new Set(['', '.txt', '.text', '.md', '.mdx', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.csv', '.tsv',
  '.xml', '.html', '.svg', '.css', '.diff', '.patch', '.log', '.sh', '.js', '.ts', '.tsx', '.jsx', '.py', '.sql']);
const images = new Map([['.png', 'image/png'], ['.jpeg', 'image/jpeg'], ['.jpg', 'image/jpeg'], ['.webp', 'image/webp']]);

function versionOf(fd: number) {
  const stat = fstatSync(fd, { bigint: true });
  return { size: Number(stat.size), version: createHash('sha256')
    .update([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')).digest('hex') };
}

function readRange(fd: number, offset: number, length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < buffer.length) {
    const count = readSync(fd, buffer, read, buffer.length - read, offset + read);
    if (!count) break;
    read += count;
  }
  return buffer.subarray(0, read);
}

function textRange(bytes: Buffer, continues: boolean): { text: string; bytesRead: number } | null {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  if (bytes.includes(0)) return null;
  // A single U+10FFFF can use up to four bytes; a cut can leave at most three trailing bytes.
  for (let trim = 0; trim <= (continues ? 3 : 0) && trim <= bytes.length; trim++) {
    const prefix = bytes.subarray(0, bytes.length - trim);
    try { return { text: decoder.decode(prefix), bytesRead: prefix.length }; }
    catch { /* Try ending at the preceding code point. */ }
  }
  return null;
}

function truncateText(base: object, text: string, offset: number, size: number) {
  let used = 0, chars = 0;
  // Use the largest possible numeric offset to reserve the metadata before walking the string.
  const limit = READ_JSON_CHARS - RESTORE_ROOM - JSON.stringify({ ...base, text: '', nextOffset: size }).length;
  for (const char of text) {
    const quoted = JSON.stringify(char).length - 2;
    if (used + quoted > limit) break;
    chars += char.length;
    used += quoted;
  }
  const part = text.slice(0, chars);
  const end = offset + Buffer.byteLength(part);
  return { ...base, text: part, nextOffset: end < size ? end : null };
}

const changed = () => new Problem(PROBLEM_CODE.conflict, 'Task file changed; begin reading it again', undefined,
  { reason: { kind: 'validation_error' }, issues: [{ path: 'version', code: 'invalid_value', message: 'Task file version differs' }] });

/** Read and check one descriptor, including any whole-file hash, before releasing a single result. */
export async function readMcpFile(root: string, task: string, path: string, origin: string, input: McpFileReadOptions) {
  const { fd } = await openTaskFile(root, task, path);
  try {
    const { size, version } = versionOf(fd);
    if (input.version !== undefined && input.version !== version) throw changed();
    const offset = input.offset ?? 0;
    if (offset > size || offset > 0 && input.version === undefined) {
      const message = offset > size ? 'offset exceeds file size' : 'version is required for a nonzero offset';
      throw new Problem(PROBLEM_CODE.invalidInput, message, undefined,
        { reason: { kind: 'validation_error' }, issues: [{ path: 'offset', code: 'invalid_value', message }] });
    }
    const digest = input.digest ? createHash('sha256') : undefined;
    if (digest) {
      const chunk = Buffer.allocUnsafe(Math.min(128 * 1024, size));
      for (let position = 0; position < size;) {
        const { bytesRead } = await readChunk(fd, chunk, 0, Math.min(chunk.length, size - position), position);
        if (!bytesRead) throw changed();
        digest.update(chunk.subarray(0, bytesRead));
        position += bytesRead;
      }
    }
    const base = { name: basename(path), path, size, version, url: new URL(taskFileRoute(task, path), origin).href,
      ...(digest ? { digest: digest.digest('hex') } : {}) };
    const suffix = extname(path).toLowerCase();
    const mimeType = images.get(suffix);
    const requestedLength = input.length ?? (input.encoding === 'base64' ? 24 * 1024 : 16 * 1024);
    const limit = input.encoding === 'base64' ? 24 * 1024 : 32 * 1024;
    if (requestedLength > limit) {
      const message = 'length exceeds the limit for this encoding';
      throw new Problem(PROBLEM_CODE.invalidInput, message, undefined,
        { reason: { kind: 'validation_error' }, issues: [{ path: 'length', code: 'too_big', message, params: { maximum: limit } }] });
    }
    let result: { data: object; image?: { mimeType: string; data: string } } = { data: base };
    if (input.encoding === 'base64') {
      const length = Math.min(requestedLength, size - offset,
        Math.floor((READ_JSON_CHARS - RESTORE_ROOM - JSON.stringify({ ...base, contentBase64: '', nextOffset: size }).length) / 4) * 3);
      const bytes = readRange(fd, offset, length);
      const end = offset + bytes.length;
      result = { data: { ...base, contentBase64: bytes.toString('base64'), nextOffset: end < size ? end : null } };
    } else if (mimeType && input.encoding === undefined && size <= IMAGE_BYTES && offset === 0 && input.length === undefined) {
      result = { data: base, image: { mimeType, data: readRange(fd, 0, size).toString('base64') } };
    } else if (TEXT_TYPES.has(suffix) || input.encoding === 'text') {
      const bytes = readRange(fd, offset, Math.min(requestedLength, size - offset));
      const utf8 = textRange(bytes, offset + bytes.length < size);
      if (utf8?.bytesRead || utf8 && offset === size) result = { data: truncateText(base, utf8.text, offset, size) };
      else if (utf8 && offset < size) {
        // A range shorter than its first code point must still make progress.
        const first = textRange(readRange(fd, offset, Math.min(4, size - offset)), offset + 4 < size);
        if (first?.bytesRead) result = { data: truncateText(base, Array.from(first.text)[0]!, offset, size) };
      }
    }
    if (versionOf(fd).version !== version) throw changed();
    return result;
  } finally { closeSync(fd); }
}
