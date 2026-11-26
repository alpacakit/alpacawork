import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { aiStackSchema, type AiRow, type Selection } from '@alpacawork/contract';
import { DELIVERY_STATE } from '@alpacawork/contract/control';
import { PROTOCOL_LIMITS } from '@alpacawork/contract/run-protocol';
import { runNumber, type CoordinatorRunRecord, type RuntimeRunRecord, type RunRecord } from '@alpacawork/contract/run';
import { Problem } from '@alpacawork/core';
import { compareRequestOrder, currentRequestRun, type RunStore, type RunTransaction } from '@alpacawork/runs';
import { assignedSession, coordinatorLaunchSnapshot, launchIfResumable, launchSnapshot, readAgentsSettings, type AgentsSettings } from '../agents-settings.js';
import { deliveredMessages } from '../coordinator/messages.js';
import { coordinatorInput, coordinatorTurnNumber, prepareCoordinatorStart } from '../coordinator/continuation.js';
import { queuedStart } from './execution-control.js';
import { appliedSessionValues, isConversationAgent } from './session-continuation.js';
import type { EndObservation } from './result-observation.js';

/** Previous answers come from the conversation's stored Requests and Runs, never a provider transcript. */
function priorContext(db: DatabaseSync, run: RunRecord, first: number) {
  // A resumed Run may be an input taken into the conversation or a replacement that inherited its first trial's work.
  return db.prepare(`WITH RECURSIVE earlier(id,depth) AS (
    SELECT CAST(substr(resumes_id,2) AS INTEGER),1 FROM runs WHERE id=?
    UNION ALL
    SELECT CAST(substr(coalesce(r.into_id,r.resumes_id,first.resumes_id),2) AS INTEGER),earlier.depth+1
    FROM earlier JOIN runs r ON r.id=earlier.id JOIN runs first ON first.request_id=r.request_id AND first.attempt=0
    WHERE earlier.depth<12
  )
  SELECT r.id,q.body,r.result FROM earlier JOIN runs r ON r.id=earlier.id JOIN requests q ON q.id=r.request_id
  WHERE r.state IN ('joined','succeeded') AND r.placement_id=? ORDER BY earlier.depth LIMIT 8`).all(first, run.placementId);
}

const newConversationText = (prompt: string): string =>
  prompt.replace(/^(\[alpacawork\] Request for task T\d+) \(continuing the same conversation\)\./, '$1.');

function nextPrompt(db: DatabaseSync, run: RunRecord, cause: string): string | undefined {
  const first = db.prepare('SELECT id,prompt FROM runs WHERE request_id=? AND attempt=0').get(run.requestId);
  if (typeof first?.prompt !== 'string') return undefined;
  const received = db.prepare(`SELECT input.prompt FROM runs carrier JOIN run_attempts a ON a.run_no=carrier.id
    JOIN run_inputs i USING(attempt_id) JOIN runs input ON input.id=i.instruction_run_no
    WHERE carrier.request_id=? AND i.initial=0 AND i.state='taken' ORDER BY input.id`).all(run.requestId).map(row => String(row.prompt));
  const required = [first.prompt, ...received].map(newConversationText).join('\n\n');
  const header = [
    'Continue the same request in this new conversation.',
    `The previous Run ${run.id} stopped because of ${cause}.`,
    'Check recorded progress and the current working directory before continuing. Do not repeat completed operations or retry operations whose results are unknown.',
    `Read current task records with alpacawork task get --task ${run.task}.`,
  ].join('\n');
  const remaining = PROTOCOL_LIMITS.prompt - Buffer.byteLength(header + '\n\n' + required);
  if (remaining < 0) return undefined;
  let history = '';
  if (remaining > 64) for (const row of priorContext(db, run, Number(first.id))) {
    const context = JSON.stringify({ earlierMessage: row.body, answer: row.result });
    const link = `Earlier Run: alpacawork run get --run R${row.id} (add --kind prompt for its instructions).`;
    const text = Buffer.byteLength(context + history) + 64 < remaining ? context : link;
    if (text && Buffer.byteLength(text + history) + 64 < remaining) history = '\n' + text + history;
  }
  return [header, history && `Earlier conversation for context:${history}`, required].filter(Boolean).join('\n\n');
}

type Rebinding = { run: RunRecord; rows?: AiRow[]; prompt?: string };
type SessionBinding = AiRow & { adapter: string; session: RuntimeRunRecord['session']; applied: Selection };

function taskBindingLaunch(config: AgentsSettings, path: string, row: AiRow, previous: SessionBinding | undefined) {
  const resume = previous
    ? launchIfResumable(() => launchSnapshot(config, row.agent, 'resume', path, row.values, previous)) : undefined;
  return resume ? { snapshot: resume, resumes: true } :
    { snapshot: launchSnapshot(config, row.agent, 'start', path, row.values), resumes: false };
}

/** Rebind an undelivered continuation, preserving the next request's own admissible selections. */
function rebindPending(db: DatabaseSync, config: AgentsSettings, lane: readonly RunRecord[], previous: RunRecord,
  replacement: SessionBinding): Rebinding[] | undefined {
  const changed = new Map([[previous.id, replacement]]), bindings: Rebinding[] = [];
  const pending = lane.filter(run => run.state === 'queued').sort(compareRequestOrder);
  for (const run of pending) {
    const predecessor = run.resumes ? changed.get(run.resumes) : undefined;
    if (!predecessor) continue;
    const row = db.prepare('SELECT q.ai_stack,q.ai_explicit,r.prompt FROM runs r JOIN requests q ON q.id=r.request_id WHERE r.id=?')
      .get(runNumber(run.id));
    if (!row || db.prepare("SELECT 1 FROM run_inputs WHERE instruction_run_no=? AND state<>'not_sent'").get(runNumber(run.id)))
      return undefined;
    const saved = typeof row.ai_stack === 'string' ? aiStackSchema.parse(JSON.parse(row.ai_stack)) : undefined;
    const position = saved?.findIndex(item => item.agent === predecessor.agent && isDeepStrictEqual(item.values, predecessor.values)) ?? -1;
    const matched = run.agent === predecessor.agent && isDeepStrictEqual(run.launch.values, predecessor.values);
    const adoptsRow = !matched && row.ai_explicit !== 1 && position >= 0;
    const { agent } = adoptsRow ? predecessor : run;
    const values = adoptsRow ? predecessor.values : run.launch.values;
    const sameAgent = isConversationAgent(predecessor, agent);
    let updated: RunRecord;
    let resumes: boolean;
    try {
      const path = run.launch.path;
      const prepared = taskBindingLaunch(config, path, { agent, values }, sameAgent ? predecessor : undefined);
      const { snapshot } = prepared;
      if (snapshot.ok === false) return undefined;
      const launch = snapshot.launch;
      resumes = prepared.resumes;
      const session = resumes ? predecessor.session : assignedSession(launch, agent);
      const resumeFrom = resumes ? run.resumes : null;
      const newConversation = resumes ? run.newConversation :
        { because: sameAgent ? 'unresumable' as const : 'another_ai' as const };
      const opened = newConversation ? { newConversation } : {};
      updated = { ...run, agent, launch, resumes: resumeFrom, session, ...opened };
      changed.set(run.id, { agent, values: launch.values, session, adapter: launch.adapter,
        applied: appliedSessionValues(launch, resumes ? predecessor : undefined) });
    } catch (error) {
      if (error instanceof Problem) return undefined;
      throw error;
    }
    const prompt = !resumes && typeof row.prompt === 'string' ? newConversationText(row.prompt) : undefined;
    bindings.push({ run: updated, rows: adoptsRow ? saved?.slice(position) : undefined, prompt });
  }
  return bindings;
}

/** Called only by the importer, in the transaction that commits the previous Run's terminal result. */
export function reserveAiFallback(store: RunStore, tx: RunTransaction, run: RuntimeRunRecord,
  end: EndObservation, attemptId: string): RuntimeRunRecord['id'] | undefined {
  if (!end.availability || !end.handoffSafe || run.stop_requested || run.state !== 'running' ||
      end.finalResult.state === 'unreadable' || end.finalResult.state === 'too_large') return;
  const db = store.connection;
  const saved = db.prepare(`SELECT q.ai_stack,q.placement_revision,q.delivery_state,
    (${currentRequestRun('q.id')}) AS current_run FROM requests q WHERE q.id=?`).get(run.requestId);
  if (typeof saved?.ai_stack !== 'string' || saved.current_run !== runNumber(run.id) ||
    saved.delivery_state === DELIVERY_STATE.aborted || saved.delivery_state === DELIVERY_STATE.recorded_unconfirmed) return;
  if (db.prepare("SELECT 1 FROM run_inputs WHERE attempt_id=? AND state IN ('attempted','uncertain')").get(attemptId)) return;
  const settings = readAgentsSettings(store.root);
  if (!settings.ok) return;
  const rows = aiStackSchema.parse(JSON.parse(saved.ai_stack));
  if (run.role === 'coordinator')
    return reserveCoordinatorFallback(store, tx, run, settings.config, rows, end.availability.cause);
  if (db.prepare('SELECT 1 FROM returns WHERE request_id=?').get(run.requestId)) return;
  const placement = tx.getPlacement(run.placementId);
  if (!placement?.active || placement.revision !== saved.placement_revision || queuedStart(store, tx, run).kind !== 'go') return;
  // A long-running earlier trial can publish its end after this Request was admitted.
  if (db.prepare(`SELECT 1 FROM task_log l JOIN tasks t ON t.id=l.task_id
    JOIN runs r ON r.id=CAST(substr(json_extract(l.entry,'$.runId'),2) AS INTEGER)
    WHERE t.external_id=? AND r.request_id=? AND json_extract(l.entry,'$.toState') IN ('done','stopped','error')
    LIMIT 1`).get(run.task, run.requestId)) return;
  const prompt = nextPrompt(db, run, end.availability.cause);
  if (prompt === undefined) return;
  const lane = tx.conversationRuns(run.placementId);
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
    const bindings = rebindPending(db, settings.config, lane, run, { agent, values, session, adapter: launch.adapter,
      applied: appliedSessionValues(launch) });
    if (!bindings) continue;
    const common = { requestId: run.requestId, attempt, firstRunId: run.firstRunId ?? run.id, agent, resumes: null,
      session, cwd: run.cwd, launch };
    const next = tx.create({
      ...common, task: run.task, placementId: run.placementId, role: run.role, continues: false, caller: run.caller,
    }, prompt);
    for (const binding of bindings) {
      const record = binding.run;
      tx.rebindQueued(record.resumes === run.id ? { ...record, resumes: next.id } : record, { aiStack: binding.rows, prompt: binding.prompt });
    }
    return next.id;
  }
}

/** The replacement owns the same Request and takes already-received inputs exactly once in its first prompt. */
function reserveCoordinatorFallback(store: RunStore, tx: RunTransaction, run: CoordinatorRunRecord,
  config: AgentsSettings, rows: readonly AiRow[], cause: string) {
  const db = store.connection;
  if (!db.prepare('SELECT 1 FROM coordinator_conversations WHERE id=? AND cleared_at IS NULL').get(run.conversationId)) return;
  const input = coordinatorInput(db, run.requestId);
  const otherInputs = deliveredMessages(db, run.id).filter(id => id !== run.requestId).map(id => coordinatorInput(db, id));
  const prompt = prepareCoordinatorStart(db, run.conversationId, coordinatorTurnNumber(db, run.requestId),
    [input, ...otherInputs], { run: run.id, cause });
  if (prompt === undefined) return;
  for (let attempt = (run.attempt ?? 0) + 1; attempt < rows.length; attempt++) {
    const row = rows[attempt]!;
    let next;
    try { next = coordinatorLaunchSnapshot(config, row.agent, 'start', run.launch.path, row.values); }
    catch (error) {
      if (error instanceof Problem) continue;
      throw error;
    }
    if (!next.ok || !isDeepStrictEqual(next.launch.values, row.values)) continue;
    return tx.createCoordinatorRun({ requestId: run.requestId, attempt, firstRunId: run.firstRunId ?? run.id,
      agent: row.agent, resumes: null, session: assignedSession(next.launch, row.agent), cwd: run.cwd, launch: next.launch,
      conversationId: run.conversationId, message: run.message }, prompt).id;
  }
}
