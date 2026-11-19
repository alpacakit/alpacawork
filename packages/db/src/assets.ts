/** SQL has one location in each built layout: the standalone DB package or backend assets. */
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function assetsRoot(): string {
  for (let at = dirname(fileURLToPath(import.meta.url));; at = dirname(at)) {
    if (basename(at) === 'dist') {
      const owner = dirname(at), group = basename(dirname(owner));
      if (basename(owner) === 'backend' && group === 'apps') return join(at, 'assets/db');
      // A standalone package may be installed or copied under any package name.
      return owner;
    }
    if (dirname(at) === at) throw new Error('Expected a built DB package or backend bundle');
  }
}

export const databaseAsset = (...parts: string[]) => join(assetsRoot(), ...parts);
