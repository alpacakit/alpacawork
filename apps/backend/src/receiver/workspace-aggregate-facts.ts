/** The notice layer supplies its row and personal baselines; ownership and running counts come from the same records. */
import type { TaskRowDTO } from '@alpacawork/contract/control';
import type { RecordsReader, TaskId } from './projection-contract.js';
export interface NoticeBaselines {
  readonly checkpoint: { readonly tasks: Readonly<Record<string, { log: number; state: string; body: string; turnKey?: string | null }>> };
  readonly reads: Readonly<Record<string, { log: number; state: string; body: string; turnKey?: string | null }>>;
}
/** Structurally the AggregateFacts input of screen-aggregate; no aggregate implementation is required here. */
export interface WorkspaceAggregateFacts { readonly scopes: readonly string[]; readonly listed: boolean; readonly freshFinished: boolean; readonly menuRunning: boolean }
export function aggregateFactsOf(records: RecordsReader, task: TaskId,
  row: Pick<TaskRowDTO, 'state' | 'notice'>, notices: NoticeBaselines | null): WorkspaceAggregateFacts {
  const baseline = notices && (notices.reads[task] ?? notices.checkpoint.tasks[task]);
  const freshFinished = !!notices && (!baseline || baseline.state !== row.state || baseline.body !== row.notice.bodyHash
    || row.notice.turnKey !== null && baseline.turnKey !== row.notice.turnKey
    || !!row.notice.lastNoticed && row.notice.lastNoticed.position >= baseline.log);
  return { scopes: records.scopes(task), listed: records.shelf().listed.has(records.projectOf(task)), freshFinished,
    menuRunning: records.bundle(task)?.runs.some(run => run.state === 'running') ?? false };
}
