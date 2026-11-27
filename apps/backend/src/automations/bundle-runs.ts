import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  automationProgramRunCursorSchema, automationProgramRunSchema, type AutomationProgramRun, type ProgramAutomationEvent, type AutomationConfig, type AutomationProgramView,
} from '@alpacawork/contract/automation-program';
import { Problem, PROBLEM_CODE, redactSecrets } from '@alpacawork/core';
import { effectiveTaskState, type TaskBaseState } from '@alpacawork/raw';
import { touch } from '@alpacawork/db';
import { automationLocalDay, bundleLifecycle, bundleVersion, bundleVersionView, type BundleAutomation } from './bundle-store.js';

const WEEK_MS = 7 * 86_400_000;
const THIRTY_DAYS_MS = 30 * 86_400_000;
const STORAGE_BYTES = 200 * 1024 * 1024;
type DbRow = Record<string, SQLOutputValue>;
export type BundleMode = 'live' | 'trial';
export type RunKey = { uuid: string; number: number };
export type BundleRefusal = { kind: string; reason: string };
const text = (value: SQLOutputValue | undefined) => typeof value === 'string' ? value : null;
const json = <T>(value: SQLOutputValue | undefined, fallback: T): T => typeof value === 'string' ? JSON.parse(value) : fallback;

export function bundleLimit(db: DatabaseSync, automation: BundleAutomation, config: AutomationConfig & { timezone: string }, now: Date): BundleRefusal | null {
  const { limits, timezone } = config;
  const day = automationLocalDay(timezone, now);
  if (limits.until && day > limits.until) return { kind: 'automation_expired', reason: 'The last day for this automation has passed' };
  const rows = db.prepare(`SELECT number,run_started_at FROM automation_runs WHERE automation_id=? AND mode='live'
    AND run_started_at IS NOT NULL AND run_started_at>=? ORDER BY run_started_at DESC,number DESC`)
    .all(automation.uuid, new Date(now.getTime() - 25 * 60 * 60_000).toISOString());
  if (rows.filter(row => automationLocalDay(timezone, new Date(String(row.run_started_at))) === day).length >= limits.perDay)
    return { kind: 'daily_limit', reason: 'The daily run limit has been reached' };
  const previous = rows[0] ?? db.prepare(`SELECT number,run_started_at FROM automation_runs WHERE automation_id=? AND mode='live'
    AND run_started_at IS NOT NULL ORDER BY run_started_at DESC,number DESC LIMIT 1`).get(automation.uuid);
  if (!previous) return null;
  if (now.getTime() - Date.parse(String(previous.run_started_at)) < (limits.cooldownMinutes ?? 0) * 60_000)
    return { kind: 'cooldown', reason: 'The minimum time between runs has not elapsed' };
  if (limits.waitForPrevious === false) return null;
  const unfinished = db.prepare(`SELECT t.base_state AS state FROM automation_operations o JOIN tasks t ON t.external_id=o.requested_task_id
    WHERE o.automation_id=? AND o.run_number=? AND o.name='tasks.create' AND o.request_id IS NOT NULL
    AND t.lifecycle='active' AND (t.hold=1 OR t.base_state IN ('todo','doing','error'))
    ORDER BY (t.base_state='error') DESC LIMIT 1`).get(automation.uuid, Number(previous.number));
  return unfinished ? unfinished.state === 'error' ? { kind: 'previous_task_failed', reason: 'A task from the previous run is still failed' }
    : { kind: 'previous_task_active', reason: 'A task from the previous run is still in progress' } : null;
}

export function touchBundleRun(db: DatabaseSync, automation: BundleAutomation, number: number): void {
  touch(db, { kind: 'automation', id: automation.id });
  touch(db, { kind: 'automation_run', id: JSON.stringify([automation.id, number]) });
}

function nextRunNumber(db: DatabaseSync, automation: BundleAutomation): number {
  return Number(db.prepare('UPDATE automations SET next_run_number=next_run_number+1 WHERE id=? RETURNING next_run_number')
    .get(automation.uuid)!.next_run_number) - 1;
}

export function bundleRunRow(db: DatabaseSync, key: RunKey) {
  return db.prepare('SELECT * FROM automation_runs WHERE automation_id=? AND number=?').get(key.uuid, key.number);
}

export function readBundleEvent(db: DatabaseSync, key: RunKey): ProgramAutomationEvent | null {
  const row = bundleRunRow(db, key);
  if (!row) return null;
  const saved = db.prepare('SELECT event FROM automation_run_data WHERE automation_id=? AND run_number=?').get(key.uuid, key.number);
  const event = json<ProgramAutomationEvent | null>(saved?.event, null);
  if (event) return event;
  if (row.trigger_kind !== 'signal') return null;
  const items = db.prepare('SELECT item FROM automation_signal_items WHERE automation_id=? AND run_number=? ORDER BY sequence DESC')
    .all(key.uuid, key.number).map(row => JSON.parse(String(row.item)));
  return items.length ? { kind: 'signal', ref: String(row.trigger_ref), at: String(row.last_at), manual: false, count: Number(row.count),
    firstAt: String(row.at), lastAt: String(row.last_at), items } : null;
}

function persistEvent(db: DatabaseSync, key: RunKey, event: ProgramAutomationEvent, at: string): void {
  // Signal members are stored individually. Keeping both would double the size of the reference data.
  if (event.kind === 'signal' && !event.manual) return;
  db.prepare(`INSERT INTO automation_run_data(automation_id,run_number,event,saved_at) VALUES (?,?,?,?)
    ON CONFLICT(automation_id,run_number) DO UPDATE SET event=excluded.event,saved_at=excluded.saved_at`)
    .run(key.uuid, key.number, JSON.stringify(event), at);
}

export function enqueueBundleRun(db: DatabaseSync, automation: BundleAutomation, digest: string, event: ProgramAutomationEvent,
  mode: BundleMode, now: Date, refusal?: BundleRefusal | null): AutomationProgramRun {
  const number = nextRunNumber(db, automation), at = now.toISOString();
  db.prepare(`INSERT INTO automation_runs(automation_id,number,digest,activation_revision,activation_epoch,mode,trigger_kind,trigger_ref,manual,state,phase,at,last_at)
    VALUES (?,?,?,?,?,?,?,?,?,'running','trigger',?,?)`).run(automation.uuid, number, digest, automation.activationRevision, automation.activationEpoch,
    mode, event.kind, event.ref, +event.manual, at, at);
  persistEvent(db, { uuid: automation.uuid, number }, event, at);
  if (refusal) return settleBundleRun(db, automation, number, now, { state: 'skipped', ...refusal });
  touchBundleRun(db, automation, number);
  return readBundleRun(db, automation, number);
}

export function appendBundleSignal(db: DatabaseSync, automation: BundleAutomation, id: string, item:
  Extract<ProgramAutomationEvent, { kind: 'signal' }>['items'][number], now: Date) {
  const at = now.toISOString();
  let row = db.prepare("SELECT number,count,trigger_ref,expires_at FROM automation_runs WHERE automation_id=? AND state='waiting'")
    .get(automation.uuid);
  if (row && String(row.expires_at) <= at) {
    settleBundleRun(db, automation, Number(row.number), now, { state: 'skipped', kind: 'signal_expired', reason: 'The pending signal expired' });
    row = undefined;
  }
  const number = row ? Number(row.number) : nextRunNumber(db, automation);
  const count = row ? Number(row.count) + 1 : 1;
  if (row) db.prepare('UPDATE automation_runs SET last_at=?,count=?,version=version+1 WHERE automation_id=? AND number=?')
    .run(at, count, automation.uuid, number);
  else db.prepare(`INSERT INTO automation_runs(automation_id,number,digest,activation_revision,activation_epoch,mode,trigger_kind,trigger_ref,state,at,last_at,expires_at)
    VALUES (?,?,?,?,?,'live','signal',?,'waiting',?,?,?)`)
    .run(automation.uuid, number, automation.live!, automation.activationRevision, automation.activationEpoch, id, at, at, new Date(now.getTime() + WEEK_MS).toISOString());
  db.prepare('INSERT INTO automation_signal_items(automation_id,run_number,sequence,item) VALUES (?,?,?,?)')
    .run(automation.uuid, number, count, JSON.stringify(item));
  db.prepare('DELETE FROM automation_signal_items WHERE automation_id=? AND run_number=? AND sequence<=?')
    .run(automation.uuid, number, count - 20);
  touchBundleRun(db, automation, number);
  return { number, status: row ? 'coalesced' as const : 'accepted' as const };
}

type Settlement = {
  state: 'done' | 'skipped' | 'failed' | 'stopped';
  kind?: string; reason?: string; trigger?: AutomationProgramRun['trigger']; summary?: string; report?: string; notify?: true;
  error?: AutomationProgramRun['error']; output?: AutomationProgramRun['output']; failedPhase?: 'trigger' | 'run'; resolveTrigger?: boolean;
};
export function settleBundleRun(db: DatabaseSync, automation: BundleAutomation, number: number, now: Date,
  outcome: Settlement, root?: string): AutomationProgramRun {
  const key = { uuid: automation.uuid, number }, row = bundleRunRow(db, key);
  if (!row) throw new Problem(PROBLEM_CODE.notFound, 'Automation run does not exist');
  if (row.finished_at !== null) return readBundleRun(db, automation, number);
  const at = now.toISOString(), live = row.mode === 'live';
  const reason = outcome.reason ? redactSecrets(outcome.reason) : null;
  const trigger = outcome.trigger ? { ...outcome.trigger, reason: redactSecrets(outcome.trigger.reason) } : null;
  const error = outcome.error ? { ...outcome.error, message: redactSecrets(outcome.error.message).slice(0, 1024) } : null;
  const day = outcome.state === 'skipped' && live
    ? automationLocalDay(bundleVersion(db, automation.uuid, String(row.digest)).config.timezone, now) : null;
  if (live && automation.activationEpoch === row.activation_epoch) {
    for (const phase of [...(outcome.resolveTrigger ? ['trigger'] : []), ...(outcome.state === 'done' ? ['run'] : [])]) {
      const resolved = db.prepare(`UPDATE automation_runs SET resolved_at=?,version=version+1 WHERE automation_id=? AND activation_epoch=?
        AND failed_phase=? AND resolved_at IS NULL RETURNING number`).all(at, automation.uuid, automation.activationEpoch, phase);
      for (const item of resolved) touchBundleRun(db, automation, Number(item.number));
    }
  }
  const grouped = day === null ? undefined : db.prepare(`SELECT number FROM automation_runs WHERE automation_id=? AND skip_day=? AND reason_kind=?`)
    .get(automation.uuid, day, outcome.kind ?? 'skipped');
  const savedNumber = grouped ? Number(grouped.number) : number;
  if (grouped) {
    // Minute buckets retain calendar-day boundaries even when a later version uses another timezone.
    const matchedMinute = '$."' + String(row.at).slice(0, 16) + ':00.000Z"';
    db.prepare(`UPDATE automation_runs SET version=version+1,count=count+?,last_at=?,finished_at=?,reason=?,trigger_result=?,
      folded_matches=json_set(folded_matches,?,coalesce(json_extract(folded_matches,?),0)+1)
      WHERE automation_id=? AND number=?`).run(Number(row.count), String(row.last_at), at, reason, trigger && JSON.stringify(trigger),
      matchedMinute, matchedMinute, automation.uuid, savedNumber);
    db.prepare('DELETE FROM automation_runs WHERE automation_id=? AND number=?').run(automation.uuid, number);
    touchBundleRun(db, automation, number);
  } else {
    db.prepare(`UPDATE automation_runs SET version=version+1,state=?,phase=NULL,finished_at=?,reason_kind=?,reason=?,trigger_result=?,
      summary=?,notify=?,error=?,failed_phase=?,skip_day=?,expires_at=NULL,attempt=NULL WHERE automation_id=? AND number=?`)
      .run(outcome.state, at, outcome.kind ?? (outcome.state === 'skipped' ? 'skipped' : null), reason, trigger && JSON.stringify(trigger),
        outcome.summary ? redactSecrets(outcome.summary) : null, +(live && !!outcome.notify), error && JSON.stringify(error),
        outcome.failedPhase ?? null, day, automation.uuid, number);
    if (outcome.report !== undefined || outcome.output?.length) {
      const output = outcome.output?.map(row => ({ ...row, text: redactSecrets(row.text) }));
      db.prepare(`INSERT INTO automation_run_data(automation_id,run_number,report,output,saved_at) VALUES (?,?,?,?,?)
        ON CONFLICT(automation_id,run_number) DO UPDATE SET report=excluded.report,output=excluded.output,saved_at=excluded.saved_at`)
        .run(automation.uuid, number, outcome.report ? redactSecrets(outcome.report) : null, output ? JSON.stringify(output) : null, at);
    }
  }
  db.prepare(`UPDATE automation_operations SET outcome='failed',
    code=CASE WHEN name='send' THEN 'unknown_result' ELSE 'temporary' END
    WHERE automation_id=? AND run_number=? AND outcome='running'`).run(automation.uuid, number);
  db.prepare('UPDATE automation_signal_receipts SET settled_at=?,run_number=? WHERE automation_id=? AND run_number=? AND settled_at IS NULL')
    .run(at, savedNumber, automation.uuid, number);
  touchBundleRun(db, automation, savedNumber);
  if (live && root && outcome.state === 'failed' && automation.activationEpoch === row.activation_epoch && automation.enabled) {
    const recent = db.prepare(`SELECT state,resolved_at FROM automation_runs WHERE automation_id=? AND activation_epoch=?
      AND mode='live' AND state IN ('failed','done') ORDER BY finished_at DESC,number DESC LIMIT 3`)
      .all(automation.uuid, automation.activationEpoch);
    if (recent.length === 3 && recent.every(result => result.state === 'failed' && result.resolved_at === null))
      bundleLifecycle(db, root, automation, { kind: 'disabled', reason: 'consecutive_failures' }, { kind: 'system' }, now);
  }
  return readBundleRun(db, automation, savedNumber);
}

export function operationViews(db: DatabaseSync, key: RunKey | { previewId: string }) {
  const condition = 'previewId' in key ? 'preview_id=?' : 'automation_id=? AND run_number=?';
  const values = 'previewId' in key ? [key.previewId] : [key.uuid, key.number] as const;
  return db.prepare(`SELECT o.*,d.data,t.base_state AS task_state,t.hold AS task_hold
    FROM automation_operations o LEFT JOIN automation_operation_data d ON d.operation_id=o.id
    LEFT JOIN tasks t ON o.name='tasks.create' AND t.external_id=o.requested_task_id AND t.lifecycle<>'deleted'
    WHERE ${condition} ORDER BY o.ordinal,o.id`).all(...values).map(row => {
    const data = json<{ input?: unknown; result?: unknown; replaced?: boolean }>(row.data, {});
    return { name: String(row.name), ordinal: Number(row.ordinal), at: String(row.at), target: json(row.target, null),
      input: data.input ?? null, result: data.result ?? null, replaced: !!data.replaced, code: text(row.code), outcome: row.outcome,
      usage: row.name === 'ai.ask' ? { model: text(row.model), costUsd: row.cost_usd as number | null,
        inputTokens: row.input_tokens as number | null, outputTokens: row.output_tokens as number | null } : null,
      durationMs: row.duration_ms as number | null,
      taskState: row.task_state === null ? null
        : effectiveTaskState({ baseState: row.task_state as TaskBaseState, hold: Boolean(row.task_hold) }) };
  });
}

export function readBundleRun(db: DatabaseSync, automation: BundleAutomation, number: number): AutomationProgramRun {
  const key = { uuid: automation.uuid, number }, row = bundleRunRow(db, key);
  if (!row) throw new Problem(PROBLEM_CODE.notFound, 'Automation run does not exist');
  return bundleRunView(db, key, row);
}

function bundleRunView(db: DatabaseSync, key: RunKey, row: DbRow): AutomationProgramRun {
  const { number, uuid } = key;
  const data = db.prepare('SELECT report,output FROM automation_run_data WHERE automation_id=? AND run_number=?').get(uuid, number);
  return automationProgramRunSchema.parse({
    number, digest: row.digest, version: row.version, activationRevision: row.activation_revision, mode: row.mode,
    event: { kind: row.trigger_kind, ref: row.trigger_ref, manual: Boolean(row.manual) },
    state: row.state, phase: row.phase, at: row.at, lastAt: row.last_at, count: row.count,
    startedAt: row.started_at, phaseStartedAt: row.phase_started_at, runStartedAt: row.run_started_at, finishedAt: row.finished_at,
    reasonKind: row.reason_kind, reason: row.reason, trigger: json(row.trigger_result, null), summary: row.summary, report: text(data?.report),
    notify: Boolean(row.notify), error: json(row.error, null), operations: operationViews(db, key), output: json(data?.output, []),
  });
}

type RunsPage = { automation?: BundleAutomation; scope: string | null; limit: number; before?: number; cursor?: string };

function decodeRunCursor(cursor: string | undefined) {
  if (cursor === undefined) return null;
  try {
    return automationProgramRunCursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new Problem(PROBLEM_CODE.invalidInput, 'Use a cursor from an automation runs page');
  }
}

export function bundleRunsPage(db: DatabaseSync, { automation, scope, limit, before, cursor }: RunsPage) {
  const after = decodeRunCursor(cursor);
  const filters: [string, ...(string | number)[]][] = [];
  if (automation) filters.push(['r.automation_id=?', automation.uuid]);
  if (scope !== null) filters.push(['p.external_id=?', scope]);
  if (before !== undefined) filters.push(['r.number<?', before]);
  if (after) filters.push(['(r.at,a.number,r.number)<(?,?,?)', ...after]);
  const conditions = filters.length ? 'WHERE ' + filters.map(([sql]) => sql).join(' AND ') : '';
  const order = automation ? 'r.at DESC,r.number DESC' : 'r.at DESC,a.number DESC,r.number DESC';
  const rows = db.prepare(`SELECT r.*,a.external_id AS automation_external_id,a.number AS automation_number
    FROM automation_runs r JOIN automations a ON a.id=r.automation_id JOIN tasks p ON p.id=a.project_task_id
    ${conditions} ORDER BY ${order} LIMIT ?`).all(...filters.flatMap(([, ...values]) => values), limit + 1);
  const page = rows.slice(0, limit), last = page.at(-1);
  return {
    runs: page.map(row => ({ ...bundleRunView(db, { uuid: String(row.automation_id), number: Number(row.number) }, row),
      automationId: String(row.automation_external_id) })),
    nextCursor: rows.length > limit && last
      ? Buffer.from(JSON.stringify([last.at, last.automation_number, last.number])).toString('base64url') : null,
  };
}

export function listBundleRuns(db: DatabaseSync, automation: BundleAutomation, limit: number) {
  return bundleRunsPage(db, { automation, scope: null, limit }).runs.map(({ automationId: _id, ...run }) => run);
}

function recentBundleWeek(db: DatabaseSync, automation: BundleAutomation, timezone: string, now: Date): AutomationProgramView['week'] {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = day.format(now);
  const first = new Date(Date.parse(today) - 6 * 86_400_000).toISOString().slice(0, 10);
  const since = new Date(now.getTime() - WEEK_MS - 86_400_000).toISOString();
  const end = now.toISOString();
  const rows = db.prepare(`SELECT at,run_started_at,finished_at,state,reason_kind,folded_matches FROM automation_runs
    WHERE automation_id=? AND mode='live' AND (last_at>=? OR run_started_at>=? OR finished_at>=?)`)
    .iterate(automation.uuid, since, since, since);
  const inWeek = (value: SQLOutputValue | undefined) => {
    if (typeof value !== 'string' || value > end) return null;
    const local = day.format(new Date(value));
    return local >= first && local <= today ? local : null;
  };
  let matched = 0, started = 0, skipped = 0, failed = 0, busiestDay = 0;
  const startsByDay = new Map<string, number>(), skippedBy = new Map<string, number>();
  for (const row of rows) {
    const startedDay = inWeek(row.run_started_at);
    if (startedDay) {
      const total = (startsByDay.get(startedDay) ?? 0) + 1;
      startsByDay.set(startedDay, total);
      busiestDay = Math.max(busiestDay, total);
    }
    const ownMatch = inWeek(row.at) !== null;
    let matches = Number(ownMatch);
    for (const [minute, count] of Object.entries(json<Record<string, number>>(row.folded_matches, {}))) {
      if (inWeek(minute)) matches += count;
    }
    matched += matches;
    if (ownMatch && startedDay) started++;
    if (ownMatch && row.state === 'failed' && inWeek(row.finished_at)) failed++;
    if (matches && row.state === 'skipped' && inWeek(row.finished_at)) {
      skipped += matches;
      const reason = text(row.reason_kind) ?? 'skipped';
      skippedBy.set(reason, (skippedBy.get(reason) ?? 0) + matches);
    }
  }
  return { matched, started, skipped, failed, busiestDay,
    skippedBy: [...skippedBy].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)) };
}

export function bundleAutomationView(db: DatabaseSync, root: string, a: BundleAutomation, now: Date, includeSource = false): AutomationProgramView {
  const latest = bundleVersionView(db, root, a, a.latest, now, includeSource);
  const live = a.live ? a.latest === a.live ? latest : bundleVersionView(db, root, a, a.live, now, includeSource) : null;
  const waiting = db.prepare("SELECT count,at,last_at FROM automation_runs WHERE automation_id=? AND state='waiting'").get(a.uuid);
  const failures = db.prepare(`SELECT number,finished_at,reason,reason_kind FROM automation_runs WHERE automation_id=? AND activation_epoch=? AND mode='live'
    AND state='failed' AND resolved_at IS NULL ORDER BY finished_at DESC,number DESC LIMIT 1`).get(a.uuid, a.activationEpoch);
  const everEnabled = !!db.prepare("SELECT 1 FROM automation_changes WHERE automation_id=? AND kind='enabled' LIMIT 1").get(a.uuid);
  const stopped = db.prepare("SELECT at FROM automation_runs WHERE automation_id=? AND phase='stopping' ORDER BY at LIMIT 1").get(a.uuid);
  const changed = db.prepare('SELECT at FROM automation_changes WHERE automation_id=? AND revision=?').get(a.uuid, a.revision);
  const attention: AutomationProgramView['attention'] = [];
  if (failures) attention.push({ kind: 'failed', at: String(failures.finished_at), run: Number(failures.number),
    reason: text(failures.reason), reasonKind: text(failures.reason_kind) });
  if (a.disabledReason && changed) attention.push({ kind: 'disabled', at: String(changed.at) });
  if (a.enabled && a.latest !== a.live) attention.push({ kind: 'awaiting_enable', at: latest.savedAt });
  if (stopped) attention.push({ kind: 'stopping', at: String(stopped.at) });
  return {
    id: a.id, project: a.project, name: a.name, hash: a.hash, enabled: a.enabled, disabledReason: a.disabledReason,
    latest, live, awaitingEnable: a.enabled && a.latest !== a.live,
    everEnabled, nextAt: a.enabled ? a.nextAt : null, week: recentBundleWeek(db, a, (live ?? latest).facts.limits.timezone, now),
    hook: { exists: !!db.prepare('SELECT 1 FROM automation_secrets WHERE automation_id=?').get(a.uuid) },
    pendingSignal: waiting ? { count: Number(waiting.count), firstAt: String(waiting.at), lastAt: String(waiting.last_at) } : null,
    lastRun: listBundleRuns(db, a, 1)[0] ?? null, attention,
  };
}

export function pruneBundleHistory(db: DatabaseSync, now: Date) {
  const week = new Date(now.getTime() - WEEK_MS).toISOString();
  const month = new Date(now.getTime() - THIRTY_DAYS_MS).toISOString();
  const quarter = new Date(now.getTime() - 3 * THIRTY_DAYS_MS).toISOString();
  const ids = new Map(db.prepare('SELECT id,external_id FROM automations').all().map(row => [row.id, String(row.external_id)]));
  const mark = (rows: DbRow[], kind: 'run' | 'preview' | 'task') => {
    for (const row of rows) {
      if (kind === 'task') { touch(db, { kind: 'task', id: String(row.task_id) }); continue; }
      const id = ids.get(row.automation_id!);
      if (!id) continue;
      touch(db, { kind: 'automation', id });
      if (kind === 'run') touch(db, { kind: 'automation_run', id: JSON.stringify([id, row.number ?? row.run_number]) });
    }
  };
  mark(db.prepare('DELETE FROM automation_previews WHERE at<? AND attempt IS NULL RETURNING automation_id').all(week), 'preview');
  db.prepare('DELETE FROM automation_signal_receipts WHERE settled_at<?').run(week);
  db.prepare("DELETE FROM cli_operations WHERE operation IN ('automation/signal','automation/run-now','automation/try') AND committed_at<?").run(week);
  mark(db.prepare(`DELETE FROM automation_runs AS r WHERE r.finished_at IS NOT NULL AND (r.state<>'failed' OR r.resolved_at IS NOT NULL)
    AND ((r.state='skipped' AND r.finished_at<?) OR (r.finished_at<? AND NOT EXISTS(
      SELECT 1 FROM automation_operations o JOIN tasks t ON t.external_id=o.requested_task_id
      WHERE o.automation_id=r.automation_id AND o.run_number=r.number AND t.lifecycle='active' AND t.base_state NOT IN ('done','stopped'))))
    RETURNING automation_id,number`).all(month, quarter), 'run');
  mark(db.prepare(`DELETE FROM automation_runs WHERE (automation_id,number) IN (SELECT automation_id,number FROM (
    SELECT automation_id,number,row_number() OVER (PARTITION BY automation_id ORDER BY finished_at DESC,number DESC) AS ordinal
    FROM automation_runs WHERE state='skipped') WHERE ordinal>1000) RETURNING automation_id,number`).all(), 'run');
  db.prepare(`DELETE FROM automation_operations AS o WHERE o.at<? AND
    NOT EXISTS(SELECT 1 FROM automation_runs r WHERE r.automation_id=o.automation_id AND r.number=o.run_number)
    AND NOT EXISTS(SELECT 1 FROM automation_previews p WHERE p.id=o.preview_id)`).run(week);
  const oldOperations = db.prepare(`SELECT d.rowid,o.automation_id,o.run_number FROM automation_operation_data d
    JOIN automation_operations o ON o.id=d.operation_id WHERE o.at<? AND o.outcome<>'running'`).all(month);
  db.prepare(`DELETE FROM automation_operation_data WHERE operation_id IN (
    SELECT id FROM automation_operations WHERE at<? AND outcome<>'running')`).run(month);
  mark(oldOperations.filter(row => row.run_number !== null), 'run');
  mark(db.prepare(`DELETE FROM automation_run_data AS d WHERE d.saved_at<? AND EXISTS(
    SELECT 1 FROM automation_runs r WHERE r.automation_id=d.automation_id AND r.number=d.run_number AND r.finished_at IS NOT NULL)
    RETURNING automation_id,run_number`).all(month), 'run');
  mark(db.prepare(`DELETE FROM automation_signal_items AS i WHERE EXISTS(
    SELECT 1 FROM automation_runs r WHERE r.automation_id=i.automation_id AND r.number=i.run_number AND r.finished_at<?)
    RETURNING automation_id,run_number`).all(month), 'run');
  mark(db.prepare('DELETE FROM automation_task_inputs WHERE saved_at<? RETURNING task_id').all(month), 'task');
  const largeRows = db.prepare(`WITH payloads(kind,row_id,saved,bytes,finished) AS (
    SELECT 'run',d.rowid,d.saved_at,
      coalesce(length(CAST(d.event AS BLOB)),0)+coalesce(length(CAST(d.report AS BLOB)),0)+coalesce(length(CAST(d.output AS BLOB)),0),
      r.finished_at IS NOT NULL FROM automation_run_data d JOIN automation_runs r
      ON d.automation_id=r.automation_id AND d.run_number=r.number
    UNION ALL
    SELECT 'signal',i.rowid,r.last_at,length(CAST(i.item AS BLOB)),r.finished_at IS NOT NULL
      FROM automation_signal_items i JOIN automation_runs r ON i.automation_id=r.automation_id AND i.run_number=r.number
    UNION ALL
    SELECT 'operation',d.rowid,o.at,length(CAST(d.data AS BLOB)),o.outcome<>'running'
      FROM automation_operation_data d JOIN automation_operations o ON o.id=d.operation_id
    UNION ALL
    SELECT 'preview',rowid,at,length(CAST(event AS BLOB))+coalesce(length(CAST(result AS BLOB)),0),attempt IS NULL
      FROM automation_previews
    UNION ALL
    SELECT 'task',rowid,saved_at,length(CAST(data AS BLOB)),1 FROM automation_task_inputs
  ), ranked AS (
    SELECT kind,row_id,bytes,finished,sum(bytes) OVER () AS total,
      coalesce(sum(CASE WHEN finished THEN bytes ELSE 0 END)
        OVER (ORDER BY saved,kind,row_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS released FROM payloads
  ) SELECT kind,row_id FROM ranked WHERE finished AND bytes>0 AND total-released>?`).all(STORAGE_BYTES);
  const rowsFor = (kind: string) => JSON.stringify(largeRows.filter(row => row.kind === kind).map(row => row.row_id));
  if (largeRows.length) {
    mark(db.prepare('DELETE FROM automation_run_data WHERE rowid IN (SELECT value FROM json_each(?)) RETURNING automation_id,run_number')
      .all(rowsFor('run')), 'run');
    mark(db.prepare('DELETE FROM automation_signal_items WHERE rowid IN (SELECT value FROM json_each(?)) RETURNING automation_id,run_number')
      .all(rowsFor('signal')), 'run');
    const operations = db.prepare(`SELECT o.automation_id,o.run_number FROM automation_operation_data d JOIN automation_operations o ON o.id=d.operation_id
      WHERE d.rowid IN (SELECT value FROM json_each(?)) AND o.run_number IS NOT NULL`).all(rowsFor('operation'));
    db.prepare('DELETE FROM automation_operation_data WHERE rowid IN (SELECT value FROM json_each(?))').run(rowsFor('operation'));
    mark(operations, 'run');
    mark(db.prepare('DELETE FROM automation_previews WHERE rowid IN (SELECT value FROM json_each(?)) RETURNING automation_id')
      .all(rowsFor('preview')), 'preview');
    mark(db.prepare('DELETE FROM automation_task_inputs WHERE rowid IN (SELECT value FROM json_each(?)) RETURNING task_id')
      .all(rowsFor('task')), 'task');
  }
}
