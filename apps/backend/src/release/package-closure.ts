/** Materialize the installed runtime graph as bundled, ordinary files, never as published workspace dependencies. */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { RUNTIME_EXTERNAL_ROOTS } from '../../../../scripts/runtime-roots.mjs';
import { copyTree, regular } from './package-files.js';

export type Manifest = { name: string; version: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }>; [key: string]: unknown };
export const readManifest = (root: string) => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Manifest;
export function packageName(name: string): void {
  if (name.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name))
    throw new Error('Expected a literal lowercase npm package name');
}
/** The npm version shape a distribution may carry. Build metadata (+...) is not allowed. */
export function packageVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Expected a literal npm version without build metadata');
}
export function resolveDependency(from: string, name: string, boundary: string): string | null {
  packageName(name);
  for (let at = resolve(from);; at = dirname(at)) {
    const candidate = join(at, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) {
      const actual = realpathSync(candidate);
      if (relative(boundary, actual).startsWith('..') || relative(boundary, actual) === '')
        throw new Error(`Dependency escapes the build root: ${name}`);
      regular(join(actual, 'package.json'));
      if (readManifest(actual).name !== name) throw new Error(`Dependency name mismatch: ${name}`);
      return actual;
    }
    if (at === boundary || dirname(at) === at) return null;
  }
}
/** The emitted manifests describe only materialized runtime edges. Original manifests remain in the commit. */
export function runtimeClosure(release: string, target: string, targets: readonly PackageTarget[] = PACKAGE_TARGETS): string[] {
  const origins = new Map<string, string>();
  const top = new Set<string>();
  function install(source: string, parent: string): string {
    const pkg = readManifest(source); packageName(pkg.name);
    for (let at = parent;; at = dirname(at)) {
      const found = join(at, 'node_modules', pkg.name);
      if (origins.get(found) === source) return found;
      if (at === target) break;
    }
    const hoisted = join(target, 'node_modules', pkg.name);
    const dest = origins.has(hoisted) ? join(parent, 'node_modules', pkg.name) : hoisted;
    if (origins.has(dest)) throw new Error(`Conflicting runtime dependency: ${pkg.name}`);
    origins.set(dest, source);
    if (dest === hoisted) top.add(pkg.name);
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(source).sort())
      if (!['node_modules', 'package.json', '.git', '.npmrc', '.npmignore', '.gitignore'].includes(name)) copyTree(join(source, name), join(dest, name));
    const dependencies: Record<string, string> = {};
    const optional: Record<string, string> = {};
    const edges = { ...pkg.peerDependencies, ...pkg.dependencies, ...pkg.optionalDependencies };
    for (const name of Object.keys(edges).sort()) {
      const maybeOptional = name in (pkg.optionalDependencies ?? {}) || pkg.peerDependenciesMeta?.[name]?.optional === true && !(name in (pkg.dependencies ?? {}));
      const origin = resolveDependency(source, name, release);
      if (!origin) { if (maybeOptional) continue; throw new Error(`Missing runtime dependency: ${pkg.name} -> ${name}`); }
      if (maybeOptional && !targets.some(target => matchesTarget(readManifest(origin), target))) continue;
      install(origin, dest);
      (maybeOptional ? optional : dependencies)[name] = readManifest(origin).version;
    }
    const { scripts: _scripts, devDependencies: _dev, dependencies: _deps, optionalDependencies: _optional,
      peerDependencies: _peers, peerDependenciesMeta: _peerMeta, packageManager: _manager, pnpm: _pnpm,
      bundledDependencies: _bundled, bundleDependencies: _bundle, files: _files, bin: _bin,
      os: _os, cpu: _cpu, libc: _libc, ...runtime } = pkg;
    // Lifecycle scripts are build-time input, never install-time configuration in the assembled artifact.
    writeFileSync(join(dest, 'package.json'), JSON.stringify({ ...runtime, dependencies, optionalDependencies: optional }, null, 2) + '\n');
    return dest;
  }
  for (const { name, from } of RUNTIME_EXTERNAL_ROOTS) {
    const origin = resolveDependency(join(release, from), name, release);
    if (!origin) throw new Error(`Missing runtime external: ${name}`);
    install(origin, target);
  }
  return [...top].sort();
}

export const PACKAGE_TARGETS = ['linux-x64-glibc', 'darwin-arm64'] as const;
export type PackageTarget = typeof PACKAGE_TARGETS[number];
export function matchesTarget(pkg: Manifest, target: PackageTarget): boolean {
  const matches = (value: unknown, expected: string) => {
    if (value === undefined) return true;
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`Invalid platform filter: ${pkg.name}`);
    return !value.includes('!' + expected) && (!value.some(item => !item.startsWith('!')) || value.includes(expected));
  };
  return matches(pkg.os, target === 'darwin-arm64' ? 'darwin' : 'linux') &&
    matches(pkg.cpu, target === 'darwin-arm64' ? 'arm64' : 'x64') && matches(pkg.libc, 'glibc');
}
export function parseTargets(value: string): PackageTarget[] {
  const targets = value.split(',');
  if (!targets.length || new Set(targets).size !== targets.length || targets.some(target => !(PACKAGE_TARGETS as readonly string[]).includes(target)))
    throw new Error('Targets must be linux-x64-glibc,darwin-arm64 (WSL2 uses the Linux closure)');
  return targets.sort() as PackageTarget[];
}
/** These optional packages are required by the shipped FFI/SDK. Check bytes; ignore-scripts must not hide their absence. */
export function checkNative(root: string, targets: PackageTarget[]): void {
  const koffi = resolveDependency(root, 'koffi', root), sdk = resolveDependency(root, '@github/copilot-sdk', root);
  if (!koffi || !sdk) throw new Error('Missing mandatory Koffi/Copilot SDK runtime');
  for (const target of targets) {
    const platform = target === 'darwin-arm64' ? 'darwin-arm64' : 'linux-x64';
    const ffi = resolveDependency(koffi, `@koromix/koffi-${platform}`, root);
    const runtime = resolveDependency(sdk, `@github/copilot-sdk-${platform}`, root);
    if (!ffi || !runtime) throw new Error(`Missing native closure for ${target}; supply the offline platform packages before claiming this target`);
    const ffiFile = join(ffi, platform.replace('-', '_'), 'koffi.node');
    for (const file of [ffiFile, join(runtime, 'prebuilds', platform, 'runtime.node'), join(runtime, 'prebuilds', platform, 'copilot-runtime')]) {
      regular(file);
      const bytes = readFileSync(file);
      if (bytes.length < 20) throw new Error(`Empty native runtime: ${file}`);
      const magic = bytes.subarray(0, 4).toString('hex');
      const arm64 = 0x0100000c;
      let correct = magic === '7f454c46' && bytes[4] === 2 && bytes[5] === 1 && bytes.readUInt16LE(18) === 62;
      if (target === 'darwin-arm64') {
        correct = magic === 'cffaedfe' && bytes.readUInt32LE(4) === arm64 || magic === 'feedfacf' && bytes.readUInt32BE(4) === arm64;
        if (['cafebabe', 'bebafeca'].includes(magic)) {
          const word = (offset: number) => magic === 'cafebabe' ? bytes.readUInt32BE(offset) : bytes.readUInt32LE(offset);
          const count = word(4);
          correct = count > 0 && count <= 64 && 8 + count * 20 <= bytes.length && Array.from({ length: count }, (_, i) => word(8 + i * 20)).includes(arm64);
        }
      }
      if (!correct)
        throw new Error(`Native runtime does not match ${target}: ${file}`);
    }
  }
}
