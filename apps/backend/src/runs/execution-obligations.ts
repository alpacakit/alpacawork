/** One lifetime for import, FORMAT protection and release retention. Historical launch bodies are not readers' input. */
import { closeSync, constants, lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { SQLOutputValue } from 'node:sqlite';
import { z } from 'zod';
import { hasCode, strictJson, trySharedLock } from '@alpacawork/core';
import { UNSETTLED_INPUTS_SQL, UNFINISHED_SQL, type RunStore } from '@alpacawork/runs';
import { RUN_FILES, runFolder, runNumber } from '@alpacawork/contract/run';
import { identitySchema } from '@alpacawork/contract/run-protocol';
import { executionFolder, messageName, names } from './execution-files.js';
import { openRunFile } from './files.js';

type Attempt = Record<string, SQLOutputValue>;
type Store = Pick<RunStore, 'root' | 'connection'>;

/** Only the small terminal/incomplete set needs filesystem evidence. Absence never means an I/O fault. */
function hasUnsettledEvidence(root: string, attempt: Attempt): boolean {
  const id = `R${attempt.run_no}`, folder = runFolder(root, id);
  let lock = -1;
  try {
    // Do not create a missing lock or write any execution evidence during inspection.
    lock = openRunFile(folder, RUN_FILES.managerLock, constants.O_RDONLY);
    if (!trySharedLock(lock)) return true;
    const spool = executionFolder(root, id, String(attempt.attempt_id));
    if (names(join(spool, 'events')).some(name => name >= messageName(Number(attempt.next_seq)))) return true;
    // Without a completion, any result blob or exchange text is still evidence, not proof of a saved reply.
    if (names(join(spool, 'results')).length) return true;
    for (const name of [RUN_FILES.promptTemp, RUN_FILES.resultTemp]) {
      try { lstatSync(join(folder, name)); return true; }
      catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
    }
    return false;
  } catch {
    // Missing lock, unsafe path, permission and resource faults cannot certify a quiet, writer-free history.
    return true;
  } finally { if (lock >= 0) closeSync(lock); }
}

// Keep this predicate identical to the baseline run_attempts_open partial index.
const OPEN = 'a.completed_digest IS NULL OR a.diagnostic IS NOT NULL OR a.acked_seq<a.next_seq-1';
const pending = `EXISTS(SELECT 1 FROM run_inputs i WHERE i.attempt_id=a.attempt_id AND i.state IN (${UNSETTLED_INPUTS_SQL}))`;
const columns = `a.run_no,a.attempt_id,a.next_seq,a.acked_seq,a.completed_digest,a.diagnostic,
  (r.state IN (${UNFINISHED_SQL})) AS unfinished, ${pending} AS pending`;
const admitted = "json_extract(a.diagnostic,'$.kind') IS NOT 'launch_aborted'";

/** Every-second demand/import uses only the open index, never a scan of input or attempt history. */
export function executionImportCandidates(store: Store, runIds?: readonly string[]): Attempt[] {
  if (runIds?.length === 0) return [];
  const attempts = store.connection.prepare(`SELECT ${columns}
    FROM run_attempts a JOIN runs r ON r.id=a.run_no
    WHERE (${OPEN}) AND ${admitted}
      ${runIds ? 'AND a.run_no IN (SELECT value FROM json_each(?))' : ''} ORDER BY a.run_no`)
    .all(...(runIds ? [JSON.stringify(runIds.map(runNumber))] : []));
  return attempts.filter(a => a.unfinished && a.completed_digest === null || a.diagnostic !== null || a.pending ||
    Number(a.acked_seq) < Number(a.next_seq) - 1 || hasUnsettledEvidence(store.root, a));
}

/** FORMAT/retention also protect settled exchanges whose input decision still needs human resolution.
 * Completion releases reserved inputs; manager/recovery publish uncertain for attempted inputs before completion.
 * Check ALL unsettled states here, including inconsistent stored combinations, rather than trust that history.
 * This input-index scan belongs to explicit inspection, not hasPublishedTail/pass's every-second path.
 */
export function executionObligations(store: Store): Attempt[] {
  const imports = executionImportCandidates(store);
  const inputOnly = store.connection.prepare(`SELECT ${columns}
    FROM (SELECT DISTINCT attempt_id FROM run_inputs WHERE state IN (${UNSETTLED_INPUTS_SQL})) i
    JOIN run_attempts a ON a.attempt_id=i.attempt_id JOIN runs r ON r.id=a.run_no
    WHERE NOT (${OPEN}) AND ${admitted} ORDER BY a.run_no`).all();
  return [...imports, ...inputOnly];
}

/** A reference is a separate contract from a runnable launch. Validate its selected fields, never repair a body. */
const referenceSchema = identitySchema.extend({ format: z.string().regex(/^[a-f0-9]{64}$/), release: z.string().startsWith('/').nullable() }).strict();
export function executionReference(store: Store, attempt: Attempt) {
  const row = store.connection.prepare('SELECT launch_json FROM run_attempts WHERE attempt_id=?').get(String(attempt.attempt_id));
  const raw = strictJson(Buffer.from(String(row?.launch_json))) as Record<string, unknown> | null;
  const reference = referenceSchema.parse(raw && {protocol:raw.protocol,workspaceId:raw.workspaceId,runId:raw.runId,
    attemptId:raw.attemptId,format:raw.format,release:raw.release});
  if (reference.runId !== `R${attempt.run_no}` || reference.attemptId !== attempt.attempt_id ||
    reference.workspaceId !== store.connection.prepare('SELECT id FROM workspace_identity WHERE singleton=1').get()?.id)
    throw new Error('Execution reference identity mismatch');
  return reference;
}
