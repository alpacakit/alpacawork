/** Ownership and running counts come from the same records. */
import type { RecordsReader, TaskId } from './projection-contract.js';
/** Structurally the AggregateFacts input of screen-aggregate; no aggregate implementation is required here. */
export interface WorkspaceAggregateFacts { readonly scopes: readonly string[]; readonly listed: boolean; readonly menuRunning: boolean }
export function aggregateFactsOf(records: RecordsReader, task: TaskId): WorkspaceAggregateFacts {
  return { scopes: records.scopes(task), listed: records.shelf().listed.has(records.projectOf(task)),
    menuRunning: records.bundle(task)?.runs.some(run => run.state === 'running') ?? false };
}
