/** Request relationships and projections for coordinator messages. No clock, admission token or turn state lives here. */
import type { DatabaseSync } from 'node:sqlite';
import { touch } from '@alpacawork/db';
import { TaskRepository } from '../control/task-store.js';
import { Problem, PROBLEM_CODE, errorBody, PROBLEM_RULE } from '@alpacawork/core';
import { type TaskLog, type ControlTask } from '@alpacawork/raw';
import type { CoordinatorRunRecord } from '@alpacawork/contract/run';
import { runNumber } from '@alpacawork/contract/run';
import type { CoordinatorMessage, CoordinatorResult } from '@alpacawork/contract/coordinator';
import { answerFilesSchema, type AnswerFiles } from '@alpacawork/contract';
import { problemErrorSchema, recordedProblemSchema } from '@alpacawork/contract/problem';
import { replyAccess } from '@alpacawork/contract/access-boundaries';
import { UNSETTLED_INPUTS_SQL } from '@alpacawork/runs';

type Screen = { source: string; conversation: string; runId?: string };

/** Only the actual screen Run's own Request; never a session's earlier Run or a newer queued message. */
export function messageForRun(db: DatabaseSync, runId: string): string | undefined {
  const row = db.prepare(`SELECT q.id FROM runs r JOIN requests q ON q.id=r.request_id
    JOIN coordinator_conversations c ON c.id=q.conversation_id
    WHERE r.id=? AND c.warm_request_id IS NOT q.id`).get(runNumber(runId));
  return row ? String(row.id) : undefined;
}
/** This Run's initial message and messages proved taken into it, including their reply references. */
export function deliveredMessages(db: DatabaseSync, runId: string): string[] {
  return db.prepare(`SELECT q.id FROM runs r JOIN requests q ON q.id=r.request_id
    JOIN coordinator_conversations c ON c.id=q.conversation_id
    WHERE c.warm_request_id IS NOT q.id AND (r.id=? OR
      (r.state='joined' AND r.into_id=? AND EXISTS (SELECT 1 FROM run_inputs i JOIN run_attempts a USING(attempt_id)
        WHERE i.instruction_run_no=r.id AND i.initial=0 AND i.state='taken' AND a.run_no=?))) ORDER BY r.id`)
    .all(runNumber(runId), runId, runNumber(runId)).map(row => String(row.id));
}
/** A reference whose manager may still publish its receipt. Unrelated queued messages are never candidates. */
export function pendingInput(db: DatabaseSync, runId: string,
  target: { sourceRequest?: string; replyTo?: string }): boolean {
  const sourceRequest = target.sourceRequest !== undefined && !deliveredMessages(db, runId).includes(target.sourceRequest)
    ? target.sourceRequest : undefined;
  const replyTo = target.replyTo !== undefined && !referencesReply(db, runId, target.replyTo)
    ? target.replyTo : undefined;
  if (sourceRequest === undefined && replyTo === undefined) return false;
  return !!db.prepare(`SELECT 1 FROM run_inputs i JOIN run_attempts a USING(attempt_id)
    JOIN runs r ON r.id=i.instruction_run_no JOIN requests q ON q.id=r.request_id
    WHERE a.run_no=? AND i.initial=0 AND i.state IN (${UNSETTLED_INPUTS_SQL})
      AND q.conversation_id=(SELECT conversation_id FROM runs WHERE id=?)
      AND (q.id=? OR q.reply_to=?) LIMIT 1`)
    .get(runNumber(runId), runNumber(runId), sourceRequest ?? null, replyTo ?? null);
}
/** An explicit source is a record reference within this Run; omission names the Run's own Request. */
export function sourceMessage(db: DatabaseSync, runId: string, requested?: string): string | undefined {
  if (requested === undefined) return messageForRun(db, runId);
  if (!deliveredMessages(db, runId).includes(requested))
    throw new Problem(PROBLEM_CODE.invalidInput, 'Source Request was not delivered to this coordinator Run', undefined,
      { reason: { kind: 'coordinator_request_not_delivered' } });
  return requested;
}

function linkUuids(db: DatabaseSync, request: string, tasks: Iterable<string>): void {
  const insert = db.prepare('INSERT INTO task_dialogues(task_uuid,request_id) VALUES (?,?) ON CONFLICT DO NOTHING');
  for (const task of tasks) {
    const written = insert.run(task, request);
    if (written.changes) touch(db, { kind: 'dialogue', id: JSON.stringify([task, request]) });
  }
}
/** The Tasks a message acts on: its answers' and its press's. `ask` refuses the message when one of them is absent. */
export const actedTasks = (message: CoordinatorMessage): Set<string> => new Set([...(message.answers ?? []).map(answer => answer.task),
  ...(typeof message.intent?.task === 'string' ? [message.intent.task] : [])]);
/**
 * The Tasks a message names: those it acts on and its draft's `tasks` (labels and IDs written in its words). A named
 * Task links the message to its dialogue; a written ID with no Task (a sample's or a mistyped number) links nothing.
 */
export const messageTasks = (message: CoordinatorMessage): Set<string> => new Set([...(message.tasks ?? []), ...actedTasks(message)]);
/** Execution or a taken input links the message's fixed explicit recipients, never inferred prose or AI writes. */
export function linkMessage(db: DatabaseSync, run: CoordinatorRunRecord): void {
  if (db.prepare('SELECT 1 FROM coordinator_conversations WHERE warm_request_id=?').get(run.requestId)) return;
  const selected = [...messageTasks(run.message)];
  if (!selected.length) return;
  const tasks = db.prepare(`SELECT t.id FROM json_each(?) selected JOIN tasks t ON t.external_id=selected.value
    ORDER BY selected.key`).all(JSON.stringify(selected)).map(row => String(row.id));
  linkUuids(db, run.requestId, tasks);
}
/** A real refusal on an existing Task, saved only after the mutation rolled back, with its original retry snapshot. */
export function refuse(db: DatabaseSync, request: string, taskId: string, problem: Problem, now = new Date()): void {
  const task = db.prepare('SELECT id FROM tasks WHERE external_id=?').get(taskId);
  if (task) {
    db.prepare('INSERT INTO coordinator_refusals(request_id,task_uuid,problem_json,refused_at) VALUES (?,?,?,?)')
      .run(request, String(task.id), JSON.stringify(problemErrorSchema.parse(errorBody(problem).error)), now.toISOString());
    touch(db, { kind: 'refusal', id: JSON.stringify([request, task.id]) });
  }
}

type Write = CoordinatorResult['writes'][number];
/** Successes come solely from effect logs; refuses from complete immutable Problem snapshots. */
export function resultsOf(db: DatabaseSync, requestIds: readonly string[]): Map<string, CoordinatorResult> {
  const results = new Map(requestIds.map(id => [id, { writes: [], refused: [] } as CoordinatorResult]));
  if (!requestIds.length) return results;
  const ids = JSON.stringify(requestIds);
  // The two disjoint Task record forms both use their author's message index. A cross-table coalesce scans all history.
  const records = db.prepare(`SELECT id,request_id,task FROM (
    SELECT l.rowid AS sequence,l.id,json_extract(l.entry,'$.actor.message') AS request_id,k.external_id AS task
      FROM task_log l JOIN tasks k ON k.id=l.task_id
      WHERE json_extract(l.entry,'$.actor.kind')='main' AND json_extract(l.entry,'$.actor.message') IS NOT NULL
        AND json_extract(l.entry,'$.actor.message') IN (SELECT value FROM json_each(?))
    UNION ALL
    SELECT l.rowid AS sequence,l.id,json_extract(q.author,'$.message') AS request_id,k.external_id AS task
      FROM requests q JOIN task_log l ON l.request_id=q.id JOIN tasks k ON k.id=l.task_id
      WHERE json_extract(q.author,'$.kind')='main' AND json_extract(q.author,'$.message') IS NOT NULL
        AND json_extract(q.author,'$.message') IN (SELECT value FROM json_each(?))
    ) ORDER BY sequence`).all(ids,ids);
  const events = new TaskRepository('', db).events(records.map(row => String(row.id)));
  for (const row of records) {
    const event = events.get(String(row.id))!;
    results.get(String(row.request_id))!.writes.push({ task: String(row.task), record: event.id,
      kind: event.kind as Write['kind'], toState: event.toState,
      ...(event.kind === 'answered' && event.questionId || event.answers) ? { question: event.questionId ?? event.answers } : {},
      ...event.kind === 'review_approved' && event.runId ? { runId: event.runId } : {} });
  }
  for (const row of db.prepare(`SELECT r.request_id,k.external_id AS task,r.problem_json,r.code_only FROM coordinator_refusals r
    JOIN tasks k ON k.id=r.task_uuid WHERE r.request_id IN (SELECT value FROM json_each(?)) ORDER BY r.rowid`).all(ids)) {
    const code = String(row.code_only);
    const problem = row.problem_json === null
      ? { code, message: 'Historical refusal', retry: PROBLEM_RULE[code as keyof typeof PROBLEM_RULE]?.retry ?? 'check' }
      : JSON.parse(String(row.problem_json));
    results.get(String(row.request_id))!.refused.push({ ...recordedProblemSchema.parse(problem), task: String(row.task) });
  }
  return results;
}

export function saidAt(db: DatabaseSync, requestIds: readonly string[]): Map<string, string> {
  return new Map(db.prepare('SELECT id,submitted_at FROM requests WHERE id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify([...new Set(requestIds)])).map(row => [String(row.id), String(row.submitted_at)]));
}
function userMark(log: readonly TaskLog[]): { at: string; message: string | null } | null {
  const mark = [...log].reverse().find(entry => entry.userRequested !== undefined);
  if (mark?.userRequested !== true) return null;
  return { at: mark.at, message: mark.actor.kind === 'main' ? mark.actor.message ?? null : null };
}
export const markMessages = (logs: readonly (readonly TaskLog[])[]) => logs.flatMap(log => userMark(log)?.message ?? []);
export function requestedByUser(log: readonly TaskLog[], said: (message: string) => string | undefined): { at: string } | null {
  const mark = userMark(log);
  return mark && { at: (mark.message === null ? undefined : said(mark.message)) ?? mark.at };
}

export type Dialogue = { taskId: string; messageId: string; at: string; words: string; answer: string | null; answerFiles?: AnswerFiles };
/**
 * Screen words stay in Requests; external recorded quotes project from their effect log with no captured answer.
 * An answer's kept copies come with it only while its conversation holds them (until it is cleared and swept).
 */
export function dialoguesOf(db: DatabaseSync, tasks: readonly Pick<ControlTask, 'id' | 'meta'>[]): Dialogue[] {
  const ids = JSON.stringify(tasks.map(task => task.id));
  const screen = db.prepare(`SELECT k.external_id AS task_id,q.id AS message_id,q.submitted_at AS at,q.body AS words,
      a.result AS answer,a.request_id AS kept_by,CASE WHEN c.cleared_at IS NULL THEN json_extract(a.record,'$.answerFiles') END AS answer_files
    FROM task_dialogues d JOIN tasks k ON k.id=d.task_uuid JOIN requests q ON q.id=d.request_id
    LEFT JOIN runs a ON a.id=(SELECT coalesce(CAST(substr(r.into_id,2) AS INTEGER),r.id) FROM runs r WHERE r.request_id=q.id)
      AND a.state='succeeded' AND a.result_state='present'
    LEFT JOIN coordinator_conversations c ON c.id=a.conversation_id
    WHERE k.external_id IN (SELECT value FROM json_each(?))`).all(ids);
  // An independent Task record may quote an outside conversation. A Request's author is part of that Request,
  // not an additional Task dialogue with the same identity; its words and provenance remain on the Request.
  // These events have already been decoded in the same tree read. Request reference events carry the
  // Request author, not an independent note; only stored events can supply an outside quotation.
  const outside = tasks.flatMap(task => task.meta.log.flatMap(entry =>
    entry.kind !== 'request_accepted' && entry.kind !== 'review_sent_back' && entry.actor.kind === 'main'
      && entry.actor.message == null && typeof entry.actor.quote === 'string'
      ? [{ taskId: task.id, messageId: entry.id, at: entry.at, words: entry.actor.quote, answer: null }] : []));
  return [...screen.map(row => ({ taskId: String(row.task_id), messageId: String(row.message_id),
    at: String(row.at), words: String(row.words), answer: typeof row.answer === 'string' ? row.answer : null,
    ...typeof row.answer_files === 'string' ? { answerFiles: answerFilesSchema.parse({ requestId: row.kept_by, files: JSON.parse(row.answer_files) }) } : {} })), ...outside]
    .sort((a, b) => a.at.localeCompare(b.at) || a.messageId.localeCompare(b.messageId));
}
/**
 * The Coordinator Run that took each of these screen messages (the Run it joined into, when it did), with what it ran
 * with: the Coordinator end of a dialogue, and of a record the Coordinator wrote while working on that message.
 */
export function coordinatorRunsOf(db: DatabaseSync, requestIds: readonly string[]): Record<string, { agent: string; modelId: string | null; effort: string | null }> {
  if (!requestIds.length) return {};
  const rows = db.prepare(`SELECT r.request_id AS message,json_extract(a.record,'$.agent') AS agent,
      json_extract(a.record,'$.launch.values.model') AS model,json_extract(a.record,'$.launch.values.effort') AS effort
    FROM runs r JOIN runs a ON a.id=coalesce(CAST(substr(r.into_id,2) AS INTEGER),r.id)
    WHERE r.request_id IN (SELECT value FROM json_each(?)) AND json_extract(r.record,'$.role')='coordinator'`).all(JSON.stringify([...new Set(requestIds)]));
  const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
  return Object.fromEntries(rows.flatMap(row => text(row.agent) === null ? []
    : [[String(row.message), { agent: text(row.agent)!, modelId: text(row.model), effort: text(row.effort) }]]));
}
/** A reply is readable only when an actual delivered message in this Run references it. */
export function mayReadReply(db: DatabaseSync, speaker: Screen, id: string): boolean {
  return replyAccess.allows(speaker, runId => referencesReply(db, runId, id));
}
function referencesReply(db: DatabaseSync, runId: string, id: string): boolean {
  return !!db.prepare(`SELECT 1 FROM requests WHERE conversation_id=(SELECT conversation_id FROM runs WHERE id=?)
    AND reply_to=? AND id IN (SELECT value FROM json_each(?)) LIMIT 1`).get(runNumber(runId), id,
      JSON.stringify(deliveredMessages(db, runId)));
}
