/** A real receipt over a real Store session, with the repo's skill bytes in an image the actual reader accepts. */
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { InstalledSkillsStore, BUNDLED_SKILL_NAMES, type ManagedSkillName } from '@alpacawork/core/installed-skills';

export const scratch = (t: TestContext, name = 'alpacawork-managed-skills-') => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), name)));
  t.after(() => { openTree(root); rmSync(root, { recursive: true, force: true }); });
  return root;
};
/** Published trees are read-only by design; a test's cleanup and tampering are the places that open them. */
export function openTree(path: string): void {
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path, { withFileTypes: true })) if (entry.isDirectory()) openTree(join(path, entry.name));
}

export async function installed(root: string, selected: ManagedSkillName[]) {
  const release = join(root, 'distribution'), home = join(root, 'home'), skills = join(home, '.agents/skills');
  mkdirSync(release, { recursive: true }); mkdirSync(skills, { recursive: true, mode: 0o700 });
  const source = 'a'.repeat(40), format = 'b'.repeat(64);
  writeFileSync(join(release, 'SOURCE'), source + '\n'); writeFileSync(join(release, 'FORMAT'), format + '\n');
  writeFileSync(join(release, 'package.json'), JSON.stringify({ name: '@fixture/receipt', version: '1.2.3',
    alpacawork: { source, format, cliContract: { descriptionSha256: 'c'.repeat(64), implementationSha256: 'd'.repeat(64) } } }));
  for (const name of BUNDLED_SKILL_NAMES) cpSync(resolve('skills', name), join(release, 'skills', name), { recursive: true });
  const inventory: Record<string, { bytes: number; sha256: string }> = {};
  const scan = (path: string, prefix: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const member = prefix + entry.name, file = join(path, entry.name);
      if (entry.isDirectory()) scan(file, member + '/');
      else { const value = readFileSync(file); inventory[member] = { bytes: value.length, sha256: createHash('sha256').update(value).digest('hex') }; }
    }
  };
  scan(release, ''); writeFileSync(join(release, 'DISTRIBUTION.json'), JSON.stringify(inventory));
  const store = new InstalledSkillsStore(skills);
  await store.session(session => {
    session.begin({ operationId: randomUUID(), place: selected, remove: [], release });
    for (const name of selected) cpSync(join(release, 'skills', name), join(skills, name), { recursive: true });
    return session.commit();
  });
  return { release, home, skills, store };
}
