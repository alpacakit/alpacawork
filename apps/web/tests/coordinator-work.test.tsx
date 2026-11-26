import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { startI18n, i18n } from '@alpacawork/i18n';
import { LastWordsPill } from '../src/features/coordinator/LastWords';
import { Thinking } from '../src/features/coordinator/parts';
import { workNameWords, workWords } from '../src/domain/work-words';
import { useConnection } from '../src/data/connection';
import { useActivityText } from '../src/features/people/labels';
import { screenData, TestWorkspace } from './fixtures';
import { setConversationState, SERVED } from './conversation-fixture';
import type { CoordinatorTurn } from '../src/data/coordinator';

beforeAll(async () => { await startI18n(); await i18n.changeLanguage('en'); });
afterEach(() => { vi.useRealTimers(); cleanup(); setConversationState({ conversation: null }); });
const turn: CoordinatorTurn = { id: 'turn', at: new Date(0).toISOString(), ask: 'work', status: 'running', attachments: [],
  waiting: false, answer: null, answeredAt: null, seen: false, error: null, result: null };

test('every place shows one paced work name and the seconds since sending: held 2 s from the DOM, latest after, released at once', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(0);
  const conversation = { id: 'conversation', nextLaunch: { agent: 'fake', values: {} }, ...SERVED, busy: false, cancelled: [], turns: [turn] };
  setConversationState({ conversation });
  useConnection.setState({ offline: false });
  const base = screenData();
  const at = (work: Partial<NonNullable<typeof base.info.coordinatorWork>> | null, rev = base.info.rev) => ({ ...base, info: { ...base.info, rev,
    coordinatorWork: work && { conversation: 'conversation', turn: turn.id, run: 'R1', name: 'command' as const, count: 1, steps: [], stepEvents: 0, stepsStarted: 0, words: null, ...work } } });
  function RunWork() {
    const text = useActivityText();
    return <span data-testid="run">{text({ at: turn.at, kind: 'output', toolName: null, note: null, context: null, steps: [],
      doing: { at: turn.at, toolName: 'Bash', command: 'task.new' } })}</span>;
  }
  const page = (data: ReturnType<typeof at>, open = true) =>
    <TestWorkspace data={data}><LastWordsPill style={{}} />{open && <Thinking turn={turn} />}<RunWork /></TestWorkspace>;
  // The message was sent at 0: every place ends with the whole seconds since then.
  const shown = (text: string) => expect(screen.getAllByText(`${text} ${Math.floor(Date.now() / 1000)}s`)).toHaveLength(2);
  const until = (ms: number) => act(() => { vi.advanceTimersByTime(ms - Date.now()); });
  const view = render(page(at(null)));
  shown('Working on it…');
  until(2490);
  view.rerender(page(at({})));
  shown('Command');
  expect(screen.getByTestId('run').textContent).toBe('Creating a task…');
  // A repeat of the same work is no change: no count is shown, and the hold is not started again.
  until(3000);
  view.rerender(page(at({ count: 2 })));
  shown('Command');
  until(4010);
  view.rerender(page(at({ name: 'file' })));
  until(4489);
  shown('Command');
  view.rerender(page(at({ name: 'file' }), false));
  view.rerender(page(at({ name: 'file' })));
  until(4490);
  shown('File read');
  view.rerender(page(at({ name: 'file' })));
  act(() => useConnection.setState({ offline: true }));
  shown('Working on it…');
  until(5000);
  shown('Working on it…');
  // The feed's resumed stream is live once open, with no delta and no whole index: the held work returns after the
  // usual hold, its count as serve has it.
  act(() => useConnection.setState({ offline: false }));
  until(6999);
  shown('Working on it…');
  until(7000);
  shown('File read');
  // A delta is an ordinary work update under the same hold.
  view.rerender(page(at({ name: 'file', count: 2 }, base.info.rev + 1)));
  until(8999);
  shown('File read');
  until(9000);
  shown('File read');
  view.rerender(page({ ...at({ name: 'file' }), info: { ...at({}).info, coordinatorWork: { ...at({}).info.coordinatorWork!, turn: 'another' } } }));
  shown('Working on it…');
  view.rerender(page(at({ name: 'file' })));
  until(11_100);
  shown('File read');
  // Answered, the running line goes (as its places draw it only while running) and the pill says the answer.
  act(() => setConversationState({ conversation: { ...conversation, turns: [{ ...turn, status: 'succeeded', answer: 'Done.', answeredAt: turn.at }] } }));
  view.rerender(page(at({ name: 'file' }), false));
  expect(screen.getByText('Done.')).toBeTruthy();
  act(() => { vi.advanceTimersByTime(3_000); });
  expect(screen.queryByText(/\d+s$/)).toBeNull();
  vi.useRealTimers();
});

test('each message counts from its own sending, also when drawn again', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(32_400);
  const conversation = { id: 'conversation', nextLaunch: { agent: 'fake', values: {} }, ...SERVED, busy: false, cancelled: [], turns: [turn] };
  setConversationState({ conversation });
  useConnection.setState({ offline: false });
  const page = (running: CoordinatorTurn) => <TestWorkspace data={screenData()}><LastWordsPill style={{}} /><Thinking turn={running} /></TestWorkspace>;
  const shown = (text: string) => expect(screen.getAllByText(text)).toHaveLength(2);
  const view = render(page(turn));
  shown('Working on it… 32s');
  act(() => { vi.advanceTimersByTime(600); });
  shown('Working on it… 33s');
  // Drawn again (a reload or reconnect draws the same message), it counts from the same sending.
  view.unmount();
  const again = render(page(turn));
  shown('Working on it… 33s');
  const next = { ...turn, id: 'next', at: new Date(30_000).toISOString() };
  act(() => setConversationState({ conversation: { ...conversation, turns: [{ ...turn, status: 'succeeded', answer: 'Done.', answeredAt: turn.at }, next] } }));
  again.rerender(page(next));
  shown('Working on it… 3s');
});

test('operation and work-name wording is available in Japanese and English', async () => {
  await i18n.changeLanguage('ja');
  expect(workWords('task.new')).toBe('タスクを作成中です…');
  expect(workWords('task.report')).toBe('タスクの状態・報告を更新中です…');
  await i18n.changeLanguage('en');
  expect(workWords('task.update')).toBe('Updating a task…');
  await i18n.changeLanguage('ja');
  expect(workNameWords('task.request')).toBe('エージェントへの依頼');
  await i18n.changeLanguage('en');
});

test('folded words follow the last active turn before a later finished reply', () => {
  setConversationState({ conversation: { id: 'conversation', nextLaunch: { agent: 'fake', values: {} }, ...SERVED, busy: false, cancelled: [], turns: [
    turn,
    { ...turn, id: 'queued', status: 'queued' },
    { ...turn, id: 'finished', status: 'succeeded', answer: 'Finished reply', answeredAt: turn.at },
  ] } });
  render(<TestWorkspace data={screenData()}><LastWordsPill style={{}} /></TestWorkspace>);
  const pill = document.querySelector('[data-coordinator-pill]')!;
  expect(pill.getAttribute('data-coordinator-pill-state')).toBe('running');
  expect(pill.textContent).toBe(i18n.t('ui:coordinatorCard.posting'));
});
