import { setConversationState, SERVED } from './conversation-fixture';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { CoordinatorCapsule } from '../src/features/coordinator/CoordinatorCapsule';
import { fittingLabels, previewContent } from '../src/features/coordinator/DraftPreview';
import { emptyDocument, taskLabel, textDocument, type Document, type Inline } from '../src/features/coordinator/editor/document';
import { useConversation } from '../src/features/coordinator/coordinator';
import { focusCoordinator } from '../src/features/coordinator/editor/draft';
import { useReaderSend } from '../src/features/coordinator/reader-send';

const source = vi.hoisted(() => ({ value: undefined as any, listeners: new Set<() => void>() }));
vi.mock('../src/features/coordinator/editor/draft', async () => {
  const { useSyncExternalStore } = await import('react');
  return { useInputDraft: () => useSyncExternalStore(listener => {
    source.listeners.add(listener); return () => { source.listeners.delete(listener); };
  }, () => source.value), focusCoordinator: vi.fn() };
});
const index = { byId: new Map() };
vi.mock('../src/data/queries', () => ({ useWorkspaceWritable: () => true, useWriteDisabled: () => false, useEveryTaskIndex: () => index, useProjects: () => [] }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => ({ 'coordinatorCard.draft': 'Draft', 'coordinatorCard.attached': 'Attachments only', 'ui:input.placeholderFolded': 'Ask for anything here' })[key] ?? key }) }));
const answer: Inline = { type: 'answerLabel', attrs: { task: 'T111', question: 'Q1', n: '1', name: 'Continue with it', answer: '1-Continue' } };
const doc = (...content: Inline[]): Document => ({ type: 'doc', content: [{ type: 'paragraph', content }] });
function draft(document: Document, attachments = '[]') {
  act(() => {
    source.value = { doc: document, entry: { values: { doc: JSON.stringify(document), attachments } } };
    source.listeners.forEach(listener => listener());
  });
}
beforeEach(() => { useReaderSend.setState({ sendDraft: null }); setConversationState({ conversation: { id: 'test', nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, cancelled: [], turns: [] }, error: null, wanted: false, trying: false }); });
afterEach(() => { cleanup(); document.querySelector('meta[name="alpacawork-voice"]')?.remove(); });

test('the projection reads structured labels, orders recipients before choices and leaves the document intact', () => {
  const input = doc({ type: 'text', text: 'Words T999 1-pretend' }, answer, taskLabel({ id: 'T111', title: 'Task' }));
  const before = structuredClone(input), projected = previewContent(input);
  expect(projected.labels.map(label => label.type)).toEqual(['taskLabel', 'answerLabel']);
  expect(projected.text).toBe('Words T999 1-pretend');
  expect(input).toEqual(before);
});

test('fitting reserves the count, keeps whole answer names and gives up task titles before labels', () => {
  expect(fittingLabels(220, [60, 100], 22, 2)).toBe(2);
  expect(fittingLabels(140, [60, 100], 22, 2)).toBe(1);
  expect(fittingLabels(40, [60, 100], 22, 2)).toBe(0);
  expect(fittingLabels(220, [60, 100, 80], 22, 2)).toBe(2);
});

for (const [name, document] of [
  ['task, choice and words', doc(taskLabel({ id: 'T111', title: 'Task' }), answer, { type: 'text', text: 'My words' })],
  ['multiple labels', doc(taskLabel({ id: 'T111', title: 'One' }), taskLabel({ id: 'T112', title: 'Two' }), answer)],
  ['only words', textDocument('Only my words')],
] as const) test(`${name}: preview opens the unchanged draft, with no edit tools inside it`, () => {
  draft(document);
  const before = JSON.stringify(document), view = render(<CoordinatorCapsule />);
  const button = view.container.querySelector<HTMLButtonElement>('[data-coordinator-write]')!;
  expect(button.querySelector('button,[tabindex]')).toBeNull();
  expect(button.querySelector('[data-icon=edit],[data-icon=close]')).toBeNull();
  expect(button.getAttribute('aria-label')).toMatch(/^Draft /);
  fireEvent.click(button);
  expect(focusCoordinator).toHaveBeenCalled();
  expect(JSON.stringify(document)).toBe(before);
});

test('empty and attachment-only drafts keep their respective guidance', () => {
  draft(emptyDocument());
  const view = render(<CoordinatorCapsule />);
  expect(view.getByRole('button').textContent).toBe('Ask for anything here');
  draft(emptyDocument(), JSON.stringify([{ name: 'note.txt', path: 'attachments/note.txt', absolutePath: '/note.txt', size: 1 }]));
  // Its own draft subscription updates the memoized line.
  expect(view.container.querySelector('[data-coordinator-write]')?.textContent).toBe('Attachments only');
});

test('the folded action shares content meaning and the sender gate, including when voice is unavailable', () => {
  const meta = document.createElement('meta'); meta.name = 'alpacawork-voice'; document.head.append(meta);
  const task = taskLabel({ id: 'T112', title: 'Another task' });
  draft(doc(task));
  const view = render(<CoordinatorCapsule />);
  expect(view.container.querySelector('[data-coordinator-speak]')).toBeNull();
  const send = vi.fn().mockReturnValue('retained');
  act(() => { useReaderSend.setState({ sendDraft: send }); });
  for (const content of [doc(task, answer), textDocument('Words'), doc(task, answer, { ...answer, attrs: { ...answer.attrs, n: '2' } })]) {
    draft(content); view.rerender(<CoordinatorCapsule />);
    expect(view.container.querySelector('[data-coordinator-speak]')).toBeNull();
    fireEvent.click(view.container.querySelector('[data-ask-send]')!);
  }
  expect(send).toHaveBeenCalledTimes(3);
  act(() => { useReaderSend.setState({ sendDraft: null }); });
  view.rerender(<CoordinatorCapsule />);
  // Without a sender a press sends nothing; the button dims only once that lasts (steady-control).
  fireEvent.click(view.container.querySelector('[data-ask-send]')!);
  expect(send).toHaveBeenCalledTimes(3);
  draft(doc(task)); view.rerender(<CoordinatorCapsule />);
  expect(view.container.querySelector('[data-coordinator-speak]')).toBeNull();
  expect(view.container.querySelector('[data-ask-send]')).toBeNull();
  meta.remove();
  draft(emptyDocument(), JSON.stringify([{ name: 'note.txt', path: 'attachments/note.txt', absolutePath: '/note.txt', size: 1 }]));
  view.rerender(<CoordinatorCapsule />);
  expect(view.container.querySelector('[data-ask-send]')).not.toBeNull();
});

for (const admission of ['rejected', 'retained', 'retired'] as const) test(`folded send ${admission}: only a refusal opens the existing input`, () => {
  draft(textDocument('Keep these words'));
  vi.mocked(focusCoordinator).mockClear();
  const send = vi.fn().mockReturnValue(admission); act(() => { useReaderSend.setState({ sendDraft: send }); });
  const view = render(<CoordinatorCapsule />);
  fireEvent.click(view.container.querySelector('[data-ask-send]')!);
  expect(send).toHaveBeenCalledOnce();
  expect(focusCoordinator).toHaveBeenCalledTimes(admission === 'rejected' ? 1 : 0);
  expect(source.value.doc).toEqual(textDocument('Keep these words'));
});
