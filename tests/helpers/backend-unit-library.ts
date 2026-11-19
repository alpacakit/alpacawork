/** Test-only unbundled library, outside the sealed subject. Public execution uses release/dist. */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
export function backendUnitLibrary(repo: string, library: string, release: string) {
  const modules = join(library, 'node_modules'); mkdirSync(modules, { recursive: true });
  const output = join(library, 'apps/backend/test-dist'); cpSync(join(repo, 'apps/backend/test-dist'), output, { recursive: true });
  mkdirSync(join(library, 'scripts'));
  for (const file of ['app-root.mjs', 'runtime-roots.mjs']) cpSync(join(repo, 'scripts', file), join(library, 'scripts', file));
  cpSync(join(release, 'apps/backend/dist'), join(library, 'apps/backend/dist'), { recursive: true });
  // Unit modules use this checkout's declared dependencies; they are never put into the subject image.
  // A scope is merged package by package: the backend declares scoped packages the checkout's root does not.
  for (const source of [join(repo, 'node_modules'), join(repo, 'apps/backend/node_modules')])
    for (const scope of readdirSync(source)) {
      if (scope.startsWith('.')) continue;
      for (const name of scope.startsWith('@') ? readdirSync(join(source, scope)).map(child => join(scope, child)) : [scope]) {
        const target = join(modules, name);
        if (existsSync(target)) continue;
        mkdirSync(dirname(target), { recursive: true }); symlinkSync(join(source, name), target);
      }
    }
  writeFileSync(join(library, 'package.json'), '{"type":"module"}');
  writeFileSync(join(output, 'app-paths.js'), readFileSync(join(output, 'app-paths.js'), 'utf8').replace("import { appRoot } from '../../../scripts/app-root.mjs';", `const appRoot = () => ${JSON.stringify(release)};`));
  writeFileSync(join(output, 'release/location.js'), `export { releaseForEntry } from '@alpacawork/core';\nexport const thisRelease = () => ${JSON.stringify(release)};\n`);
  return output;
}
