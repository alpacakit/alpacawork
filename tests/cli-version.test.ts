/** The public version command reads local metadata and refuses broken identities. */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { releaseFixture } from './helpers/release-fixture.ts';

const flags = ['version', '--version'] as const;
const run = (entry: string, flag: string) => spawnSync(process.execPath, [entry, flag], { encoding: 'utf8', timeout: 10000 });
function refused(result: ReturnType<typeof run>, message: string | RegExp) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const body = JSON.parse(result.stderr);
  if (typeof message === 'string') assert.equal(body.error.message, message);
  else assert.match(body.error.message, message);
  assert.ok(body.error.code);
  assert.ok(body.error.retry);
  assert.equal(body.version, undefined);
  assert.equal(body.source, undefined);
  assert.doesNotMatch(result.stderr, /\n\s+at |Node\.js v/);
}
for (const flag of flags) test(`checkout ${flag} returns one structured refusal without stack or invented facts`, () => {
  refused(run(resolve('apps/cli/dist/cli.js'), flag), /SOURCE/);
});

describe('distribution version', { concurrency: false }, () => {
  let root: string;
  let fixture: ReturnType<typeof releaseFixture>;
  let pkg: { name: string; version: string; alpacawork: Record<string, unknown> };
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'version-refusal-'));
    fixture = releaseFixture(root);
    pkg = JSON.parse(readFileSync(join(fixture.image, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'alpacawork');
    assert.equal(pkg.version, '0.3.0');
    assert.equal(pkg.alpacawork.source, 'a'.repeat(40));
  });
  after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  for (const flag of flags) test(`normal distribution ${flag} returns its concrete version facts`, () => {
    const result = run(join(fixture.image, 'apps/cli/dist/cli.js'), flag);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    if (flag === '--version') assert.equal(result.stdout, '0.3.0\n');
    else assert.deepEqual(JSON.parse(result.stdout), {
      name: 'alpacawork', version: '0.3.0', node: process.versions.node, ...pkg.alpacawork,
    });
  });

  for (const field of ['SOURCE', 'FORMAT'] as const) for (const fault of ['missing', 'mismatch'] as const) for (const flag of flags)
    test(`damaged distribution ${field} ${fault} ${flag} is structured and never falls back`, t => {
      const path = join(fixture.image, field), original = readFileSync(path);
      t.after(() => {
        writeFileSync(path, original);
      });
      if (fault === 'missing') rmSync(path);
      else {
        const changed = (field === 'SOURCE' ? 'b'.repeat(40) : 'd'.repeat(64));
        assert.notEqual(changed, original.toString('utf8'));
        writeFileSync(path, changed);
      }
      refused(run(fixture.cli, flag), fault === 'missing' ? new RegExp(field) : new RegExp(`Package/${field} mismatch`));
    });
});
