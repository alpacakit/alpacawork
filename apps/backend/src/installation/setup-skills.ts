/** Setup keeps its pending request until HTTP readiness. The Store owns the skill receipt. */
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readRecord, publishRecord, syncDirectory } from './skill-files.js';
import { ManagedSkillsWriter, requestSchema, equal, type SkillWriteRequest } from './skills.js';
export const setupSkillsSchema = z.object({ version: z.literal(2), workspace: z.string(), root: z.string(), request: requestSchema }).strict();
export type SetupSkills = z.infer<typeof setupSkillsSchema>;
export const setupSkillsPath = (releases: string) => join(releases, 'setup-skills.json');
export function readSetupSkills(releases: string): SetupSkills | null {
  try { const value = readRecord(setupSkillsPath(releases)); return value === null ? null : setupSkillsSchema.parse(value); }
  catch (cause) { throw new Error('Unknown or invalid setup journal; preserve it and inspect the logged cause.', {cause}); }
}
export const newSetupSkills = (workspace: string, root: string, request: SkillWriteRequest): SetupSkills =>
  setupSkillsSchema.parse({ version: 2, workspace, root, request });
export function saveSetupSkills(releases: string, saved: SetupSkills): void { publishRecord(setupSkillsPath(releases), setupSkillsSchema.parse(saved)); }
/** Called under the release lock only after the whole setup reached its approved HTTP port. */
export function completeSetup(releases: string, saved: SetupSkills): void {
  if (!equal(readSetupSkills(releases), saved)) throw new Error('Setup request changed before completion; retained');
  unlinkSync(setupSkillsPath(releases)); syncDirectory(releases);
}
export async function finishSetupSkills(_releases: string, saved: SetupSkills, writer: ManagedSkillsWriter, say: (line: string) => void): Promise<void> {
  await writer.install(saved.request); say('Managed skills installed.');
}
