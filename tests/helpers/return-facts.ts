/** Synthetic facts for scale/corruption fixtures; behavioural tests enter through ReturnRouter. */
import type { DatabaseSync } from 'node:sqlite';
import type { StoredReturn } from '@alpacawork/runs';
export function insertReturnFact(db: DatabaseSync, row: Pick<StoredReturn,
  'id' | 'requestId' | 'boundaryRunId' | 'outcome' | 'toTaskId' | 'causeLogId' | 'createdAt'> & { holdReason?: string | null }) {
  db.prepare(`INSERT INTO returns(id,request_id,boundary_run_id,outcome,to_task_id,cause_log_id,hold_reason,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(row.id,row.requestId,row.boundaryRunId,row.outcome,row.toTaskId,row.causeLogId,
      row.holdReason ?? null,row.createdAt);
}
