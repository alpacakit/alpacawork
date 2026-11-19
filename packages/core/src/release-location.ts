/** Locate the installed release from an entry; ordinary startup reads package identity only. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
export function releaseForEntry(entry: string): string | null {
  for (let path = dirname(resolve(entry)); path !== dirname(path); path = dirname(path)) {
    const manifest = join(path, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    if (pkg.alpacawork || pkg.name === 'alpacawork' && pkg.private === false) return path;
    if (pkg.name === 'alpacawork' && pkg.private === true && existsSync(join(path, 'pnpm-workspace.yaml'))) return null;
  }
  return null;
}
export function packageVersionForEntry(entry: string): string {
  for (let path = dirname(resolve(entry)); path !== dirname(path); path = dirname(path)) {
    const manifest = join(path, 'package.json');
    if (!existsSync(manifest)) continue;
    const version = JSON.parse(readFileSync(manifest, 'utf8')).version;
    if (typeof version !== 'string' || !version) throw new Error(`Missing package version: ${manifest}`);
    return version;
  }
  throw new Error(`Cannot find package version for entry: ${entry}`);
}
