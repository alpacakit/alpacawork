/** Parse one acquisition request and pin repository input before building. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { packageName } from './package-closure.js';

export type DeploySource = { kind: 'repository'; repo: string; ref: string } |
  { kind: 'npm'; packageName: string; selector: string };
const invalid = (message: string): never => { throw new Problem(PROBLEM_CODE.invalidInput, message); };
export function parseDeploySource(value: string, cwd: string, home: string): DeploySource {
  if (!value || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) return invalid('Expected deploy <path[#ref]> or deploy npm:<name>[@version]');
  if (value.startsWith('npm:')) {
    const spec = value.slice(4), at = spec.lastIndexOf('@');
    const name = at > 0 ? spec.slice(0, at) : spec, selector = at > 0 ? spec.slice(at + 1) : 'latest';
    try { packageName(name); } catch { return invalid('Expected npm:<literal-package-name>[@version]'); }
    if (selector !== 'latest' && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(selector))
      return invalid('Use an exact npm version or omit the version for latest');
    return { kind: 'npm', packageName: name, selector };
  }
  if (/^[a-z][a-z\d+.-]*:|^[^/]+@[^/]+:|\.t(?:ar\.)?gz(?:#|$)/i.test(value))
    return invalid('Use a local repository with a registered remote, or npm:<name>[@version]. Git and tarball URLs are not accepted');
  if (!/^(?:\.|\/|~)/.test(value) && value.includes('@')) return invalid('For npm packages, add npm: (deploy npm:<name>[@version])');
  const [path, ref = 'HEAD', extra] = value.split('#');
  if (!path || !ref || extra !== undefined || ref.startsWith('-')) return invalid('Expected one repository path and optional #branch-or-commit');
  return { kind: 'repository', repo: resolve(cwd, path.replace(/^~(?=\/|$)/, home)), ref };
}
function git(repo: string, args: string[]): string {
  try { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (cause) { throw new Problem(PROBLEM_CODE.invalidInput, `Could not resolve repository input (${args[0]}); check the path, ref and registered remote`, undefined, { cause }); }
}
export function pinDeployRepository(source: Extract<DeploySource, {kind: 'repository'}>): { repo: string; sha: string } {
  const { repo, ref } = source, remote = ref.split('/')[0]!;
  const remotes = git(repo, ['remote']).split('\n');
  let pinned = ref;
  if (ref.includes('/') && remotes.includes(remote)) {
    const branch = ref.slice(remote.length + 1), privateRef = 'refs/alpacawork/deploy/' + randomUUID();
    git(repo, ['check-ref-format', 'refs/heads/' + branch]);
    try {
      git(repo, ['fetch', '--no-tags', '--no-write-fetch-head', '--refmap=', '--', remote, `refs/heads/${branch}:${privateRef}`]);
      pinned = git(repo, ['rev-parse', '--verify', '--end-of-options', `${privateRef}^{commit}`]);
    } finally { git(repo, ['update-ref', '-d', privateRef]); }
  }
  const sha = git(repo, ['rev-parse', '--verify', '--end-of-options', `${pinned}^{commit}`]);
  if (!/^[a-f0-9]{40}$/.test(sha)) return invalid('Repository input is not a commit');
  return { repo, sha };
}
export function commitPackage(repo: string, sha: string): {name: string; version: string} {
  const manifest = JSON.parse(git(repo, ['show', `${sha}:package.json`]));
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') return invalid('Commit has no application package identity');
  return { name: manifest.name, version: manifest.version };
}
