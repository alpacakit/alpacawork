import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Find the installation root from any chunk below apps/<app>/{dist,test-dist}. */
export function appRoot(moduleUrl) {
  for (let at = dirname(fileURLToPath(moduleUrl));; at = dirname(at)) {
    if (['dist', 'test-dist'].includes(basename(at)) && basename(dirname(dirname(at))) === 'apps')
      return resolve(at, '../../..');
    if (dirname(at) === at) throw new Error(`Expected an application output path: ${moduleUrl}`);
  }
}
