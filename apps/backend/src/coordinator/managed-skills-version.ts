/** Admission reads receipt versions only. Skill contents and Run assets are not compatibility tests. */
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Problem, PROBLEM_CODE, hasCode, packageVersionForEntry, releaseForEntry } from '@alpacawork/core';
import { InstalledSkillsStore, BUNDLED_SKILL_NAMES, managedSkillsRoot, SkillsRefused } from '@alpacawork/core/installed-skills';
import { skillsUpdateCommand } from '../installation/skills-update-command.js';

export function assertManagedSkillsVersion(selected: readonly string[], home = homedir(),
  expectedVersion?: string): void {
  const managed = selected.filter(name => BUNDLED_SKILL_NAMES.some(each => each === name));
  if (!managed.length) return;
  let installation: ReturnType<InstalledSkillsStore['read']> | undefined;
  try { installation = new InstalledSkillsStore(managedSkillsRoot(home)).read(); }
  catch (error) {
    if (hasCode(error, 'ENOENT')) installation = null;
    else if (!(error instanceof SkillsRefused)) throw error;
  }
  // A source checkout has no installed release or receipt: its skills are maintained with that checkout.
  // Packaged releases (and callers asking for a particular version) still require a complete receipt.
  if (installation === null && expectedVersion === undefined && releaseForEntry(fileURLToPath(import.meta.url)) === null) return;
  expectedVersion ??= packageVersionForEntry(fileURLToPath(import.meta.url));
  const receipt = installation?.receipt;
  const installed = receipt?.state === 'complete' ? receipt.skills : [];
  const mismatch = managed.find(name => installed.find(skill => skill.name === name)?.source.version !== expectedVersion);
  if (!mismatch) return;
  const currentVersion = installed.find(skill => skill.name === mismatch)?.source.version ?? null;
  const command = skillsUpdateCommand(expectedVersion);
  throw new Problem(PROBLEM_CODE.conflict,
    `Managed skill ${mismatch} requires ${expectedVersion} (installed: ${currentVersion ?? 'unavailable'}). Run locally: ${command}. Then send again.`,
    undefined, { reason: { kind: 'managed_skills_version', skill: mismatch, expectedVersion, currentVersion, command } });
}
