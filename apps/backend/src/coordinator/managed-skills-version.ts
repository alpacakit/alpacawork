/** Admission reads receipt versions only. Skill contents and Run assets are not compatibility tests. */
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Problem, PROBLEM_CODE, hasCode, packageVersionForEntry } from '@alpacawork/core';
import { InstalledSkillsStore, BUNDLED_SKILL_NAMES, managedSkillsRoot, SkillsRefused } from '@alpacawork/core/installed-skills';
import { skillsUpdateCommand } from '../installation/skills-update-command.js';

export function assertManagedSkillsVersion(selected: readonly string[], home = homedir(),
  expectedVersion?: string): void {
  const managed = selected.filter(name => BUNDLED_SKILL_NAMES.some(each => each === name));
  if (!managed.length) return;
  // undefined: the receipt is unreadable, so no selected skill can be shown to be outside alpacawork's care.
  let receipt: NonNullable<ReturnType<InstalledSkillsStore['read']>>['receipt'] | null | undefined;
  try { receipt = new InstalledSkillsStore(managedSkillsRoot(home)).read()?.receipt ?? null; }
  catch (error) {
    if (hasCode(error, 'ENOENT')) receipt = null;
    else if (!(error instanceof SkillsRefused)) throw error;
  }
  // alpacawork keeps only the skills its receipt lists current; a skill placed by hand (or a source checkout's) is its owner's.
  const recorded = receipt === undefined ? managed : receipt === null ? [] : managed.filter(name =>
    receipt.skills.some(skill => skill.name === name) || receipt.state !== 'complete' && receipt.request.remove.some(each => each === name));
  if (!recorded.length) return;
  expectedVersion ??= packageVersionForEntry(fileURLToPath(import.meta.url));
  const installed = receipt?.state === 'complete' ? receipt.skills : [];
  const mismatch = recorded.find(name => installed.find(skill => skill.name === name)?.source.version !== expectedVersion);
  if (!mismatch) return;
  const currentVersion = installed.find(skill => skill.name === mismatch)?.source.version ?? null;
  const command = skillsUpdateCommand(expectedVersion);
  throw new Problem(PROBLEM_CODE.conflict,
    `Managed skill ${mismatch} requires ${expectedVersion} (installed: ${currentVersion ?? 'unavailable'}). Run on the computer where the alpacawork server runs: ${command}. Then send again.`,
    undefined, { reason: { kind: 'managed_skills_version', skill: mismatch, expectedVersion, currentVersion, command } });
}
