/** Read-only pages of the returns to a seat and what the lifecycle makes of each. */
import type { DatabaseSync } from 'node:sqlite';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { RunStore, type StoredReturn } from '@alpacawork/runs';
import { activeDelivery, unknownReceipts, returnDisposition } from './return-lifecycle.js';

/** An urgent notice says why from its cause log; a closing return or another notice says none. */
function urgentReasons(db: DatabaseSync, rows: readonly StoredReturn[]): ReadonlyMap<string, string> {
  const ids = rows.filter(row => row.outcome === 'urgent' && row.causeLogId !== null).map(row => row.causeLogId);
  if (!ids.length) return new Map();
  return new Map(db.prepare(`SELECT id,json_extract(entry,'$.urgentReason') AS reason FROM task_log
    WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids))
    .flatMap(row => typeof row.reason === 'string' ? [[String(row.id), row.reason]] : []));
}

/**
 * Each return to the seat with its disposition (pending, carried, in_flight, disposed), an urgent notice's reason, and
 * whether the delivery out for it has an unknown receipt. `project` is the project Task whose returns the caller may
 * read; none is the whole workspace's.
 */
export async function readTaskReturns(root: string, input: { task: string; after?: string; limit?: number }, project?: string) {
  const store = RunStore.openReadable(root, { busyTimeoutMs: 1000 });
  try {
    if (!store && input.after !== undefined) throw new Problem(PROBLEM_CODE.invalidInput, 'Unknown return cursor', undefined,
      { reason: { kind: 'unknown_return_cursor' } });
    const page = store?.readReturnPage({ ...input, limit: Math.min(input.limit ?? 80, 200) }, project)
      ?? { returns: [], nextAfter: null };
    const db = store?.connection;
    const reasons = db ? urgentReasons(db, page.returns) : new Map<string, string>();
    const unknown = db ? unknownReceipts(db, page.returns.flatMap(row => {
      const delivery = activeDelivery(row); return delivery ? [delivery] : [];
    })) : new Set<string>();
    return { returns: db ? page.returns.map(row => {
      const delivery = activeDelivery(row);
      return { ...row, disposition: returnDisposition(row), urgentReason: row.outcome === 'urgent' ? reasons.get(row.causeLogId ?? '') ?? null : null,
        receiptUnknown: !!delivery && unknown.has(delivery.wakeRequestId) };
    }) : [], nextAfter: page.nextAfter };
  } finally { store?.close(); }
}
