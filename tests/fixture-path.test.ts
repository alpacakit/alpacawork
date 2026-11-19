import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { FIXTURE_PROVIDER_COMMANDS, fixturePath, installAgentStub } from './helpers/agent-stub.ts';

// Observe execvp's first file without starting it, including version/help probes.
function find(command: string, path: string): string | undefined {
  for (const directory of path.split(delimiter)) {
    const file = join(directory, command);
    try { accessSync(file, constants.X_OK); if (statSync(file).isFile()) return file; }
    catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code!)) throw error; }
  }
}

test('fixture PATH keeps Node tools but cannot fall through to providers beside them', async t => {
  const area = mkdtempSync(join(tmpdir(), 'fixture-path-')), root = join(area, 'workspace'), nodeBin = join(area, 'personal-node-bin');
  const node = process.execPath, marker = join(area, 'provider-started');
  t.after(() => { process.execPath = node; rmSync(area, { recursive: true, force: true }); });
  mkdirSync(nodeBin, { recursive: true });
  symlinkSync(node, join(nodeBin, 'node'));
  for (const name of ['pnpm', 'corepack', ...FIXTURE_PROVIDER_COMMANDS])
    writeFileSync(join(nodeBin, name), `#!/bin/sh\nprintf started > '${marker}'\nexit 99\n`, { mode: 0o700 });
  // The real Node executable and a poison provider share one synthetic personal bin.
  process.execPath = join(nodeBin, 'node');
  const path = installAgentStub(root, 'claude');
  const oldPath = `${join(root, 'agent-bin')}:${dirname(process.execPath)}:/usr/bin:/bin`;
  assert.equal(find('gemini', oldPath), join(nodeBin, 'gemini'), 'the old path really exposes the poison CLI');
  for (const name of ['claude', 'alpacawork-agent']) assert.ok(find(name, path), `${name} remains available to fixtures`);
  for (const name of FIXTURE_PROVIDER_COMMANDS) {
    const resolved = find(name, path);
    if (resolved) {
      assert.equal(resolved, join(root, 'agent-bin', name), `${name} must resolve only to an intended stub`);
      assert.equal(realpathSync(resolved), join(root, `fixture-${name}.sh`));
    }
  }
  for (const name of ['node', 'pnpm', 'corepack']) {
    const file = find(name, path); assert.ok(file, `the ${name} tool is available`);
    assert.equal(realpathSync(file), realpathSync(join(nodeBin, name)));
  }
  assert.equal(installAgentStub(root, 'alpacawork-agent'), path, 'both common stub callers share one tool PATH');
  symlinkSync(join(nodeBin, 'gemini'), join(root, 'tool-bin', 'gemini'));
  assert.throws(() => fixturePath(root), /provider outside its declared stubs/, 'serve preparation must reject an exposed provider before starting it');
  assert.equal(existsSync(marker), false, 'no poison command was executed');
});
