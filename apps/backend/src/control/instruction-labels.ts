/**
 * What each instruction of a Task is, as its labels say: the latest label a person gave, else the latest any AI gave
 * (a coordinator that quotes the person's words still judged the kind itself). The labels themselves are request_labeled log entries, never rewritten; a
 * relabel is a later entry.
 */
import type { InstructionLabel, TaskActor, TaskLog } from '@alpacawork/raw';

/** Who said what an instruction is: the person, or an AI. */
export const labeledBy = (actor: TaskActor): 'human' | 'ai' => actor.kind === 'human' ? 'human' : 'ai';

export type InstructionLabelView = InstructionLabel & { by: 'human' | 'ai'; at: string; labelId: string; labels: number };

export function instructionLabels(log: readonly TaskLog[]): InstructionLabelView[] {
  const chosen = new Map<string, InstructionLabelView>();
  for (const entry of log) {
    if (entry.kind !== 'request_labeled' || !entry.label) continue;
    const by = labeledBy(entry.actor), held = chosen.get(entry.label.request);
    const labels = (held?.labels ?? 0) + 1;
    if (held && held.by === 'human' && by === 'ai') { held.labels = labels; continue; }
    chosen.set(entry.label.request, { ...entry.label, by, at: entry.at, labelId: entry.id, labels });
  }
  return [...chosen.values()];
}
