/** The local distribution facts shown by every CLI entry. No host adapter or server access. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export function readPackageVersion(root: string) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const source = readFileSync(join(root, 'SOURCE'), 'utf8').trim();
  if (!pkg.alpacawork || pkg.alpacawork.source !== source) throw new Error('Package/SOURCE mismatch');
  const format = readFileSync(join(root, 'FORMAT'), 'utf8').trim();
  if (pkg.alpacawork.format !== format) throw new Error('Package/FORMAT mismatch');
  return { name: pkg.name, version: pkg.version, node: process.versions.node, ...pkg.alpacawork };
}
