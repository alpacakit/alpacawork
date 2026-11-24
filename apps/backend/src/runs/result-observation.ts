/** DB-free final observation, shared by the manager and the serve adapter. */
import { join } from 'node:path';
import { digestBytes, publishImmutable } from '@alpacawork/core';
import { type TokenCounters } from '@alpacawork/contract/run';
import type { RunAvailability } from '@alpacawork/contract/run-failure';
import { failureAvailability } from '@alpacawork/contract/agent-diagnostics';
import type { CompactionOutcome, ResultObservation } from '@alpacawork/contract/run-protocol';
import type { EventJournal } from './execution-files.js';
import type { InputReceipt } from './input.js';
import type { AdapterObservation } from '../agents/adapters/types.js';
import type { AgentExit, ReaderResult } from './readers/result.js';
export type Outcome = ReaderResult | { state: 'cancelled'; reason: 'stopped' } | { state: 'failed'; reason: 'launch' | 'timeout' };
type FinalResult = { state: 'present'; text: string } | { state: 'missing' | 'too_large' | 'unreadable'; text: null };
/** How an agent ended, as `readEnd` read it and as a completed event carries it. */
export type EndObservation = { outcome: Outcome; finalResult: FinalResult; session: string | null;
  availability?: RunAvailability;
  handoffSafe?: true;
  measuredUsage: { scope: 'conversation' | 'run'; counters: TokenCounters } | null; exit: AgentExit | null;
  /** What the agent said of the compaction its launch asked for. */
  compaction: CompactionOutcome | null };
/** The result of a run whose reply cannot be read: what a failed reader said of it, else missing. */
const absentResult = (observed: ReaderResult | undefined): FinalResult =>
  ({ state: observed?.state === 'failed' ? observed.resultState ?? 'missing' : 'missing', text: null });
/** Whether a Run has used up its minutes. Each caller reads elapsed time from the clock it can trust. */
export const runExpired = (minutes: number, elapsedMs: number): boolean => minutes > 0 && elapsedMs >= minutes * 60_000;
/** A stop or timeout decides how a Run ended, whatever its agent's output says. Each caller says which came first. */
export const endOutcome = (cause: 'stopped' | 'timeout' | null, observed: ReaderResult): Outcome =>
  cause === 'stopped' ? { state: 'cancelled', reason: 'stopped' } : cause === 'timeout' ? { state: 'failed', reason: 'timeout' } : observed;
/** Journal what a provider's receipt says became of an input. */
export function appendReceipt(journal: EventJournal, receipt: InputReceipt<string>): void {
  if (receipt.outcome === 'not_sent') journal.append('input_not_sent', { inputId: receipt.id, evidence: 'transfer_not_started', receipt: receipt.raw });
  else journal.append(receipt.outcome === 'taken' ? 'input_taken' : 'input_uncertain', { inputId: receipt.id, receipt: receipt.raw });
}
/** Publish how a Run ended: its reply first, then the completed event that names it. Only the Importer commits it. */
export function publishCompletion(journal: EventJournal, end: EndObservation): void {
  let result: ResultObservation['result'] = { state: end.finalResult.state, digest: null, size: 0 };
  if (end.finalResult.state === 'present') {
    const bytes = Buffer.from(end.finalResult.text), digest = digestBytes(bytes);
    publishImmutable(join(journal.folder, 'results'), `${digest}.bin`, bytes);
    result = { state: 'present', digest, size: bytes.length };
  }
  journal.append('completed', { outcome: { state: end.outcome.state, reason: end.outcome.state === 'succeeded' ? null : end.outcome.reason },
    session: end.session, measuredUsage: end.measuredUsage, availability: end.availability, handoffSafe: end.handoffSafe, exit: end.exit, result,
    compaction: end.compaction });
}
/**
 * Read how an agent ended, from what its manager saw and its output. The manager calls this when its agent
 * exits; a settle calls it for a lost manager's Run once the agent's process group is gone.
 */
export function readEnd(ended: { outcome: Outcome;
  observed: AdapterObservation; exit: AgentExit | null; measured: boolean; interrupted?: boolean }): EndObservation {
  let { outcome } = ended;
  const observed = ended.observed.outcome;
  let finalResult: FinalResult = absentResult(observed);
  if (outcome.state !== 'needs_review' && 'result' in observed && typeof observed.result === 'string')
    finalResult = { state: 'present', text: observed.result };
  if (outcome.state === 'succeeded' && finalResult.state !== 'present') outcome = { state: 'failed', reason: 'output' };
  const known = failureAvailability(ended.observed.failure);
  const availability = ended.measured && known && outcome.state === 'failed' &&
    (outcome.reason === 'exit' || outcome.reason === 'output') ? known : undefined;
  return { outcome, finalResult, session: ended.observed.session, availability,
    ...(availability && !ended.interrupted && ended.observed.toolsSettled && ended.exit?.signal === null ? { handoffSafe: true as const } : {}),
    measuredUsage: ended.measured && outcome.state !== 'needs_review' ? ended.observed.usage : null, exit: ended.exit,
    compaction: ended.observed.compaction };
}
