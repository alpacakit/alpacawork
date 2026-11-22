/** Serve commits a manager's final observation against the current conversation totals. */
import type { RunUsage,RuntimeRunRecord,TokenCounters } from '@alpacawork/contract/run';
import type { RunTransaction } from '@alpacawork/runs';
import type { DatabaseSync } from 'node:sqlite';
import { TOKEN_COUNTER_KEYS, runNumber } from '@alpacawork/contract/run';
import { captureAnswerFiles } from '../coordinator/answer-files.js';
import type { AnswerFile } from '@alpacawork/contract';
export { terminateAgent } from './termination.js';
import type { EndObservation } from './result-observation.js';
/** The transaction sees the preceding committed conversation total. */
function runUsage(run: RuntimeRunRecord, observed: { scope: 'conversation' | 'run'; counters: TokenCounters }, tx: RunTransaction): RunUsage {
  if (observed.scope === 'run') {
    const previous = run.resumes === null ? null : tx.runtimeGet(run.resumes)?.usage?.conversation;
    const conversation = run.resumes === null ? observed.counters : previous &&
      Object.fromEntries(TOKEN_COUNTER_KEYS.map(key => [key, previous[key] + observed.counters[key]])) as TokenCounters;
    const valid = conversation && TOKEN_COUNTER_KEYS.every(key => Number.isSafeInteger(conversation[key]));
    return { conversation: valid ? conversation : null, run: observed.counters, includesEarlier: false };
  }
  const conversation = observed.counters;
  let predecessor = run.resumes === null ? null : tx.runtimeGet(run.resumes);
  const includesEarlier = predecessor !== null && predecessor.usage === null ||
    run.resumes !== null && predecessor === null;
  const seen = new Set([run.id]);
  while (predecessor && predecessor.usage === null && predecessor.resumes && !seen.has(predecessor.id)) {
    seen.add(predecessor.id);
    predecessor = tx.runtimeGet(predecessor.resumes);
  }
  const previous = predecessor?.usage?.conversation;
  const delta = Object.fromEntries(TOKEN_COUNTER_KEYS.map(key => [key, conversation[key] - (previous?.[key] ?? 0)])) as TokenCounters;
  return { conversation, run: TOKEN_COUNTER_KEYS.every(key => delta[key] >= 0) ? delta : null, includesEarlier };
}

/**
 * What a coordinator's answer keeps of the local files it links to: their copies are published (FileJournal, so outside
 * the transaction that records the end, and again safely when that transaction is replayed) before its end is
 * recorded. Undefined for a Task's Run or a coordinator Run that gave no answer; 'unsaved' when the copies could not be
 * published, which fails the Run (`attachment_save`).
 */
export type AnswerCapture = AnswerFile[] | 'unsaved' | undefined;
export function captureAnswer(root: string, run: RuntimeRunRecord, succeeded: boolean, answer: string | null): AnswerCapture {
  if (run.role !== 'coordinator' || !succeeded || answer === null) return undefined;
  try { return captureAnswerFiles(root, run.conversationId, run.requestId, answer); }
  catch (cause) {
    console.error('Coordinator completion failed', { requestId: run.requestId, runId: run.id, stage: 'publish_answer_files', cause });
    return 'unsaved';
  }
}

/**
 * Commit what `readEnd` read, inside the caller's transaction on `db`, with what `captureAnswer` kept. A Task Run's end
 * is left for routing to read (`dirty`); a coordinator's Run has nothing to route.
 */
export function recordEnd(db: DatabaseSync, tx: RunTransaction, run: RuntimeRunRecord, end: EndObservation,
  occurredAt = new Date().toISOString(), answer: AnswerCapture = undefined, supersededBy?: RuntimeRunRecord['id']): void {
  const { outcome, session, measuredUsage } = end;
  const latest = tx.runtimeGet(run.id);
  if (!latest) throw new Error(`Run disappeared: ${run.id}`);
  const ended = { ...answer === 'unsaved' ? { state: 'failed' as const, reason: 'attachment_save' as const }
    : { state: outcome.state, reason: outcome.state === 'succeeded' ? null : outcome.reason },
    exit: end.exit, ended_at: occurredAt,
    session: latest.session ?? (session ? { provider: run.agent, id: session } : null),
    usage: measuredUsage ? runUsage(latest, measuredUsage, tx) : null };
  const availability = end.availability ? { availability: end.availability } : {};
  const continuation = supersededBy === undefined ? {} : { supersededBy };
  const settled: RuntimeRunRecord = latest.role !== 'coordinator' ? { ...latest, ...ended, ...availability, ...continuation }
    : { ...latest, ...ended, ...availability, ...continuation, ...Array.isArray(answer) && answer.length ? { answerFiles: answer } : {} };
  if (settled.state === 'needs_review') tx.update(settled);
  else tx.finish(settled, end.finalResult);
  if (run.role !== 'coordinator') db.prepare('UPDATE run_attempts SET dirty=1 WHERE run_no=?').run(runNumber(run.id));
}
