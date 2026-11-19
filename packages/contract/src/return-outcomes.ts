/**
 * Browser-safe: what a return to a seat says, and why an undelivered return stops waiting. The only definition of
 * these value sets; the Run store, the return rules and the control database's checks all read them.
 */
import type { RequestPurpose } from './control-contract.js';

/** How a Request's work ended: the one return that closes it. */
export const RETURN_CLOSURES = ['succeeded', 'failed', 'stopped', 'needs_review', 'closed', 'moved'] as const;
/** News for a seat that closes no Request: a question, an urgent note, an answer, a new responsible, a new child. */
export const RETURN_NOTICES = ['question', 'urgent', 'answer', 'handover', 'child_added', 'work_changed'] as const;
export const RETURN_OUTCOMES = [...RETURN_CLOSURES, ...RETURN_NOTICES] as const;
export type ReturnOutcome = (typeof RETURN_OUTCOMES)[number];
export const isNotice = (outcome: ReturnOutcome): outcome is (typeof RETURN_NOTICES)[number] =>
  (RETURN_NOTICES as readonly ReturnOutcome[]).includes(outcome);
/** A Request the server sent to wake a seat with its returns: the same seat going on by itself, not a new ask. */
export const isSeatContinuation = (purpose: RequestPurpose) => purpose === 'return_continuation';
/**
 * Why a return no longer waits to be delivered: its question closed, its seat finished, the Task it came from was
 * stopped, or the switch to this database found it already handled.
 */
export const RESOLUTION_REASONS = ['question_closed', 'seat_finished', 'origin_stopped', 'migrated_handled'] as const;

/** An explicit placement author waits for the work's return, whatever the instruction's purpose. */
export const hasRequesterSeat = (request: { purpose: RequestPurpose; author: { kind: string } }) =>
  !isSeatContinuation(request.purpose) && request.author.kind === 'placement';
