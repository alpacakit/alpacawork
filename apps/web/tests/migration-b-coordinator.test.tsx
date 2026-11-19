import { setConversationState } from './conversation-fixture';
import { expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TestWorkspace, at, homeFixture, historyFixture, serveTimeline, logEntry, decideItem, questionFixture, screenData, taskFixture, tree, userBall } from './fixtures';
import { TimeTree } from '../src/features/tree/TimeTree';
import { Reader } from '../src/features/reader/Reader';
import { CoordinatorCard } from '../src/features/coordinator/CoordinatorCard';
import { WaitingReportActions } from '../src/features/reader/WaitingReportActions';
import { useConversation } from '../src/features/coordinator/coordinator';
import { useDraftStore } from '../src/features/forms/draft-store';
import { useViewStore } from '../src/state/view-store';
import { setupCoordinator, transport, mountCoordinator, field, conversation, json } from './migration-b-coordinator-fixture';

setupCoordinator();

test('unavailable PiP: Close remains available and no pop-out is offered', async () => {
  vi.stubGlobal('documentPictureInPicture', undefined); transport(); await mountCoordinator();
  expect(await screen.findByRole('button', { name: 'Close the conversation' })).toBeTruthy();
  expect(document.querySelector('[data-coordinator-pop-out]')).toBeNull();
});

test('draft storage failure explains duplicates, disables Send and keeps copyable words', async () => {
  transport();
  const put = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key === 'alpacawork-input-drafts-v10') throw new DOMException('Full', 'QuotaExceededError');
    return put.call(this, key, value);
  });
  await mountCoordinator();
  act(() => field().editor.commands.setContent('<p>Keep these words available to copy</p>'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('prevent duplicates'));
  expect(screen.getByRole('alert').textContent).toContain('Copy your text before closing');
  expect((document.querySelector('[data-ask-send]') as HTMLButtonElement).disabled).toBe(true);
  expect(field().textContent).toContain('Keep these words available to copy');
});

for (const device of ['pc', 'phone']) test(`skill discovery explains an unsupported catalog in the existing list (${device})`, async () => {
  // Width-dependent placement is retained in coordinator-editor's browser list checks.
  if (device === 'phone') {
    const original = window.matchMedia;
    vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ ...original(query), matches: /max-width|pointer: coarse/.test(query) }));
  }
  transport().fetcher.mockImplementation(async url => String(url).startsWith('/api/coordinator/skills')
    ? json({ status: 'unavailable', profile: 'claude', skills: [], reason: 'plugins' }) : json(conversation));
  setConversationState({ engaged: true }); await mountCoordinator();
  await waitFor(() => expect(field().getAttribute('contenteditable')).toBe('true'));
  act(() => { field().editor.commands.focus('end'); field().editor.commands.insertContent('/'); });
  await waitFor(() => expect(screen.getByRole('listbox').textContent).toContain('Skills from enabled plugins cannot be verified'));
  expect(screen.queryAllByRole('option')).toHaveLength(0);
});

test('choices pressed before conversation loading survive its arrival', async () => {
  transport(); setConversationState({ conversation: null });
  const decide = [decideItem('How to open suggestions', [['Option1 Complete from a number', 'Insert the selected task in the text'], ['Option2 Choose from a symbol', 'Open the list']])];
  const data = screenData(tree({ tasks: [taskFixture({ id: 'T112', title: 'Question', state: 'doing', ball: userBall('question', 'Q1', at, { questionId: 'Q1' }),
    log: [logEntry({ id: 'Q1', kind: 'asked', askedTo: null, actor: { kind: 'placement', placementId: 'P1' }, title: 'Please choose', description: 'Choose one' })] })],
    questions: [questionFixture({ id: 'Q1', taskId: 'T112', decide })] }));
  render(<TestWorkspace data={data}><WaitingReportActions task={data.tasks[0]!} question="Q1" onFollow={() => {}} /><CoordinatorCard /></TestWorkspace>);
  fireEvent.click(screen.getByRole('button', { name: /Option1 Complete from a number/ }));
  const loading = Object.values(useDraftStore.getState().entries).find(entry => entry.values.doc?.includes('answerLabel'))!;
  const requestId = loading.values.requestId;
  act(() => setConversationState({ conversation }));
  await waitFor(() => expect(field().getAttribute('contenteditable')).toBe('true'));
  expect(field().closest('[data-label-editor]')!.querySelector('[data-label-layer] [data-label=answer]')?.textContent).toContain('Option1');
  expect(Object.values(useDraftStore.getState().entries).find(entry => entry.values.doc?.includes('answerLabel'))!.values.requestId).toBe(requestId);
});

test('unconfigured voice: native editor, no voice wrapper or shortcut, retained words after reload', async () => {
  expect(document.querySelector('meta[name="alpacawork-voice"]')).toBeNull();
  transport(); const view = await mountCoordinator();
  expect(document.querySelector('[data-voice-state], [data-voice-textarea]')).toBeNull();
  expect(field().getAttribute('contenteditable')).toBe('true');
  expect(fireEvent.keyDown(field(), { key: 'm', altKey: true, shiftKey: true })).toBe(true);
  act(() => field().editor.commands.setContent('<p>Ordinary input without voice configuration</p>'));
  expect(field().textContent).toBe('Ordinary input without voice configuration');
  const saved = JSON.parse(sessionStorage.getItem('alpacawork-input-drafts-v10')!).entries;
  view.unmount(); useDraftStore.setState({ entries: saved }); await mountCoordinator();
  expect(field().textContent).toContain('Ordinary input without voice configuration');
});

for (const mode of ['aligned', 'named-completion'] as const) test(`reader selection answers its own question: ${mode}`, async () => {
  const name = mode === 'aligned' ? 'Option1 Save locally' : 'Option1 Save locally → 完了';
  const decide = [decideItem('Storage destination', [[name, 'Local only', 'Keep locally'], ['Option2 Send externally', 'Send']], { decide_note: 'One shared line' })];
  const value = tree({ tasks: [taskFixture({ id: 'T112', title: 'Question', state: 'doing',
    ball: userBall('question', 'Q1', at, { questionId: 'Q1' }), log: [logEntry({ id: 'Q1', kind: 'asked', askedTo: null,
      actor: { kind: 'placement', placementId: 'P1' }, title: 'Please choose', description: 'Choose one' })] })],
    questions: [questionFixture({ id: 'Q1', taskId: 'T112', decide })], home: homeFixture([{ taskId: 'T112', section: 'review' }]), history: { T112: historyFixture([{ id: 'Q1', taskId: 'T112', kind: 'question', open: true, title: 'Please choose', summary: 'Choose one' }]) } });
  serveTimeline(value);
  const data = screenData(value), posts: Record<string, any>[] = [];
  const { fetcher } = transport();
  fetcher.mockImplementation(async (url, init) => {
    if (String(url).startsWith('/api/task/view')) return json((await import('./fixtures')).viewsOf(value).find(view => view.task.id === 'T112'));
    if (String(url).startsWith('/api/coordinator/skills')) return json({ status: 'unavailable', profile: 'claude', skills: [], reason: 'test' });
    if (String(url).startsWith('/api/task/history')) return json({ events: value.history!.T112, nextBefore: null });
    if (String(url) === '/api/coordinator/messages') posts.push(JSON.parse(String(init?.body)));
    return json(conversation);
  });
  render(<TestWorkspace data={data}><TimeTree /><Reader mode="docked" /><CoordinatorCard /></TestWorkspace>);
  const mark = document.querySelector<HTMLElement>('[data-row="T112"] [data-read="T112"]')!;
  expect(mark).toBeTruthy(); fireEvent.click(mark);
  const question = await waitFor(() => { const found = document.querySelector<HTMLElement>('[data-question="1"]'); expect(found).toBeTruthy(); return found!; });
  expect(question.textContent).toContain('Storage destination');
  const choices = within(question).getAllByRole('button').filter(button => /Option[12]/.test(button.textContent!));
  expect(choices).toHaveLength(2); expect(choices[0]!.textContent).toContain(name);
  fireEvent.click(choices[0]!);
  await waitFor(() => expect(field().closest('[data-label-editor]')!.querySelector('[data-label-layer] [data-label=answer]')?.textContent).toBe('1Option1'));
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(document.querySelector('[data-ask-send]')!);
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]!.text).toContain('） 1-Option1');
  expect(posts[0]!.answers).toEqual([{ task: 'T112', question: 'Q1' }]);
  expect(posts[0]).not.toHaveProperty('intent');
});
