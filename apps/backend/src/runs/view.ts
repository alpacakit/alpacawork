/** Run records and bounded run files read the same Run authority. */
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { RunStore } from '@alpacawork/runs';
import type { RuntimeRunRecord } from '@alpacawork/contract/run';
import type { RunId } from '@alpacawork/contract/fields';
import { controlRunFilesSchema, type ControlRunFilesDTO } from '@alpacawork/contract/control';
import { PROMPT_LIMIT, RESULT_LIMIT } from './files.js';
import { readRunFailure } from './error-cause.js';

/** The Runs not yet ended, coordinators' included; what the periodic checks (host samples, settle) look for. */
export function readUnfinishedRunRecords(root: string): RuntimeRunRecord[] {
  const store = RunStore.openReadable(root, { busyTimeoutMs: 0 });
  if (!store) return [];
  try { return store.readUnfinished(); }
  finally { store.close(); }
}
function textStatus(stored: NonNullable<ReturnType<RunStore['getFileText']>>, fileKind: 'prompt' | 'result') {
  const source = 'alpacawork.sqlite' as const;
  const limit = fileKind === 'prompt' ? PROMPT_LIMIT : RESULT_LIMIT;
  const text = stored.text;
  const bytes = text === null ? null : Buffer.byteLength(text, 'utf8');
  const state = stored.state;
  return { kind: fileKind, state: bytes !== null && bytes > limit ? 'too_large' : state,
    source, bytes, text: bytes !== null && bytes <= limit && state === 'present' ? text : null };
}
/**
 * One Task Run's bounded prompt/result body (a coordinator's Run is not found). Each failure state remains distinct.
 * A failed Run's result also carries the agent's own error words, the only reason its requester has when no reply was written.
 */
export function readRunFiles(root: string, run: RunId, kind: 'prompt' | 'result'): ControlRunFilesDTO {
  const store = RunStore.openReadable(root, { busyTimeoutMs: 0 });
  let stored: ReturnType<RunStore['getFileText']> | undefined;
  try { stored = store?.getFileText(run, kind); }
  finally { store?.close(); }
  if (!stored || stored.record.role === 'coordinator') throw new Problem(PROBLEM_CODE.notFound, 'Run does not exist', undefined, { reason: { kind: 'run_does_not_exist' } });
  const failure = kind === 'result' ? readRunFailure(root, stored.record) : undefined;
  return controlRunFilesSchema.parse({ run, taskId: stored.record.task, files: [textStatus(stored, kind)], ...failure ? { failure } : {} });
}
