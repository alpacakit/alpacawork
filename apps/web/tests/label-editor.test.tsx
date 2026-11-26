import { freeze, outgoingKey, cancelUnsent, canTakeBack, takeBack, reconcileOutbox } from '../src/features/coordinator/editor/outbox';
import { consumeInput } from '../src/features/coordinator/editor/input-ownership';
import { serialize, draftDocument, filterDocument, parseDocument } from '../src/features/coordinator/editor/document';
import { served, snapshotJson, SERVED } from './conversation-fixture';
import { setConversationState } from './conversation-fixture';
import { afterEach, beforeAll, beforeEach, expect, onTestFinished, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { startI18n, i18n } from '@alpacawork/i18n';
import { PROJECT_TASK, TestWorkspace, screenData, tree, taskFixture, dto, viewsOf } from './fixtures';
import { Reader } from '../src/features/reader/Reader';
import { LabelEditor } from '../src/features/coordinator/editor/LabelEditor';
import { CoordinatorCard } from '../src/features/coordinator/CoordinatorCard';
import { useViewStore } from '../src/state/view-store';
import { replyInDraft, useInputDraft } from '../src/features/coordinator/editor/draft';
import { useConversation } from '../src/features/coordinator/coordinator';
import { taskLabel, textDocument, replyTo, replyIn, inlines, emptyDocument, hasContent, type Document } from '../src/features/coordinator/editor/document';
import { useDraftStore } from '../src/features/forms/draft-store';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { inputPlaceholder } from '../src/features/coordinator/editor/placeholder';
import * as wire from '../src/features/coordinator/editor/wire';
const onSend = vi.fn();
let active: Editor | null;
let input: ReturnType<typeof useInputDraft>;
const catalog = { status: 'ready' as const, profile: 'claude', skills: [] };
function Harness({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation('ui');
  input = useInputDraft(); const editorRef = useRef<Editor | null>(null);
  return <LabelEditor draft={input} catalog={catalog} onSend={onSend} disabled={disabled} attaching tall={false} placeholder={inputPlaceholder(input.doc, t, () => false)} onLong={() => {}} editorRef={editorRef} />;
}
const current = () => (screen.getByRole('textbox') as HTMLElement & { editor: Editor }).editor;
const hintText = () => document.querySelector('[data-draft-hint]')?.getAttribute('data-draft-hint')
  ?? document.querySelector('[data-placeholder]')?.getAttribute('data-placeholder');
beforeAll(() => startI18n());
beforeEach(async () => { onSend.mockClear(); await i18n.changeLanguage('en'); setConversationState({ conversation: { id: 'editor-tests', nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, admitted: {}, cancelled: [], turns: [] } }); });
afterEach(() => { cleanup(); setConversationState({ conversation: null, open: false }); });
const mount = () => render(<TestWorkspace><Harness /></TestWorkspace>);

test('ordinary typing does not scan the whole draft for a task ending before the caret', async () => {
  mount();
  const lexer = vi.spyOn(wire, 'taskTokens');
  act(() => {
    current().commands.setContent(textDocument('Ordinary words. '.repeat(100)));
    current().commands.setTextSelection(current().state.doc.content.size - 1);
    current().commands.insertContent('あ');
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
  expect(current().getText()).toBe(`${'Ordinary words. '.repeat(100)}あ`);
  expect(lexer).not.toHaveBeenCalled();
});

test.each<[string, boolean]>([
  ['T1 ', true], ['t1。', true], ['Ｔ１ ', true], ['ｔ１\n', true], ['T1\n', true],
  ['T1😀', false], ['P100 ', false], ['T1（Task one） ', false],
  ['https://example.com/T1 ', false], ['`T1 ', false], ['> T1 ', false], ['T1A', false],
])('typed suffix %j keeps the full lexer decision', async (text, converts) => {
  mount();
  act(() => {
    current().commands.setContent(textDocument(text));
    current().commands.setTextSelection(current().state.doc.content.size - 1);
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });
  expect(document.querySelector('[data-label-slot=taskLabel]') !== null).toBe(converts);
});

test('task badges are nonselectable atoms; Backspace removes a whole badge and makes the draft the person\'s', async () => {
  mount();
  act(() => current().commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: [taskLabel({ id: 'T1', title: 'Task one' })] }] }));
  expect(current().state.schema.nodes.taskLabel!.spec.selectable).toBe(false);
  expect(current().state.doc.firstChild!.firstChild!.nodeSize).toBe(1);
  act(() => { current().commands.setTextSelection(2); current().commands.keyboardShortcut('Backspace'); });
  expect(screen.queryByText('T1')).toBeNull();
  await waitFor(() => expect(input.entry.values.phase).toBe('composing'));
});
test('no HTML is read as a label: what it says it is is not taken (a paste is looked up, lib/clipboard.ts)', () => {
  mount();
  act(() => current().commands.setContent(`<p><span data-editor-label="taskLabel" data-label-attrs='{"id":"T1","title":"Fake"}'>T1</span></p>`));
  expect(current().state.doc.firstChild!.firstChild!.type.name).toBe('text');
  act(() => current().commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: [taskLabel({ id: 'T1', title: 'Original title' })] }] }));
  expect(current().getText()).toContain('T1（Original title）');
  expect(current().getHTML()).not.toContain('data-label-attrs');
});
test('close, remount and a draft-store reload preserve document JSON and request ID', () => {
  const view = mount();
  act(() => current().commands.setContent(textDocument('Retain after reload')));
  const key = input.key, saved = input.entry.values;
  view.unmount();
  expect(JSON.parse(sessionStorage.getItem('alpacawork-input-drafts-v10')!).entries[key].values.doc).toBe(saved.doc);
  useDraftStore.setState({ entries: JSON.parse(sessionStorage.getItem('alpacawork-input-drafts-v10')!).entries });
  mount();
  expect(current().getText()).toBe('Retain after reload');
  expect(input.entry.values.requestId).toBe(saved.requestId);
});
test('a typed closed ID becomes a label without a live row and reads its actual title', async () => {
  const closed = viewsOf(tree({ tasks: [dto({ id: 'T9001', title: 'Completed task', baseState: 'done' })] })).find(view => view.task.id === 'T9001')!;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(closed)));
  onTestFinished(() => fetcher.mockRestore());
  mount();
  act(() => { current().commands.setContent(textDocument('T9001の')); current().commands.setTextSelection(current().state.doc.content.size - 1); });
  await waitFor(() => expect(document.querySelector('[data-label=task]')?.textContent).toContain('Completed task'));
  expect(document.querySelector('[data-label-id]')?.textContent).toBe('T9001');
});

test('undoing a typed task in the middle of a paragraph keeps the following words and stays literal', async () => {
  mount();
  // The input standing at the foot from the page's start does not take the focus by itself: the person goes into it.
  act(() => { current().commands.focus(); });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox')));
  act(() => { current().commands.setContent(textDocument('T1の続きの文')); current().commands.setTextSelection(4); });
  await waitFor(() => expect(document.querySelector('[data-label=task]')).toBeTruthy());
  act(() => current().commands.keyboardShortcut('Backspace'));
  expect(current().getText()).toBe('T1の続きの文');
  await new Promise(resolve => setTimeout(resolve, 90));
  expect(document.querySelector('[data-label=task]')).toBeNull();
});

test('choices made during conversation loading transfer to the real draft with their request identity', () => {
  setConversationState({ conversation: null }); mount();
  act(() => input.change(() => ({ type: 'doc', content: [{ type: 'paragraph', content: [taskLabel({ id: 'T1', title: 'Task one' }), { type: 'answerLabel', attrs: { question: 'Q1', task: 'T1', n: '1', name: 'Choice', answer: '1-Choice' } }] }] })));
  const requestId = input.entry.values.requestId;
  act(() => setConversationState({ conversation: { id: 'loaded-conversation', nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, admitted: {}, cancelled: [], turns: [] } }));
  expect(current().getText()).toContain('1-Choice'); expect(input.entry.values.requestId).toBe(requestId);
  expect(Object.keys(useDraftStore.getState().entries).some(key => JSON.parse(key)[2] === 'loading')).toBe(false);
});

test('a seed into the loading draft does not reach a draft the person already wrote', () => {
  mount();
  act(() => input.change(() => textDocument('Retained words')));
  act(() => setConversationState({ conversation: null }));
  act(() => input.observe({ panel: { id: 'T1', title: 'Task one' }, project: null }));
  act(() => setConversationState({ conversation: { id: 'editor-tests', nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, admitted: {}, cancelled: [], turns: [] } }));
  expect(current().getText()).toBe('Retained words'); expect(input.entry.values.phase).toBe('composing');
});
test('a selection made immediately after mount is not reset by a deferred autofocus timer', () => {
  vi.useFakeTimers();
  try {
    mount();
    act(() => { current().commands.setContent(textDocument('aXXz')); current().commands.setTextSelection({ from: 2, to: 4 }); });
    act(() => vi.advanceTimersByTime(50));
    expect(current().state.selection.from).toBe(2);
    expect(current().state.selection.to).toBe(4);
    act(() => current().commands.insertContent('voice text'));
    expect(current().getText()).toBe('avoice textz');
  } finally { vi.useRealTimers(); }
});


test.each([{}, { ctrlKey: true }])('Enter sends once without adding a line: %j', modifiers => {
  mount(); const field = screen.getByRole('textbox');
  act(() => current().commands.setContent(textDocument('Text to send')));
  fireEvent.keyDown(field, { key: 'Enter', ...modifiers });
  expect(onSend).toHaveBeenCalledOnce();
  expect(current().getText()).toBe('Text to send');
  expect(current().state.doc.childCount).toBe(1);
});
test('Shift+Enter inserts a line break without sending', () => {
  mount();
  act(() => { current().commands.setContent(textDocument('az')); current().commands.setTextSelection(2); });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', shiftKey: true });
  expect(onSend).not.toHaveBeenCalled();
  expect(current().getJSON().content?.[0]?.content?.map(node => node.type)).toEqual(['text', 'hardBreak', 'text']);
});
test('disabled Enter neither sends nor changes the draft', () => {
  render(<TestWorkspace><Harness disabled /></TestWorkspace>);
  const before = current().getJSON();
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  expect(onSend).not.toHaveBeenCalled(); expect(current().getJSON()).toEqual(before);
});
test.each(['chrome', 'safari'])('%s IME confirming Enter never sends; a later Enter does', async browser => {
  mount(); const field = screen.getByRole('textbox');
  fireEvent.compositionStart(field);
  fireEvent.keyDown(field, { key: 'Enter', keyCode: 229, isComposing: true });
  fireEvent.compositionEnd(field);
  // Safari can finish composition before delivering its confirming keydown.
  if (browser === 'safari') await new Promise(resolve => setTimeout(resolve, 65));
  fireEvent.keyDown(field, { key: 'Enter', keyCode: browser === 'safari' ? 229 : 13, isComposing: false });
  expect(onSend).not.toHaveBeenCalled();
  await new Promise(resolve => setTimeout(resolve, 65));
  fireEvent.keyDown(field, { key: 'Enter' }); expect(onSend).toHaveBeenCalledOnce();
});
test('coarse devices keep Enter as a paragraph and retain explicit send shortcuts', () => {
  const original = window.matchMedia;
  const media = vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ ...original(query), matches: query === '(pointer: coarse)' }));
  try {
    mount(); act(() => current().commands.setContent(textDocument('Onscreen keyboard')));
    const field = screen.getByRole('textbox');
    expect(field.title).toContain('Enter for a new line');
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled(); expect(current().state.doc.childCount).toBe(2);
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true }); expect(onSend).toHaveBeenCalledOnce();
  } finally { media.mockRestore(); }
});
test.each(['#T1', '/alpacawork'])('Enter selects %s without sending or adding a line', async trigger => {
  const skills = [{ name: 'alpacawork', description: 'Management', invocation: '/' }];
  catalog.skills = skills as typeof catalog.skills;
  try {
    mount(); act(() => { current().commands.focus(); current().commands.insertContent(trigger); });
    await screen.findByRole('listbox');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect(current().state.doc.childCount).toBe(1);
    await waitFor(() => expect(document.querySelector(trigger[0] === '#' ? '[data-label=task]' : '[data-label=skill]')).toBeTruthy());
  } finally { catalog.skills = []; }
});
test('the / list keeps the skill chosen with the arrows while more is typed', async () => {
  catalog.skills = [
    { name: 'alpha', description: 'First', invocation: '/' },
    { name: 'alpine', description: 'Second', invocation: '/' },
  ] as typeof catalog.skills;
  try {
    mount(); act(() => { current().commands.focus(); current().commands.insertContent('/a'); });
    await screen.findByRole('listbox');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getByRole('option', { selected: true }).textContent).toContain('alpine'));
    act(() => { current().commands.insertContent('l'); });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    expect(screen.getByRole('option', { selected: true }).textContent).toContain('alpine');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(document.querySelector('[data-label=skill]')?.textContent).toContain('alpine'));
  } finally { catalog.skills = []; }
});
test('Enter with no matching candidates is consumed without sending', async () => {
  mount(); act(() => { current().commands.focus(); current().commands.insertContent('#zzzznomatch'); });
  await screen.findByRole('listbox');
  expect(fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })).toBe(false);
  expect(onSend).not.toHaveBeenCalled(); expect(current().getText()).toBe('#zzzznomatch');
});

test.each(['#T', '/al'])('a press outside the %s list closes it and leaves the words as written', async trigger => {
  mount(); act(() => { current().commands.focus(); current().commands.insertContent(`Words ${trigger}`); });
  await screen.findByRole('listbox');
  // A press inside the list or the words keeps it.
  fireEvent.pointerDown(screen.getByRole('textbox'));
  expect(screen.queryByRole('listbox')).not.toBeNull();
  // Nor does a press that opens a Task in the panel: the list follows the panel.
  const row = document.body.appendChild(Object.assign(document.createElement('button'), { textContent: 'T2' }));
  row.dataset.read = 'T2';
  fireEvent.pointerDown(row);
  expect(screen.queryByRole('listbox')).not.toBeNull();
  row.remove();
  fireEvent.pointerDown(document.body);
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  expect(current().getText()).toBe(`Words ${trigger}`);
  // Closed, it does not come back by itself on the next change elsewhere in the draft.
  act(() => { current().commands.focus('start'); current().commands.insertContent('More '); });
  expect(screen.queryByRole('listbox')).toBeNull();
});

test('the project Task the screen is narrowed to seeds a task badge, removable like any, and no project badge', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(snapshotJson(url.startsWith('/api/coordinator/skills')
    ? { status: 'unavailable', profile: 'claude', skills: [], reason: 'test' }
    : { id: 'editor-tests', nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, admitted: {}, cancelled: [], turns: [] }))));
  onTestFinished(() => { vi.unstubAllGlobals(); useViewStore.setState(useViewStore.getInitialState()); });
  useViewStore.setState({ project: PROJECT_TASK, selected: null, navigationReady: true });
  setConversationState({ open: true, read: true, error: null });
  render(<TestWorkspace><CoordinatorCard /></TestWorkspace>);
  const badge = await waitFor(() => {
    const found = document.querySelector<HTMLElement>('[data-label=task]');
    expect(found).not.toBeNull();
    return found!;
  });
  // A project's label says the project, not a task: its square and its name, no ID and no state.
  expect(badge.hasAttribute('data-label-project')).toBe(true);
  expect(badge.textContent).toBe('default');
  expect(badge.querySelector('[data-project-tile]')).not.toBeNull();
  expect(badge.querySelector(`[aria-label="Remove ${PROJECT_TASK}"]`)).not.toBeNull();
  expect(document.querySelector('[data-label=project]')).toBeNull();
});

test('a task-only draft shows its recipient after the label without writing to the draft', async () => {
  const view = mount();
  const doc: Document = { type: 'doc', content: [{ type: 'paragraph', content: [taskLabel({ id: 'T1', title: 'Task one' })] }] };
  act(() => current().commands.setContent(doc));
  const saved = input.entry.values, key = input.key;
  await waitFor(() => expect(document.querySelector('[data-one-input] [data-draft-hint]')?.getAttribute('data-draft-hint')).toBe('Instructions or questions about T1'));
  const slot = document.querySelector('[data-label-slot=taskLabel]')!;
  expect(slot.getAttribute('data-draft-hint')).toBe('Instructions or questions about T1');
  expect(slot.childNodes).toHaveLength(0);
  expect(current().getJSON()).toEqual(doc);
  expect(current().getText()).not.toContain('Instructions or questions about');
  act(() => current().commands.insertContent(' My words'));
  expect(document.querySelector('[data-draft-hint], [data-placeholder]')).toBeNull();
  expect(current().getText()).toContain('My words');
  // Repeated renders and a language change only change the decoration, never retained words or request identity.
  const written = input.entry.values.doc;
  await act(() => i18n.changeLanguage('ja'));
  view.rerender(<TestWorkspace><Harness /></TestWorkspace>);
  expect(input.entry.values.doc).toBe(written);
  expect(input.entry.values.requestId).toBe(saved.requestId);
  expect(input.key).toBe(key);
});

test('whitespace and breaks keep the hint, while a skill or answer hides it', async () => {
  mount();
  const blank: Document = { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: ' \t' }, { type: 'hardBreak' },
  ] }, { type: 'paragraph' }] };
  act(() => current().commands.setContent(blank));
  expect(hasContent(blank)).toBe(false);
  await waitFor(() => expect(hintText()).toBeTruthy());
  const contents: Document[] = [
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'skillLabel', attrs: { name: 'alpacawork', invocation: '/' } }] }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'answerLabel', attrs: { task: 'T1', question: 'Q1', n: '1', name: 'Yes', answer: 'Yes' } }] }] },
  ];
  for (const content of contents) {
    act(() => current().commands.setContent(content));
    expect(hasContent(content)).toBe(true);
    await waitFor(() => expect(hintText()).toBeUndefined());
  }
});

test('the recipient hint follows the first distinct draft label and its language, rather than the viewed task', async () => {
  mount();
  act(() => useViewStore.setState({ selected: 'T9', reader: { ...useViewStore.getState().reader, open: true } }));
  const one = taskLabel({ id: 'T1', title: 'Task one' });
  const other = taskLabel({ id: 'T2', title: 'Task two' });
  const doc: Document = { type: 'doc', content: [{ type: 'paragraph', content: [one, one] }, { type: 'paragraph', content: [other] }] };
  act(() => current().commands.setContent(doc));
  await waitFor(() => expect(hintText()).toBe('Instructions or questions about T1 and others'));
  const saved = input.entry.values.doc;
  await act(() => i18n.changeLanguage('ja'));
  await waitFor(() => expect(hintText()).toBe('T1ほか 関連の指示・質問'));
  expect(input.entry.values.doc).toBe(saved);
  expect(current().getJSON()).toEqual(doc);
  act(() => current().commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: [other] }] }));
  await waitFor(() => expect(hintText()).toBe('T2 関連の指示・質問'));
  act(() => current().commands.clearContent());
  await waitFor(() => expect(hintText()).toBe('タスクの管理も作業の依頼も、すべてここで'));
});


test('loading draft merge keeps one reply reference and the retained reply wins', async () => {
  const retained = { id: 'retained-reply', answeredAt: '2026-10-22T11:00:00Z' };
  const incoming = { id: 'incoming-reply', answeredAt: '2026-10-22T11:01:00Z' };
  mount();
  act(() => input.change(() => replyTo(textDocument('Retained words'), retained)));
  act(() => setConversationState({ conversation: null }));
  // QueryCache delivers removals through its scheduled subscription; edit only once the loading draft is actually shown.
  await waitFor(() => expect(JSON.parse(input.key)[2]).toBe('loading'));
  act(() => input.change(() => replyTo(textDocument('Loading words'), incoming)));
  act(() => setConversationState({ conversation: { id: 'editor-tests', nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, admitted: {}, cancelled: [], turns: [] } }));
  expect(replyIn(input.doc)).toEqual(retained);
  expect(inlines(input.doc).filter(node => node.type === 'replyLabel')).toHaveLength(1);
  expect(current().getText()).toContain('Retained words'); expect(current().getText()).toContain('Loading words');
});

test('the reply icon takes the draft\'s Task labels off for good: the Task in view does not seed them back, and a remount keeps it', async () => {
  const reply = { id: 'reply-press', answeredAt: '2026-10-22T11:00:00Z' };
  mount();
  act(() => input.observe({ panel: { id: 'T315', title: 'In view' }, project: null }));
  await waitFor(() => expect(document.querySelector('[data-label=task]')).toBeTruthy());
  act(() => replyInDraft(reply));
  await waitFor(() => expect(document.querySelector('[data-label=reply]')).toBeTruthy());
  expect(inlines(input.doc).map(node => node.type)).toEqual(['replyLabel']);
  expect(document.querySelector('[data-label=task]')).toBeNull();
  act(() => { input.observe({ panel: { id: 'T315', title: 'In view' }, project: null }); input.observe({ panel: { id: 'T400', title: 'Opened next' }, project: null }); });
  expect(inlines(input.doc).map(node => node.type)).toEqual(['replyLabel']);
  act(() => input.change(doc => ({ ...doc, content: [...doc.content, { type: 'paragraph', content: [taskLabel({ id: 'T7', title: 'Put in' }), { type: 'text', text: ' about T8' }] }] })));
  act(() => replyInDraft(reply));
  expect(inlines(input.doc).map(node => node.type === 'text' ? node.text : node.type)).toEqual(['replyLabel', ' about T8']);
  const saved = input.entry.values.doc;
  cleanup(); mount();
  expect(input.entry.values.doc).toBe(saved);
  await waitFor(() => expect(document.querySelector('[data-label=reply]')).toBeTruthy());
  expect(document.querySelector('[data-label=task]')).toBeNull();
});

test('a reply-only label keeps the hint after it and Backspace removes it as an ordinary atom', async () => {
  mount();
  act(() => input.change(() => replyTo(emptyDocument(), { id: 'reply-only', answeredAt: '2026-10-22T11:00:00Z' })));
  await waitFor(() => expect(document.querySelector('[data-label-slot=replyLabel][data-draft-hint]')).toBeTruthy());
  await waitFor(() => expect(document.querySelector('[data-label-layer] [data-label=reply]')).toBeTruthy());
  act(() => { current().commands.setTextSelection(2); current().commands.keyboardShortcut('Backspace'); });
  expect(replyIn(input.doc)).toBeUndefined(); expect(document.querySelector('[data-label=reply]')).toBeNull();
});

test.each(['「', '```'])('typed IDs inside %s begun in an earlier paragraph stay words', async marker => {
  mount();
  act(() => { current().commands.setContent(textDocument(marker + '\nT1 ')); current().commands.setTextSelection(current().state.doc.content.size - 1); });
  await new Promise(resolve => setTimeout(resolve, 120));
  expect(current().state.doc.childCount).toBe(2);
  expect(document.querySelector('[data-label=task]')).toBeNull();
});

test('a typed target in a later paragraph converts and Backspace restores its spelling once', async () => {
  mount();
  act(() => { current().commands.setContent(textDocument('Earlier paragraph\nT1 ')); current().commands.setTextSelection(current().state.doc.content.size - 1); });
  await waitFor(() => expect(document.querySelector('[data-label=task]')).toBeTruthy());
  act(() => current().commands.keyboardShortcut('Backspace'));
  expect(current().getText()).toBe('Earlier paragraph\n\nT1 ');
  await new Promise(resolve => setTimeout(resolve, 120));
  expect(document.querySelector('[data-label=task]')).toBeNull();
});


test('# list marks the viewed task first, filters it, follows another panel and resets keyboard selection', async () => {
  const tasks = [
    taskFixture({ id: 'T11', title: 'September monthly close', log: [] }),
    taskFixture({ id: 'T113', title: 'Another task', log: [] }),
    ...Array.from({ length: 14 }, (_, n) => taskFixture({ id: `T${200 + n}`, title: `List extension item ${n + 1}`,
      log: [{ id: `L${n}`, kind: 'created', at: `2026-10-01T00:${String(n).padStart(2, '0')}:00Z`, title: null,
        description: null, fromState: null, toState: null, actor: { kind: 'human' }, userRequested: false }] })),
  ];
  useViewStore.getState().openTask('T11', { reader: true });
  render(<TestWorkspace data={screenData(tree({ tasks }))}><Reader mode="docked" /><Harness /></TestWorkspace>);
  const enter = (text: string) => act(() => { current().commands.setContent(textDocument(text)); current().commands.focus('end'); });
  const options = () => screen.getAllByRole('option');
  const ids = () => options().map(row => row.children[1]!.textContent);
  const viewing = () => options().filter(row => row.querySelector('[data-viewing]'));
  enter('#');
  await waitFor(() => expect(options()).toHaveLength(12));
  expect(options()[0]!.textContent).toContain('T11'); expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
  expect(options()[0]!.querySelector('[data-viewing]')!.textContent).toBe('Viewing'); expect(viewing()).toHaveLength(1);
  expect(options().filter(row => row.textContent!.includes('September monthly close'))).toHaveLength(1);
  expect(document.querySelector('[data-reader-task-id]')!.textContent).toBe('T11');
  const shownFirst = ids();
  enter('#List');
  await waitFor(() => expect(options()[0]!.textContent).toContain('List extension item 14'));
  expect(viewing()).toHaveLength(0);
  enter('#September');
  await waitFor(() => expect(options()[0]!.textContent).toContain('T11')); expect(viewing()).toHaveLength(1);
  enter('#'); await waitFor(() => expect(options()).toHaveLength(12));
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowDown' }); fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowDown' });
  expect(options()[2]!.getAttribute('aria-selected')).toBe('true');
  act(() => useViewStore.getState().openTask('T113', { reader: true }));
  await waitFor(() => expect(viewing()[0]!.textContent).toContain('T113'));
  expect(document.querySelector('[data-reader-task-id]')!.textContent).toBe('T113');
  expect(options()[0]!.textContent).toContain('T113'); expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  expect(document.querySelector('[data-label=task]')!.textContent).toContain('T113');
  act(() => useViewStore.getState().closeReader()); enter('#');
  await waitFor(() => expect(options()).toHaveLength(12)); expect(viewing()).toHaveLength(0);
  expect(document.querySelector('aside[data-reader-mode]')).toBeNull();
  expect(options().filter(row => row.textContent!.includes('September monthly close'))).toHaveLength(0);
  expect(shownFirst.slice(1)).toEqual(ids().slice(0, 11)); expect(new Set(shownFirst).size).toBe(12);
});


test('a project is chosen by its P ID and never by stripping the T prefix', async () => {
  mount();
  act(() => { current().commands.focus(); current().commands.insertContent('#' + PROJECT_TASK); });
  await screen.findByRole('listbox');
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  await waitFor(() => expect(current().getText()).toContain(PROJECT_TASK + '（default）'));
  act(() => { current().commands.setContent(textDocument('')); current().commands.focus(); current().commands.insertContent('#T' + PROJECT_TASK.slice(1)); });
  await screen.findByRole('listbox');
  expect(screen.getByText('No matching items')).toBeTruthy();
});

test('pending words leave the editor immediately; editing identical next words preserves the retained original through admission', () => {
  mount();
  act(() => { current().commands.setContent(textDocument('same')); });
  const id = input.entry.values.requestId!, key = input.key;
  act(() => { freeze('/fixture', { conversationId: 'editor-tests', text: 'same', attachments: [] }, input.entry.values, { from: key }); });
  expect(current().getText()).toBe('');
  expect(useDraftStore.getState().entries[key]!.values.doc).toContain('same');
  act(() => {
    current().commands.insertContent('same same');
    current().commands.deleteRange({ from: 1, to: 6 });
  });
  expect(current().getText()).toBe('same');
  const entries = { ...useDraftStore.getState().entries };
  expect(consumeInput(entries, entries[outgoingKey('/fixture', id)]!)).toBe(true);
  expect(serialize(draftDocument(entries[key]!.values))).toBe('same');
});


test.each(['reply', 'change', 'intend'] as const)('programmatic %s edits only the visible input while the earlier reply/body stay retained', kind => {
  mount();
  act(() => current().commands.setContent(replyTo(textDocument('original message'), { id: 'answer-one', answeredAt: '2026-11-05T00:00:00Z' })));
  const id = input.entry.values.requestId!, key = input.key;
  act(() => { freeze('/fixture', { conversationId: 'editor-tests', text: 'original message', replyTo: 'answer-one', attachments: [] }, input.entry.values, { from: key }); });
  const fixed = useDraftStore.getState().entries[outgoingKey('/fixture', id)]!.values.submitted;
  expect(serialize(input.doc)).toBe('');
  act(() => {
    if (kind === 'reply') replyInDraft({ id: 'answer-two', answeredAt: '2026-11-05T00:01:00Z' });
    else if (kind === 'change') input.change(() => textDocument('new words'));
    else {
      const task = screenData(tree()).tasks.find(task => task.id === 'T1')!;
      input.intend(task, { task: task.id, action: 'sendback', expectedTaskHash: task.hash }, 'new words');
    }
  });
  expect(serialize(input.doc)).not.toContain('original message');
  if (kind === 'reply') expect(replyIn(input.doc)?.id).toBe('answer-two');
  else expect(serialize(input.doc)).toContain('new words');
  const visible = input.doc, entries = { ...useDraftStore.getState().entries };
  expect(serialize(draftDocument(entries[key]!.values))).toContain('original message');
  expect(entries[outgoingKey('/fixture', id)]!.values.submitted).toBe(fixed);
  expect(consumeInput(entries, entries[outgoingKey('/fixture', id)]!)).toBe(true);
  expect(draftDocument(entries[key]!.values)).toEqual(visible);
});


test.each(['delete text', 'delete paragraphs and reply', 'delete empty paragraph', 'replace all', 'replace document'] as const)('a retained send survives native whole-input editing: %s', edit => {
  mount();
  const original = replyTo(textDocument('retained words\n\n😀'), { id: 'original-answer', answeredAt: '2026-11-05T00:00:00Z' });
  act(() => current().commands.setContent(original));
  const id = input.entry.values.requestId!, key = input.key;
  act(() => { freeze('/fixture', { conversationId: 'editor-tests', text: serialize(original), replyTo: 'original-answer', attachments: [] }, input.entry.values, { from: key }); });
  const fixed = useDraftStore.getState().entries[outgoingKey('/fixture', id)]!.values.submitted;
  act(() => input.change(() => edit === 'delete empty paragraph' ? textDocument('\n') : edit === 'delete paragraphs and reply'
    ? replyTo(textDocument('next\n\nwords'), { id: 'next-answer', answeredAt: '2026-11-05T00:01:00Z' }) : textDocument('next words')));
  act(() => {
    if (edit === 'replace document') current().commands.setContent(textDocument('replacement\n\nwords'));
    else {
      current().commands.selectAll();
      if (edit === 'replace all') current().commands.insertContent(textDocument('replacement\n\nwords'));
      else current().commands.keyboardShortcut('Backspace');
    }
  });
  expect(input.doc).toEqual(parseDocument(current().getJSON()));
  expect(serialize(input.doc)).toBe(edit.startsWith('replace') ? 'replacement\n\nwords' : '');
  act(() => { current().commands.setTextSelection(current().state.doc.content.size - 1); current().commands.insertContent('after'); });
  const visible = input.doc, entries = { ...useDraftStore.getState().entries };
  expect(serialize(visible)).not.toContain('retained words');
  expect(serialize(visible)).toContain('after');
  expect(serialize(draftDocument(entries[key]!.values))).toContain('retained words');
  expect(entries[outgoingKey('/fixture', id)]!.values.submitted).toBe(fixed);
  expect(consumeInput(entries, entries[outgoingKey('/fixture', id)]!)).toBe(true);
  expect(draftDocument(entries[key]!.values)).toEqual(visible);
});

test.each(['clear before cancelling', 'keep until manual recovery', 'send newer reply before recovery'] as const)('cancelled reply recovers its complete context: %s', recovery => {
  mount();
  const reply = { id: 'answer-one', answeredAt: '2026-11-05T00:00:00Z' };
  act(() => current().commands.setContent(replyTo(textDocument('original message'), reply)));
  const id = input.entry.values.requestId!, key = input.key;
  act(() => { freeze('/fixture', { conversationId: 'editor-tests', text: 'original message', replyTo: reply.id, attachments: [] }, input.entry.values, { from: key }); });
  const fixed = useDraftStore.getState().entries[outgoingKey('/fixture', id)]!.values.submitted;
  act(() => replyInDraft({ id: 'answer-two', answeredAt: '2026-11-05T00:01:00Z' }));
  const clearReply = () => input.change(doc => filterDocument(doc, node => node.type !== 'replyLabel'));
  if (recovery === 'clear before cancelling') act(clearReply);
  act(() => { expect(cancelUnsent('/fixture', id)).toBe('cancelled'); });
  if (recovery !== 'clear before cancelling') {
    expect(replyIn(input.doc)?.id).toBe('answer-two');
    expect(serialize(input.doc)).toBe('');
    expect(useDraftStore.getState().entries[outgoingKey('/fixture', id)]!.values.taken).toBeUndefined();
    expect(canTakeBack(useDraftStore.getState().entries, '/fixture', id, key)).toBe(false);
    if (recovery === 'send newer reply before recovery') {
      act(() => input.change(doc => ({ ...doc, content: [...doc.content, ...textDocument('next words').content] })));
      const nextId = input.entry.values.requestId!;
      act(() => {
        expect(freeze('/fixture', { conversationId: 'editor-tests', text: 'next words', replyTo: 'answer-two', attachments: [] }, input.entry.values, { from: key })).toBe(nextId);
        reconcileOutbox(served({ id: 'editor-tests', nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: true, admitted: {}, cancelled: [], turns: [{ id: nextId, at: '', ask: 'next words', replyTo: { id: 'answer-two', answeredAt: '2026-11-05T00:01:00Z', head: '' }, attachments: [], status: 'queued', waiting: true, answer: null, answeredAt: null, seen: false, error: null, result: null }] }), '/fixture', key);
      });
    } else act(clearReply);
    expect(serialize(input.doc)).toBe('');
    expect(canTakeBack(useDraftStore.getState().entries, '/fixture', id, key)).toBe(true);
    act(() => { expect(takeBack('/fixture', id, key)).toBe(true); });
  }
  expect(serialize(input.doc)).toBe('original message');
  expect(replyIn(input.doc)).toEqual(reply);
  expect(useDraftStore.getState().entries[outgoingKey('/fixture', id)]!.values.submitted).toBe(fixed);
  expect(canTakeBack(useDraftStore.getState().entries, '/fixture', id, key)).toBe(false);
});
