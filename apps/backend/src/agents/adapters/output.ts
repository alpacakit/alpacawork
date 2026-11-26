import { hasCode } from '@alpacawork/core';
import { RUN_FILES } from '@alpacawork/contract/run';
import { JsonlReader } from '../../runs/readers/jsonl.js';
import { readRunFile, RESULT_LIMIT, RunFileRejected } from '../../runs/files.js';

export const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export type Rejection = 'missing' | 'too_large' | 'unreadable';
export const rejectedFile = (error: unknown): Rejection => error instanceof RunFileRejected ? error.reason
  : hasCode(error, 'ENOENT') ? 'missing' : 'unreadable';
/** Consume all complete lines and the final unterminated line, retaining only the adapter's bounded summary. */
export function scanOutput(folder: string, observe: (value: unknown, line: number) => boolean | void, skipLine?: (line: Buffer) => boolean): {
  rejection: Rejection | null; outcomeRejection: Rejection | null;
} {
  let outcomeRejection: Rejection | null = null, oversized = false;
  const lines = new JsonlReader(() => {
    oversized ||= lines.rejection === 'too_large';
    outcomeRejection = oversized ? 'too_large' : lines.rejection;
  }, undefined, skipLine);
  const accept = (value: unknown, line: number) => {
    // A verified completion supersedes earlier malformed lines for the outcome only.
    // Oversized lines and any damage to the evidence used for diagnostics remain rejected.
    if (observe(value, line) && !oversized) outcomeRejection = null;
  };
  try { lines.read(folder, accept); lines.finish(accept); return { rejection: lines.rejection, outcomeRejection }; }
  catch (error) { const rejection = rejectedFile(error); return { rejection, outcomeRejection: rejection }; }
}
export function resultFile(folder: string): { result: string; rejection: null } | { result: null; rejection: Rejection } {
  try {
    return { result: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(readRunFile(folder, RUN_FILES.resultTemp, RESULT_LIMIT)), rejection: null };
  } catch (error) { return { result: null, rejection: rejectedFile(error) }; }
}
