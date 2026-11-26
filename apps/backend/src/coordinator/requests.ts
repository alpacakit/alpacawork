import type { DatabaseSync } from 'node:sqlite';
import { coordinatorRunRecordSchema, type CoordinatorRunRecord } from '@alpacawork/contract/run';

/** SQL predicate for visible requests, using the request alias q. */
export const visible = "q.coordinator_turn_no IS NOT NULL AND q.delivery_state <> 'aborted'";

export function activeCoordinatorRuns(db: DatabaseSync, conversation: string): CoordinatorRunRecord[] {
  return db.prepare(`SELECT r.record FROM runs r INDEXED BY coordinator_active_runs JOIN requests q ON q.id=r.request_id
    WHERE r.conversation_id=? AND r.conversation_id IS NOT NULL AND r.state IN ('queued','running','needs_review')
    AND ${visible} ORDER BY r.id`)
    .all(conversation).map(row => coordinatorRunRecordSchema.parse(JSON.parse(String(row.record))));
}
