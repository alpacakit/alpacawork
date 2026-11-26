import type { DatabaseSync } from 'node:sqlite';
import { runNumber } from '@alpacawork/contract/run';
import { touch } from '@alpacawork/db';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { authorize, type Caller } from '../control/authorize.js';
import { deliveredMessages } from './messages.js';

function memoForCaller(db: DatabaseSync, caller: Caller) {
  if (caller.kind !== 'coordinator' || caller.source !== 'screen') throw new Error('Expected a screen coordinator');
  const row = db.prepare(`SELECT c.id,c.memo_text,c.memo_updated_at,c.memo_through_turn_no FROM coordinator_conversations c
    JOIN runs r ON r.conversation_id=c.id
    WHERE c.id=? AND c.cleared_at IS NULL AND r.id=? AND r.state='running'`)
    .get(caller.conversation, runNumber(caller.runId));
  if (!row) throw new Problem(PROBLEM_CODE.forbidden, 'Coordinator Run is not running in the open conversation', undefined,
    { reason: { kind: 'coordinator_run_not_running' } });
  return { caller, through: row.memo_through_turn_no as number | null, memo: row.memo_text === null ? null : { text: String(row.memo_text), updatedAt: String(row.memo_updated_at) } };
}

export function readCoordinatorMemo(db: DatabaseSync, caller: Caller) {
  authorize(db, caller, { name: 'coordinator.memo' }, { task: null, quote: null });
  return memoForCaller(db, caller).memo;
}

/** The command router has authorized the write; both paths scope the memo to the running screen session. */
export function setCoordinatorMemo(db: DatabaseSync, caller: Caller, text: string, now = new Date().toISOString()) {
  const { caller: screen, memo, through: previous } = memoForCaller(db, caller);
  if (memo?.text === text) return memo;
  const delivered = deliveredMessages(db, screen.runId);
  const through = db.prepare('SELECT max(coordinator_turn_no) AS turn FROM requests WHERE id IN (SELECT value FROM json_each(?))')
    .get(JSON.stringify(delivered))?.turn ?? null;
  db.prepare('UPDATE coordinator_conversations SET memo_text=?,memo_updated_at=?,memo_through_turn_no=? WHERE id=?')
    .run(text, now, Math.max(Number(previous ?? 0), Number(through ?? 0)) || null, screen.conversation);
  touch(db, { kind: 'conversation', id: screen.conversation });
  return { text, updatedAt: now };
}
