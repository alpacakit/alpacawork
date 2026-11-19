import { join } from 'node:path';
/** Only serve removes committed exchange files. */
import { closeSync, constants, fsyncSync, openSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { hasCode, tryLock, faultReason, PROBLEM_CODE, type ProblemReason } from '@alpacawork/core';
import { UNSETTLED_INPUTS_SQL, type RunStore } from '@alpacawork/runs';
import { RUN_FILES, isRunEnded, runNumber, type RuntimeRunRecord } from '@alpacawork/contract/run';
import type { RunId } from '@alpacawork/contract/fields';
import { openRunFile, readRunFile, RunFileRejected, PROMPT_LIMIT, RESULT_LIMIT } from './files.js';

/** Rebuildable review facts; never write these into an execution attempt's diagnostic. */
type RunCleanupIssue = {
  code: string; message: string; path: string; reason: ProblemReason; runId: RunId;
  /** Available only after a bounded, successful file read. */
  sha256?: string; bytes?: number;
};
type RunCleanupResult = { state: 'normal' | 'skipped' | 'review'; issues: RunCleanupIssue[] };
const normal = (): RunCleanupResult => ({ state: 'normal', issues: [] });
const skipped = (): RunCleanupResult => ({ state: 'skipped', issues: [] });
const runPath = (id: RunId, name?: string) => `.alpacawork/runs/${id}${name ? `/${name}` : ''}`;
function issue(id: RunId, path: string, cause: unknown, bytes?: Buffer): RunCleanupIssue {
  const diagnostic = cause instanceof Error ? cause.message : String(cause);
  const message = `Temporary Run text requires review; files retained at ${path}: ${diagnostic}`;
  return { code: PROBLEM_CODE.readFailed, message, path, reason: faultReason(new Error(message)), runId: id,
    ...(bytes ? { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length } : {}),
    ...(cause instanceof RunFileRejected && cause.bytes !== null ? { bytes: cause.bytes } : {}) };
}
const review = (id: RunId, path: string, cause: unknown): RunCleanupResult =>
  ({ state: 'review', issues: [issue(id, path, cause)] });

/** After a manager crash, remove only exchange files proven identical to committed Run text.
 * Uncommitted output stays with its needs_review Run. A conflicting terminal file is
 * isolated to this Run, and every exchange file remains available as evidence.
 * An input still waiting on its receipt keeps them; a resolved one does not.
 */
export function reconcileCompletedRunFiles(store: RunStore, run: Pick<RuntimeRunRecord, 'id' | 'state'>): RunCleanupResult {
  if (!isRunEnded(run.state)) return skipped();
  let path = runPath(run.id);
  try {
    if (store.connection.prepare(`SELECT 1 FROM run_inputs i JOIN run_attempts a USING(attempt_id) WHERE a.run_no=? AND i.state IN (${UNSETTLED_INPUTS_SQL}) LIMIT 1`).get(runNumber(run.id))) return skipped();
    const folder = store.folder(run.id);
    const dir = (() => {
      try { return openSync(folder, constants.O_RDONLY | constants.O_DIRECTORY); }
      catch (error) { if (hasCode(error, 'ENOENT')) return -1; throw error; }
    })();
    if (dir < 0) return normal();
    let lock = -1;
    try {
      // Probe without following links. Any unsafe file is reported, never removed.
      const present = [RUN_FILES.promptTemp, RUN_FILES.resultTemp].some(name => {
        path = runPath(run.id, name);
        try { const fd = openSync(join(folder, name), constants.O_RDONLY); closeSync(fd); return true; }
        catch (error) { if (hasCode(error, 'ENOENT')) return false; throw error; }
      });
      if (!present) return normal();
      path = runPath(run.id, RUN_FILES.managerLock);
      lock = openRunFile(folder, RUN_FILES.managerLock, constants.O_RDWR | constants.O_CREAT);
      if (!tryLock(lock)) return skipped(); // A live manager still owns its completion cleanup.
      return removeCommittedRunFiles(store, run.id);
    } finally { try { if (lock >= 0) closeSync(lock); } finally { closeSync(dir); } }
  } catch (cause) { return review(run.id, path, cause); }
}

/** Caller holds manager.lock. Verify all files before deleting any, without changing DB facts. */
function removeCommittedRunFiles(store: RunStore, id: RunId): RunCleanupResult {
  let path = runPath(id);
  try {
    const stored = store.getText(id);
    if (!stored || !isRunEnded(stored.record.state)) return skipped();
    const folder = store.folder(id), dir = openSync(folder, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      const removable: string[] = [], issues: RunCleanupIssue[] = [];
      for (const name of [RUN_FILES.promptTemp, RUN_FILES.resultTemp]) {
        path = runPath(id, name);
        const text = name === RUN_FILES.promptTemp ? stored.prompt : stored.result;
        const limit = name === RUN_FILES.promptTemp ? PROMPT_LIMIT : RESULT_LIMIT;
        let bytes: Buffer | undefined;
        try {
          bytes = readRunFile(folder, name, limit);
          // Do not silently treat replacement-character decoding as usable UTF-8 evidence.
          new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          if (text == null || !bytes.equals(Buffer.from(text)))
            throw new Error('File differs from the control database');
          removable.push(name);
        } catch (error) {
          if (hasCode(error, 'ENOENT')) continue;
          issues.push(issue(id, path, error, bytes));
        }
      }
      if (issues.length) return { state: 'review', issues };
      for (const name of removable) { path = runPath(id, name); unlinkSync(join(folder, name)); }
      if (removable.length) fsyncSync(dir);
      return normal();
    } finally { closeSync(dir); }
  } catch (cause) { return review(id, path, cause); }
}
