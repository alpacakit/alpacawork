/** Records the third-party packages whose code a Vite build puts into its output, with their license texts.
 * Release assembly joins these records into the package's THIRD-PARTY-NOTICES; the bundle is the only source. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';

export const THIRD_PARTY_RECORD = 'third-party.json';
export type ThirdPartyPackage = { name: string; version: string; license: string | null; author: string | null; repository: string | null;
  texts: { file: string; text: string }[] };

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(-[a-z0-9]+)?(\.(md|markdown|txt))?$/i;
/** Standard texts for packages that declare a license but ship no license file. */
const STANDARD = { MIT: 'MIT.txt', 'Apache-2.0': 'Apache-2.0.txt' } as Record<string, string>;
const standardText = (license: string) => readFileSync(new URL('./licenses/' + STANDARD[license], import.meta.url), 'utf8').trim();

/** The package directory of a module id or file, or nothing for our own sources and virtual modules. */
export function packageDirectory(id: string): string | undefined {
  const path = id.replace(/^\0/, '').replace(/[?#].*$/, '');
  const at = path.lastIndexOf('/node_modules/');
  if (at < 0) return undefined;
  const parts = path.slice(at + '/node_modules/'.length).split('/');
  const length = parts[0]!.startsWith('@') ? 2 : 1;
  if (parts.length <= length || parts[0] === '.pnpm') return undefined;
  return path.slice(0, at) + '/node_modules/' + parts.slice(0, length).join('/');
}
/** The record of a workspace package's own bundled build (packages/db bundles drizzle-orm into its dist). */
export function workspaceRecord(id: string): string | undefined {
  const path = id.replace(/^\0/, '').replace(/[?#].*$/, '');
  if (!path.startsWith('/') || path.includes('/node_modules/')) return undefined;
  for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir)) {
    if (!existsSync(join(dir, 'package.json'))) continue;
    const record = join(dir, 'dist', THIRD_PARTY_RECORD);
    return path.startsWith(join(dir, 'dist') + '/') && existsSync(record) ? record : undefined;
  }
  return undefined;
}
export function describe(directory: string): ThirdPartyPackage {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const text = (value: unknown, key: string) => typeof value === 'string' ? value
    : typeof (value as Record<string, unknown> | undefined)?.[key] === 'string' ? (value as Record<string, string>)[key]! : null;
  const found = { name: manifest.name, version: manifest.version, license: text(manifest.license, 'type'), author: text(manifest.author, 'name'),
    repository: text(manifest.repository, 'url') };
  const texts = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && LICENSE_FILE.test(entry.name))
    .map(entry => entry.name).sort().map(file => ({ file, text: readFileSync(join(directory, file), 'utf8').trim() }));
  // MIT asks for the copyright line too: without a file or an author there is nothing to reproduce, and assembly stops.
  if (!texts.length && found.license && STANDARD[found.license] && (found.license !== 'MIT' || found.author))
    texts.push({ file: `(the package ships no license file; standard ${found.license} text)`,
      text: (found.license === 'MIT' ? `Copyright (c) ${found.author}\n\n` : '') + standardText(found.license) });
  return { ...found, texts };
}

/** One record per build output. `worker` collects from worker builds, whose module ids the main bundle does not see.
 * `compiledIn` names packages a plugin compiles into the output outside the module graph, resolved from `app`
 * (Tailwind resolves the CSS `@import "tailwindcss"` inside its own compiler).
 * Code the bundler itself adds (Vite's preload helper, the Rolldown runtime) is not a package dependency and is not recorded. */
export function thirdPartyRecord(compiledIn: { app: URL; packages: readonly string[] } = { app: new URL(import.meta.url), packages: [] }):
  { plugin: Plugin; worker: Plugin } {
  const directories = new Set<string>(), records = new Set<string>();
  const require = createRequire(compiledIn.app);
  for (const name of compiledIn.packages) directories.add(dirname(require.resolve(name + '/package.json')));
  const add = (id: string) => {
    const directory = packageDirectory(id), record = directory ? undefined : workspaceRecord(id);
    if (directory) directories.add(directory);
    if (record) records.add(record);
  };
  const collect = (bundle: Record<string, { type: string; moduleIds?: readonly string[]; modules?: Record<string, unknown> }>) => {
    for (const output of Object.values(bundle)) if (output.type === 'chunk')
      for (const id of output.moduleIds ?? Object.keys(output.modules ?? {})) add(id);
  };
  const worker: Plugin = { name: 'third-party-record-worker', generateBundle(_, bundle) { collect(bundle as never); } };
  const plugin: Plugin = {
    name: 'third-party-record',
    apply: 'build',
    generateBundle(_, bundle) {
      collect(bundle as never);
      const packages = new Map<string, ThirdPartyPackage>();
      for (const record of records)
        for (const found of JSON.parse(readFileSync(record, 'utf8')) as ThirdPartyPackage[]) packages.set(found.name + '@' + found.version, found);
      for (const directory of directories) {
        const found = describe(directory);
        packages.set(found.name + '@' + found.version, found);
      }
      const record = [...packages.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, found]) => found);
      this.emitFile({ type: 'asset', fileName: THIRD_PARTY_RECORD, source: JSON.stringify(record, null, 2) + '\n' });
    },
  };
  return { plugin, worker };
}
