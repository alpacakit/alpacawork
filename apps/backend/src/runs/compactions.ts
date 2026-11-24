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
import type { RunRecord } from '@alpacawork/contract/run';
import type { Selection } from '@alpacawork/contract/agent-settings';

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
/** Whether an agent that needs a chosen model would compact with `values` on its automatic choice ('auto', or none). */
const automaticModel = (can: NonNullable<ReturnType<typeof ability>>, values: Readonly<Record<string, unknown>>) =>
  can.needsModel && (typeof values.model !== 'string' || !values.model || values.model === 'auto');
const NEEDS_MODEL = 'compacts only a conversation with a chosen model; choose one in its agent settings, or with ' +
  'task request --selected for a conversation whose launch chose Auto';
const refuse = (message: string,
  kind: 'compaction_without_conversation' | 'compaction_unsupported' | 'compaction_instructions_unsupported' | 'compaction_needs_model') =>
  new Problem(PROBLEM_CODE.invalidInput, message, undefined, { reason: { kind } });

/**
 * Ask that the conversation of `placementId`, an active placement of `taskId`, be compacted when it next starts. Its
 * agent is the one its latest conversation ran on. A request still pending takes the new words instead of a second one.
 */
export function requestCompaction(db: DatabaseSync, input: { taskId: string; placementId: string;
  instructions: string | null; at: string;
  /** The launch values the conversation's next start would use (null when the settings cannot say). */
  nextValues: (head: Pick<RunRecord, 'agent' | 'launch'>) => Selection | null }): Compaction {
  const placement = db.prepare('SELECT ended_at FROM placements WHERE id=? AND task_id=?').get(input.placementId, input.taskId);
  if (!placement || placement.ended_at !== null)
    throw new Problem(PROBLEM_CODE.notFound, 'No active placement with this ID on the task', undefined,
      { reason: { kind: 'placement_does_not_belong_task' } });
  const row = db.prepare('SELECT record FROM runs WHERE placement_id=? AND session_id IS NOT NULL ORDER BY id DESC LIMIT 1').get(input.placementId);
  if (!row) throw refuse('This placement has no conversation to compact yet', 'compaction_without_conversation');
  const head = JSON.parse(String(row.record)) as Pick<RunRecord, 'agent' | 'launch'>, adapter = head.launch.adapter;
  const can = ability(adapter);
  if (!can) throw refuse(`${adapter} cannot compact a conversation`, 'compaction_unsupported');
  const next = input.nextValues(head);
  if (next && automaticModel(can, next)) throw refuse(`${adapter} ${NEEDS_MODEL}`, 'compaction_needs_model');
  if (input.instructions !== null && !can.instructions)
    throw refuse(`${adapter} compacts without instructions; leave out --instructions`, 'compaction_instructions_unsupported');
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
  const dropped = invocation.mode !== 'resume' ? 'The conversation started anew'
    : !can ? `${invocation.launch.adapter} cannot compact a conversation`
    : automaticModel(can, invocation.launch.values) ? `${invocation.launch.adapter} ${NEEDS_MODEL}` : null;
  if (dropped) db.prepare("UPDATE compactions SET state='dropped',message=?,ended_at=? WHERE id=?").run(dropped, at, String(row.id));
  else db.prepare("UPDATE compactions SET state='sent',attempt_id=? WHERE id=?").run(attemptId, String(row.id));
  changed(db, placementId);
  return dropped ? null : { id: String(row.id), instructions: can!.instructions && row.instructions !== null ? String(row.instructions) : null };
}

/**
 * How the compaction `attemptId` carried ended, once its attempt ended (its completion, or a launch that never started).
 * It went with the attempt's initial input, so it shares that input's fate: never sent, it waits for the next start
 * again (unless a newer request replaced it); sent, it is what the agent said of it, else nobody knows.
 */
export function settleCompaction(db: DatabaseSync, attemptId: string, outcome: CompactionOutcome | null, at: string): void {
  const row = db.prepare(`SELECT c.id,c.placement_id,i.state AS input FROM compactions c
    LEFT JOIN run_inputs i ON i.attempt_id=c.attempt_id AND i.initial=1 WHERE c.attempt_id=? AND c.state='sent'`).get(attemptId);
  if (!row) return;
  const id = String(row.id), placementId = String(row.placement_id);
  if (outcome) db.prepare('UPDATE compactions SET state=?,message=?,ended_at=? WHERE id=?').run(outcome.state, outcome.message, at, id);
  else if (row.input !== 'not_sent') db.prepare("UPDATE compactions SET state='unknown',ended_at=? WHERE id=?").run(at, id);
  else if (db.prepare("SELECT 1 FROM compactions WHERE placement_id=? AND state='pending'").get(placementId))
    db.prepare("UPDATE compactions SET state='dropped',message='A newer request replaced it',ended_at=? WHERE id=?").run(at, id);
  else db.prepare("UPDATE compactions SET state='pending',attempt_id=NULL WHERE id=?").run(id);
  changed(db, placementId);
}

/** Each of `placementIds`' latest compaction request, as task get and the screen show it with the placement. */
export function latestCompactions(db: DatabaseSync, placementIds: readonly string[]): Map<string, Compaction> {
  if (!placementIds.length) return new Map();
  const rows = db.prepare(`SELECT c.*,p.task_id FROM compactions c JOIN placements p ON p.id=c.placement_id
    WHERE c.placement_id IN (SELECT value FROM json_each(?)) ORDER BY c.requested_at,c.rowid`).all(JSON.stringify(placementIds));
  return new Map(rows.map(row => [String(row.placement_id), view(row, String(row.task_id))]));
}
