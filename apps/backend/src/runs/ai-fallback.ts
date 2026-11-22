import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { aiStackSchema, type AiRow } from '@alpacawork/contract';
import { DELIVERY_STATE } from '@alpacawork/contract/control';
import { PROTOCOL_LIMITS } from '@alpacawork/contract/run-protocol';
import { runNumber, type RuntimeRunRecord } from '@alpacawork/contract/run';
import { Problem } from '@alpacawork/core';
import { compareRequestOrder, currentRequestRun, type RunStore, type RunTransaction } from '@alpacawork/runs';
import { assignedSession, coordinatorLaunchSnapshot, launchSnapshot, readAgentsSettings, type AgentsSettings } from '../agents-settings.js';
import { queuedStart } from './execution-control.js';
import type { EndObservation } from './result-observation.js';

function nextPrompt(db: DatabaseSync, run: RuntimeRunRecord, cause: string): string | undefined {
  const first = db.prepare('SELECT id,prompt FROM runs WHERE request_id=? AND attempt=0').get(run.requestId);
  if (typeof first?.prompt !== 'string') return undefined;
  const received = db.prepare(`SELECT input.prompt FROM runs carrier JOIN run_attempts a ON a.run_no=carrier.id
    JOIN run_inputs i USING(attempt_id) JOIN runs input ON input.id=i.instruction_run_no
    WHERE carrier.request_id=? AND i.initial=0 AND i.state='taken' ORDER BY input.id`).all(run.requestId).map(row => String(row.prompt));
  const context = run.role !== 'coordinator' ? [] : db.prepare(`SELECT q.body,r.result FROM requests q
    JOIN runs first ON first.request_id=q.id AND first.attempt=0
    JOIN runs r ON r.id=(${currentRequestRun('q.id')}) JOIN coordinator_conversations c ON c.id=q.conversation_id
    WHERE q.conversation_id=? AND first.id<? AND c.warm_request_id IS NOT q.id AND r.state='succeeded'
    ORDER BY first.id DESC LIMIT 8`).all(run.conversationId, first.id!).reverse()
    .map(row => JSON.stringify({ earlierMessage: row.body, answer: row.result }));
  const required = [first.prompt, ...received].join('\n\n');
  const header = [
    'Continue the same request in this new conversation.',
    `The previous Run ${run.id} stopped because of ${cause}.`,
    'Check recorded progress and the current working directory before continuing. Do not repeat completed operations or retry operations whose results are unknown.',
  ].join('\n');
  if (Buffer.byteLength(header + '\n\n' + required) > PROTOCOL_LIMITS.prompt) return undefined;
  let history = '';
  for (const reply of context.reverse()) {
    if (Buffer.byteLength(header + reply + history + required) + 100 > PROTOCOL_LIMITS.prompt) break;
    history = '\n' + reply + history;
  }
  return [header, history && `Earlier conversation for context:${history}`, required].filter(Boolean).join('\n\n');
}

type Rebinding = { run: RuntimeRunRecord; rows?: AiRow[] };

/** Rebind an undelivered continuation before it can reach the abandoned session. */
function rebindPending(db: DatabaseSync, config: AgentsSettings, lane: readonly RuntimeRunRecord[], previous: RuntimeRunRecord,
  replacement: AiRow, session: RuntimeRunRecord['session'], adapter: string): Rebinding[] | undefined {
  const inherited = new Set([previous.id]), bindings: Rebinding[] = [];
  const pending = lane.filter(run => run.state === 'queued').sort(compareRequestOrder);
  for (const run of pending) {
    if (!run.resumes || !inherited.has(run.resumes)) continue;
    const row = db.prepare('SELECT ai_stack,ai_explicit FROM requests WHERE id=?').get(run.requestId);
    if (!row || db.prepare("SELECT 1 FROM run_inputs WHERE instruction_run_no=? AND state<>'not_sent'").get(runNumber(run.id)))
      return undefined;
    const explicit = row.ai_explicit === 1;
    const canResume = !explicit || run.agent === replacement.agent && isDeepStrictEqual(run.launch.values, replacement.values);
    const mode = canResume ? 'resume' : 'start';
    const agent = explicit ? run.agent : replacement.agent;
    const values = explicit ? run.launch.values : replacement.values;
    const history = canResume ? { adapter, values } : undefined;
    let updated: RuntimeRunRecord;
    try {
      const path = run.launch.path;
      if (run.role === 'coordinator') {
        const snapshot = coordinatorLaunchSnapshot(config, agent, mode, path, values, history);
        if (snapshot.ok === false) return undefined;
        updated = { ...run, agent, launch: snapshot.launch, restartArgv: snapshot.restartArgv,
          resumes: canResume ? run.resumes : null, session: canResume ? session : assignedSession(snapshot.launch, agent) };
      } else {
        const snapshot = launchSnapshot(config, agent, mode, path, values, history);
        if (snapshot.ok === false) return undefined;
        updated = { ...run, agent, launch: snapshot.launch,
          resumes: canResume ? run.resumes : null, session: canResume ? session : assignedSession(snapshot.launch, agent) };
      }
    } catch (error) {
      if (error instanceof Problem) return undefined;
      throw error;
    }
    if (!explicit || canResume) inherited.add(run.id);
    const saved = !explicit && typeof row.ai_stack === 'string' ? aiStackSchema.parse(JSON.parse(row.ai_stack)) : undefined;
    const position = saved?.findIndex(item => isDeepStrictEqual(item, replacement)) ?? -1;
    bindings.push({ run: updated, rows: saved && [replacement, ...saved.slice(position < 0 ? 1 : position + 1)] });
  }
  return bindings;
}

/** Called only by the importer, in the transaction that commits the previous Run's terminal result. */
export function reserveAiFallback(store: RunStore, tx: RunTransaction, run: RuntimeRunRecord,
  end: EndObservation, attemptId: string): RuntimeRunRecord['id'] | undefined {
  if (!end.availability || !end.handoffSafe || run.stop_requested || run.state !== 'running' ||
      end.finalResult.state === 'unreadable' || end.finalResult.state === 'too_large') return;
  const db = store.connection;
  const saved = db.prepare(`SELECT q.ai_stack,q.placement_revision,q.submitted_at,q.delivery_state,
    (${currentRequestRun('q.id')}) AS current_run FROM requests q WHERE q.id=?`).get(run.requestId);
  if (typeof saved?.ai_stack !== 'string' || typeof saved.submitted_at !== 'string' || saved.current_run !== runNumber(run.id) ||
    saved.delivery_state === DELIVERY_STATE.aborted || saved.delivery_state === DELIVERY_STATE.recorded_unconfirmed) return;
  if (db.prepare("SELECT 1 FROM run_inputs WHERE attempt_id=? AND state IN ('attempted','uncertain')").get(attemptId)) return;
  if (run.role === 'coordinator') {
    if (!db.prepare('SELECT 1 FROM coordinator_conversations WHERE id=? AND cleared_at IS NULL').get(run.conversationId)) return;
  } else {
    if (db.prepare('SELECT 1 FROM returns WHERE request_id=?').get(run.requestId)) return;
    const placement = tx.getPlacement(run.placementId);
    if (!placement?.active || placement.revision !== saved.placement_revision || queuedStart(store, tx, run).kind !== 'go') return;
    if (db.prepare(`SELECT 1 FROM task_log l JOIN tasks t ON t.id=l.task_id
      WHERE t.external_id=? AND l.at>=? AND json_extract(l.entry,'$.toState') IN ('done','stopped','error') LIMIT 1`)
      .get(run.task, saved.submitted_at)) return;
  }
  const prompt = nextPrompt(db, run, end.availability.cause);
  if (prompt === undefined) return;
  const settings = readAgentsSettings(store.root);
  if (!settings.ok) return;
  const rows = aiStackSchema.parse(JSON.parse(saved.ai_stack));
  const lane = run.role === 'coordinator' ? tx.coordinatorRuns(run.conversationId) : tx.conversationRuns(run.placementId);
  for (let attempt = (run.attempt ?? 0) + 1; attempt < rows.length; attempt++) {
    const { agent, values } = rows[attempt]!;
    let prepared;
    try {
      prepared = launchSnapshot(settings.config, agent, 'start', run.launch.path, values);
    } catch (error) {
      if (error instanceof Problem) continue;
      throw error;
    }
    if (prepared.ok === false || !isDeepStrictEqual(prepared.launch.values, values)) continue;
    const launch = prepared.launch;
    const session = assignedSession(launch, agent);
    const bindings = rebindPending(db, settings.config, lane, run, { agent, values }, session, launch.adapter);
    if (!bindings) continue;
    const common = { requestId: run.requestId, attempt, firstRunId: run.firstRunId ?? run.id, agent, resumes: null,
      session, cwd: run.cwd, launch };
    const next = run.role === 'coordinator' ? tx.createCoordinatorRun({
      ...common, conversationId: run.conversationId, message: run.message, restartArgv: null,
    }, prompt) : tx.create({
      ...common, task: run.task, placementId: run.placementId, role: run.role, continues: false, caller: run.caller,
    }, prompt);
    for (const binding of bindings) {
      const record = binding.run;
      tx.rebindQueued(record.resumes === run.id ? { ...record, resumes: next.id } : record, binding.rows);
    }
    return next.id;
  }
}
