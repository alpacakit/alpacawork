/** Pure stored Run decoding. */
import { Problem, PROBLEM_CODE, faultReason, storedJsonDecoder } from '@alpacawork/core';
import type { RuntimeRunRecord } from '@alpacawork/contract/run';

type Row = Record<string, unknown>;
type Schema<T extends RuntimeRunRecord> = { parse(value: unknown): T };

export function runsUnavailable(cause: unknown): Problem {
  return new Problem(PROBLEM_CODE.runsUnavailable, `Cannot read or write runs: ${cause instanceof Error ? cause.message : String(cause)}`, undefined,
    { reason: { kind: 'run_store_unavailable', cause: faultReason(cause) }, cause });
}

/** Classify only store-owned operations, never the caller's transaction callback. */
export function storageOperation<T>(operation: () => T): T {
  try { return operation(); }
  catch (cause) {
    if (cause instanceof Problem) throw cause;
    if (typeof cause === 'object' && cause !== null && 'errcode' in cause && Number(cause.errcode) % 256 === 5)
      throw new Problem(PROBLEM_CODE.busy, 'Run database is busy', undefined, { reason: { kind: 'run_database_busy' }, cause });
    throw runsUnavailable(cause);
  }
}

/** Both fresh decoding and reuse bind their result to the current row in this one boundary. */
function boundRecord<T extends { readonly id: string }>(row: Row, decode: () => T): T {
  try {
    const record = decode();
    if (record.id !== `R${row.id}`) throw new Error('Record ID differs from row number');
    return record;
  } catch (cause) {
    throw runsUnavailable(new Error(`Invalid stored run record R${row.id}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }));
  }
}

const decoders = new WeakMap<object, (key: unknown, text: string) => unknown>();
export const parseRecord = <T extends RuntimeRunRecord>(schema: Schema<T>, row: Row): T => {
  let decode = decoders.get(schema);
  if (!decode) decoders.set(schema, decode = storedJsonDecoder(schema));
  return boundRecord(row, () => decode(row.id, String(row.record)) as T);
};


