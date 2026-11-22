import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { aiStackSchema, compileAgentSetting, resolveAgentSelection, type AiRow } from '@alpacawork/contract';
import { PROTOCOL_LIMITS } from '@alpacawork/contract/run-protocol';
import { runNumber, type RuntimeRunRecord } from '@alpacawork/contract/run';
import { Problem } from '@alpacawork/core';
import type { RunStore, RunTransaction } from '@alpacawork/runs';
import { assignedSession, launchSnapshot, readAgentsSettings, type AgentsSettings } from '../agents-settings.js';
import { queuedStart } from './execution-control.js';
import type { EndObservation } from './result-observation.js';

/** Freeze the actual first row and deduplicate the subsequent effective launch values. */
export function freezeAiStack(config: AgentsSettings, first: AiRow): AiRow[] | undefined {
  if (!config.aiStack?.length) return undefined;
  const seen = new Map<string, object[]>();
  return [first, ...config.aiStack].flatMap(row => {
    const compiled = compileAgentSetting(row.agent, config.agents[row.agent]);
    const selection = resolveAgentSelection(compiled, row.values);
    const previous = seen.get(row.agent) ?? [];
    if (previous.some(values => isDeepStrictEqual(values, selection.effective))) return [];
    seen.set(row.agent, [...previous, selection.effective]);
    return [{ agent: row.agent, values: selection.values }];
  });
}

function nextPrompt(db: DatabaseSync, run: RuntimeRunRecord, end: EndObservation): string | undefined {
  const stored = db.prepare('SELECT prompt FROM runs WHERE id=?').get(runNumber(run.id));
  if (!stored || typeof stored.prompt !== 'string') return undefined;
  const latest = run.attempt === undefined ? stored.prompt : db.prepare('SELECT prompt FROM runs WHERE request_id=? AND attempt=0')
    .get(run.requestId)?.prompt;
  if (typeof latest !== 'string') return undefined;
  const prompt = [
    'Continue the same request in this new conversation.',
    `The previous Run ${run.id} stopped because of ${end.availability!.cause}.`,
    'Check the task records and the current working directory before continuing. Do not repeat completed operations or retry operations whose results are unknown.',
    '',
    latest,
  ].join('\n');
  return Buffer.byteLength(prompt) <= PROTOCOL_LIMITS.prompt ? prompt : undefined;
}

/** Called only by the importer, in the transaction that commits the previous Run's terminal result. */
export function reserveAiFallback(store: RunStore, tx: RunTransaction, run: RuntimeRunRecord,
  end: EndObservation, attemptId: string): RuntimeRunRecord['id'] | undefined {
  if (!end.availability || run.stop_requested || run.state !== 'running' || end.finalResult.state === 'unreadable' ||
      end.finalResult.state === 'too_large' || run.role === 'coordinator') return;
  const db = store.connection;
  const saved = db.prepare('SELECT ai_stack,placement_revision,submitted_at FROM requests WHERE id=?').get(run.requestId);
  if (typeof saved?.ai_stack !== 'string' || typeof saved.submitted_at !== 'string' || tx.getRequest(run.requestId)?.runId !== run.id) return;
  if (db.prepare('SELECT 1 FROM returns WHERE request_id=?').get(run.requestId)) return;
  const placement = tx.getPlacement(run.placementId);
  if (!placement?.active || placement.revision !== saved.placement_revision || queuedStart(store, tx, run).kind !== 'go') return;
  if (db.prepare(`SELECT 1 FROM task_log l JOIN tasks t ON t.id=l.task_id
    WHERE t.external_id=? AND l.at>=? AND json_extract(l.entry,'$.toState') IN ('done','stopped','error') LIMIT 1`)
    .get(run.task, saved.submitted_at)) return;
  if (db.prepare(`SELECT 1 FROM run_inputs WHERE attempt_id=? AND
    (state IN ('attempted','uncertain') OR (initial=0 AND state='taken')) LIMIT 1`).get(attemptId)) return;
  if (tx.conversationRuns(run.placementId).some(other => other.state === 'queued')) return;
  const prompt = nextPrompt(db, run, end);
  if (prompt === undefined) return;
  const settings = readAgentsSettings(store.root);
  if (!settings.ok) return;
  const rows = aiStackSchema.parse(JSON.parse(saved.ai_stack));
  for (let attempt = (run.attempt ?? 0) + 1; attempt < rows.length; attempt++) {
    const { agent, values } = rows[attempt]!;
    let prepared;
    try {
      prepared = launchSnapshot(settings.config, agent, 'start', run.launch.path, values);
    } catch (error) {
      if (error instanceof Problem) continue;
      throw error;
    }
    if (!prepared.ok || !isDeepStrictEqual(prepared.launch.values, values)) continue;
    return tx.create({ task: run.task, placementId: run.placementId, requestId: run.requestId, attempt,
      agent, role: run.role, resumes: null, continues: false, session: assignedSession(prepared.launch, agent),
      caller: run.caller, cwd: run.cwd, launch: prepared.launch }, prompt).id;
  }
}
