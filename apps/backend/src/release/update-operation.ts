import { releasePath } from './edition.js';
/** The sole Owner of update acceptance, authorization, acquisition and offer consumption. */
import { readlinkSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { digestBytes, hasCode, Problem, PROBLEM_CODE, faultReason } from '@alpacawork/core';
import { InstalledSkillsStore, bundledSkillSelection } from '@alpacawork/core/installed-skills';
import { resolveUpdateRuntime } from './update-runtime.js';
import { assertJournalUpdateHandoff } from './update-capabilities.js';
import { launchUpdateController } from './update-controller.js';
import { saveJournal, loadJournal, terminal, type SwitchJournal, JournalReadFault, JournalUnsupportedVersion } from './journal.js';
import { holdReleases, readFormat, validateRelease } from './layout.js';
import { InstallationStore, installationPath, type Installation } from '../installation/store.js';
import { thisRelease } from './location.js';
import { CandidateRejection, reject, stable, type HumanConfirmedNpmCandidate, type NpmCandidate } from './npm-records.js';
import { readUpdateRecord, readManagedSwitch, checkedManagedSwitch, type UpdateRecord, saveUpdateRecord, compactUpdateRecord, completedUpdate,
  isNpmCandidate, updateTarget, type PreparedCandidate, type UpdateOperation } from './update-record.js';
function refused(reason: string, detail?: object, cause?: unknown): never {
  throw new Problem(reason === 'not_found' ? PROBLEM_CODE.notFound : PROBLEM_CODE.conflict,
    `Update refused: ${reason}`, { reason, ...detail },
    { cause, reason: { kind: 'update_refused', reason, ...(cause === undefined ? {} : { cause: faultReason(cause) }) } });
}
export function currentRelease(releases: string): string | null {
  try { return resolve(releases, readlinkSync(join(releases, 'current'))); }
  catch (error) { if (hasCode(error, 'ENOENT')) return null; throw error; }
}
export function managedScope(workspace: string) {
  const release = thisRelease();
  if (!release) refused('not_managed');
  try {
    const canonicalWorkspace = realpathSync(workspace), releases = realpathSync(dirname(release));
    const current = currentRelease(releases);
    if (current !== release || realpathSync(current) !== release) refused('not_managed');
    validateRelease(releases, release);
    const format = readFormat(release);
    if (!format) refused('not_managed');
    const journal = readManagedSwitch(releases, canonicalWorkspace, current);
    return { ...journal, releases, format };
  } catch (error) {
    if (error instanceof Problem) throw error;
    if (error instanceof JournalUnsupportedVersion) refused('unsupported', undefined, error);
    if (error instanceof JournalReadFault) throw new Problem(PROBLEM_CODE.unavailable, 'Update scope is unavailable', undefined, { cause:error, reason:faultReason(error) });
    refused('not_managed', undefined, error);
  }
}
/** All release/update decisions use this lock. No operation inode, lease or second lock. */
export function updateDecision<T>(releases: string, work: () => T): T {
  let unlock: () => void;
  try { unlock = holdReleases(releases); } catch (error) { reject('operation_busy', error); }
  try { return work(); } finally { unlock(); }
}
/** Bounded lock acquisition for work already owned by an accepted update. */
export async function awaitUpdateDecision<T>(releases: string, work: () => T, canWait: () => boolean = () => true, waitMs = 30_000): Promise<T> {
  for (const deadline = performance.now() + waitMs;;) {
    try { return updateDecision(releases, work); }
    catch (error) {
      if (!(error instanceof CandidateRejection) || error.kind !== 'operation_busy' || performance.now() >= deadline || !canWait()) throw error;
      await delay(25);
    }
  }
}
/** Translate expected update conflicts once at the human HTTP command boundary. */
async function humanDecision<T>(work: () => T | Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) { if (error instanceof CandidateRejection) refused(error.kind, undefined, error); throw error; }
}
function placement(root: string, receipt: NonNullable<ReturnType<InstalledSkillsStore['read']>>['receipt'] | undefined) {
  if (receipt?.state !== 'complete') refused('not_installed');
  return { root, place: bundledSkillSelection(receipt.skills.map(s => s.name)) };
}
function reviewDigest(candidate: NpmCandidate, skills: ReturnType<typeof placement>) {
  return digestBytes(stable({ candidateId:candidate.candidateId, registry:candidate.registryOrigin, packageName:candidate.packageName,
    version:candidate.exactVersion, integrity:candidate.integrity, source:candidate.facts.source, edition:candidate.edition,
    expectedCurrent:candidate.expectedActive, skills }));
}
const inputFor = (op: UpdateOperation) => ({ opId:op.opId, candidateId:op.candidate.candidateId, reviewDigest:op.reviewDigest });
function response(op: UpdateOperation, result: string | null = null) {
  return { ...inputFor(op), terminal: result === 'cancelled' ? 'cancelled' as const : null };
}
/** Discovery publication replaces the offer atomically and never changes an accepted operation. Caller holds L. */
export function offerUpdateLocked(releases: string, candidate: NpmCandidate | null): void {
  const state = readUpdateRecord(releases); compactUpdateRecord(releases, state);
  if (state.operation) return;
  state.offer = candidate; saveUpdateRecord(releases, state);
}
export async function reviewUpdate(workspace: string, candidateId?: string) {
  try {
    const runtime = resolveUpdateRuntime(workspace);
    const scope = managedScope(workspace), state = scope.state, op = state.operation;
    if (op && !completedUpdate(scope.releases, op, scope.journal)) {
      if (op.workspace !== scope.workspace || candidateId && candidateId !== op.candidate.candidateId) return {kind:'unavailable' as const};
      return {kind:'ready' as const,candidateId:op.candidate.candidateId,version:op.candidate.exactVersion,
        reviewDigest:op.reviewDigest,skills:op.skills.place,resume:inputFor(op)};
    }
    const c = state.offer;
    if (!candidateId || !c || c.candidateId !== candidateId || c.expectedActive !== scope.current) return {kind:'unavailable' as const};
    const root = runtime.writer.root, skills = placement(root, new InstalledSkillsStore(root).read()?.receipt);
    return {kind:'ready' as const,candidateId,version:c.exactVersion,reviewDigest:reviewDigest(c,skills),skills:skills.place,resume:null};
  } catch (error) { console.error('Update review unavailable', error); return {kind:'unavailable' as const}; }
}
export async function confirmUpdate(workspace: string, input: {opId:string;candidateId:string;reviewDigest:string}) {
  // Locate only the lock before entering it; current and authorization are observed under that lock.
  const release = thisRelease();
  if (!release) refused('not_managed');
  const releases = realpathSync(dirname(release));
  return humanDecision(() => awaitUpdateDecision(releases, () => {
    const runtime = resolveUpdateRuntime(workspace), root = runtime.writer.root;
    const current = managedScope(workspace), state = current.state, op = state.operation;
    if (current.releases !== releases) refused('stale');
    if (op?.opId === input.opId) {
      if (stable(inputFor(op)) !== stable(input)) refused('input_conflict');
      if (op.workspace !== current.workspace || root !== op.skills.root) refused('stale');
      const receipt = new InstalledSkillsStore(root).read()?.receipt;
      if (receipt?.state === 'complete' && stable(bundledSkillSelection(receipt.skills.map(s=>s.name))) !== stable(bundledSkillSelection(op.skills.place))) refused('stale');
      saveUpdateRecord(current.releases, state);
      return response(op);
    }
    if (state.lastResult?.opId === input.opId) {
      const result = state.lastResult;
      if (result.candidateId !== input.candidateId || result.reviewDigest !== input.reviewDigest) refused('input_conflict');
      saveUpdateRecord(current.releases, state);
      return { ...input, terminal:result.result === 'cancelled' ? 'cancelled' as const : null };
    }
    compactUpdateRecord(current.releases, state, current.journal);
    if (state.operation) refused('pending_operations');
    if (!terminal(current.journal)) refused('operation_busy');
    const receipt = new InstalledSkillsStore(root).read()?.receipt;
    const candidate = state.offer, skills = placement(root, receipt);
    if (!candidate || candidate.candidateId !== input.candidateId || candidate.expectedActive !== current.current ||
        reviewDigest(candidate, skills) !== input.reviewDigest) refused('stale');
    const operation: UpdateOperation = { opId:input.opId, workspace:current.workspace, candidate, reviewDigest:input.reviewDigest,
      skills,
      phase:'fetching',controller:null,failure:null };
    state.operation = operation; state.offer = null;
    saveUpdateRecord(current.releases, state);
    return response(operation);
  }, () => {
    // This unlocked observation only permits waiting; authorization and publication stay under L.
    const { operation, lastResult } = readUpdateRecord(releases);
    const accepted = operation?.opId === input.opId ? inputFor(operation) : lastResult;
    return !!accepted && accepted.opId === input.opId && accepted.candidateId === input.candidateId && accepted.reviewDigest === input.reviewDigest;
  }, 5_000));
}
export async function confirmAndStartUpdate(workspace: string, input: Parameters<typeof confirmUpdate>[1]) {
  const result = await confirmUpdate(workspace, input);
  if (!result.terminal) await launchUpdateController(workspace, input.opId);
  return result;
}
export async function cancelUpdate(workspace: string, opId: string) {
  resolveUpdateRuntime(workspace);
  const scope = managedScope(workspace);
  return humanDecision(() => updateDecision(scope.releases, () => {
    // Re-read after lock acquisition; the initial scope was only for this command's lock location.
    const current = managedScope(workspace), state = current.state, op = state.operation;
    if (!op || op.opId !== opId) {
      if (state.lastResult?.opId === opId && state.lastResult.result === 'cancelled') {
        saveUpdateRecord(scope.releases,state);
        return {opId,candidateId:state.lastResult.candidateId,reviewDigest:state.lastResult.reviewDigest,terminal:'cancelled' as const};
      }
      refused('not_found');
    }
    const journal = current.journal.opId === op.opId ? current.journal : null;
    if (journal && !['waiting_runs','aborted'].includes(journal.phase)) refused('operation_busy');
    if (journal?.phase === 'waiting_runs') { journal.phase='aborted'; saveJournal(scope,journal); }
    state.lastResult = {opId,candidateId:op.candidate.candidateId,reviewDigest:op.reviewDigest,version:op.candidate.exactVersion,result:'cancelled'};
    // A new offer identity is essential even when cancellation did not change current.
    state.offer = isNpmCandidate(op.candidate) ? {...op.candidate,candidateId:randomUUID()} : null; state.operation=null;
    saveUpdateRecord(scope.releases,state); return response(op,'cancelled');
  }));
}
/** Acquisition rechecks authorization and current at each publication boundary. Caller holds L. */
export function assertAcquisitionLocked(releases: string, confirmation: HumanConfirmedNpmCandidate): NpmCandidate {
  const op = readUpdateRecord(releases).operation;
  if (!op || op.opId !== confirmation.opId) reject('operation_terminal');
  const c = op.candidate;
  if (!isNpmCandidate(c)) reject('confirmation_mismatch');
  if (c.candidateId !== confirmation.candidateId || c.metadataDigest !== confirmation.metadataDigest || c.expectedActive !== confirmation.expectedActive)
    reject('confirmation_mismatch');
  if (currentRelease(releases) !== c.expectedActive) reject('expected_active_changed');
  if (completedUpdate(releases, op)) reject('operation_terminal');
  return c;
}

/** All acceptance predicates run before publication, including validation of projected records. */
function checkPreparedUpdate(request: {
  place: {releases:string;workspace:string}; candidate:PreparedCandidate;
  skills:{root:string;place:import('../installation/skill-write-contract.js').SkillIntent['place']};
  expectedCurrent:string|null; expectedInstallation:Installation;
}, observed: {installation:Installation|null;current:string|null;journal:SwitchJournal|null;state:UpdateRecord}): string | null {
  const {place:{releases,workspace},candidate,skills,expectedCurrent,expectedInstallation}=request;
  if (stable(observed.installation) !== stable(expectedInstallation)) refused('stale');
  const {journal,state}=checkedManagedSwitch(releases,workspace,observed.current,observed.journal,observed.state);
  compactUpdateRecord(releases,state,journal);
  const target=releasePath(releases,{source:candidate.facts.source,edition:candidate.edition}),pending=state.operation;
  if(pending) {
    if(updateTarget(releases,pending)!==target || pending.workspace!==workspace || stable(pending.skills)!==stable(skills)) refused('pending_operations');
    return pending.opId;
  }
  if(!terminal(journal)) refused('operation_busy');
  if(observed.current!==expectedCurrent) refused('stale');
  validateRelease(releases,target,candidate.edition);
  assertJournalUpdateHandoff(target,journal);
  return null;
}
/** A local confirmation accepts already published code through the same operation Owner as screen updates. */
export function acceptPreparedUpdate(runtime: import('./update-runtime.js').UpdateRuntime, candidate: PreparedCandidate,
  skills: {root: string; place: import('../installation/skill-write-contract.js').SkillIntent['place']}, expectedCurrent: string | null, expectedInstallation: Installation): string {
  const {releases, workspace} = runtime.place;
  return updateDecision(releases, () => {
    const state=readUpdateRecord(releases);
    const pending=checkPreparedUpdate({place:runtime.place,candidate,skills,expectedCurrent,expectedInstallation}, {
      installation:new InstallationStore(installationPath(process.env)).read(),current:currentRelease(releases),
      journal:loadJournal({releases,workspace}),state,
    });
    if(pending)return pending;
    const opId = randomUUID();
    state.operation = {opId, workspace, candidate, skills, reviewDigest:digestBytes(stable({candidate,skills})), phase:'staged', controller:null, failure:null};
    state.offer = null; saveUpdateRecord(releases, state); return opId;
  });
}
