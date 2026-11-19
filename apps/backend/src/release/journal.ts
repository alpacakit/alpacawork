import type { Caller } from '../control/authorize.js';
/** The switch journal alone decides whether serve may open databases and start work. */
import { existsSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { hasCode, Problem, PROBLEM_CODE } from '@alpacawork/core';
import { atomicJson } from './atomic-json.js';
import { syncFile, parseControlSchema, parseMigrationHistory, type ControlSchema, type MigrationIdentity } from '@alpacawork/db';

import { RECOVERY_PROTOCOL,RESTORE_HEADER,INITIAL_RESTORE_ID } from '@alpacawork/contract/recovery';
export { RECOVERY_PROTOCOL,RESTORE_HEADER,INITIAL_RESTORE_ID };
export type Phase = 'waiting_runs' | 'prepared' | 'old_stopped' | 'restoring_old' | 'aborted' |
  'maintenance_complete' | 'target_selected' | 'target_ready' | 'committed' |
  'recovery_intent' | 'recovery_stopped' | 'recovery_saved' | 'recovery_replacing' |
  'recovery_floor' | 'recovery_check' | 'recovery_ready' | 'recovered';
export type RecoveryGrant = {caller:Extract<Caller,{kind:'run'}>;tokenDigest:string};
export const JOURNAL_VERSION = 4 as const;
/** Keep the on-disk representation while the source serve still reads the handoff. */
export const newJournalVersion = (onDisk: SwitchJournal | null): typeof JOURNAL_VERSION => onDisk?.version ?? JOURNAL_VERSION;
export type SwitchJournal = { version: typeof JOURNAL_VERSION; opId: string; workspace: string; old: string | null; target: string; previous: string | null;
  skillsWriteStarted: boolean; ready?:{release:string;url:string;generation:string}; phase: Phase; schema: number | null; control?: ControlSchema; host?: MigrationIdentity[] | null;
  abortReason?: string; restoreStoppedGeneration?: string;
  backup?: string; recovery?: { id: string; backup: string; source: string; reader:string; target: string; replaced: string[]; failure: string;
    diagnostics?: unknown; beforeGeneration?: string | null; authorization?:RecoveryGrant };
  drained?: { workspace: string; generation: string; nonce: string; state: 'drained' } };
const phases: Phase[] = ['waiting_runs','prepared','old_stopped','restoring_old','aborted','maintenance_complete',
  'target_selected','target_ready','committed','recovery_intent','recovery_stopped','recovery_saved',
  'recovery_replacing','recovery_floor','recovery_check','recovery_ready','recovered'];
export const terminal = (journal: SwitchJournal) => ['committed','aborted','recovered'].includes(journal.phase);
/** The durable stopped boundary, including restoration, selects the update-side process after a crash. */
export function stoppedContinuationTarget(journal:SwitchJournal|null):string|null {
 return journal&&['old_stopped','maintenance_complete','target_selected','target_ready','restoring_old'].includes(journal.phase)?journal.target:null;
}
/** Once overwriting starts, neither automatic application rollback nor DB recovery may claim restored originals. */
export function canRestorePreviousApplication(journal: SwitchJournal): boolean {
  return !journal.skillsWriteStarted;
}
export const recovering = (journal: SwitchJournal) => journal.phase.startsWith('recovery_')||journal.phase==='waiting_runs'&&journal.recovery!==undefined;
export const recoveryGrantSchema=z.object({caller:z.object({kind:z.literal('run'),runId:z.string(),placementId:z.string(),taskId:z.string(),role:z.enum(['owner','worker']),responsible:z.boolean()}),tokenDigest:z.string().regex(/^[a-f0-9]{64}$/)});
const journalSchema = z.object({ version: z.literal(JOURNAL_VERSION), opId: z.string().min(1), workspace: z.string(),
  old: z.string().nullable(), target: z.string(), previous: z.string().nullable(), phase: z.enum(phases as [Phase,...Phase[]]),
  skillsWriteStarted:z.boolean(),
  control:z.unknown().transform(parseControlSchema).optional(), host:z.unknown().transform(parseMigrationHistory).nullable().optional(),
  abortReason:z.string().optional(), restoreStoppedGeneration:z.string().optional(), backup:z.string().optional(),
  drained:z.object({workspace:z.string(),generation:z.string(),nonce:z.string(),state:z.literal('drained')}).strict().optional(), ready:z.object({release:z.string(),url:z.string(),generation:z.string()}).strict().optional(), schema: z.number().nullable(), recovery: z.object({ id: z.string().uuid(), backup: z.string(), source: z.string(), reader:z.string(),
    target: z.string(), replaced: z.array(z.string()), failure: z.string(), diagnostics: z.unknown().optional(),
    beforeGeneration: z.string().nullable().optional(), authorization:recoveryGrantSchema.optional() }).strict().optional() }).strict();
/** Acquisition/access/safety failed before journal syntax or identity could be judged. */
export class JournalReadFault extends Error {
  constructor(cause: unknown) { super('Switch journal could not be read safely', { cause }); }
}
export function loadJournal(place: { releases: string; workspace?: string }): SwitchJournal | null {
  const path = join(place.releases, 'switch.json');
  let text: string;
  try {  text = readFileSync(path, 'utf8'); }
  catch (cause) { if (hasCode(cause, 'ENOENT')) return null; throw new JournalReadFault(cause); }
  return decodeJournal(place,text);
}
export class JournalUnsupportedVersion extends Error {constructor(readonly version:unknown){super('Unsupported switch journal version');}}
function decodeJournal(place:{releases:string;workspace?:string},text:string):SwitchJournal {
  const raw=JSON.parse(text);if(raw&&typeof raw==='object'&&raw.version!==JOURNAL_VERSION)throw new JournalUnsupportedVersion(raw.version);
  const journal = journalSchema.parse(raw) as SwitchJournal;
  if (place.workspace !== undefined && journal.workspace !== place.workspace || recovering(journal) && !journal.recovery)
    throw new Error('Switch journal identity/phase mismatch');
  return journal;
}
export function saveJournal(place: { releases: string; workspace: string }, journal: SwitchJournal): void {
  journalSchema.parse(journal);
  statSync(join(place.workspace, '.alpacawork'));
  // Publish the locator first. A missing/corrupt journal then fails closed, before any DB open.
  atomicJson(join(place.workspace, '.alpacawork/release-location.json'), { releases: resolve(place.releases) });
  atomicJson(join(place.releases, 'switch.json'), journal);
  if(readFileSync(join(place.releases,'switch.json'),'utf8')!==JSON.stringify(journal))throw new Error('Switch journal readback differs');
}
function workspaceLocation(root: string): { releases: string } | null {
  const path = join(root, '.alpacawork/release-location.json');
  try { return z.object({ releases: z.string() }).strict().parse(JSON.parse(readFileSync(path, 'utf8'))); }
  catch (error) { if (hasCode(error, 'ENOENT')) return null; throw error; }
}
export function workspaceJournal(root: string): SwitchJournal | null {
  const location = workspaceLocation(root);
  if (!location) return null;
  statSync(location.releases);
  const journal = loadJournal({ releases: location.releases, workspace: resolve(root) });
  if (!journal) throw new Error('Located switch journal is missing; maintenance required');
  return journal;
}
/** Read-only admission for removal; a locator without its journal remains a maintenance fault. */
export function assertFinishedJournalRemoval(place: { releases: string; workspace: string }): void {
  const location = workspaceLocation(place.workspace);
  if (location && realpathSync(location.releases) !== realpathSync(place.releases))
    throw new Problem(PROBLEM_CODE.conflict, 'Workspace switch journal belongs to another installation');
  const journal = loadJournal({ releases: place.releases });
  if (journal && resolve(journal.workspace) !== resolve(place.workspace) && realpathSync(journal.workspace) !== realpathSync(place.workspace))
    throw new Problem(PROBLEM_CODE.conflict, 'Switch journal belongs to another workspace');
  if (location && !journal) throw new Problem(PROBLEM_CODE.conflict, 'Located switch journal is missing; maintenance required');
  if (journal && !terminal(journal))
    throw new Problem(PROBLEM_CODE.conflict, 'Cannot remove an installation with an unfinished switch journal', { phase: journal.phase });
}
/** Caller holds the releases lock and has stopped the service. Detach before deleting the target. */
export function removeFinishedJournal(place: { releases: string; workspace: string }): void {
  assertFinishedJournalRemoval(place);
  rmSync(join(place.workspace, '.alpacawork/release-location.json'), { force: true });
  if (existsSync(join(place.workspace, '.alpacawork'))) syncFile(join(place.workspace, '.alpacawork'));
  rmSync(join(place.releases, 'switch.json'), { force: true });
  syncFile(place.releases);
}
/** waiting_runs deliberately continues old Run reports and import; only launching is suppressed. */
export function releaseAdmission(root: string): 'accepting' | 'waiting_runs' | 'maintenance' {
  const journal = workspaceJournal(root);
  return !journal || terminal(journal) ? 'accepting' : journal.phase === 'waiting_runs' ? 'waiting_runs' : 'maintenance';
}
export function assertServeAdmission(root: string, release: string | null = null): void {
  const journal = workspaceJournal(root);
  const expected = journal?.phase === 'restoring_old' ? journal.old
    : journal?.phase === 'recovery_ready' ? journal.recovery?.target
    : journal && ['target_selected','target_ready'].includes(journal.phase) ? journal.target : null;
  if (releaseAdmission(root) === 'maintenance' && !(release !== null && expected === release)) throw new Problem(PROBLEM_CODE.conflict,
    'Release maintenance is incomplete; resume the same target and journal before serve', { journal: workspaceJournal(root) }, { reason: { kind: 'release_maintenance_resume_before_serve' } });
}
type RecoveryReference = { id: string; failure: string; reader: string };
type RestoreIdentity = RecoveryReference & { version: 1; previous?: RecoveryReference[] };
export function restoreIdentity(root: string): RestoreIdentity | null {
  const path = join(root, '.alpacawork/restore-identity.json');
  try {  return z.object({ version: z.literal(1), id: z.string().uuid(), failure: z.string(), reader: z.string(), previous:z.array(z.object({id:z.string().uuid(),failure:z.string(),reader:z.string()}).strict()).optional() })
    .strict().parse(JSON.parse(readFileSync(path, 'utf8'))); }
  catch (error) { if (hasCode(error, 'ENOENT')) return null; throw error; }
}
export function recoveryLineage(root:string):RecoveryReference[] {
  const current=restoreIdentity(root);return current?[current,...current.previous??[]]:[];
}
export function publishRestoreIdentity(root:string,identity:RecoveryReference):void {
  const previous=recoveryLineage(root).filter(item=>item.id!==identity.id).map(({id,failure,reader})=>({id,failure,reader}));
  atomicJson(join(root,'.alpacawork/restore-identity.json'),{version:1,...identity,previous});
}
export const restoreId = (root: string) => restoreIdentity(root)?.id ?? INITIAL_RESTORE_ID;
export function assertMutationIdentity(root: string, sent: string | null): void {
  const expected = restoreId(root);
  // The initial pre-recovery browser has no pin yet. After a restore every writer must carry an explicit pin.
  if (sent === expected || sent === null && expected === INITIAL_RESTORE_ID) return;
  throw new Problem(PROBLEM_CODE.restoreChanged, 'Workspace was restored; do not repeat the old operation. Check its earlier result',
    { expectedRestoreId: expected, receivedRestoreId: sent, priorResult: 'operation get', notFoundProvesUnexecuted: false });
}
/** An already-running old serve finishes its final handoff; a new serve still fails at the bootstrap gate. */
export function assertImportAdmission(root:string,release:string|null):void {
  const journal=workspaceJournal(root);
  const drainingSource=journal?.phase==='prepared'?journal.old:journal?.phase==='recovery_intent'?journal.recovery?.source:null;
  if(release!==null&&drainingSource===release)return;
  assertServeAdmission(root,release);
}
/** All application Run reservation sites consume this decision; waiting reports and imports do not reserve a Run. */
export function assertRunReservation(root:string):void {
  if(releaseAdmission(root)!=='accepting')throw new Problem(PROBLEM_CODE.busy,'Release is waiting; new Run reservations are paused',undefined,{reason:{kind:'release_waiting_new_runs_paused'}});
}
