import type { DatabaseSync } from 'node:sqlite';
import { questionText, type FieldItem } from '@alpacawork/contract';
import { type automationMessages } from '@alpacawork/contract/automation-program';
import { speaksForUser, type TaskLog } from '@alpacawork/raw/task-log-schema';
import type { TaskBaseState } from '@alpacawork/raw';
import { TASK_RECORD_COLUMNS, TASK_RECORD_JOINS, taskEvent } from '../control/task-history.js';

type MessageTypes = typeof automationMessages;
type Words = { [By in keyof MessageTypes]: { by: By; type: MessageTypes[By][number] } }[keyof MessageTypes];
type StateChange = { event: 'state_changed'; from: TaskBaseState; to: TaskBaseState };
type Message = { event: 'message_received' } & Words;
export type TaskEvent = {
  kind: 'task_event';
  key: string;
  sequence: number;
  project: string;
  at: string;
  title: string;
  description: string;
  userRequested: boolean;
  automated: boolean;
  fields: Record<string, string>;
} & (StateChange | Message);

export const eventCursor = (db: DatabaseSync): number =>
  Number(db.prepare('SELECT event_sequence FROM automation_cursor WHERE singleton=1').get()!.event_sequence);

export function advanceEvents(db: DatabaseSync, through: number): void {
  db.prepare('UPDATE automation_cursor SET event_sequence=? WHERE singleton=1 AND event_sequence<?').run(through, through);
}

// Hold is an overlay. A record that also changes the base state still carries that change.
const baseState = "CASE WHEN json_extract(l.entry,'$.toState') IS NOT NULL THEN coalesce(json_extract(l.entry,'$.stage.baseState'),nullif(json_extract(l.entry,'$.toState'),'held')) END";
const eventColumns = `${TASK_RECORD_COLUMNS},l.task_id,l.ordinal,l.event_sequence,t.external_id,t.title AS task_title,
  p.external_id AS project,${baseState} AS state,x.text AS answer_body,
  CASE WHEN q.purpose='review_send_back' THEN q.body END AS send_back_body`;
const eventRows = `FROM task_log l JOIN tasks t ON t.id=l.task_id JOIN tasks p ON p.id=t.project_task_id
  ${TASK_RECORD_JOINS} LEFT JOIN log_texts x ON x.log_id=l.id`;
const relevantRecords = `(json_extract(l.entry,'$.toState') IS NOT NULL
  OR l.kind IN ('reported','asked','answered','review_approved') OR q.purpose='review_send_back')`;
const recordedAt = 'julianday(coalesce(l.at,q.submitted_at))';

function words(entry: TaskLog): Message | null {
  if (speaksForUser(entry.actor)) {
    switch (entry.kind) {
      case 'answered': return { event: 'message_received', by: 'human', type: 'answer' };
      case 'review_sent_back': return { event: 'message_received', by: 'human', type: 'send_back' };
      case 'review_approved': return { event: 'message_received', by: 'human', type: 'accept' };
    }
  }
  if (entry.actor.kind !== 'placement') return null;
  if (entry.kind === 'asked') return { event: 'message_received', by: 'ai', type: 'question' };
  if (entry.kind === 'reported') {
    const action = entry.stage?.action;
    // A comment or administrative state change is not a report of the AI's work.
    if (action === 'report_doing' || action === 'report_done' || action === undefined &&
        (entry.toState === 'doing' || entry.toState === 'waiting' || entry.toState === 'done'))
      return { event: 'message_received', by: 'ai', type: 'report' };
  }
  return null;
}

function descriptionOf(entry: TaskLog, source: Record<string, unknown>): string {
  if (entry.kind === 'answered' && typeof source.answer_body === 'string') return source.answer_body;
  if (entry.kind === 'review_sent_back' && typeof source.send_back_body === 'string') return source.send_back_body;
  if (entry.kind === 'asked' && entry.decide) return [entry.description, questionText(entry.decide as FieldItem[])].filter(Boolean).join('\n\n');
  return entry.description ?? '';
}

function decodeEvent(db: DatabaseSync, source: Record<string, unknown>): TaskEvent[] {
  const task = String(source.task_id), ordinal = Number(source.ordinal);
  const previous = db.prepare(`SELECT ${baseState} AS state FROM task_log l
    WHERE l.task_id=? AND l.ordinal<? AND ${baseState} IS NOT NULL ORDER BY l.ordinal DESC LIMIT 1`).get(task, ordinal);
  const from = (previous?.state ?? null) as TaskBaseState | null;
  const to = (source.state ?? null) as TaskBaseState | null;
  const entry = taskEvent(source, from);
  const message = words(entry);
  const transition: StateChange | null = from !== null && to !== null && to !== from && entry.kind !== 'created'
    ? { event: 'state_changed', from, to } : null;
  if (!message && !transition) return [];
  const created = db.prepare("SELECT json_type(entry,'$.origin') AS origin FROM task_log WHERE task_id=? AND ordinal=0").get(task);
  const mark = db.prepare(`SELECT json_extract(entry,'$.userRequested') AS requested FROM task_log
    WHERE task_id=? AND ordinal<=? AND kind IN ('created','user_request_changed') ORDER BY ordinal DESC LIMIT 1`).get(task, ordinal);
  const title = entry.title ?? String(source.task_title);
  const description = descriptionOf(entry, source);
  const common = { kind: 'task_event' as const, key: entry.id, sequence: Number(source.event_sequence),
    project: String(source.project), at: new Date(entry.at).toISOString(), title, description,
    userRequested: mark?.requested === 1, automated: created?.origin != null || entry.actor.kind === 'automation',
    fields: { 'task.id': String(source.external_id), 'task.title': String(source.task_title), 'task.state': to ?? from ?? '',
      'event.title': entry.title ?? '', 'event.description': description } };
  const events: TaskEvent[] = [];
  if (transition) events.push({ ...common, ...transition });
  if (message) events.push({ ...common, ...message });
  return events;
}

/** A report can both change state and deliver words, with one position in the immutable history. */
export function readTaskEvents(db: DatabaseSync, sequence: number): TaskEvent[] {
  const row = db.prepare(`SELECT ${eventColumns} ${eventRows} WHERE l.event_sequence=? AND ${relevantRecords}`).get(sequence);
  return row ? decodeEvent(db, row) : [];
}

export function readTaskEventReference(db: DatabaseSync, project: string, ref: string): TaskEvent[] {
  const row = db.prepare(`SELECT ${eventColumns} ${eventRows} WHERE p.external_id=? AND l.id=? AND ${relevantRecords}`).get(project, ref);
  return row ? decodeEvent(db, row) : [];
}

export function* recentTaskEvents(db: DatabaseSync, project: string, since: string, until: string): Iterable<TaskEvent> {
  for (const row of db.prepare(`SELECT ${eventColumns} ${eventRows}
    WHERE p.external_id=? AND ${recordedAt}>=julianday(?) AND ${recordedAt}<=julianday(?) AND ${relevantRecords}
    ORDER BY ${recordedAt} DESC,l.event_sequence DESC`).iterate(project, since, until))
    yield* decodeEvent(db, row);
}
