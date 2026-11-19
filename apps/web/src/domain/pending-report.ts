import type { TaskDetail } from '@/data/types';
import { taskLook, type LookTask } from '@/components/ui/tone';
import { turnRecord, type ReportEvent } from './report-events';

type WaitingTask = Pick<TaskDetail, 'id'> & LookTask;
type RecordId = Pick<ReportEvent, 'taskId' | 'id'>;
/** Only the Task's own current wait; another open question or a child's record has its historical meaning. */
export const isCurrentWait = (task: WaitingTask, record: RecordId) => record.taskId === task.id && turnRecord(task) === record.id;
/** The same state colour as the list and corner; event shape stays with the record. */
export function pendingReportMark(task: WaitingTask, record: RecordId, mark: NonNullable<ReportEvent['mark']>): NonNullable<ReportEvent['mark']> {
  return isCurrentWait(task, record) ? { ...mark, tone: taskLook(task).tone } : mark;
}
