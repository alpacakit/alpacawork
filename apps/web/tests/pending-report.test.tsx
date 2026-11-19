import { expect, test } from 'vitest';
import { pendingReportMark, isCurrentWait } from '../src/domain/pending-report';
import { turnRecord } from '../src/domain/report-events';
import { userBall } from './fixtures';
const record = { taskId: 'T1', id: 'current' };
for (const reason of ['question', 'review'] as const) for (const [state, tone] of [['doing', 'turn'], ['waiting', 'turn'], ['held', 'quiet']] as const)
  test(`${reason} follows the ${state} colour from the Task ball without a stateLog`, () => {
    const ball = userBall(reason, 'current', '2026-10-28T02:00:00Z', reason === 'question' ? { questionId: 'current' } : {});
    const task = { id: 'T1', state, ball, rowFacts: null };
    expect(turnRecord(task)).toBe('current');
    expect(isCurrentWait(task, record)).toBe(true);
    expect(pendingReportMark(task, record, { kind: 'report', tone: 'quiet' })).toEqual({ kind: 'report', tone });
    for (const other of [{ ...record, id: 'old' }, { ...record, taskId: 'T2' }]) {
      expect(isCurrentWait(task, other)).toBe(false);
      expect(pendingReportMark(task, other, { kind: 'report', tone: 'quiet' }).tone).toBe('quiet');
    }
  });
for (const state of ['todo', 'doing', 'waiting', 'held', 'error', 'done', 'stopped'] as const)
  test(`${state} without a question/review ball keeps historical marks`, () => {
    for (const ball of [null, userBall('failed', 'current', '2026-10-28T02:00:00Z')]) {
      const task = { id: 'T1', state, ball, rowFacts: null };
      expect(isCurrentWait(task, record)).toBe(false);
      expect(pendingReportMark(task, record, { kind: 'report', tone: 'quiet' }).tone).toBe('quiet');
    }
  });
