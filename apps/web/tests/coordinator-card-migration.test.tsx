import { readConversationThroughOwner, SERVED } from './conversation-fixture';
import { queryClient } from '../src/data/query-client';
import { snapshotJson } from './conversation-fixture';
import { setConversationState } from './conversation-fixture';
/** Full reader/card wiring. Geometry, focus motion and native History stay in browser checks. */
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { i18n, startI18n } from '@alpacawork/i18n';
import { CoordinatorCard } from '../src/features/coordinator/CoordinatorCard';
import { Toaster } from '../src/components/ui/toaster';
import { notify, useToasts } from '../src/lib/notify';
import { Reader } from '../src/features/reader/Reader';
import { useConversation } from '../src/features/coordinator/coordinator';
import { outgoingKey, useOutbox } from '../src/features/coordinator/editor/outbox';
import { textDocument } from '../src/features/coordinator/editor/document';
import { draftKey, readDrafts, useDraftStore } from '../src/features/forms/draft-store';
import { useReaderSend } from '../src/features/coordinator/reader-send';
import { useViewStore } from '../src/state/view-store';
import { setAutoSwipe, useSitting } from '../src/features/reader/next-question';
import { useTaskActionSlot } from '../src/features/coordinator/task-action-slot';
import { TestWorkspace, at, dto, logEntry, narrowScreen, screenData, taskFixture, tree, userBall } from './fixtures';
const root = '/fixture', cid = 'card-migration';
const empty = (id = cid) => ({ id, nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, cancelled: [], turns: [] as any[] });
const reply = (value: unknown) => new Response(snapshotJson(value));
const review = taskFixture({ id: 'T1', state: 'waiting', title: 'Review', log: [logEntry({ id: 'L1', kind: 'reported', toState: 'waiting' })],
  ball: userBall('review', 'L1', at, { aboutRunId: 'R1' }) });
const data = () => screenData(tree({ tasks: [review, dto({ id: 'T2', state: 'doing', title: 'Working' })] }));
const field = () => document.querySelector('[data-one-input]')!;
const input = (text: string) => act(() => { (field() as HTMLElement & { editor: import('@tiptap/react').Editor }).editor.commands.setContent(textDocument(text)); });
let current = empty();
let posted: any[];
beforeAll(async () => { await startI18n(); await i18n.changeLanguage('en'); });
beforeEach(async () => {
  sessionStorage.clear(); localStorage.clear(); current = empty(); posted = [];
  // Its sends from the input are read leaving their cards: auto-swipe on.
  setAutoSwipe(true);
  useViewStore.setState(useViewStore.getInitialState()); useSitting.setState(useSitting.getInitialState());
  useDraftStore.setState({ entries: {}, unavailable: false }); useOutbox.setState({ live: new Set(), resend: null });
  useReaderSend.setState({ receipts: new Map() }); useTaskActionSlot.setState({ element: null, inThread: false, page: null });
  queryClient.clear(); data();
  useConversation.setState({ root, open: false, expanded: false, engaged: false, error: null, wanted: false, focusRequested: false });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url) === '/api/coordinator/messages') { posted.push(JSON.parse(String(init?.body))); return new Response('{}', { status: 500 }); }
    if (String(url) === '/api/coordinator/clear') { current = empty('new-conversation'); return reply(current); }
    if (String(url) === '/api/coordinator') return reply(current);
    if (String(url).includes('/skills')) return reply({ skills: [], unavailable: false });
    return reply({ status: 'unavailable', skills: [], profile: 'claude' });
  });
  await readConversationThroughOwner(current, root);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); for (const toast of useToasts.getState().toasts) notify.dismiss(toast.id); });
const mount = () => render(<TestWorkspace data={data()}><Reader mode="docked" /><CoordinatorCard /><Toaster /></TestWorkspace>);
async function write() {
  fireEvent.click(document.querySelector('[data-coordinator-write]')!);
  await waitFor(() => expect(field()).toBeTruthy());
}

test('unsent words return from the folded capsule; an unanswered send remains in the conversation for resend', async () => {
  mount(); await write(); input('Draft to send later');
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(document.querySelector('[data-coordinator-capsule]')?.textContent).toContain('Draft to send later'));
  expect(document.querySelector('[data-coordinator-capsule]')?.textContent).toContain('Draft');
  await write(); expect(field().textContent).toContain('Draft to send later');
  fireEvent.click(document.querySelector('[data-ask-send]')!);
  await waitFor(() => expect(document.querySelector('[data-coordinator-pill]')?.textContent).toContain("Couldn't confirm whether it arrived"));
  fireEvent.click(document.querySelector('[data-coordinator-pill]')!);
  await waitFor(() => expect(document.querySelector('[data-coordinator-local=unknown]')?.textContent).toContain('Draft to send later'));
  expect(field().textContent).toBe(''); expect(posted).toHaveLength(1);
  input('Next unsent words');
  expect(field().textContent).toBe('Next unsent words');
  expect(document.querySelector('[data-coordinator-local=unknown]')?.textContent).toContain('Draft to send later');
  expect(posted[0]).toMatchObject({ text: 'Draft to send later', conversationId: cid });
});

test('Done disappears with the actual reader and stays absent while a working task is read or written about', async () => {
  act(() => useViewStore.getState().openTask('T1', { reader: true })); mount();
  expect(document.querySelector('[data-task-done]')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
  await waitFor(() => expect(document.querySelector('[data-task-done]')).toBeNull());
  act(() => useViewStore.getState().openTask('T2', { reader: true }));
  expect(document.querySelector('[data-task-done]')).toBeNull(); await write(); expect(document.querySelector('[data-task-done]')).toBeNull();
});

for (const submitted of [false, true]) test(`clear preserves an unsent draft but settles fixed sends with their conversation; submitted=${submitted}`, async () => {
  current = { ...empty(), turns: [{ id: 'previous', at, ask: 'Previous', status: 'succeeded', waiting: false, answer: 'Done', seen: true, answeredAt: at, error: null, result: { writes: [], refused: [] }, attachments: [] }] };
  useConversation.setState({ open: true, expanded: true });
  await readConversationThroughOwner(current, root);
  mount(); await waitFor(() => expect(field()).toBeTruthy()); input('Original unsent input'); expect(field().textContent).toBe('Original unsent input');
  const key = draftKey(root, 'coordinator', cid);
  const requestId = useDraftStore.getState().entries[key]!.values.requestId!;
  const attachment = { name: 'retained.txt', size: 19, path: `attachments/${requestId}/retained.txt`, absolutePath: `/api/coordinator/file?requestId=${requestId}&name=retained.txt` };
  act(() => { const entry = useDraftStore.getState().entries[key]!; useDraftStore.setState({ entries: { ...useDraftStore.getState().entries,
    [key]: { ...entry, values: { ...entry.values, attachments: snapshotJson([attachment]) } } } }); });
  expect(document.querySelector('[data-attachment-state=saved]')).toBeTruthy();
  if (submitted) { fireEvent.click(document.querySelector('[data-ask-send]')!); await waitFor(() => expect(posted).toHaveLength(1));
    await waitFor(() => expect(document.querySelector('[data-coordinator-local=unknown]')).toBeTruthy());
    expect(document.querySelector('[data-coordinator-local=unknown]')?.textContent).toContain('Original unsent input');
    expect(field().textContent).toBe('');
    expect(document.querySelector('[data-toast]')).toBeNull(); }
  const originalKey = submitted ? outgoingKey(root, requestId) : key;
  const original = [originalKey, useDraftStore.getState().entries[originalKey]!] as const;
  expect(original).toBeTruthy(); expect(!!original[1].values.submitted).toBe(submitted);
  expect(JSON.parse(original[0])[2].startsWith('send:')).toBe(submitted);
  expect(JSON.parse(original[1].values.attachments!)).toEqual([attachment]);
  if (submitted) {
    expect(posted[0]).toMatchObject({ text: 'Original unsent input', attachments: ['retained.txt'] });
    expect(original[1].values.requestId).toBe(posted[0].id);
    expect(JSON.parse(original[1].values.submitted!)).toMatchObject({ text: posted[0].text, attachments: posted[0].attachments });
  }
  if (submitted) {
    // A real public read of the still-open scope cannot settle an absent unknown send.
    await act(async () => { await useConversation.getState().refresh(); });
    expect(useConversation.getState().conversation?.id).toBe(cid);
    expect(useConversation.getState().conversation?.turns.some(turn => turn.id === original[1].values.requestId)).toBe(false);
    expect(readDrafts().entries[original[0]]).toEqual(original[1]);
  }
  const clear = document.querySelector('[data-coordinator-clear]')!; fireEvent.click(clear); fireEvent.click(clear);
  await waitFor(() => expect(useConversation.getState().conversation?.id).toBe('new-conversation'));
  expect(document.querySelector('[data-attachment-state=saved]')).toBeNull();
  const retained = () => JSON.parse(sessionStorage.getItem('alpacawork-input-drafts-v10')!).entries[original[0]];
  expect(retained()).toEqual(submitted ? undefined : original[1]);
  const freshKey = draftKey(root, 'coordinator', 'new-conversation');
  await waitFor(() => expect(readDrafts().entries[freshKey]).toBeTruthy());
  const fresh = readDrafts().entries[freshKey]!;
  expect(fresh.values.requestId).not.toBe(original[1].values.requestId);
  cleanup(); useDraftStore.setState(readDrafts()); mount(); act(() => useConversation.getState().setExpanded(true));
  await waitFor(() => expect(field()).toBeTruthy());
  expect(document.querySelector('[data-attachment-state=saved]')).toBeNull();
  expect(document.querySelector('[data-coordinator-card]')?.textContent).not.toContain('retained.txt');
  expect(field().textContent).not.toContain('Original unsent input'); expect(retained()).toEqual(submitted ? undefined : original[1]);
  // Reopening starts another edition; the canonical document and its send identity stay intact.
  const reopened = readDrafts().entries[freshKey]!;
  expect(reopened).toEqual({ ...fresh, revision: expect.any(String) });
  expect(reopened.revision).not.toBe(fresh.revision);
});

/** A mouse's tap on what the coordinator stands over: pressed and let go in one place, soon (fold-on-press-away.ts). */
async function tapOn(target: Element) {
  const pointer = (type: string) => { const event = new Event(type, { bubbles: true }); Object.assign(event, { isPrimary: true, button: 0, pointerId: 1, clientX: 5, clientY: 5 }); fireEvent(target, event); };
  pointer('pointerdown'); pointer('pointerup'); fireEvent.click(target, { detail: 1, clientX: 5, clientY: 5 });
  await act(() => new Promise(resolve => setTimeout(resolve, 0)));
}

// One rule (foot.ts goesDownByItself): on a phone a tap on the list or a report, and a message sent, take the
// coordinator one step down; on a computer it stays as it is.
for (const phone of [false, true]) test(`a tap away and a send take the coordinator down on a phone only; phone=${phone}`, async () => {
  const narrow = narrowScreen(phone), animations = Element.prototype.getAnimations;
  Element.prototype.getAnimations = () => [];
  const list = document.body.appendChild(document.createElement('button')); list.textContent = 'T2 in the list';
  try {
    mount(); act(() => useConversation.getState().setExpanded(true));
    await tapOn(list);
    expect(useConversation.getState()).toMatchObject({ open: true, expanded: !phone });
    act(() => useConversation.getState().setExpanded(false));
    await tapOn(list);
    expect(useConversation.getState().open).toBe(!phone);
    if (phone) await write();
    input('Sent from the open input');
    fireEvent.click(document.querySelector('[data-ask-send]')!); await waitFor(() => expect(posted).toHaveLength(1));
    expect(useConversation.getState()).toMatchObject({ open: !phone, expanded: false });
  } finally { list.remove(); Element.prototype.getAnimations = animations; narrow.restore(); }
});
