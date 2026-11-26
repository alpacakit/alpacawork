import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { coordinatorResetReasonSchema, type CoordinatorReset, type CoordinatorResetReason } from '@alpacawork/contract/coordinator';
import { runNumber, type CoordinatorRunRecord } from '@alpacawork/contract/run';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { touch } from '@alpacawork/db';

function resetView(row: Record<string, unknown>): CoordinatorReset {
  return { id: String(row.id), beforeRequestId: row.before_request_id as string | null, at: String(row.requested_at),
    reason: coordinatorResetReasonSchema.parse(JSON.parse(String(row.reason))) };
}

export function pendingCoordinatorReset(db: DatabaseSync, conversation: string): CoordinatorReset | null {
  const row = db.prepare('SELECT * FROM coordinator_resets WHERE conversation_id=? AND start_run_no IS NULL').get(conversation);
  return row ? resetView(row) : null;
}

/** Each start belongs to the interval beginning at the last reset's first input. */
export function coordinatorBoundary(db: DatabaseSync, conversation: string): number {
  const row = db.prepare(`SELECT q.coordinator_turn_no FROM coordinator_resets r JOIN requests q ON q.id=r.before_request_id
    WHERE r.conversation_id=? AND r.start_run_no IS NOT NULL ORDER BY r.start_run_no DESC LIMIT 1`).get(conversation);
  return Number(row?.coordinator_turn_no ?? 0);
}

export function coordinatorResetsFor(db: DatabaseSync, conversation: string, ids: readonly string[]): CoordinatorReset[] {
  return db.prepare(`SELECT r.* FROM json_each(?) turn JOIN coordinator_resets r ON r.before_request_id=turn.value
    WHERE r.conversation_id=? ORDER BY turn.key`).all(JSON.stringify(ids), conversation).map(resetView);
}

export function coordinatorResetMemo(db: DatabaseSync, conversation: string, reset: string) {
  const row = db.prepare('SELECT memo_text,memo_updated_at FROM coordinator_resets WHERE id=? AND conversation_id=?').get(reset, conversation);
  if (!row) throw new Problem(PROBLEM_CODE.notFound, 'Reset is not in this conversation');
  return row.memo_text === null ? null : { text: String(row.memo_text), updatedAt: String(row.memo_updated_at) };
}

/** A new request joins the existing reservation. Record each operation ID so its replay stays attached to that reset. */
export function reserveCoordinatorReset(db: DatabaseSync, conversation: string, reason: CoordinatorResetReason, at: string,
  operation?: string): CoordinatorReset {
  const saved = operation ? replayCoordinatorReset(db, conversation, operation) : null;
  if (saved) return saved;
  let reset = pendingCoordinatorReset(db, conversation);
  if (!reset) {
    const id = operation ?? randomUUID();
    db.prepare(`INSERT INTO coordinator_resets(id,conversation_id,reason,requested_at,memo_text,memo_updated_at)
      SELECT ?,id,?,?,memo_text,memo_updated_at FROM coordinator_conversations WHERE id=?`).run(id, JSON.stringify(reason), at, conversation);
    touch(db, { kind: 'conversation', id: conversation });
    reset = { id, beforeRequestId: null, at, reason };
  }
  if (operation) db.prepare('INSERT INTO coordinator_reset_ops(id,reset_id) VALUES (?,?)').run(operation, reset.id);
  return reset;
}

export function replayCoordinatorReset(db: DatabaseSync, conversation: string, operation: string): CoordinatorReset | null {
  const row = db.prepare(`SELECT r.* FROM coordinator_reset_ops o JOIN coordinator_resets r ON r.id=o.reset_id WHERE o.id=?`).get(operation);
  if (!row) return null;
  if (row.conversation_id !== conversation) throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Reset operation belongs to another conversation');
  return resetView(row);
}

export function startCoordinatorReset(db: DatabaseSync, reset: CoordinatorReset, run: CoordinatorRunRecord): void {
  const written = db.prepare(`UPDATE coordinator_resets SET before_request_id=?,start_run_no=?
    WHERE id=? AND conversation_id=? AND start_run_no IS NULL`).run(run.requestId, runNumber(run.id), reset.id, run.conversationId);
  if (written.changes !== 1) throw new Error('Coordinator reset reservation changed before launch');
  touch(db, { kind: 'conversation', id: run.conversationId });
}
