import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOriginal, copyWorkspace, profiles, removeWorkspace } from '../scripts/dev-fixtures/fixture.ts';
import { cleanCliEnv } from './helpers/http-cli.ts';
import { preserveTestFailure } from './helpers/failure-workspace.ts';

test('real built recover/operation help explains existing authorization without opening or writing the workspace', async t => {
  const base = mkdtempSync(join(tmpdir(), 'recovery-help-')), root = join(base, 'data');
  const original = createOriginal({ ...profiles.small, seed: 'recovery-help' }, join(base, 'originals'));
  copyWorkspace(original.root, root);
  const home = join(base, 'home'), state = join(base, 'state'); mkdirSync(home); mkdirSync(state);
  t.after(async () => { await preserveTestFailure(t, base, { databaseRoot: root }); removeWorkspace(root); removeWorkspace(original.root); rmSync(base, { recursive: true, force: true }); });
  const hash = () => Object.fromEntries(readdirSync(base, { recursive: true, withFileTypes: true }).filter(item => item.isFile())
    .map(item => { const path = join(item.parentPath, item.name); return [path, createHash('sha256').update(readFileSync(path)).digest('hex')]; }));
  const before = hash();
  for (const command of ['recover', 'operation']) for (const help of ['-h', '--help']) {
    const result = spawnSync(process.execPath, ['apps/backend/dist/backend.js', '--workspace', root, 'release', command, help], {
      env: cleanCliEnv({ HOME: home, XDG_STATE_HOME: state, ALPACAWORK_RUN: 'R404', ALPACAWORK_RUN_TOKEN: 'synthetic-invalid-token' }),
      encoding: 'utf8', timeout: 10_000,
    });
    t.diagnostic(JSON.stringify({ command, help, exit: result.status, stdout: result.stdout, stderr: result.stderr }));
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
    assert.match(result.stdout, /Access \(server authorization/); assert.match(result.stdout, /same admitted Run ID and matching token/);
    assert.match(result.stdout, /Local credentials:/);
  }
  assert.deepEqual(hash(), before, 'help creates or changes no workspace, original, HOME or state files');
});
