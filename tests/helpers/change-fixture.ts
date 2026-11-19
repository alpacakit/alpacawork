import type { TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOriginal, copyWorkspace, profiles, removeWorkspace } from '../../scripts/dev-fixtures/fixture.ts';

export function changeFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'alpacawork-changes-'));
  const original = createOriginal({ ...profiles.small, seed: 'control-changes' }, join(directory, 'cache'));
  const root = join(directory, 'work');
  copyWorkspace(original.root, root);
  const cleanup: (() => void)[] = [];
  t.after(() => {
    try { for (const close of cleanup.reverse()) close(); }
    finally { removeWorkspace(root); removeWorkspace(original.root); rmSync(directory, { recursive: true, force: true }); }
  });
  return { root, after: (close: () => void) => { cleanup.push(close); } };
}

