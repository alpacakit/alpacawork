import * as syncFs from 'node:fs';
/** Filesystem boundary shared by assembly and validation. No links or shared inodes in a package. */
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export function regular(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Package file must be regular and unshared: ${path}`);
}
export function copyTree(source: string, target: string, includeFile: (path: string) => boolean = () => true): void {
  const stat = lstatSync(source);
  if (stat.isDirectory()) {
    mkdirSync(target, { recursive: true, mode: 0o755 });
    for (const name of readdirSync(source).sort()) {
      if (name !== 'node_modules' && name !== '.git') copyTree(join(source, name), join(target, name), includeFile);
    }
  } else {
    if (!includeFile(source)) return;
    regular(source); mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    copyFileSync(source, target); chmodSync(target, stat.mode & 0o755);
  }
}
export function inventory(root: string): Record<string, { bytes: number; sha256: string }> {
  const result = new Map<string, { bytes: number; sha256: string }>();
  const walk = (relative: string) => {
    const dir = join(root, relative);
    for (const name of readdirSync(dir).sort()) {
      const file = relative ? relative + '/' + name : name, path = join(root, file), stat = lstatSync(path);
      if (stat.isDirectory()) walk(file);
      else {
        regular(path);
        const bytes = readFileSync(path);
        result.set(file, { bytes: bytes.length, sha256: digest(bytes) });
      }
    }
  };
  walk(''); return Object.fromEntries(result);
}

/** One payload check for both local npm pack and integrity-verified npm intake.
 * Return the full observed tree: provenance also includes the inventory file itself. */
export function verifyDistributionInventory(root: string): ReturnType<typeof inventory> {
  const tree = inventory(root);
  const recorded = JSON.parse(readFileSync(join(root, 'DISTRIBUTION.json'), 'utf8'));
  const content = { ...tree }; delete content['DISTRIBUTION.json'];
  if (!isDeepStrictEqual(recorded, content)) throw new Error('Distribution inventory mismatch');
  return tree;
}

/** Persist an unpublished complete tree before its one-time rename. Never follows links or shares an inode. */
export function syncDirectory(path: string): void {
  const fd = syncFs.openSync(path, syncFs.constants.O_RDONLY | syncFs.constants.O_DIRECTORY | syncFs.constants.O_NOFOLLOW);
  try { syncFs.fsyncSync(fd); } finally { syncFs.closeSync(fd); }
}
export function syncTree(path: string): void {
  for (const name of readdirSync(path)) {
    const file = join(path, name);
    if (lstatSync(file).isDirectory()) syncTree(file);
    else { regular(file); const fd = syncFs.openSync(file, syncFs.constants.O_RDONLY | syncFs.constants.O_NOFOLLOW);
      try { syncFs.fsyncSync(fd); } finally { syncFs.closeSync(fd); } }
  }
  syncDirectory(path);
}
