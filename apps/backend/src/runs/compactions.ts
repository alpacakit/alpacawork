/**
 * The one owner of the compactions table: a request to compact a placement's conversation, which that conversation's
 * next start carries before its first instruction (agent compact). Every write and the read the screen and task get
 * show go through here.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { touch } from '@alpacawork/db';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { AGENT_ADAPTERS, builtinAdapterIdSchema } from '@alpacawork/contract/agent-adapters';
import type { Compaction } from '@alpacawork/contract/control';
import type { CompactionLaunch, CompactionOutcome } from '@alpacawork/contract/run-protocol';
import type { AgentInvocation } from './launch-agent.js';

const view = (row: Record<string, SQLOutputValue>, taskId: string): Compaction => ({ id: String(row.id), task: taskId,
  agent: String(row.placement_id), state: String(row.state) as Compaction['state'],
  instructions: row.instructions === null ? null : String(row.instructions), message: row.message === null ? null : String(row.message),
  requestedAt: String(row.requested_at), endedAt: row.ended_at === null ? null : String(row.ended_at) });
const changed = (db: DatabaseSync, placementId: string) => touch(db, { kind: 'placement', id: placementId });
/** What an agent of `adapter` can do: compact, and take words on what to keep in focus. */
const ability = (adapter: unknown) => {
  const id = builtinAdapterIdSchema.safeParse(adapter);
  return id.success ? AGENT_ADAPTERS[id.data].compaction : null;
};
const refuse = (message: string,
  kind: 'compaction_without_conversation' | 'compaction_unsupported' | 'compaction_instructions_unsupported') =>
  new Problem(PROBLEM_CODE.invalidInput, message, undefined, { reason: { kind } });

/**
 * Ask that the conversation of `placementId`, an active placement of `taskId`, be compacted when it next starts. Its
 * agent is the one its latest conversation ran on. A request still pending takes the new words instead of a second one.
 */
export function requestCompaction(db: DatabaseSync, input: { taskId: string; placementId: string;
  instructions: string | null; at: string }): Compaction {
  const placement = db.prepare('SELECT ended_at FROM placements WHERE id=? AND task_id=?').get(input.placementId, input.taskId);
  if (!placement || placement.ended_at !== null)
    throw new Problem(PROBLEM_CODE.notFound, 'No active placement with this ID on the task', undefined,
      { reason: { kind: 'placement_does_not_belong_task' } });
  const head = db.prepare(`SELECT json_extract(record,'$.launch.adapter') AS adapter FROM runs
    WHERE placement_id=? AND session_id IS NOT NULL ORDER BY id DESC LIMIT 1`).get(input.placementId);
  if (!head) throw refuse('This placement has no conversation to compact yet', 'compaction_without_conversation');
  const can = ability(head.adapter);
  if (!can) throw refuse(`${String(head.adapter)} cannot compact a conversation`, 'compaction_unsupported');
  if (input.instructions !== null && !can.instructions)
    throw refuse(`${String(head.adapter)} compacts without instructions; leave out --instructions`, 'compaction_instructions_unsupported');
  const pending = db.prepare("SELECT id FROM compactions WHERE placement_id=? AND state='pending'").get(input.placementId);
  const id = pending ? String(pending.id) : randomUUID();
  if (pending) db.prepare('UPDATE compactions SET instructions=?,requested_at=? WHERE id=?').run(input.instructions, input.at, id);
  else db.prepare("INSERT INTO compactions(id,placement_id,instructions,state,requested_at) VALUES (?,?,?,'pending',?)")
    .run(id, input.placementId, input.instructions, input.at);
  changed(db, input.placementId);
  return view(db.prepare('SELECT * FROM compactions WHERE id=?').get(id)!, input.taskId);
}

/**
 * What a placement's next launch carries, decided as `attemptId` is reserved: a pending request goes with a launch that
 * resumes the conversation on an agent that compacts; a conversation started anew, or an agent that cannot, drops it.
 */
export function claimCompaction(db: DatabaseSync, placementId: string | null, attemptId: string,
  invocation: Pick<AgentInvocation, 'launch' | 'mode'>, at: string): CompactionLaunch | null {
  if (placementId === null) return null;
  const row = db.prepare("SELECT id,instructions FROM compactions WHERE placement_id=? AND state='pending'").get(placementId);
  if (!row) return null;
  const can = ability(invocation.launch.adapter);
  const dropped = invocation.mode !== 'resume' ? 'The conversation started anew' : !can ? `${invocation.launch.adapter} cannot compact a conversation` : null;
  if (dropped) db.prepare("UPDATE compactions SET state='dropped',message=?,ended_at=? WHERE id=?").run(dropped, at, String(row.id));
  else db.prepare("UPDATE compactions SET state='sent',attempt_id=? WHERE id=?").run(attemptId, String(row.id));
  changed(db, placementId);
  return dropped ? null : { id: String(row.id), instructions: can!.instructions && row.instructions !== null ? String(row.instructions) : null };
}

/**
 * How the compaction `attemptId` carried ended, from its completion: what the agent said; else, when its agent never
 * started, it waits for the next start again (unless a newer request replaced it); else nobody knows.
 */
export function settleCompaction(db: DatabaseSync, attemptId: string, outcome: CompactionOutcome | null, started: boolean, at: string): void {
  const row = db.prepare("SELECT id,placement_id FROM compactions WHERE attempt_id=? AND state='sent'").get(attemptId);
  if (!row) return;
  const id = String(row.id), placementId = String(row.placement_id);
  if (outcome) db.prepare('UPDATE compactions SET state=?,message=?,ended_at=? WHERE id=?').run(outcome.state, outcome.message, at, id);
  else if (started) db.prepare("UPDATE compactions SET state='unknown',ended_at=? WHERE id=?").run(at, id);
  else if (db.prepare("SELECT 1 FROM compactions WHERE placement_id=? AND state='pending'").get(placementId))
    db.prepare("UPDATE compactions SET state='dropped',message='A newer request replaced it',ended_at=? WHERE id=?").run(at, id);
  else db.prepare("UPDATE compactions SET state='pending',attempt_id=NULL WHERE id=?").run(id);
  changed(db, placementId);
}

/** Each placement's latest compaction request, for the placements of `taskId`. */
export function latestCompactions(db: DatabaseSync, taskId: string): Map<string, Compaction> {
  const rows = db.prepare(`SELECT c.* FROM compactions c JOIN placements p ON p.id=c.placement_id WHERE p.task_id=?
    ORDER BY c.requested_at,c.rowid`).all(taskId);
  return new Map(rows.map(row => [String(row.placement_id), view(row, taskId)]));
}
