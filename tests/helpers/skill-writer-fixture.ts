/** Tiny synthetic acquired distribution. Writer tests do not run acquisition or package fact generators. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { MANAGED_SKILL_NAMES, InstalledSkillsStore } from '@alpacawork/core/installed-skills';
import { ManagedSkillsWriter, type SkillIntent, type SkillWriteRequest } from '@alpacawork/backend/test-dist/installation/skills.js';
export const basic: SkillIntent = { place: ['alpacawork'], remove: [] };
export function skillWriterFixture(t: TestContext) {
  const scratch = mkdtempSync(join(tmpdir(), 'managed-skill-writer-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const release = join(scratch, 'distribution'), source = 'a'.repeat(40);
  mkdirSync(release);
  const inventory: Record<string, { bytes: number; sha256: string }> = {};
  const putSource = (member: string, bytes: string) => {
    const file = join(release, member);
    writeFileSync(file, bytes);
    inventory[member] = { bytes: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  putSource('SOURCE', source + '\n');
  putSource('package.json', JSON.stringify({ name: '@fixture/writer', version: '1.2.3', alpacawork: { source } }));
  for (const name of MANAGED_SKILL_NAMES) {
    mkdirSync(join(release, 'skills', name, 'empty'), { recursive: true });
    putSource(`skills/${name}/SKILL.md`, `# ${name}\n`);
    putSource(`skills/${name}/reference.txt`, `source ${name}\n`);
  }
  putSource('unrelated-app.js', 'Writer must not read this file');
  writeFileSync(join(release, 'DISTRIBUTION.json'), JSON.stringify(inventory));
  const root = join(scratch, 'home/.agents/skills'), writer = new ManagedSkillsWriter({ root });
  const request = (intent: SkillIntent = basic): SkillWriteRequest => ({ version: 2, operationId: randomUUID(), release, intent });
  const put = (name = 'alpacawork', value = 'original edited skill\n') => {
    const dir = join(root, name); mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(join(dir, 'SKILL.md'), value);
  };
  return { release, root, writer, request, put,
    store: () => new InstalledSkillsStore(root), read: () => readFileSync(join(root, 'alpacawork/SKILL.md'), 'utf8') };
}
