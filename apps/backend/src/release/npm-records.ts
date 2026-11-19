/** npm candidate codecs and release-owned acquisition metadata; no update authorization or retention. */
import { join, isAbsolute } from 'node:path';
import { z } from 'zod';
import { parseControlSchema, parseMigrationHistory } from '@alpacawork/db';
import { mkdirSync } from 'node:fs';
import { atomicJson } from './atomic-json.js';
import type { ReleaseKind } from './edition.js';
import type { PackageTarget } from './package-closure.js';
import type { PackageFacts } from './package-facts.js';
export type CandidateEnvironment = {
  /** From the installation Owner, never discovered across prefixes. Compatibility is evaluated by the later apply Owner. */
  managedNodeVersion: string; target: PackageTarget; edition: ReleaseKind;
};
export const NPM_RECORD_VERSION = 1 as const;
export type NpmCandidate = {
  version: typeof NPM_RECORD_VERSION;
  candidateId: string; registryOrigin: string; packageName: string; exactVersion: string;
  tarball: string; integrity: string; metadataDigest: string; edition: ReleaseKind;
  facts: PackageFacts; engines: { node: string }; environment: CandidateEnvironment; expectedActive: string | null;
  /** No release-note contract exists yet. Unknown never means no changes. */
  changes: 'unknown';
};
/** Only a subsequent existing human authorization boundary may construct this command.
 * It must bind the exact review and checkbox intent there. Run permissions and arbitrary browser bodies are not approval.
 * This module intentionally exposes no HTTP/Run/CLI entry for constructing or submitting it.
 */
export type HumanConfirmedNpmCandidate = Pick<NpmCandidate, 'candidateId' | 'metadataDigest' | 'expectedActive'> & { opId: string };
export type CandidateFailure = 'invalid_input' | 'metadata_failed' | 'metadata_unknown' | 'candidate_withdrawn' |
  'confirmation_mismatch' | 'expected_active_changed' | 'metadata_changed' |
  'download_failed' | 'integrity_mismatch' | 'archive_invalid' | 'validation_failed' | 'stage_conflict' |
  'aborted' | 'deadline' | 'cleanup_failed' | 'io_failed' | 'record_invalid' |
  'operation_busy' | 'operation_terminal' | 'input_conflict';
export type CandidateResult<T> = { ok: true; value: T } | { ok: false; error: { kind: CandidateFailure; cause?: string; fault?: unknown; httpStatus?: number } };
export const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const id = (v: string) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(v);
export const sha256 = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
// The DB Owner alone validates control reader/history identities and migration eligibility.
export const schemaFacts = z.object({
  control: z.unknown(),
  host: z.array(z.unknown()).min(1),
}).superRefine((facts, context) => {
  try { parseControlSchema(facts.control); parseMigrationHistory(facts.host); }
  catch { context.addIssue({ code: 'custom', message: 'Unknown schema history' }); }
});
export function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
}

export class CandidateRejection extends Error {
  constructor(readonly kind: CandidateFailure, cause?: unknown) { super(kind, { cause }); }
}
export function reject(kind: CandidateFailure, cause?: unknown): never { throw new CandidateRejection(kind, cause); }
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const pathSchema = z.string().refine(isAbsolute);
const nullablePath = pathSchema.nullable();
const editionSchema = z.enum(['production', 'diagnostic']);
const environmentSchema = z.object({ managedNodeVersion: z.string().regex(/^v?\d+\.\d+\.\d+/),
  target: z.enum(['linux-x64-glibc', 'darwin-arm64']), edition: editionSchema }).strict();
const recordFormatSchema=z.object({read:z.array(z.number().int().positive()).nonempty(),write:z.number().int().positive(),migrate:z.array(z.object({from:z.number().int().positive(),to:z.number().int().positive()}).strict())}).strict().refine(f=>f.read.includes(f.write));
export const updateCapabilitiesSchema=z.object({handoff:z.number().int().positive(),records:z.record(z.string(),recordFormatSchema)}).strict();
export const packageFactsSchema = z.object({ source: z.string().regex(/^[a-f0-9]{40}$/), edition: editionSchema,
  format: z.string().min(1), schema: schemaFacts, update:updateCapabilitiesSchema,
  skills: z.object({ sha256: digestSchema }).passthrough(),
  targets: z.array(z.enum(['linux-x64-glibc', 'darwin-arm64'])).min(1),
}).passthrough();
export const candidateSchema = z.object({ version: z.literal(NPM_RECORD_VERSION), candidateId: idSchema, registryOrigin: z.url(), packageName: z.string().min(1),
  exactVersion: z.string().min(1), tarball: z.url(), integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/),
  metadataDigest: digestSchema, edition: editionSchema, facts: packageFactsSchema,
  engines: z.object({ node: z.string().min(1) }).strict(), environment: environmentSchema,
  expectedActive: nullablePath, changes: z.literal('unknown'),
}).strict().transform(value => value as NpmCandidate);
const provenanceSchema = z.object({ version: z.literal(NPM_RECORD_VERSION), registryOrigin: z.url(), packageName: z.string().min(1), exactVersion: z.string().min(1),
  tarball: z.url(), integrity: z.string().min(1), sha256: digestSchema, bytes: z.number().int().positive(), treeDigest: digestSchema }).strict();
export const provenanceDirectory = (releases: string) => join(releases, '.release-metadata');
function provenancePath(releases: string, key: string): string {
  if (!/^[a-f0-9]{40}(?:-diagnostic)?$/.test(key)) reject('invalid_input');
  return join(provenanceDirectory(releases), key + '.json');
}
/** Release-owned acquisition metadata. Caller holds L; this never creates an update or retains code. */
export function publishProvenance(releases: string, key: string, value: z.input<typeof provenanceSchema>): void {
  provenanceSchema.parse(value);
  // This is the latest verified acquisition receipt, not the distribution identity or a reuse gate.
  mkdirSync(provenanceDirectory(releases),{recursive:true});
  atomicJson(provenancePath(releases,key),value);
}
