/** Admission consumes an answer's body while its Task remains the next message's context. */
import { beforeAll, beforeEach, expect, test } from 'vitest';
import { i18n, startI18n } from '@alpacawork/i18n';
import { availableInput, freeze, reconcileOutbox, returnReaderSubmission, restoreReaderDraft, useOutbox } from '../src/features/coordinator/editor/outbox';
import { draftKey, useDraftStore } from '../src/features/forms/draft-store';
import { emptyDocument, toggleAnswer, inlines, draftDocument, textDocument, taskLabel, taskReferencesIn } from '../src/features/coordinator/editor/document';
import { useConversation } from '../src/features/coordinator/coordinator';
import { mutateInput } from '../src/features/coordinator/editor/draft';
import { observed } from '../src/features/coordinator/editor/lifecycle';
import { setConversationState, SERVED } from './conversation-fixture';

const root = '/fixture', cid = 'answer-context', key = draftKey(root, 'coordinator', cid);
const conversation = (turns: any[] = []) => ({ id: cid, nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, cancelled: [], turns });
beforeAll(async () => { await startI18n(); await i18n.changeLanguage('en'); });
beforeEach(() => {
  useDraftStore.setState({ entries: {}, unavailable: false });
  useOutbox.setState({ live: new Set(), resend: null });
  setConversationState({ ...useConversation.getInitialState(), root, conversation: conversation(), open: true, expanded: true, read: true });
});
for (const shared of [false, true]) test(`an admitted reader answer retains its Task context${shared ? ' after a shared recipient' : ''}`, () => {
  const id = crypto.randomUUID();
  const doc = toggleAnswer(emptyDocument(), { id: 'T1', title: 'First task' },
    { task: 'T1', question: 'Q1', n: '1', name: 'Yes', answer: '1-Yes' });
  // A shared recipient precedes the reader-owned answer.
  if (shared) doc.content[0]!.content!.unshift({ type: 'taskLabel', attrs: { id: 'T5', title: 'Shared task' } });
  useDraftStore.setState({ entries: { [key]: { status: 'editing', values: { doc: JSON.stringify(doc), requestId: id } } } });
  freeze(root, { conversationId: cid, text: '1-Yes', attachments: [] },
    useDraftStore.getState().entries[key]!.values, { from: key },
    [{ taskId: 'T1', title: 'First task', turn: 'Q1', phase: 'doing', kind: 'answer', answer: 'send', expectedWrites: null }]);
  reconcileOutbox(conversation([{ id, at: '2026-11-05T00:00:00Z', ask: '1-Yes', attachments: [],
    status: 'running', waiting: false, answer: null, seen: false, answeredAt: null, error: null }]), root, null);
  const values = useDraftStore.getState().entries[key]!.values, left = inlines(draftDocument(values));
  expect(left.filter(node => node.type === 'taskLabel').map(node => node.attrs.id)).toEqual(shared ? ['T5', 'T1'] : ['T1']);
  expect(left.filter(node => node.type !== 'taskLabel')).toEqual([]);
  expect(values.phase).toBe('prepared');
  expect(values.requestId).not.toBe(id);
});


test('a reader send follows the next Task without resurrecting its recipient on late admission', () => {
  const original = { id: 'T1', title: 'First task' }, next = { id: 'T2', title: 'Next task' };
  const id = crypto.randomUUID();
  const doc = toggleAnswer(emptyDocument(), original,
    { task: original.id, question: 'Q1', n: '1', name: 'Yes', answer: '1-Yes' });
  useDraftStore.setState({ entries: { [key]: { status: 'editing', values: { doc: JSON.stringify(doc), phase: 'composing', seen: original.id, requestId: id } } } });
  freeze(root, { conversationId: cid, text: 'T1 1-Yes', attachments: [] },
    useDraftStore.getState().entries[key]!.values, { from: key },
    [{ taskId: 'T1', title: original.title, turn: 'Q1', phase: 'doing', kind: 'answer', answer: 'send', expectedWrites: null }]);
  mutateInput(key, values => observed(values, { panel: next, project: null }));
  const visible = () => inlines(draftDocument(availableInput(useDraftStore.getState().entries, root, key)!));
  expect(visible()).toEqual([{ type: 'taskLabel', attrs: next }]);
  reconcileOutbox(conversation([{ id, at: '2026-11-05T00:00:00Z', ask: 'T1 1-Yes', attachments: [],
    status: 'running', waiting: false, answer: null, seen: false, answeredAt: null, error: null }]), root, null);
  expect(visible()).toEqual([{ type: 'taskLabel', attrs: next }]);
  expect(inlines(draftDocument(useDraftStore.getState().entries[key]!.values))).toEqual(visible());
});


// Recovery must return the original recipients, independent of whether HTTP admission happened.
for (const answer of [true, false]) test(`a refused reader ${answer ? 'choice' : 'free-text answer'} returns with its own recipient after navigation`, () => {
  const original = { id: 'T1', title: 'First task' }, next = { id: 'T2', title: 'Next task' };
  const id = crypto.randomUUID();
  const doc = answer ? toggleAnswer(emptyDocument(), original,
    { task: original.id, question: 'Q1', n: '1', name: 'Yes', answer: '1-Yes' }) : textDocument('Please explain this task');
  if (!answer) doc.content[0]!.content!.unshift(taskLabel(original));
  const values = { doc: JSON.stringify(doc), phase: 'composing', seen: original.id, requestId: id };
  useDraftStore.setState({ entries: { [key]: { status: 'editing', values } } });
  freeze(root, { conversationId: cid, text: 'Original answer', attachments: [] }, values, { from: key },
    [{ taskId: original.id, title: original.title, turn: 'Q1', phase: 'doing', kind: 'answer', answer: 'send', expectedWrites: null }]);
  mutateInput(key, values => observed(values, { panel: next, project: null }));
  returnReaderSubmission(root, id, 'refused');
  expect(restoreReaderDraft(root, cid, original.id)).toBe(true);
  const restored = draftDocument(availableInput(useDraftStore.getState().entries, root, key)!);
  expect([...taskReferencesIn(restored, [])]).toEqual([original.id]);
  expect(restored).toEqual(doc);
});
