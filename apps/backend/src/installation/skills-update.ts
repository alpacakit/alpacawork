/** Local skills-only caller. Placement and receipt publication belong exclusively to the common writer. */
import { uiLocaleFromEnvironment } from '@alpacawork/core/ui-language';
import { skillsUpdateCommand } from './skills-update-command.js';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { BUNDLED_SKILL_NAMES } from '@alpacawork/core/installed-skills';
import { readPackageVersion } from '@alpacawork/core/package-version';

import { ManagedSkillsWriter, type SkillWriteRequest, type SkillWriteResult } from './skills.js';
import { installationSkillsRoot } from './setup.js';
import { inspectAgentSkillLinks } from './agent-skill-links.js';
import { skillLinkConflicts } from './confirmation.js';

export type SkillsUpdateFactory = (input: { root: string }) => { install(input: SkillWriteRequest): Promise<SkillWriteResult> };

export async function main(args: string[], input: { release: string; createWriter?: SkillsUpdateFactory }): Promise<void> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log('alpacawork skills update [--package-version <version>] [--operation-id <UUID>]\nUpdate current release skills in your local HOME (bundled when not installed). --package-version requires that exact bundled package. Repeat a failed operation with the printed operation ID.');
    return;
  }
  let values: { 'package-version'?: string; 'operation-id'?: string };
  try { ({ values } = parseArgs({ args, options: { 'package-version': { type: 'string' }, 'operation-id': { type: 'string' } }, allowPositionals: false })); }
  catch { throw new Error('Usage: alpacawork skills update [--package-version <version>] [--operation-id <UUID>]'); }
  const operationId = z.uuid().parse(values['operation-id'] ?? randomUUID());
  const release = realpathSync(input.release), facts = readPackageVersion(release);
  if (values['package-version'] !== undefined && values['package-version'] !== facts.version)
    throw new Error(`This package is ${facts.version}; run ${skillsUpdateCommand(values['package-version'])}`);
  // The installation Owner selects this root; this caller only forwards it.
  const root = installationSkillsRoot();
  const place = BUNDLED_SKILL_NAMES.filter(name => existsSync(join(release, 'skills', name, 'SKILL.md'))).sort();
  if (!place.includes('alpacawork')) throw new Error('Bundled release has no alpacawork skill');
  const writer = (input.createWriter ?? (input => new ManagedSkillsWriter(input)))({ root });
  console.error(`Skills update operation: ${operationId}. To resume: ${skillsUpdateCommand(facts.version)} --operation-id ${operationId}`);
  const result = await writer.install({ version: 2, operationId, release, intent: { place, remove: [] } });
  for (const line of skillLinkConflicts(inspectAgentSkillLinks(root, place, []), uiLocaleFromEnvironment(process.env))) console.error(line);
  console.log(JSON.stringify(result));
}
