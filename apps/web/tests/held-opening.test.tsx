import { snapshotJson } from './conversation-fixture';
import { setConversationState } from './conversation-fixture';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { i18n, startI18n } from '@alpacawork/i18n';
import { userTurn } from '@alpacawork/contract';
import type { ControlTreeDTO } from '@alpacawork/contract/control';
import type { CoordinatorConversation, CoordinatorMessageInput } from '@alpacawork/contract/coordinator';
import { queryClient } from '../src/data/query-client';
import { Reader } from '../src/features/reader/Reader';
import { CoordinatorInput } from '../src/features/coordinator/CoordinatorInput';
import { useConversation } from '../src/features/coordinator/coordinator';
import { useReaderSend } from '../src/features/coordinator/reader-send';
import { useSitting } from '../src/features/reader/next-question';
import { openInput } from '../src/state/open-input';
import { useViewStore } from '../src/state/view-store';
import { headOf, TestWorkspace, at, homeFixture, screenData, tree, viewsOf, recordHistory } from './fixtures';
import { problemResponse } from './problem';

/**
 * The trees the server read at each step (tests/helpers/reader-hold-fixture.ts, made through the Task commands): two
 * Tasks the user asked for, each with a question its responsible's Run asked the user (`asked`); the user's proxy
 * holds the first one's (`held`), returns it to work (`restored`) and holds it again (`heldAgain`).
 */
type Stage = 'asked' | 'held' | 'restored' | 'heldAgain';
let fixture: Record<Stage, ControlTreeDTO> & { task: string };
/** The held Task, the other Task asking the user, and the project they are in. */
let task: string, other: string, project: string;

beforeAll(async () => {
  startI18n(); await i18n.changeLanguage('en');
  // Use actual Task commands and their canonical ball, rather than inventing a held row or a turn key.
  const root = resolve(import.meta.dirname, '../../..');
  fixture = JSON.parse(execFileSync(process.execPath, ['tests/helpers/reader-hold-fixture.ts'],
    { cwd: root, encoding: 'utf8', timeout: 30_000 }));
  task = fixture.task;
  const asked = fixture.asked.tasks.find(each => each.id === task)!;
  project = asked.parentId!;
  other = fixture.asked.tasks.find(each => each.kind === 'task' && each.id !== task)!.id;
});
afterEach(() => {
  cleanup(); queryClient.clear(); vi.restoreAllMocks(); useViewStore.getState().closeReader();
  document.querySelectorAll('[data-flying-card]').forEach(card => card.remove());
});

/** The screen at `stage` as the server sends it: both Tasks in its project, the held one in Hold while held. */
const servedAt = (stage: Stage) => tree({ ...fixture[stage], projectIds: { [task]: project, [other]: project },
  home: homeFixture([{ taskId: task, section: stage === 'held' || stage === 'heldAgain' ? 'held' : 'review' },
    { taskId: other, section: 'review' }]) });
const screenAt = (stage: Stage) => screenData(servedAt(stage));
/**
 * Serve as the input (CoordinatorInput, beside the reader) reaches it: a press is held in the conversation under its
 * ID, at work. Every other read is refused. What was sent, as serve received it.
 */
function serve() {
  const sent: {task:string;state:string}[] = [];
  let stage: Stage = 'asked';
  const conversation = (): CoordinatorConversation => ({ id: 'c1', agent: null, warm: 'none' as const, busy: false, cancelled: [], turns: [] });
  const json = (value: unknown) => new Response(snapshotJson(value), { status: 200 });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if (path === '/api/task/report' && init?.method === 'POST') { sent.push(JSON.parse(String(init.body))); stage = (['held', 'restored', 'heldAgain'] as const)[sent.length - 1]!; return json({ task: headOf(fixture[stage].tasks.find(each => each.id === task)!), outcome: { kind: 'recorded' } }); }
    const address = new URL(path, 'http://fixture');
    const id = address.searchParams.get('task');
    if (address.pathname === '/api/task/view') return json(viewsOf(servedAt(stage)).find(view => view.task.id === id));
    if (address.pathname === '/api/task/history') return json({ events: recordHistory(id!, fixture[stage].tasks.find(each => each.id === id)!.log), nextBefore: null });
    if (path === '/api/coordinator') return json(conversation());
    return problemResponse('not_found');
  });
  setConversationState({ root: fixture.asked.root, conversation: conversation(), open: false, expanded: false, engaged: false, read: true, error: null });
  return sent;
}
const contents = <><Reader mode="docked" /><CoordinatorInput launch={{ selected: {}, picker: null, saving: false }} profile="claude" /></>;
const hold = () => fireEvent.keyDown(document.body, { key: 'h' });

// A manual opening uses the list then at hand and keeps its shelf for that card.
// These are the two publication orders, not a claim about the unrecorded order of the original browser failure.
for (const publishedFirst of [true, false]) test(`held publication ${publishedFirst ? 'before' : 'after'} return fixes the opening shelf`, async () => {
  const sent = serve();
  let shown = screenAt('asked');
  act(() => useViewStore.getState().openTask(task, { reader: true }));
  const view = render(<TestWorkspace data={shown}>{contents}</TestWorkspace>);
  const publish = async (stage: Stage) => act(async () => {
    shown = screenAt(stage);
    view.rerender(<TestWorkspace data={shown}>{contents}</TestWorkspace>);
  });
  const returnToTask = async () => act(async () => { useViewStore.getState().openTask(task, { reader: true }); });
  // H holds the question: once serve holds the message, its card leaves for the next question.
  hold();
  await waitFor(() => expect(useViewStore.getState().selected).toBe(other));
  if (publishedFirst) { await publish('held'); await returnToTask(); }
  else { await returnToTask(); await publish('held'); }
  const card = useSitting.getState().card;
  const shelf = publishedFirst ? 'held' : 'review';
  expect(useSitting.getState().shelf).toBe(shelf);
  expect(document.querySelector('aside')!.hasAttribute('data-held')).toBe(true);
  // A hold and its return keep the turn: the ball's key is the asking one's at every step.
  for (const stage of ['held', 'restored', 'heldAgain'] as const)
    expect(userTurn(fixture[stage].balls[task] ?? null)?.key).toBe(userTurn(fixture.asked.balls[task] ?? null)!.key);

  // Restore from the state form, which offers it while held: no stamp, the card stays.
  act(() => openInput({ form: 'report', taskId: task, answerCard: card }));
  expect(screen.getAllByRole('radio').map(radio => radio.textContent)).toEqual(['Done', 'In progress', 'Stopped']);
  fireEvent.click(screen.getByRole('radio', { name: 'In progress' }));
  fireEvent.click(document.querySelector<HTMLElement>('[role=dialog] button[type=submit]')!);
  await waitFor(() => expect(sent).toHaveLength(2));
  await publish('restored');
  expect(useSitting.getState().card).toBe(card);
  expect(useSitting.getState().shelf).toBe(shelf);
  // Serve holds Restore: the input can send again.
  await waitFor(() => expect(useReaderSend.getState().post).not.toBeNull());
  hold();
  await waitFor(() => expect(sent).toHaveLength(3));
  expect(sent.map(({ task, state }) => [task, state])).toEqual([[task, 'held'], [task, 'doing'], [task, 'held']]);
  // On Hold nothing else is held: the card says so. On Your turn the other question comes next.
  await waitFor(() => expect(useViewStore.getState().selected).toBe(publishedFirst ? task : other));
  await waitFor(() => expect(Boolean(document.querySelector('[data-empty-deck]'))).toBe(publishedFirst));
});
