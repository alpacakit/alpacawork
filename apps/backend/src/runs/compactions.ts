/**
 * The one owner of compacting a conversation before an instruction (task request --compact, task report
 * --next-conversation compact): whether an agent can, the request its Run carries, what the Run's start sends, how it
 * ended, and the latest one task get and the screen show with each placement.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { touch } from '@alpacawork/db';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { AGENT_ADAPTERS, builtinAdapterIdSchema } from '@alpacawork/contract/agent-adapters';
import type { Compaction } from '@alpacawork/contract/control';
import type { CompactionLaunch, CompactionOutcome } from '@alpacawork/contract/run-protocol';
import { runNumber, type RunRecord } from '@alpacawork/contract/run';
import type { AgentInvocation } from './launch-agent.js';

type Launch = Pick<RunRecord['launch'], 'adapter' | 'values'>;
type Refusal = { kind: 'compaction_unsupported' | 'compaction_instructions_unsupported' | 'compaction_needs_model'; message: string };
const view = (row: Record<string, SQLOutputValue>, taskId: string): Compaction => ({ id: String(row.id), task: taskId,
  agent: String(row.placement_id), state: String(row.state) as Compaction['state'],
  focus: row.focus === null ? null : String(row.focus), message: row.message === null ? null : String(row.message),
  requestedAt: String(row.requested_at), endedAt: row.ended_at === null ? null : String(row.ended_at) });
const changed = (db: DatabaseSync, placementId: string) => touch(db, { kind: 'placement', id: placementId });

/**
 * Why a launch of `launch`'s agent with `launch`'s values cannot compact (with `focus`), or null when it can. Copilot on
 * its automatic choice of model ('auto', or none) has no model to compact with before a turn of its own.
 */
function refusal(launch: Launch, focus: string | null): Refusal | null {
  const id = builtinAdapterIdSchema.safeParse(launch.adapter), can = id.success ? AGENT_ADAPTERS[id.data].compaction : null;
  const model = launch.values.model;
  if (!can) return { kind: 'compaction_unsupported', message: `${launch.adapter} cannot compact a conversation` };
  if (can.needsModel && (typeof model !== 'string' || !model || model === 'auto'))
    return { kind: 'compaction_needs_model', message: `${launch.adapter} compacts only a conversation with a chosen model; ` +
      'choose one with --selected or in its agent settings' };
  if (focus !== null && !can.instructions)
    return { kind: 'compaction_instructions_unsupported', message: `${launch.adapter} compacts without a focus; leave out --compact-focus` };
  return null;
}
/** Refuse a compaction asked for with this launch, the way the request or report that asks says it. */
export function assertCompactable(launch: Launch, focus: string | null): void {
  const refused = refusal(launch, focus);
  if (refused) throw new Problem(PROBLEM_CODE.invalidInput, refused.message, undefined, { reason: { kind: refused.kind } });
}

/**
 * Record that `run`'s start compacts its conversation before its instruction. `explicit`: the sender asked for it, so an
 * agent that cannot is refused; else it came from a report's prepared intent, and is kept as dropped with the reason.
 */
export function requestCompaction(db: DatabaseSync, run: Pick<RunRecord, 'id' | 'placementId' | 'launch'>,
  focus: string | null, explicit: boolean, at: string): void {
  const refused = refusal(run.launch, focus);
  if (refused && explicit) assertCompactable(run.launch, focus);
  db.prepare('INSERT INTO compactions(id,run_no,placement_id,focus,state,message,requested_at,ended_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(randomUUID(), runNumber(run.id), run.placementId, focus, refused ? 'dropped' : 'pending', refused?.message ?? null,
      at, refused ? at : null);
  changed(db, run.placementId);
}

/**
 * What `runId`'s start sends, decided as `attemptId` is reserved: its pending compaction when the launch resumes the
 * conversation on an agent that can; a launch that starts anew (another AI after a failure) or cannot drops it.
 */
export function claimCompaction(db: DatabaseSync, runId: string, attemptId: string,
  invocation: Pick<AgentInvocation, 'launch' | 'mode'>, at: string): CompactionLaunch | null {
  const row = db.prepare("SELECT id,placement_id,focus FROM compactions WHERE run_no=? AND state='pending'").get(runNumber(runId));
  if (!row) return null;
  const focus = row.focus === null ? null : String(row.focus);
  const dropped = invocation.mode !== 'resume' ? 'The Run started a new conversation' : refusal(invocation.launch, null)?.message ?? null;
  if (dropped) db.prepare("UPDATE compactions SET state='dropped',message=?,ended_at=? WHERE id=?").run(dropped, at, String(row.id));
  else db.prepare("UPDATE compactions SET state='sent',attempt_id=? WHERE id=?").run(attemptId, String(row.id));
  changed(db, String(row.placement_id));
  // A focus the agent cannot take was refused when asked; one it lost since (another agent) is left out.
  return dropped ? null : { id: String(row.id), instructions: refusal(invocation.launch, focus) ? null : focus };
}

/**
 * How the compaction `attemptId` carried ended, once its attempt ended (its completion, or a launch that never started).
 * It went with the attempt's initial input and shares its fate: never sent, it is dropped with it; sent, it is what the
 * agent said of it, else nobody knows.
 */
export function settleCompaction(db: DatabaseSync, attemptId: string, outcome: CompactionOutcome | null, at: string): void {
  const row = db.prepare(`SELECT c.id,c.placement_id,i.state AS input FROM compactions c
    LEFT JOIN run_inputs i ON i.attempt_id=c.attempt_id AND i.initial=1 WHERE c.attempt_id=? AND c.state='sent'`).get(attemptId);
  if (!row) return;
  const id = String(row.id);
  if (outcome) db.prepare('UPDATE compactions SET state=?,message=?,ended_at=? WHERE id=?').run(outcome.state, outcome.message, at, id);
  else if (row.input !== 'not_sent') db.prepare("UPDATE compactions SET state='unknown',ended_at=? WHERE id=?").run(at, id);
  else db.prepare("UPDATE compactions SET state='dropped',message='The instruction it went with was not sent',ended_at=? WHERE id=?").run(at, id);
  changed(db, String(row.placement_id));
}

/** Each of `placementIds`' latest compaction, as task get and the screen show it with the placement. */
export function latestCompactions(db: DatabaseSync, placementIds: readonly string[]): Map<string, Compaction> {
  if (!placementIds.length) return new Map();
  const rows = db.prepare(`SELECT c.*,p.task_id FROM compactions c JOIN placements p ON p.id=c.placement_id
    WHERE c.placement_id IN (SELECT value FROM json_each(?)) ORDER BY c.run_no`).all(JSON.stringify(placementIds));
  return new Map(rows.map(row => [String(row.placement_id), view(row, String(row.task_id))]));
}
