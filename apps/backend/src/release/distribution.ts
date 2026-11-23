import { appRoot } from '../app-paths.js';
/** One Owner for executable distribution assembly, copying and sealing. No publication or service effects. */
import { accessSync, constants, chmodSync, cpSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { releaseKind, type ReleaseKind } from './edition.js';
import { packageName, packageVersion, parseTargets, readManifest, runtimeClosure, type PackageTarget } from './package-closure.js';
import { copyTree, digest, inventory, regular } from './package-files.js';
import { deriveFacts, validatePackage, type PackageFacts } from './package-facts.js';
import { writeThirdPartyNotices } from './third-party-notices.js';
import { npmReadme } from './npm-readme.js';

export type DistributionIdentity = { source: string; edition: ReleaseKind; targets: readonly PackageTarget[] };
export type DistributionImage = { root: string; facts: PackageFacts };
function identity(facts: PackageFacts, expected: DistributionIdentity): void {
  if (facts.source !== expected.source || facts.edition !== expected.edition ||
      !isDeepStrictEqual(facts.targets, parseTargets(expected.targets.join(','))))
    throw new Error('Distribution SOURCE/edition/targets differ from the request');
}
/** Distribution validation checks launcher read/execute access without repairing published files. */
function validatePermissions(root: string): void {
  for (const [file, required] of [
    ...['alpacawork.mjs', 'backend.mjs', 'agent.mjs'].map(bin => ['bin/' + bin, constants.R_OK | constants.X_OK] as const),
  ]) {
    const path = join(root, file);
    regular(path);
    try { accessSync(path, required); }
    catch (cause) { throw new Error(`Distribution permissions prevent runtime use: ${file}`, { cause }); }
  }
}
/** Read producer metadata and launcher access; npm integrity owns payload verification. */
export function validateDistribution(root: string, expected?: DistributionIdentity): DistributionImage {
  validatePermissions(root);
  const facts = validatePackage(root);
  if (expected) identity(facts, expected);
  return { root, facts };
}
/** The assembly Owner seals build facts and the one inventory exactly once. */
function seal(root: string, manifest: ReturnType<typeof readManifest>, expected: DistributionIdentity): DistributionImage {
  packageName(manifest.name);
  const facts = deriveFacts(root, parseTargets(expected.targets.join(',')));
  identity(facts, expected);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ ...manifest, alpacawork: facts }, null, 2) + '\n');
  writeFileSync(join(root, 'DISTRIBUTION.json'), JSON.stringify(inventory(root), null, 2) + '\n');
  return { root, facts };
}
/** destination must be absent, with an existing parent in the caller's unpublished stage. */
function destination(root: string): void { mkdirSync(root, { mode: 0o700 }); }
export function assembleDistribution(builtRoot: string, root: string, expected: DistributionIdentity): DistributionImage {
  const source = readFileSync(join(builtRoot, 'SOURCE'), 'utf8').trim();
  if (source !== expected.source || releaseKind(builtRoot) !== expected.edition)
    throw new Error('Build SOURCE/edition differs from the request');
  const targets = parseTargets(expected.targets.join(','));
  destination(root);
  for (const file of ['SOURCE', 'FORMAT', 'SCHEMA.json']) copyTree(join(builtRoot, file), join(root, file));
  for (const app of ['backend', 'cli', 'agent-cli']) copyTree(join(builtRoot, 'apps', app, 'dist'), join(root, 'apps', app, 'dist'));
  copyTree(join(builtRoot, 'apps/backend/public'), join(root, 'apps/backend/public'));
  copyTree(join(builtRoot, 'skills'), join(root, 'skills'));
  const docs = join(builtRoot, 'docs'), images = join(docs, 'images') + sep;
  copyTree(docs, join(root, 'docs'), file => !file.startsWith(images) || !file.endsWith('.gif'));
  copyTree(join(builtRoot, 'apps/launcher'), join(root, 'bin'));
  for (const bin of ['alpacawork.mjs', 'backend.mjs', 'agent.mjs']) chmodSync(join(root, 'bin', bin), 0o755);
  for (const file of ['LICENSE', 'SECURITY.md']) if (existsSync(join(builtRoot, file))) copyTree(join(builtRoot, file), join(root, file));
  writeThirdPartyNotices(builtRoot, root);
  const bundled = runtimeClosure(builtRoot, root, targets), original = readManifest(builtRoot);
  if (existsSync(join(builtRoot, 'README.md')))
    writeFileSync(join(root, 'README.md'), npmReadme(readFileSync(join(builtRoot, 'README.md'), 'utf8'), original.name, original.version, source,
      (original.repository as { url?: string } | undefined)?.url, file => existsSync(join(root, file))));
  return seal(root, { name: original.name, version: original.version, type: 'module', engines: original.engines,
    // What the npm page shows. npm Trusted Publishing requires repository.url to name the publishing GitHub repository.
    ...Object.fromEntries(['description', 'keywords', 'license', 'author', 'homepage', 'bugs', 'repository']
      .filter(key => original[key]).map(key => [key, original[key]])),
    bin: { alpacawork: 'bin/alpacawork.mjs', 'alpacawork-backend': 'bin/backend.mjs', 'alpacawork-agent': 'bin/agent.mjs' },
    dependencies: Object.fromEntries(bundled.map(name => [name, readManifest(join(root, 'node_modules', name)).version])),
    bundleDependencies: bundled }, expected);
}
/** Copy an integrity-verified image without generating facts or hashing its contents again. */
export function copyDistribution(imageRoot: string, root: string, expected?: DistributionIdentity, name?: string,
  version?: string): DistributionImage {
  if (name !== undefined) packageName(name);
  if (version !== undefined) packageVersion(version);
  const image = validateDistribution(imageRoot, expected);
  destination(root);
  cpSync(imageRoot, root, { recursive: true });
  if (name !== undefined || version !== undefined) {
    const path = join(root, 'package.json'), manifest = readManifest(root);
    if (name !== undefined) manifest.name = name;
    if (version !== undefined) manifest.version = version;
    const bytes = JSON.stringify(manifest, null, 2) + '\n';
    // The destination is private. Published source modes and bytes remain untouched.
    chmodSync(path, 0o644); writeFileSync(path, bytes);
    const file = join(root, 'DISTRIBUTION.json'), recorded = JSON.parse(readFileSync(file, 'utf8'));
    recorded['package.json'] = { bytes: Buffer.byteLength(bytes), sha256: digest(bytes) };
    chmodSync(file, 0o644); writeFileSync(file, JSON.stringify(recorded, null, 2) + '\n');
  }
  return { root, facts: image.facts };
}

/** Import the running installed package into an unpublished stage using the ordinary copy path. */
export function importSelfDistribution(input: unknown): DistributionImage {
  const command = selfInputSchema.parse(input);
  const source = appRoot(import.meta.url), root = command.destination;
  const inside = relative(source, root);
  if (inside === '' || (!inside.startsWith('../') && inside !== '..'))
    throw new Error('Self distribution stage must be outside the source package');
  const result = copyDistribution(source, root, command.expected);
  return result;
}

// A small target-owned executable protocol. Drivers pass paths and identity, never assembly rules.
const expectedSchema = z.object({ source: z.string().regex(/^[a-f0-9]{40}$/), edition: z.enum(['production', 'diagnostic']),
  targets: z.array(z.enum(['linux-x64-glibc', 'darwin-arm64'])).min(1) }).strict();
const path = z.string().startsWith('/');
const selfInputSchema = z.object({ destination: path, expected: expectedSchema }).strict();
const commandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('assemble'), source: path, destination: path, expected: expectedSchema }).strict(),
  z.object({ operation: z.literal('copy'), source: path, destination: path, expected: expectedSchema, name: z.string().optional(),
    version: z.string().optional() }).strict(),
  z.object({ operation: z.literal('validate'), source: path, expected: expectedSchema }).strict(),
  selfInputSchema.extend({ operation: z.literal('import-self') }).strict(),
]);
export type DistributionCommand = z.infer<typeof commandSchema>;
export function distributionMain() {
  const command = commandSchema.parse(JSON.parse(process.argv[2] ?? 'null'));
  const result = command.operation === 'import-self' ? importSelfDistribution({ destination: command.destination, expected: command.expected })
    : command.operation === 'assemble' ? assembleDistribution(command.source, command.destination, command.expected)
    : command.operation === 'copy' ? copyDistribution(command.source, command.destination, command.expected, command.name, command.version)
      : validateDistribution(command.source, command.expected);
  process.stdout.write(JSON.stringify(result) + '\n');
}
