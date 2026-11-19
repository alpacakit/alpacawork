import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { i18n, startI18n } from '@alpacawork/i18n';
import { awaitsReview as contractAwaitsReview } from '@alpacawork/contract';
import { TaskActions } from '../src/features/reader/TaskActions';
import { Toaster } from '../src/components/ui/toaster';
import { awaitsReview } from '../src/features/reader/TaskDone';
import { TaskActionSlot } from '../src/features/coordinator/task-action-slot';
import { useDirectWriteRecovery } from '../src/features/reader/recovery';
import { useToasts } from '../src/lib/notify';
import { closeInput } from '../src/state/open-input';
import { TestWorkspace, at, dto, logEntry, screenData, taskFixture, tree, userBall } from './fixtures';

beforeAll(async () => { startI18n(); await i18n.changeLanguage('en'); });
afterEach(() => { cleanup(); closeInput(); vi.restoreAllMocks(); });
function Recovery() { useDirectWriteRecovery(); return null; }
function sample() {
  return screenData(tree({ tasks: [taskFixture({ state: 'doing', userRequested: true,
    log: [logEntry({ id: 'Q1', kind: 'asked', askedTo: null, fromState: null, toState: null,
      actor: { kind: 'placement', placementId: 'P1' }, description: 'A or B' })],
    ball: userBall('question', 'Q1', at, { questionId: 'Q1' }) })] }));
}

test('question shows Done in detail and state choices on a phone, whose buttons are marks alone, without becoming review', async () => {
  const data = sample(), task = data.tasks[0]!;
  expect(awaitsReview(task)).toBe(false); expect(contractAwaitsReview(task)).toBe(false);
  render(<TestWorkspace data={data}><TaskActionSlot /><TaskActions task={task} phone /></TestWorkspace>);
  expect((screen.getByRole('button', { name: 'Mark this task done' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Change state' }));
  expect((await screen.findByRole('radio', { name: 'Done' }) as HTMLButtonElement).disabled).toBe(false);
});

test('question Done sends done directly without a review Run', async () => {
  const data = sample(), task = data.tasks[0]!;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    task: dto({ state: 'done' }), outcome: { kind: 'recorded' } })));
  render(<TestWorkspace data={data}><TaskActionSlot /><TaskActions task={task} phone={false} /></TestWorkspace>);
  fireEvent.click(screen.getByRole('button', { name: 'Mark this task done' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  const input = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
  expect(input).toMatchObject({ task: task.id, state: 'done', expectedTaskHash: task.hash });
  expect(input).not.toHaveProperty('aboutRun');
});

test('the server unfinished-child reason appears in the existing recovery notice for question Done', async () => {
  const data = sample(), task = data.tasks[0]!;
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: {
    code: 'finished_branch', message: 'Unfinished child T3', retry: 'fix',
    reason: { kind: 'unfinished_tasks_below_make_them_done_or_stopped_first', taskId: task.id, issueTasks: 'T3' },
  } }), { status: 409 }));
  render(<TestWorkspace data={data}><Recovery /><TaskActionSlot /><TaskActions task={task} phone={false} /><Toaster /></TestWorkspace>);
  fireEvent.click(screen.getByRole('button', { name: 'Mark this task done' }));
  await waitFor(() => expect(useToasts.getState().toasts.some(toast =>
    toast.kind === 'error' && String(toast.detail).includes('T3'))).toBe(true));
  expect(await screen.findByText(/T3/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Mark this task done' }) as HTMLButtonElement).disabled).toBe(false);
});
