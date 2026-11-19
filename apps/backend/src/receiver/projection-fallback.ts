/** A failed first derivation still supplies the tree edge its healthy descendants need. No seat facts are guessed. */
import type { AggregateContribution, RecordsReader } from './projection-contract.js';
import type { AggregateFacts } from './screen-aggregate.js';

export function structuralFallback(records: RecordsReader, id: string):
  { contribution: AggregateContribution; facts: AggregateFacts } | undefined {
  const bundle = records.bundle(id);
  if (!bundle) return undefined;
  const { parentId, kind, lifecycle, state, baseState, hold } = bundle.task.meta;
  return {
    contribution: { id, parentId, projectId: records.projectOf(id), kind, lifecycle, state, baseState, hold,
      ball: null, running: false, working: false, homeWorking: false,
      usage: { runs: 0, runMs: 0, tokens: null, tokensUnknown: 0 }, openRuns: [], movedAt: 0 },
    // Never listed: the index sends no row of a Task it could not read, so no shown row may follow this one.
    facts: { scopes: records.scopes(id), listed: false, freshFinished: false, menuRunning: false },
  };
}
