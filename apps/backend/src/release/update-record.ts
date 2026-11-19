import { atomicJson } from './atomic-json.js';
/** One bounded update record. Callers serialize writes with the existing release lock. */
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { hasCode, platform } from '@alpacawork/core';
import { loadJournal, terminal, recovering, type SwitchJournal } from './journal.js';
import { candidateSchema, packageFactsSchema, idSchema, reject, type NpmCandidate } from './npm-records.js';
import { namesSchema, pathSchema } from '../installation/skill-write-contract.js';
import { releasePath } from './edition.js';
import { releaseOperationRunning } from './layout.js';
import { updateRunConflictSchema } from '@alpacawork/contract';
export const UPDATE_RECORD_VERSION = 3 as const;
const controllerSchema = z.object({ pid: z.number().int().positive(), started: z.string().min(1) }).strict();
export type PreparedCandidate = Pick<NpmCandidate, 'candidateId' | 'exactVersion' | 'facts' | 'edition' | 'expectedActive'> & { kind: 'prepared'; origin: string };
const preparedCandidateSchema = z.object({ kind: z.literal('prepared'), origin: z.string().min(1), candidateId: idSchema,
  exactVersion: z.string().min(1), facts: packageFactsSchema, edition: z.enum(['production', 'diagnostic']),
  expectedActive: pathSchema.nullable() }).strict().transform(value => value as PreparedCandidate);
export const isNpmCandidate = (candidate: NpmCandidate | PreparedCandidate): candidate is NpmCandidate => !('kind' in candidate);
const operationSchema = z.object({ opId: idSchema, workspace: z.string(), candidate: z.union([candidateSchema, preparedCandidateSchema]),
  reviewDigest: z.string().regex(/^[a-f0-9]{64}$/), skills: z.object({ root: pathSchema, place: namesSchema }).strict(),
  phase: z.enum(['fetching','staged','failed']), controller: controllerSchema.nullable(),
  failure: z.object({ kind: z.string(), category: z.enum(['network','disk','other']), cause: z.string().optional(), runConflict: updateRunConflictSchema.optional() }).strict().nullable(),
}).strict();
export type UpdateOperation = z.infer<typeof operationSchema>;
const resultSchema = z.object({ opId: idSchema, candidateId: idSchema, reviewDigest: z.string(), version: z.string(),
  result: z.enum(['committed','cancelled','withdrawn','recovered']) }).strict();
const updateRecordSchema = z.object({ version: z.literal(UPDATE_RECORD_VERSION), offer: candidateSchema.nullable(),
  operation: operationSchema.nullable(), lastResult: resultSchema.nullable() }).strict();
export type UpdateRecord = z.infer<typeof updateRecordSchema>;
const updateRecordPath = (releases: string) => join(releases, '.updates', 'state.json');
export const updateTarget = (releases: string, op: UpdateOperation) => releasePath(releases, {source:op.candidate.facts.source, edition:op.candidate.edition});
export function readUpdateRecord(releases: string): UpdateRecord {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(updateRecordPath(releases), 'utf8')); }
  catch (error) { if (hasCode(error, 'ENOENT')) return { version: UPDATE_RECORD_VERSION, offer: null, operation: null, lastResult: null }; return reject('record_invalid', error); }
  const parsed = updateRecordSchema.safeParse(raw);
  if (!parsed.success) reject('record_invalid', parsed.error);
  return parsed.data;
}
export function saveUpdateRecord(releases: string, state: UpdateRecord): void {
  updateRecordSchema.parse(state);
  mkdirSync(join(releases, '.updates'), { recursive: true });
  atomicJson(updateRecordPath(releases), state);
}
export function controllerAlive(operation: Pick<UpdateOperation, 'controller'>): boolean {
  const c = operation.controller;
  return !!c && platform.run.commandProcesses(c.pid, null).some(p => p.pid === c.pid && p.started === c.started);
}
export function updateJournal(releases: string, op: UpdateOperation): SwitchJournal | null {
  return journalForOperation(releases, op, loadJournal({ releases, workspace: op.workspace }));
}
/** The journal references the accepted operation; it never contains a second authorization. */
function journalForOperation(releases: string, op: UpdateOperation, journal: SwitchJournal | null): SwitchJournal | null {
  if (!journal || journal.opId !== op.opId) return null;
  if (journal.workspace !== op.workspace || journal.target !== updateTarget(releases, op)) reject('record_invalid');
  return journal;
}
/** One coherent read per fact for managed commands and status. No liveness I/O here. */
export function readManagedSwitch(releases: string, workspace: string, current: string) {
  const journal = loadJournal({ releases, workspace }), state = readUpdateRecord(releases);
  return checkedManagedSwitch(releases, workspace, current, journal, state);
}
/** Validate an observed switch with the same identity rules as the disk reader. */
export function checkedManagedSwitch(releases: string, workspace: string, current: string | null, journal: SwitchJournal | null, state: UpdateRecord) {
  const operation = state.operation;
  const application = operation && journalForOperation(releases, operation, journal);
  if (!current || !journal || journal.workspace !== workspace || (!terminal(journal) && !application) ||
      (['committed','target_selected','target_ready'].includes(journal.phase) ? journal.target
        : journal.recovery ? ['recovered','recovery_ready'].includes(journal.phase) ? journal.recovery.target : journal.recovery.source
        : journal.old) !== current)
    throw new Error('Managed switch journal is missing, unfinished, or does not select current');
  return { generation: journal.opId, current, workspace: journal.workspace, state, journal };
}
const withdrawnFailure = (op: UpdateOperation) => ['candidate_withdrawn','metadata_changed','metadata_unknown'].includes(op.failure?.kind ?? '');
export function completedUpdate(releases: string, op: UpdateOperation, journal?: SwitchJournal | null): 'committed' | 'recovered' | 'withdrawn' | null {
  const j = journal === undefined ? updateJournal(releases, op) : journalForOperation(releases, op, journal);
  if (j?.phase === 'committed' || j?.phase === 'recovered') return j.phase;
  return withdrawnFailure(op) ? 'withdrawn' : null;
}
/** Before replacing a completed operation, retain only its public result. Never called by GET. */
export function compactUpdateRecord(releases: string, state: UpdateRecord, journal?: SwitchJournal | null): void {
  const op = state.operation, result = op && completedUpdate(releases, op, journal);
  if (!op || !result) return;
  state.lastResult = { opId: op.opId, candidateId: op.candidate.candidateId, reviewDigest: op.reviewDigest,
    version: op.candidate.exactVersion, result };
  state.operation = null;
}

/** Stage comes from the journal after reservation, from acquisition before it. */
function executionStage(journal: SwitchJournal | null): 'fetching' | 'waiting_runs' | 'applying' | 'recovering' {
  if (!journal || terminal(journal)) return 'fetching';
  if (journal.phase === 'restoring_old' || recovering(journal)) return 'recovering';
  return journal.phase === 'waiting_runs' ? 'waiting_runs' : 'applying';
}
/** The only progress observation: durable stage and current executor lifetime are independent facts. */
export function observeUpdate(releases: string, op: UpdateOperation, journal: SwitchJournal | null) {
  const application = journalForOperation(releases, op, journal);
  const result = completedUpdate(releases, op, application);
  if (result) return result;
  const stage = executionStage(application);
  const alive = controllerAlive(op) || stage !== 'fetching' && releaseOperationRunning(releases);
  if (alive) return stage;
  if (stage !== 'fetching') return 'stopped';
  if (op.failure?.kind === 'unsupported') return 'unsupported';
  return op.phase === 'failed' || application?.phase === 'aborted' ? 'failed' : 'stopped';
}
