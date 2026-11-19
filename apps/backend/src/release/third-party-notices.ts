/** Joins the build outputs' third-party records into the package's one notices file. Records come only from the bundler. */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/** Every bundled output, relative to the build root; each writes `third-party.json` (scripts/third-party-record.ts). */
export const BUNDLED_OUTPUTS = ['apps/backend/dist', 'apps/cli/dist', 'apps/agent-cli/dist', 'apps/backend/public'] as const;
export const THIRD_PARTY_NOTICES = 'THIRD-PARTY-NOTICES';
const RECORD = 'third-party.json';

const recordSchema = z.array(z.object({
  name: z.string().min(1), version: z.string().min(1), license: z.string().nullable(), author: z.string().nullable(),
  repository: z.string().nullable(), texts: z.array(z.object({ file: z.string(), text: z.string() })),
}).strict());
type ThirdPartyPackage = z.infer<typeof recordSchema>[number];

function section(found: ThirdPartyPackage): string {
  if (!found.texts.length) throw new Error(`Bundled ${found.name}@${found.version} has no license text to reproduce`);
  return [`${found.name} ${found.version}`, `License: ${found.license ?? 'not declared in package.json; see the text below'}`,
    ...found.repository ? [`Source: ${found.repository}`] : [], '', ...found.texts.map(entry => `--- ${entry.file} ---\n${entry.text}`)].join('\n');
}

/** Reads every output's record; a missing record fails assembly rather than shipping without notices. */
export function bundledPackages(builtRoot: string): ThirdPartyPackage[] {
  const packages = new Map<string, ThirdPartyPackage>();
  for (const output of BUNDLED_OUTPUTS)
    for (const found of recordSchema.parse(JSON.parse(readFileSync(join(builtRoot, output, RECORD), 'utf8'))))
      packages.set(found.name + '@' + found.version, found);
  return [...packages.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, found]) => found);
}

/** Writes the notices into the copied image and drops the per-output records, which the notices replace. */
export function writeThirdPartyNotices(builtRoot: string, root: string): void {
  const packages = bundledPackages(builtRoot);
  const intro = 'alpacawork bundles the following third-party packages into its executables and web screens.\n' +
    'Each package\'s source code is available from its Source line. Packages installed under node_modules carry their own license files.';
  writeFileSync(join(root, THIRD_PARTY_NOTICES), [intro, ...packages.map(section)].join('\n\n' + '='.repeat(72) + '\n\n') + '\n');
  for (const output of BUNDLED_OUTPUTS) rmSync(join(root, output, RECORD));
}
