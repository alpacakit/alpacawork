import { setConversationState, snapshotJson } from './conversation-fixture';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { startI18n, i18n } from '@alpacawork/i18n';
import { ReportFeed } from '../src/features/reader/ReportFeed';
import { TaskActions } from '../src/features/reader/TaskActions';
import { TaskActionSlot } from '../src/features/coordinator/task-action-slot';
import { ReaderCardContext } from '../src/features/reader/next-question';
import { reviewReports } from '../src/domain/review-reports';
import { reportEvent } from '../src/domain/report-events';
import { queryClient } from '../src/data/query-client';
import { useConversation } from '../src/features/coordinator/coordinator';
import { useReaderSend } from '../src/features/coordinator/reader-send';
import { useDraftStore } from '../src/features/forms/draft-store';
import { useWriteIntentStore } from '../src/data/write-intent';
import { at, historyFixture, logEntry, decideItem, questionFixture, screenData, taskFixture, TestWorkspace, tree, userBall } from './fixtures';

beforeAll(async () => { await startI18n(); await i18n.changeLanguage('en'); });
afterEach(() => { cleanup(); queryClient.clear(); setConversationState(useConversation.getInitialState()); useDraftStore.setState({ entries: {} }); useWriteIntentStore.setState({ entries: {}, unavailable: false }); useReaderSend.setState({ post: null }); });
const mark = 'ownReview';
/** T1's own review awaiting the user; the server sends only a Task's own human reviews (userReviews). */
function fixture({ history = false }: { history?: boolean } = {}) {
  const review = logEntry({ id: mark, kind: 'reported', fromState: 'doing', toState: 'waiting', title: 'Own result', description: 'Review the current Task result.' });
  return tree({ tasks: [taskFixture({ id: 'T1', state: 'waiting', baseState: 'waiting', log: [review], ball: userBall('review', mark, at) })],
    userReviews: { T1: [{ id: mark, taskId: 'T1', taskTitle: 'Current Task', title: 'Own result', summary: review.description!, submittedAt: at }] },
    history: { T1: history ? historyFixture([{ id: mark, kind: 'review', title: 'Own result', summary: review.description!, state: 'waiting' }]) : [] } });
}
function feed(value = fixture()) {
  const data = screenData(value);
  const node = <TestWorkspace data={data}><ReaderCardContext value={{ taskId: 'T1' }}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={vi.fn()} /></ReaderCardContext></TestWorkspace>;
  return { data, node };
}

test('the review and History share one key; questions remain separate', () => {
  const value = fixture({ history: true });
  const q = questionFixture({ id: 'Qown', taskId: 'T1', decide: [decideItem('Keep it?', [['Keep', 'Keep']])] });
  value.questions.push(q); value.userQuestions.T1 = [{ ...q, destination: { kind: 'user' }, applicable: true, taskTitle: 'Direct' }];
  render(feed(value).node);
  expect(document.querySelectorAll('[data-report-key="log:T1:ownReview"]')).toHaveLength(1);
  expect(document.querySelector('[data-report-key="log:T1:Qown"]')).not.toBeNull();
  expect(reviewReports([], screenData(value).tasks[0]!).map(each => each.key)).toEqual(['log:T1:ownReview']);
});

test('unreadable reviews are a failure', () => {
  const value = fixture(); value.userReviews.T1 = null;
  render(feed(value).node);
  expect(screen.getByRole('alert').textContent).toContain('Could not read the items awaiting review');
});

for (const state of ['waiting', 'held'] as const) test(`the ${state} current Task review has exactly one confirmation in its existing slot and no projected inline controls`, async () => {
  const own = logEntry({ id: 'ownReview', kind: 'reported', fromState: 'doing', toState: 'waiting', title: 'Own result', description: 'Review the current Task result.' });
  const data = screenData(tree({ tasks: [taskFixture({ id: 'T1', state, baseState: 'waiting', log: [own, ...state === 'held' ? [logEntry({ id: 'ownHold', kind: 'reported', fromState: 'waiting', toState: 'held' })] : []], ball: userBall('review', 'ownReview', at) })],
    userReviews: { T1: [{ id: 'ownReview', taskId: 'T1', taskTitle: 'Current Task', title: 'Own result', summary: own.description!, submittedAt: at }] },
    history: { T1: historyFixture([{ id: 'ownReview', kind: 'review', title: 'Own result', summary: own.description! }]) } }));
  render(<TestWorkspace data={data}><ReaderCardContext value={{ taskId: 'T1' }}>
    <ReportFeed task={data.tasks[0]!} people={data.people} onFollow={vi.fn()} />
    <TaskActionSlot /><TaskActions task={data.tasks[0]!} phone />
  </ReaderCardContext></TestWorkspace>);
  await waitFor(() => expect(document.querySelectorAll('[data-task-done]')).toHaveLength(1));
  expect(document.querySelector('[data-task-done]')?.closest('[data-task-action-slot]')).not.toBeNull();
  expect(document.querySelector('[data-task-done]')?.hasAttribute('disabled')).toBe(false);
  expect(document.querySelector('[data-review-report-actions]')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Send back…' })).toBeNull();
  expect(document.querySelectorAll('[data-report-key="log:T1:ownReview"]')).toHaveLength(1);
  expect(screen.getByText('Review the current Task result.')).toBeTruthy();
});

test('current review preserves History shape and always takes the Task state colour, before and after History arrives', () => {
  const task = screenData(fixture()).tasks[0]!;
  for (const kind of ['report', 'review', 'comment'] as const) {
    const history = reportEvent(historyFixture([{ id: mark, kind, state: 'waiting', title: 'Own result' }])[0]!, () => null);
    expect(history.mark).toEqual({ kind: 'report', tone: 'quiet' });
    const [merged] = reviewReports([history], task);
    expect(merged?.kind).toBe(history.kind);
    expect(merged?.mark).toEqual({ ...history.mark, tone: 'turn' });
    expect(merged?.pinned).toBe(true);
  }
  const human = reportEvent(historyFixture([{ id: mark, kind: 'review', state: 'waiting', title: 'Own result', by: 'human' }])[0]!, () => mark);
  expect(human.mark).toBeNull();
  for (const reports of [[], [human]]) {
    const [merged] = reviewReports(reports, task);
    expect(merged?.mark).toEqual({ kind: 'report', tone: 'turn' });
  }
});

for (const [state, tone] of [['waiting', 'turn'], ['held', 'quiet']] as const) test(`a ${state} review shares the state label colour even when History supplied a quiet mark`, () => {
  const task = { ...screenData(fixture()).tasks[0]!, state };
  const history = reportEvent(historyFixture([{ id: mark, kind: 'review', state: 'waiting', title: 'Own result' }])[0]!, () => null);
  for (const reports of [[], [history]]) {
    const [merged] = reviewReports(reports, task);
    expect(merged?.mark).toEqual({ kind: 'report', tone });
  }
  // A completed, older submission is outside the server's current reviews and keeps its historical colour.
  expect(reviewReports([history], { ...task, userReviews: [] })[0]!.mark?.tone).toBe('quiet');
});

test('the detail review stays in the state colour when the list snapshot lacks its ball and stateLog', () => {
  const data = screenData(fixture({ history: true }));
  const people = { ...data.people, tasks: new Map(data.people.tasks) };
  const row = people.tasks.get('T1')!;
  people.tasks.set('T1', { ...row, ball: null, stateLog: [] });
  render(<TestWorkspace data={data}><ReaderCardContext value={{ taskId: 'T1' }}>
    <ReportFeed task={data.tasks[0]!} people={people} onFollow={vi.fn()} />
  </ReaderCardContext></TestWorkspace>);
  const review = document.querySelector('[data-report-key="log:T1:ownReview"]')!;
  expect(review.querySelector('[data-rail-time] svg')?.classList.contains('text-turn')).toBe(true);
  expect(review.querySelector('[data-report-line]')?.classList.contains('text-turn')).toBe(true);
});
