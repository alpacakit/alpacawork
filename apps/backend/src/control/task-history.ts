/** The shared immutable history at one SQLite read point. Uncommitted rows never enter the kept history. */
import type { DatabaseSync } from 'node:sqlite';
import { deepFreeze, storedJsonDecoder } from '@alpacawork/core';
import { KeptTable, keptOf, controlRoot } from '@alpacawork/db';
import { startsEstimateRound } from '@alpacawork/contract';
import { requestActionReasonSchema, type RequestActionReason } from '@alpacawork/raw';
import { storedTaskLogSchema, type TaskLog } from '@alpacawork/raw/task-log-schema';

export const TASK_RECORD_COLUMNS = `l.id,l.entry,l.request_id,l.note_title,l.note_description,q.purpose,q.author,q.submitted_at,q.about_run_id,q.answers_question,q.reason,
  json_extract(r.record,'$.role') AS role`;
export const TASK_RECORD_JOINS = `LEFT JOIN requests q ON q.id=l.request_id LEFT JOIN runs r ON r.request_id=q.id AND r.attempt=0`;
const decode = storedJsonDecoder(storedTaskLogSchema);
const decodeReason = storedJsonDecoder(requestActionReasonSchema);
type RequestEventFacts = {
  id: string; purpose: string; submittedAt: string; author: TaskLog['actor'];
  answersQuestion?: string | null; aboutRunId?: string | null; reason?: RequestActionReason;
};
export function requestEvent(request: RequestEventFacts, role: string, fromState: TaskLog['fromState'],
  note: { title?: string | null; description?: string | null }): TaskLog {
  const review = request.purpose === 'review_send_back';
  return { id: request.id, kind: review ? 'review_sent_back' : 'request_accepted', at: request.submittedAt,
    actor: request.author, title: note.title ?? null, description: note.description ?? null, fromState, toState: null,
    startsEstimateRound: startsEstimateRound(request, { role }), ...(request.reason && { reason: request.reason }),
    ...(request.answersQuestion != null && { answers: request.answersQuestion }),
    ...(review && request.aboutRunId != null && { runId: request.aboutRunId }) };
}

export function taskEvent(row: Record<string, unknown>, fromState: TaskLog['fromState']): TaskLog {
  if (row.request_id === null) return decode(row.id, String(row.entry));
  if (!row.role || !row.purpose || !row.author) throw new Error(`Request reference ${row.id} has no admitted Run`);
  return requestEvent({ id: String(row.id), purpose: String(row.purpose), submittedAt: String(row.submitted_at),
    author: JSON.parse(String(row.author)),
    answersQuestion: row.answers_question as string | null, aboutRunId: row.about_run_id as string | null,
    ...(row.reason == null ? {} : { reason: decodeReason(row.id, String(row.reason)) }) },
    String(row.role), fromState, { title: row.note_title as string | null, description: row.note_description as string | null });
}
const stateAfter = (event: TaskLog, previous: TaskLog['fromState']): TaskLog['fromState'] =>
  event.toState === null ? previous : event.stage ? event.stage.hold ? 'held' : event.stage.baseState : event.toState;
export function taskEvents(rows: readonly Record<string, unknown>[], state: TaskLog['fromState'] = null): TaskLog[] {
  return rows.map(row => { const event = taskEvent(row, state); state = stateAfter(event, state); return event; });
}
type History = { rows: Record<string, unknown>[]; entries: TaskLog[]; rowids: number[]; state: TaskLog['fromState'] };
const routingKinds = new Set<TaskLog['kind']>(['moved', 'asked', 'answered', 'question_withdrawn', 'question_expired', 'archived', 'deleted', 'restored']);
const forRouting = (event: TaskLog) => event.toState !== null || routingKinds.has(event.kind) ||
  event.stage?.boundary !== undefined || event.id.startsWith('LSTARTR') || event.id.startsWith('LENDR');
type RoutingHistory = { entries: TaskLog[]; index?: Map<string, { event: TaskLog; position: number }>; causes?: ReadonlySet<string>; related?: TaskLog[]; origins?: TaskLog[] };
const routingLogs = new WeakMap<TaskLog[], RoutingHistory>();
/** Immutable histories share their routing view. Return causes retain their original history order. */
export function routingHistory(events: TaskLog[], relevant: boolean, causes: ReadonlySet<string>): TaskLog[] {
  if (!Object.isFrozen(events)) return events.filter(event => causes.has(event.id) || relevant && forRouting(event));
  if (!relevant && !causes.size) return emptyLog;
  let routing = routingLogs.get(events);
  const freeze = (entries: TaskLog[]) => deepFreeze(entries);
  if (!routing) {
    routing = { entries: freeze(events.filter(forRouting)) };
    routingLogs.set(events, routing);
  }
  if (!causes.size) return relevant ? routing.entries : emptyLog;
  const index = routing.index ??= new Map(events.map((event, position) => [event.id, { event, position }]));
  if (!routing.causes || routing.causes.size !== causes.size || [...causes].some(id => !routing.causes!.has(id))) {
    routing.causes = new Set(causes);
    const origins = [...causes].flatMap(id => {
      const entry = index.get(id);
      return entry && entry.position < events.length ? [entry] : [];
    }).sort((a, b) => a.position - b.position);
    routing.origins = freeze(origins.map(item => item.event));
    const related = new Map(routing.entries.map(event => [event.id, index.get(event.id)!]));
    for (const item of origins) related.set(item.event.id, item);
    routing.related = freeze([...related.values()].sort((a, b) => a.position - b.position).map(item => item.event));
  }
  return relevant ? routing.related! : routing.origins!;
}

const emptyLog = deepFreeze([] as TaskLog[]);
const keptHistory = () => new KeptTable<Map<string, History>>('task_log', () => new Map(), (kept, rows) => {
  for (const row of rows) {
    const id = String(row.task_id);
    let log = kept.get(id);
    if (!log) kept.set(id, log = { rows: [], entries: emptyLog, rowids: [], state: null });
    log.rows.push(row);
  }
});
/** A current read owns its membership even when another reader has already kept a later prefix. */
/**
 * The named Tasks' histories read from the table itself, at `db`'s read point, without the kept history: for a reader
 * that reads a few Tasks at a time and keeps what it read (the analysis).
 */
export function taskLogsOf(db: DatabaseSync, ids: readonly string[]): Map<string, TaskLog[]> {
  const logs = new Map(ids.map(id => [id, [] as TaskLog[]])), states = new Map<string, TaskLog['fromState']>();
  for (const row of db.prepare(`SELECT l.task_id,${TASK_RECORD_COLUMNS} FROM task_log l ${TASK_RECORD_JOINS}
    WHERE l.task_id IN (SELECT value FROM json_each(?)) ORDER BY l.task_id,l.ordinal`).all(JSON.stringify(ids))) {
    const id = String(row.task_id), before = states.get(id) ?? null, event = taskEvent(row, before);
    logs.get(id)!.push(event); states.set(id, stateAfter(event, before));
  }
  return logs;
}
export function taskLogs(db: DatabaseSync, root: string | undefined, ids: readonly string[]): Map<string, TaskLog[]> {
  root ||= controlRoot(db);
  const table = root === undefined ? undefined : keptOf(root, 'task_log', keptHistory);
  const read = table?.at(db, through => db.prepare(`SELECT l.rowid AS history_row,l.task_id,${TASK_RECORD_COLUMNS}
    FROM task_log l ${TASK_RECORD_JOINS} WHERE l.rowid>? ORDER BY l.rowid`).all(through));
  if (!read) return taskLogsOf(db, ids);
  const own = new Map<string, Record<string, unknown>[]>();
  for (const row of read.own) { const id = String(row.task_id), rows = own.get(id) ?? []; rows.push(row); own.set(id, rows); }
  return new Map(ids.map(id => {
    const log = read.kept.get(id);
    try {
      if (log?.rows.length) {
        const entries = taskEvents(log.rows, log.state);
        for (const event of entries) log.state = stateAfter(event, log.state);
        for (const row of log.rows) log.rowids.push(Number(row.history_row));
        const previous = log.entries;
        log.entries = deepFreeze([...previous, ...entries]); log.rows = [];
        const routing = routingLogs.get(previous);
        if (routing) {
          for (const [offset, event] of entries.entries()) routing.index?.set(event.id, { event, position: previous.length + offset });
          routingLogs.set(log.entries, { entries: deepFreeze([...routing.entries, ...entries.filter(forRouting)]), index: routing.index });
        }
      }
      let entries = log?.entries ?? emptyLog;
      if (log && log.rowids.at(-1)! > read.through) {
        let low = 0, high = log.rowids.length;
        while (low < high) { const mid = (low + high) >>> 1; if (log.rowids[mid]! <= read.through) low = mid + 1; else high = mid; }
        entries = deepFreeze(entries.slice(0, low));
      }
      const added = own.get(id);
      if (added?.length) entries = deepFreeze([...entries, ...taskEvents(added, log?.state ?? null)]);
      return [id, entries];
    } catch (error) { table!.forget(); throw error; }
  }));
}
