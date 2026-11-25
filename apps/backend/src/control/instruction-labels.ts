/**
 * What each instruction of a Task is, as its sender said it (request_labeled log entries, never rewritten), with who
 * said it as the History says who acted (`human`, `main` for the coordinator, `placement` for a Task's agent).
 */
import type { InstructionLabel, TaskLog } from '@alpacawork/raw';

export type InstructionKindView = InstructionLabel & { by: TaskLog['actor']['kind']; at: string };

export function instructionKinds(log: readonly TaskLog[]): InstructionKindView[] {
  return log.flatMap(entry => entry.kind === 'request_labeled' && entry.label
    ? [{ ...entry.label, by: entry.actor.kind, at: entry.at }] : []);
}
