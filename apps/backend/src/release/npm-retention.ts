/** Only unfinished operations retain their deterministic target, even before its first rename. */
import { readUpdateRecord, completedUpdate, updateTarget } from './update-record.js';
export function pendingUpdateReferences(releases: string): string[] {
  const op = readUpdateRecord(releases).operation;
  return op && !completedUpdate(releases, op) ? [updateTarget(releases, op), ...(op.candidate.expectedActive ? [op.candidate.expectedActive] : [])] : [];
}
