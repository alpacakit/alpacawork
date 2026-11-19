import type { TaskDetail } from '@/data/types';
import { pendingReportMark } from './pending-report';
import type { LookTask } from '@/components/ui/tone';
import { logKey } from './history';
import type { ReportEvent } from './report-events';

/** The server chooses the Task's own human questions. History and that projection share the original log identity. */
export function questionReports(reports: ReportEvent[], task: Pick<TaskDetail, 'userQuestions' | 'id'> & LookTask): ReportEvent[] {
  const byKey = new Map<string, ReportEvent>();
  for (const report of reports) byKey.set(report.key, report);
  for (const question of task.userQuestions ?? []) {
    const key = logKey(question.taskId, question.id);
    byKey.set(key, { ...byKey.get(key), key, at: question.askedAt, kind: 'question', text: question.title,
      description: question.summary || null, mark: pendingReportMark(task, question, { kind: 'wait', tone: 'quiet' }), pinned: true, question: question.id, userQuestion: true, id: question.id, taskId: question.taskId, askedTo: "user" });
  }
  return [...byKey.values()];
}
