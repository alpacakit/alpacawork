import { coordinatorResultSchema, type CoordinatorResult } from '@alpacawork/contract/coordinator';
import { z } from 'zod';
import { problemReasonSchema } from '@alpacawork/contract/problem';
import { PROBLEM_RULE } from '@alpacawork/core/codes';
import { ApiError } from '@/data/client';
import { i18n } from '@alpacawork/i18n';
import { userTurn } from '@alpacawork/contract';
import type { Task } from '@/data/types';
const write = coordinatorResultSchema.shape.writes.element;
const wanted = write.pick({ kind: true, toState: true, question: true, runId: true }).partial({ toState: true });
export type Wanted = z.infer<typeof wanted>[];
/** Frozen meaning of a locally saved submission; its original document belongs only to the outbox. */
export const readerSubmissionSchema = z.object({ taskId: z.string(), title: z.string(), turn: z.string(), kind: z.enum(['answer','intent']), phase: z.string(),
    answer: z.enum(['send', 'done', 'stop', 'hold']).nullable(), expectedWrites: z.array(wanted).nullable() });
export type ReaderSubmission = z.infer<typeof readerSubmissionSchema>;
/** One submission target inside a fixed message; several questions on one Task remain distinct. */
export const readerSubmissionKey = (reader: ReaderSubmission) => JSON.stringify([reader.taskId, reader.turn, reader.kind === 'intent' ? reader.phase : null]);
/** A question keeps its identity over Hold/Restore; a state operation belongs to the observed state transition it was pressed on. */
export function readerTurn(task: Pick<Task, 'id' | 'ball' | 'state' | 'stateLog'>) {
    const changed = task.stateLog.filter(entry => entry.toState !== null && entry.toState !== entry.fromState).at(-1);
    return { taskId: task.id, turn: userTurn(task.ball)?.key ?? '', phase: changed?.id ?? task.state };
}
type ReaderTurn = ReturnType<typeof readerTurn>;
export const sameTurn = (a: ReaderTurn, b: ReaderTurn) => a.taskId === b.taskId && a.turn === b.turn && a.phase === b.phase;
/** An answer goes to its question, whichever state transition that question now stands in. */
export const sameReaderTurn = (submitted: ReaderSubmission, current: ReaderTurn) =>
    sameTurn(submitted.kind === 'answer' ? { ...submitted, phase: current.phase } : submitted, current);

/** Only an explicit operation promises a Task write; a question reference remains conversational context. */
export const expectedTaskWrites = ({ kind, expectedWrites }: Pick<ReaderSubmission, 'kind' | 'expectedWrites'>): Wanted | null =>
    kind === 'intent' ? expectedWrites : null;

type SubmissionStatus = 'pending' | 'confirmed' | 'unconfirmed' | 'refused' | 'cancelled' | 'closed' | 'conflict';
/** The only projection of a submission's result into the deck. Unknown delivery never undoes a person's submission. */
export const readerOutcome = (status: SubmissionStatus): 'kept' | 'returned' => status === 'pending' || status === 'confirmed' || status === 'unconfirmed' ? 'kept' : 'returned';
/** The notification boundary: only an explicit screen operation promises a write the person can recover.
 * Words and answer labels identify context, without promising a write: the coordinator may explain or ask back.
 * Command refusals belong to the agent, independent of code, Task, or message text.
 * Delivery failures are handled by the sender before this result exists. A matching write wins a refusal. */
export function readerResult(submission: Pick<ReaderSubmission, 'kind' | 'taskId' | 'expectedWrites'>, result: CoordinatorResult): { status: 'confirmed' } | { status: 'refused' | 'unconfirmed'; error: ApiError } {
    const expectedWrites = expectedTaskWrites(submission), { taskId } = submission;
    if (expectedWrites === null) return { status: 'confirmed' };
    const done = result.writes.some(write => write.task === taskId && expectedWrites.some(want => want.kind === write.kind
            && (want.toState === undefined || want.toState === write.toState)
            && (want.question === undefined || want.question === write.question) && (want.runId === undefined || want.runId === write.runId)));
    if (done || !result.refused.some(each => each.task === taskId) && result.writes.some(each => each.task === taskId)) return { status: 'confirmed' };
    const refusal = [...result.refused].reverse().find(each => each.task === taskId);
    const error = refusal ? new ApiError(Object.hasOwn(PROBLEM_RULE, refusal.code) ? refusal.message : () => refusal.message, refusal.code, refusal.retry, refusal.detail, refusal.issues, problemReasonSchema.safeParse(refusal.reason).data)
        : new ApiError(() => i18n.t('reader:recovery.notCarriedOut'), 'operation_not_carried_out', 'reread');
    return { status: error.retry === 'check' ? 'unconfirmed' : 'refused', error };
}
