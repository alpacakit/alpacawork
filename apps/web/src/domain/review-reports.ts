import type { TaskDetail } from '@/data/types';
import { pendingReportMark } from './pending-report';
import type { LookTask } from '@/components/ui/tone';
import { logKey } from './history';
import { reportMark, type ReportEvent } from './report-events';

/** The server chooses the Task's own human reviews. History and this view retain one original submission identity. */
export function reviewReports(reports: ReportEvent[], task: Pick<TaskDetail, 'userReviews' | 'id'> & LookTask): ReportEvent[] {
  const byKey = new Map<string, ReportEvent>();
  for (const report of reports) byKey.set(report.key, report);
  for (const review of task.userReviews ?? []) {
    const key = logKey(review.taskId, review.id);
    const existing = byKey.get(key);
    const mark = reportMark({ kind: 'review', state: 'waiting', title: review.title });
    byKey.set(key, { ...existing, key, id: review.id, taskId: review.taskId, at: review.submittedAt, kind: existing?.kind ?? 'review', text: review.title,
      description: review.summary, mark: mark && pendingReportMark(task, review, existing?.mark ?? mark), pinned: true });
  }
  return [...byKey.values()];
}
