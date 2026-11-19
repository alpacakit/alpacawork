/** Strict, bounded npm tar extraction. Validate every header/path before creating any member. */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';

export async function extractNpmArchive(tarball: string, stage: string, options: {
  maxExpandedBytes: number; maxEntries: number; signal: AbortSignal;
}): Promise<string> {
  const expanded = join(stage, 'expanded.tar');
  let size = 0;
  await pipeline(createReadStream(tarball), createGunzip(), new Transform({ transform(chunk: Buffer, _, done) {
    size += chunk.length;
    done(size > options.maxExpandedBytes ? new Error('archive_limit') : null, chunk);
  } }), createWriteStream(expanded, { flags: 'wx', mode: 0o600 }), { signal: options.signal });
  const file = await open(expanded, 'r');
  const members: { name: string; size: number; offset: number; directory: boolean; mode: number }[] = [];
  const names = new Map<string, boolean>();
  const numeric = (field: Buffer, optional = false) => {
    // Lossless bytes: ASCII decoding drops high bits that npm's UTF-8/base256 reader preserves.
    // Require octal digits and an explicit NUL/space terminator, with padding only after it.
    const value = field.toString('latin1');
    if (optional && /^[\0 ]+$/.test(value)) return 0;
    if (!/^ *[0-7]+[\0 ]+$/.test(value)) throw new Error('archive_number');
    const number = Number.parseInt(value, 8);
    if (!Number.isSafeInteger(number)) throw new Error('archive_number');
    return number;
  };
  const text = (field: Buffer) => {
    const end = field.indexOf(0), content = end < 0 ? field : field.subarray(0, end);
    if (end >= 0 && field.subarray(end).some(byte => byte !== 0)) throw new Error('archive_name');
    const value = content.toString('utf8');
    if (!Buffer.from(value).equals(content)) throw new Error('archive_name');
    return value;
  };
  try {
    let offset = 0, ended = false;
    while (offset < size) {
      options.signal.throwIfAborted();
      const header = Buffer.alloc(512);
      if ((await file.read(header, 0, 512, offset)).bytesRead !== 512) throw new Error('archive_truncated');
      offset += 512;
      if (header.every(byte => byte === 0)) { ended = true; continue; }
      if (ended || members.length >= options.maxEntries) throw new Error('archive_trailing_or_limit');
      const checksum = numeric(header.subarray(148, 156));
      const actual = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
      if (checksum !== actual || !['ustar\0', 'ustar '].includes(header.subarray(257, 263).toString('latin1')))
        throw new Error('archive_header');
      const type = header[156], directory = type === 53;
      if (type !== 0 && type !== 48 && !directory || text(header.subarray(157, 257))) throw new Error('archive_type');
      const prefix = text(header.subarray(345, 500));
      let name = (prefix ? prefix + '/' : '') + text(header.subarray(0, 100));
      if (directory && name.endsWith('/')) name = name.slice(0, -1);
      if (name !== 'package' && !name.startsWith('package/') || /[\\\x00-\x1f\x7f]/.test(name) ||
        name.split('/').some(part => !part || part === '.' || part === '..') || names.has(name)) throw new Error('archive_path');
      // Unused ownership/time/device values may be absent, but must never contain another numeric encoding.
      for (const [at, width] of [[108, 8], [116, 8], [136, 12], [329, 8], [337, 8]] as const)
        numeric(header.subarray(at, at + width), true);
      const bytes = numeric(header.subarray(124, 136)), mode = numeric(header.subarray(100, 108));
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > options.maxExpandedBytes || mode > 0o777 ||
        directory && bytes !== 0 || offset + Math.ceil(bytes / 512) * 512 > size) throw new Error('archive_size');
      names.set(name, directory);
      members.push({ name, size: bytes, offset, directory, mode });
      offset += Math.ceil(bytes / 512) * 512;
    }
    if (!ended || size % 512 || !members.length) throw new Error('archive_end');
    for (const member of members) {
      if (member.name === 'package' && !member.directory) throw new Error('archive_root');
      for (let parent = dirname(member.name); parent !== '.'; parent = dirname(parent))
        if (names.get(parent) === false) throw new Error('archive_parent');
    }
    const output = join(stage, 'unpacked'); await mkdir(output);
    for (const member of members) {
      options.signal.throwIfAborted();
      const target = join(output, member.name);
      if (member.directory) { await mkdir(target, { recursive: true }); continue; }
      await mkdir(dirname(target), { recursive: true });
      if (member.size === 0) { const empty = await open(target, 'wx', member.mode & 0o111 ? 0o755 : 0o644); await empty.close(); }
      else await pipeline(createReadStream(expanded, { start: member.offset, end: member.offset + member.size - 1 }),
        createWriteStream(target, { flags: 'wx', mode: member.mode & 0o111 ? 0o755 : 0o644 }), { signal: options.signal });
    }
    return join(output, 'package');
  } finally { await file.close(); await rm(expanded, { force: true }); }
}
