/**
 * The releases directory: one folder per commit (`<sha>/` with SOURCE and FORMAT), and the links `current` (what
 * serve runs) and `previous` (where a rollback returns). The service and the CLI shims name only `current`.
 */
import { closeSync, constants, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync,
  rmSync, statSync, symlinkSync, fsyncSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { PROBLEM_CODE, Problem, hasCode, platform, tryLock, trySharedLock, withResources } from '@alpacawork/core';

import { validateRelease } from './edition.js';
export { releaseKind, releaseName, releasePath, validateRelease, type ReleaseKind } from './edition.js';

export type Link = 'current' | 'previous';

export function linkTarget(releases: string, link: Link): string | null {
  let selected: string;
  try { selected = readlinkSync(join(releases, link)); }
  catch (error) { if (hasCode(error, 'ENOENT')) return null; throw error; }
  const target = resolve(releases, selected);
  if (dirname(target) !== resolve(releases)) throw new Error(`Invalid ${link} release link`);
  const info = lstatSync(target); // A dangling/foreign/non-directory target is not an absent link.
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Invalid ${link} release target`);
  return target;
}

/** Replace `link` at once with a relative link to the release folder `target`. */
export function point(releases: string, link: Link, target: string | null): void {
  const path = join(releases, link);
  if (target === null) { rmSync(path, { force: true }); const fd = openSync(releases, constants.O_RDONLY | constants.O_DIRECTORY); try { fsyncSync(fd); } finally { closeSync(fd); } return; }
  const temporary = join(releases, `.${link}.${process.pid}`);
  rmSync(temporary, { force: true });
  symlinkSync(basename(target), temporary);
  renameSync(temporary, path);
  const fd = openSync(releases, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** A missing file reads as null; any other failure stops the operation rather than hiding a release. */
function readText(path: string): string | null {
  try { return readFileSync(path, 'utf8').trim(); }
  catch (error) { if (hasCode(error, 'ENOENT')) return null; throw error; }
}
/** A release's stored-format fingerprint; null for releases made before formats were recorded. */
export const readFormat = (release: string) => readText(join(release, 'FORMAT'));

/** Release folders, newest first. A folder counts only when its SOURCE names it. */
export function builtReleases(releases: string): string[] {
  return readdirSync(releases).filter(name => !name.startsWith('.'))
    .map(name => join(releases, name))
    .filter(path => !lstatSync(path).isSymbolicLink() && lstatSync(path).isDirectory() &&
      readText(join(path, 'SOURCE')) !== null && !!validateRelease(releases, path))
    .sort((a, b) => statSync(join(b, 'SOURCE')).mtimeMs - statSync(join(a, 'SOURCE')).mtimeMs);
}

/**
 * The processes running `release`, by its own path (Run managers, and CLI shims that resolve `current` before
 * they start) and, with `links`, by `current` or `previous` (serve's service names `current`).
 */
type HostProcess = { pid: number; command: string };
export function users(release: string, processes: HostProcess[] = platform.run.processes(), links = true): HostProcess[] {
  const releases = dirname(release);
  const named = links ? (['current', 'previous'] as const).filter(link => linkTarget(releases, link) === release)
    .map(link => join(releases, link)) : [];
  const prefixes = [release, ...named].map(path => path + sep);
  return processes.filter(({ command }) => prefixes.some(prefix => command.includes(prefix)));
}

/**
 * What alpacawork itself keeps directly in a releases folder, told apart by name from anything a person keeps beside
 * it: release folders (named by their commit), the two links and their replacements in flight, the operation lock,
 * the switch and setup journals, update and acquisition records, and publication stages. `backups` and
 * `recovery-evidence` are everyday names, so only their per-operation folders are claimed, and the folder itself
 * when it holds nothing else. `own` is what uninstall may remove; `other` names what stays. A name added elsewhere
 * and not here is left in place and reported, never removed on a guess.
 */
const OWN_ENTRY = /^(?:[a-f0-9]{40}(?:-diagnostic)?|current|previous|\.(?:current|previous)\.\d+|\.release\.lock|switch\.json(?:\.tmp)?|setup-skills\.json(?:\..+\.tmp)?|\.updates|\.release-metadata|\.(?:npm-)?stage-.+)$/;
const OPERATION_ENTRY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function releasesEntries(releases: string): { own: string[]; other: string[] } {
  const own: string[] = [], other: string[] = [];
  for (const entry of readdirSync(releases, { withFileTypes: true })) {
    const path = join(releases, entry.name);
    if (OWN_ENTRY.test(entry.name)) own.push(path);
    else if (['backups', 'recovery-evidence'].includes(entry.name) && entry.isDirectory()) {
      const children = readdirSync(path), operations = children.filter(name => OPERATION_ENTRY.test(name));
      own.push(...operations.map(name => join(path, name)));
      if (operations.length === children.length) own.push(path); else other.push(entry.name);
    } else other.push(entry.name);
  }
  return { own, other };
}

/** One release operation at a time per releases directory: a prune must not remove what a deploy switches to. */
export function tryHoldReleases(releases: string): (() => void) | null {
  const fd = openSync(join(releases, '.release.lock'), constants.O_RDWR | constants.O_CREAT, 0o600);
  if (!tryLock(fd)) { closeSync(fd); return null; }
  return () => closeSync(fd);
}

/** Observe the existing whole-operation CLI lock without creating a file or retaining a lease. */
export function releaseOperationRunning(releases: string): boolean {
  let fd: number;
  try { fd = openSync(join(releases, '.release.lock'), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (hasCode(error, 'ENOENT')) return false; throw error; }
  return withResources(resources => {
    resources.defer(() => closeSync(fd));
    return !trySharedLock(fd);
  });
}
export function holdReleases(releases: string): () => void {
  const close = tryHoldReleases(releases);
  if (!close) throw new Problem(PROBLEM_CODE.conflict, `Another release operation is running in ${releases}`);
  return close;
}
