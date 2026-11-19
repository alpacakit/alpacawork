/** Edition comes from the Web build's existing entry name and HTML connection. */
import { lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
export type ReleaseKind = 'production' | 'diagnostic';
export const releaseName = (sha: string, kind: ReleaseKind) => sha + (kind === 'diagnostic' ? '-diagnostic' : '');
export const releasePath = (releases: string, release: { source: string; edition: ReleaseKind }) =>
  join(releases, releaseName(release.source, release.edition));
const text = (path: string) => readFileSync(path, 'utf8');
export function releaseKind(root: string): ReleaseKind {
  const web = join(root, 'apps/backend/public');
  const manifest = JSON.parse(text(join(web, 'asset-manifest.json')));
  const file: unknown = manifest['index.html']?.file;
  if (typeof file !== 'string' || !/^assets\/[\w.-]+\.js$/.test(file)) throw new Error('Invalid release asset entry');
  if (!text(join(web, 'index.html')).includes(`src="/${file}"`))
    throw new Error('Release HTML is disconnected from its asset manifest');
  return file.startsWith('assets/diagnostic-') ? 'diagnostic' : 'production';
}

/** Validate root, SOURCE, name, content and optional request before any switch side effect. */
export function validateRelease(releases: string, target: string, requested?: ReleaseKind): ReleaseKind {
  if (dirname(target) !== resolve(releases) || !lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink())
    throw new Error('Release target is outside its root or is linked');
  const kind = releaseKind(target), sha = text(join(target, 'SOURCE')).trim();
  if (!sha || basename(target) !== releaseName(sha, kind)) throw new Error('Release name/SOURCE/edition mismatch');
  if (requested && requested !== kind) throw new Error('Release requested kind/content mismatch');
  return kind;
}
