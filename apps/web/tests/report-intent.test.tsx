import { queryClient } from '../src/data/query-client';
import { receiveFullIndex } from '../src/data/resources';
import { headOf, indexOf } from './fixtures';
import { taskActionsOf } from '@alpacawork/contract/task-policy';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { i18n, startI18n } from '@alpacawork/i18n';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useTaskReport } from '../src/features/reader/use-task-report';
import { useDirectWriteRecovery } from '../src/features/reader/recovery';
import { useWriteIntentStore, readWriteIntents } from '../src/data/write-intent';
import { useSitting } from '../src/features/reader/next-question';
import { useViewStore } from '../src/state/view-store';
import { StateControl } from '../src/features/forms/ReportInputs';
import { openInput, closeInput } from '../src/state/open-input';
import { TestWorkspace, screenData, tree, dto, taskFixture, userBall, logEntry, at } from './fixtures';
import { reportRequest, taskReportTarget } from '../src/data/task-report';
import { problemResponse } from './problem';
import { useToasts } from '../src/lib/notify';

beforeAll(async () => { startI18n(); await i18n.changeLanguage('en'); });
afterEach(() => { cleanup(); closeInput(); vi.restoreAllMocks(); });
const sample = () => screenData(tree({ tasks: [taskFixture({ state: 'waiting',
  log: [logEntry({ id: 'L1', kind: 'reported', fromState: 'doing', toState: 'waiting' })],
  ball: userBall('review', 'L1', at) })] }));
function Recovery() { useDirectWriteRecovery(); return null; }
const response = (state: 'done' | 'held' = 'done') => new Response(JSON.stringify({ task: headOf(dto({ state })), outcome: { kind: 'recorded' } }));
function mount(data = sample(), card: { taskId: string } | null = null) {
  return renderHook(() => useTaskReport(data.tasks[0]!, data.people, card), {
    wrapper: ({ children }) => <TestWorkspace data={data}><Recovery />{children}</TestWorkspace>,
  });
}

test('complete uses one direct report with the displayed Run and versions, defaults and no conversation', async () => {
  const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../../../tests/fixtures/contract-examples/tree.json'), 'utf8'));
  const data = screenData(tree({ ...fixture, balls: { T12: userBall('review', 'RET1', at, { aboutRunId: 'R2' }) } }));
  const task = data.tasks.find(task => task.id === 'T12')!;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response());
  const hook = renderHook(() => useTaskReport(task, data.people, null), { wrapper: ({ children }) => <TestWorkspace data={data}>{children}</TestWorkspace> });
  let sent!: ReturnType<typeof hook.result.current.complete>;
  act(() => { sent = hook.result.current.complete(); });
  expect(sent.admission).toBe('retained');
  if (sent.admission === 'rejected') throw sent.reason;
  const complete = sent.result;
  await act(async () => { await complete; });
  expect(fetcher).toHaveBeenCalledOnce();
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe('/api/commands/task/report');
  expect(JSON.parse(String(init!.body))).toEqual({ task: 'T12', state: 'done', aboutRun: 'R2', expectedPlacementRevision: 3,
    expectedTaskHash: task.hash, title: 'Done', description: 'Reviewed the result.' });
  expect(new Headers(init!.headers).get('X-Alpacawork-Op-Id')).toBe(sent.operationId);
  expect([...new Headers(init!.headers).keys()].sort()).toEqual(['content-type','x-alpacawork-op-id','x-alpacawork-restore-id']);
  expect(new Headers(init!.headers).get('X-Alpacawork-Restore-Id')).toBe('initial');
});

test('an unknown direct report survives reload and checks the same ID, input and language', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('lost')).mockResolvedValue(response());
  const hook = mount();
  let sent!: ReturnType<typeof hook.result.current.complete>;
  act(() => { sent = hook.result.current.complete(); });
  if (sent.admission === 'rejected') throw sent.reason;
  const failed = sent.result;
  await act(async () => { await expect(failed).rejects.toMatchObject({ code: 'network_error' }); });
  expect(hook.result.current.status).toBe('unconfirmed');
  const original = structuredClone(useWriteIntentStore.getState().entries[hook.result.current.key]);
  act(() => useWriteIntentStore.setState(readWriteIntents()));
  await i18n.changeLanguage('ja');
  await act(async () => { await hook.result.current.check(); });
  expect(fetcher.mock.calls[1]![1]!.body).toBe(fetcher.mock.calls[0]![1]!.body);
  expect(new Headers(fetcher.mock.calls[1]![1]!.headers).get('X-Alpacawork-Op-Id')).toBe(original!.operationId);
  expect(hook.result.current.status).toBe('confirmed');
  await i18n.changeLanguage('en');
});

for (const choice of ['approve', 'hold', 'unhold', 'stop'] as const) test(`${choice} translates once into a direct report`, () => {
  const data = sample(), task = data.tasks[0]!;
  const shown = choice === 'unhold' ? { ...task, state: 'held' as const, hold: true, allowedActions: taskActionsOf({ ...task, hold: true, userRequested: true }),
    stateLog: [...task.stateLog, { ...task.stateLog[0]!, id: 'H', fromState: 'waiting' as const, toState: 'held' as const }] } : task;
  const input = reportRequest(taskReportTarget(shown, data.people), choice, { title: 'My title' });
  expect(input.state).toBe(({ approve: 'done', hold: 'held', unhold: 'waiting', stop: 'stopped' } as const)[choice]);
  expect(input.title).toBe('My title'); expect(input.description).not.toBe(''); expect(input).not.toHaveProperty('aboutRun');
});

test('no durable admission means no HTTP and no departure', () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  const hook = mount();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('quota'); });
  act(() => { expect(hook.result.current.complete().admission).toBe('rejected'); });
  expect(fetcher).not.toHaveBeenCalled(); expect(useSitting.getState().departures).toEqual({});
});

test('local acceptance retires once; actual server conflict returns it and retains its Problem', async () => {
  const data = sample(), card = { taskId: data.tasks[0]!.id };
  useViewStore.getState().openTask(card.taskId, { reader: true }); useSitting.setState({ card, order: [card.taskId] });
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(problemResponse('conflict', 'Task changed', { reason: { kind: 'task_changed' } }));
  const hook = mount(data, card);
  let sent!: ReturnType<typeof hook.result.current.complete>;
  act(() => { sent = hook.result.current.complete(); });
  expect(sent.admission).toBe('retired');
  if (sent.admission === 'rejected') throw sent.reason;
  const failed = sent.result;
  await act(async () => { await expect(failed).rejects.toMatchObject({ code: 'conflict', message: 'Task changed' }); });
  const entry = useWriteIntentStore.getState().entries[hook.result.current.key]!;
  expect(entry).toMatchObject({ status: 'conflict', failure: { code: 'conflict', message: 'Task changed' } });
  expect(useSitting.getState().departures[card.taskId]!.status()).toBe('conflict');
  expect(useToasts.getState().toasts.some(toast => toast.kind === 'error')).toBe(true);
  expect(fetcher).toHaveBeenCalledOnce();
});

test('a state form refuses a changed opening with chooseAgain and sends only after reselecting', async () => {
  let data = sample();
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response());
  openInput({ form: 'report', taskId: data.tasks[0]!.id, answerCard: null });
  const view = render(<TestWorkspace data={data}><StateControl task={data.tasks[0]!} /></TestWorkspace>);
  data = screenData(tree({ tasks: [taskFixture({ state: 'waiting', hash: 'b'.repeat(64), ball: userBall('review', 'L1', at),
    log: [logEntry({ id: 'L1', kind: 'reported', fromState: 'doing', toState: 'waiting' })] })] }));
  view.rerender(<TestWorkspace data={data}><StateControl task={data.tasks[0]!} /></TestWorkspace>);
  fireEvent.click(screen.getByRole('button', { name: 'Update' }));
  await screen.findByText(i18n.t('forms:reportForm.chooseAgain')); expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('radio', { name: 'Done' })); fireEvent.click(screen.getByRole('button', { name: 'Update' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).expectedTaskHash).toBe('b'.repeat(64));
});


test('a form requires reselecting a Run that appears without changing the Task hash', async () => {
  const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../../../tests/fixtures/contract-examples/tree.json'), 'utf8'));
  const sample = (finished: boolean) => screenData(tree({ ...fixture, balls: { T12: finished
    ? userBall('review', 'RET1', at, { aboutRunId: 'R2' }) : { holder: 'owner' } } }));
  let data = sample(false);
  const shown = () => data.tasks.find(task => task.id === 'T12')!;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response());
  openInput({ form: 'report', taskId: shown().id, answerCard: null });
  const view = render(<TestWorkspace data={data}><StateControl task={shown()} /></TestWorkspace>);
  const openingHash = shown().hash;
  data = sample(true); expect(shown().hash).toBe(openingHash);
  view.rerender(<TestWorkspace data={data}><StateControl task={shown()} /></TestWorkspace>);
  fireEvent.click(screen.getByRole('button', { name: 'Update' }));
  await screen.findByText(i18n.t('forms:reportForm.chooseAgain'));
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('radio', { name: 'Done' }));
  fireEvent.click(screen.getByRole('button', { name: 'Update' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toMatchObject({ aboutRun: 'R2', expectedTaskHash: openingHash, expectedPlacementRevision: 3 });
});


test('a form requires reselecting a changed responsible revision even at the same Task hash', async () => {
  const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../../../tests/fixtures/contract-examples/tree.json'), 'utf8'));
  const sample = (revision: number) => {
    const value = tree({ ...fixture,
      placements: fixture.placements.map((placement: { id: string }) => placement.id === 'P2' ? { ...placement, revision } : placement),
      balls: { T12: userBall('review', 'RET1', at, { aboutRunId: 'R2' }) } });
    // The new people projection consumes server facts, so publish the actual placement revision there.
    receiveFullIndex(queryClient, indexOf(value));
    return screenData(value);
  };
  let data = sample(3);
  const shown = () => data.tasks.find(task => task.id === 'T12')!;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response());
  openInput({ form: 'report', taskId: shown().id, answerCard: null });
  const view = render(<TestWorkspace data={data}><StateControl task={shown()} /></TestWorkspace>);
  const openingHash = shown().hash;
  data = sample(4); expect(shown().hash).toBe(openingHash);
  view.rerender(<TestWorkspace data={data}><StateControl task={shown()} /></TestWorkspace>);
  fireEvent.click(screen.getByRole('button', { name: 'Update' }));
  await screen.findByText(i18n.t('forms:reportForm.chooseAgain')); expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('radio', { name: 'Done' }));
  fireEvent.click(screen.getByRole('button', { name: 'Update' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toMatchObject({ expectedTaskHash: openingHash, expectedPlacementRevision: 4, aboutRun: 'R2' });
});

test('a form requires reselecting a changed restore state and then sends that captured state', async () => {
  const sample = (fromState: 'doing' | 'todo') => screenData(tree({ tasks: [taskFixture({ state: 'held', baseState: fromState,
    log: [logEntry({ id: 'H', kind: 'reported', fromState, toState: 'held' })], ball: null })] }));
  let data = sample('doing');
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response());
  openInput({ form: 'report', taskId: data.tasks[0]!.id, answerCard: null });
  const view = render(<TestWorkspace data={data}><StateControl task={data.tasks[0]!} /></TestWorkspace>);
  const openingHash = data.tasks[0]!.hash;
  data = sample('todo'); expect(data.tasks[0]!.hash).toBe(openingHash);
  view.rerender(<TestWorkspace data={data}><StateControl task={data.tasks[0]!} /></TestWorkspace>);
  fireEvent.click(screen.getByRole('button', { name: 'Update' }));
  await screen.findByText(i18n.t('forms:reportForm.chooseAgain')); expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole('radio')[0]!);
  fireEvent.click(screen.getByRole('button', { name: 'Update' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toMatchObject({ state: 'todo', expectedTaskHash: openingHash });
});

test('unrelated people updates do not require reselecting a form target', async () => {
  const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../../../tests/fixtures/contract-examples/tree.json'), 'utf8'));
  const sample = (revision: number) => screenData(tree({ ...fixture,
    placements: fixture.placements.map((placement: { id: string }) => placement.id === 'P1' ? { ...placement, revision } : placement),
    balls: { T12: userBall('review', 'RET1', at, { aboutRunId: 'R2' }) } }));
  let data = sample(3);
  const shown = () => data.tasks.find(task => task.id === 'T12')!;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response());
  openInput({ form: 'report', taskId: shown().id, answerCard: null });
  const view = render(<TestWorkspace data={data}><StateControl task={shown()} /></TestWorkspace>);
  const openingHash = shown().hash;
  data = sample(4);
  view.rerender(<TestWorkspace data={data}><StateControl task={shown()} /></TestWorkspace>);
  fireEvent.click(screen.getByRole('button', { name: 'Update' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toMatchObject({ expectedTaskHash: openingHash, expectedPlacementRevision: 3, aboutRun: 'R2' });
});
