/** The install input must not grow beyond the shipped target pairs when dependencies change. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { matchesTarget, PACKAGE_TARGETS, packageName, type Manifest } from '@alpacawork/backend/test-dist/release/package-closure.js';

type Filters = { os?: string[]; cpu?: string[]; libc?: string[] };
type Config = { supportedArchitectures: Required<Filters>; ignoredOptionalDependencies: string[] };
type Lock = { packages: Record<string, Filters>; snapshots: Record<string, { optional?: boolean }>; ignoredOptionalDependencies: string[] };
const config = parse(readFileSync('pnpm-workspace.yaml', 'utf8')) as Config;
const lock = parse(readFileSync('pnpm-lock.yaml', 'utf8')) as Lock;
const nameOf = (key: string) => key.slice(0, key.lastIndexOf('@'));
// pnpm's configured cross product is wider than PACKAGE_TARGETS. Inspect package
// metadata, never infer the platform from a package's spelling or a copied list.
function checkInputs(config: Config, lock: Lock): void {
  const ignored = config.ignoredOptionalDependencies;
  ignored.forEach(packageName); // Literal names keep this policy reviewable.
  assert.deepEqual([...lock.ignoredOptionalDependencies].sort(), [...ignored].sort(), 'pnpm exclusion metadata drift');
  const accepts = (filter: string[] | undefined, value: string) => !filter ||
    !filter.includes('!' + value) && (!filter.some(item => !item.startsWith('!')) || filter.includes(value));
  for (const target of PACKAGE_TARGETS) {
    const [os, cpu, libc = 'glibc'] = target.split('-');
    for (const [axis, value] of Object.entries({ os, cpu, libc }))
      assert.ok(config.supportedArchitectures[axis as keyof Filters].includes(value), `missing install target ${target}`);
  }
  for (const [key, filters] of Object.entries(lock.packages)) {
    const name = nameOf(key);
    assert.ok(!ignored.includes(name), `excluded package remains in lock: ${key}`);
    if (!filters.os && !filters.cpu && !filters.libc) continue;
    const applicable = Object.entries(config.supportedArchitectures).every(([axis, values]) =>
      values.some(value => accepts(filters[axis as keyof Filters], value)));
    const shipped = PACKAGE_TARGETS.some(target => matchesTarget({ name, version: 'unused', ...filters } as Manifest, target));
    if (applicable) assert.ok(shipped, `unsupported install input: ${key} (optional=${lock.snapshots[key]?.optional === true})`);
  }
}

test('actual pnpm config and lock contain only supported platform inputs in their install cross product', () => checkInputs(config, lock));
test('new unknown optional variants and a removed exclusion fail the actual input guard', () => {
  for (const filters of [{ os: ['darwin'], cpu: ['x64'] }, { os: ['linux'], cpu: ['arm64'], libc: ['glibc'] }]) {
    const changed = structuredClone(lock), key = '@new-vendor/unexpected@1.0.0';
    changed.packages[key] = filters; changed.snapshots[key] = { optional: true };
    assert.throws(() => checkInputs(config, changed), /unsupported install input/);
  }
  const changed = structuredClone(config); changed.ignoredOptionalDependencies.pop();
  assert.throws(() => checkInputs(changed, lock), /metadata drift/);
});
test('Linux x64 and Darwin arm64 remain valid, and accidentally excluding either fails', () => {
  for (const filters of [{ os: ['linux'], cpu: ['x64'], libc: ['glibc'] }, { os: ['darwin'], cpu: ['arm64'] }]) {
    const changed = structuredClone(lock), key = '@new-vendor/supported@1.0.0';
    changed.packages[key] = filters; changed.snapshots[key] = { optional: true };
    assert.doesNotThrow(() => checkInputs(config, changed));
    const bad = structuredClone(config); bad.ignoredOptionalDependencies.push(nameOf(key));
    changed.ignoredOptionalDependencies = bad.ignoredOptionalDependencies;
    assert.throws(() => checkInputs(bad, changed), /excluded package remains/);
  }
});
