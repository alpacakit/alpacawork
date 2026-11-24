import type { DatabaseSync } from 'node:sqlite';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';

/** The original lender's seat and both direct children must still form the same relationship. */
export function loanFor(db: DatabaseSync, borrower: string, target: string): string | undefined {
  const row = db.prepare(`SELECT q.id FROM requests q JOIN wait_cycles c ON c.id=q.wait_cycle_id
    JOIN tasks lender ON lender.external_id=c.task_id
    JOIN tasks a ON a.external_id=q.task_id JOIN tasks b ON b.external_id=q.lent_task_id
    WHERE q.task_id=? AND q.lent_task_id=? AND q.loan_ended_at IS NULL
      AND q.delivery_state NOT IN ('aborted','recorded_unconfirmed')
      AND NOT EXISTS (SELECT 1 FROM returns r WHERE r.request_id=q.id)
      AND a.parent_id=lender.id AND b.parent_id=lender.id
      AND a.lifecycle='active' AND b.lifecycle='active' AND lender.lifecycle='active'
    ORDER BY q.submitted_at DESC,q.rowid DESC LIMIT 1`).get(borrower, target);
  return row ? String(row.id) : undefined;
}

export function assertLendableSibling(db: DatabaseSync, lender: string, borrower: string, target: string): void {
  const siblings = borrower !== target && db.prepare(`SELECT 1 FROM tasks p
    JOIN tasks a ON a.parent_id=p.id JOIN tasks b ON b.parent_id=p.id
    WHERE p.external_id=? AND a.external_id=? AND b.external_id=?
      AND a.kind='task' AND b.kind='task' AND b.lifecycle='active'`).get(lender, borrower, target);
  if (!siblings) throw new Problem(PROBLEM_CODE.invalidInput, 'Lend a different active direct child of the same responsible', undefined,
    { reason: { kind: 'loan_requires_sibling' } });
}

export function userRequestedLoanTarget(task: string): never {
  throw new Problem(PROBLEM_CODE.forbidden, `Cannot lend or borrow ${task}: the user requested it`, { task },
    { reason: { kind: 'loan_target_requested_by_user', task } });
}
