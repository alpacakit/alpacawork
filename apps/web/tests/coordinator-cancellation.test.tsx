/** Exercise the real input/fetch and outbox projection. */
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { i18n, startI18n } from '@alpacawork/i18n';
import { conversationSnapshot, setConversationState, snapshotJson } from './conversation-fixture';
import { TestWorkspace, screenData, tree } from './fixtures';
import { CoordinatorInput } from '../src/features/coordinator/CoordinatorInput';
import { LastWordsPill } from '../src/features/coordinator/LastWords';
import { LocalOutcome } from '../src/features/coordinator/LocalOutcome';
import { WaitingRows, useWaiting } from '../src/features/coordinator/CoordinatorQueue';
import { partitionTurns, ShownConversationProvider, useShownConversation } from '../src/features/coordinator/shown';
import { useConversation } from '../src/features/coordinator/coordinator';
import { begin, beginWithdrawal, cancelUnsent, offerOutgoingUndo, cancelOutgoing, refuse, freeze, holds, outgoing, outgoingKey, reconcileOutbox, takeBack, useOutbox } from '../src/features/coordinator/editor/outbox';
import { draftKey, readDrafts, updateDraft, useDraftStore } from '../src/features/forms/draft-store';
import { textDocument } from '../src/features/coordinator/editor/document';
import { notify, useToasts } from '../src/lib/notify';
import { useUndoOffers } from '../src/data/undo-offers';
import { useReaderSend } from '../src/features/coordinator/reader-send';
const root = '/fixture', cid = 'cancel-conversation', key = draftKey(root, 'coordinator', cid);
const values = (text = '', requestId: string = crypto.randomUUID()) => ({ doc: JSON.stringify(textDocument(text)), requestId });
const fixed = (text = 'words') => ({ conversationId: cid, text, agent: 'claude', selected: {}, attachments: [] });
const turn = (id: string, ask = 'words') => ({ id, ask, at: '2026-10-28T08:00:00Z', attachments: [], status: 'queued' as const, waiting: false, seen: false, answer: null, answeredAt: null, error: null, result: null });
const conv = (turns: ReturnType<typeof turn>[] = [], cancelled: string[] = []) => ({ id: cid, agent: 'claude', warm: 'none' as const, busy: false, turns, cancelled });
const reply = (value: unknown, status = 200) => new Response(snapshotJson(value), { status });
function setup(text = 'words') {
  setConversationState({ root, conversation: conv(), open: true, expanded: true, engaged: false, error: null });
  const id = crypto.randomUUID(); useDraftStore.setState({ entries: { [key]: { status: 'editing', values: values(text, id) } }, unavailable: false }); return id;
}
function queued(text = 'words', posted = true) {
  const id = setup(text); freeze(root, fixed(text), useDraftStore.getState().entries[key]!.values, { from: key });
  if (posted) { const attempt = begin(root, id)!; attempt.check(); attempt.finish(); }
  return id;
}
function Rows() { const shown = useShownConversation(), queue = useWaiting(); return <><output data-testid="local">{JSON.stringify(shown.local)}</output>{shown.localThread.map(turn => <LocalOutcome key={turn.id} turn={turn} />)}<WaitingRows queue={queue} open={() => {}} /></>; }
function mount(input = true) { return render(<TestWorkspace data={screenData(tree())}><ShownConversationProvider><Rows />{input && <CoordinatorInput launch={{ selected: {}, picker: null }} profile="claude" />}</ShownConversationProvider></TestWorkspace>); }
// Keep Rows and the actual input inside the same projection/provider.
beforeAll(async () => { await startI18n(); });
beforeEach(async () => { await i18n.changeLanguage('ja'); useOutbox.setState({ live: new Set(), resend: null }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); useOutbox.setState({ live: new Set(), resend: null }); setConversationState({ conversation: null }); });
function fetcher(post: () => Promise<Response> | Response, get: () => Response = () => reply(conv()), withdraw: () => Promise<Response> | Response = () => reply(conv())) {
  const fetch = vi.fn().mockImplementation((url: string) => url === '/api/coordinator/messages' ? post() : url === '/api/coordinator/messages/withdraw' ? withdraw() : url === '/api/coordinator' ? get() : reply({ status: 'unavailable', profile: 'claude', skills: [] }));
  vi.stubGlobal('fetch', fetch); return fetch;
}
const finish = () => waitFor(() => expect(useOutbox.getState().live.size).toBe(0));
const cancel = () => fireEvent.click(screen.getAllByRole('button', { name: '取り消す' })[0]!);

test('2xx accepted evidence settles its request even when the response generation cannot be drawn', async () => {
  const id = setup(), errors = vi.spyOn(notify, 'error');
  fetcher(() => new Response(JSON.stringify({ ...conversationSnapshot(conv([turn(id)])), generation: 'another-generation' })));
  mount(); fireEvent.click(document.querySelector('[data-ask-send]')!);
  await waitFor(() => expect(outgoing(useDraftStore.getState().entries, root)[0]?.stage).toBe('accepted'));
  expect(holds(useDraftStore.getState().entries, root, cid)).toBe(false);
  expect(screen.queryByRole('button', { name: '取り消す' })).toBeNull();
  expect(errors.mock.calls.some(([text]) => String(text).includes('分かりません'))).toBe(false);
});
for (const present of [false, true]) test(`a lost POST is checked with one GET; present=${present}`, async () => {
  const id = setup(), errors = vi.spyOn(notify, 'error');
  const fetch = fetcher(() => Promise.reject(new TypeError('offline')), () => reply(conv(present ? [turn(id)] : [])));
  mount(); fireEvent.click(document.querySelector('[data-ask-send]')!);
  await waitFor(() => expect(fetch.mock.calls.filter(([url]) => url === '/api/coordinator')).toHaveLength(1)); await finish();
  if (present) { expect(holds(useDraftStore.getState().entries, root, cid)).toBe(false); expect(errors.mock.calls.some(([text]) => String(text).includes('分かりません'))).toBe(false); }
  else { expect(screen.getByText('届いたか分かりません。')).toBeTruthy(); expect(screen.getByRole('button', { name: '送り直す' })).toBeTruthy(); expect(screen.getByRole('button', { name: '取り消す' })).toBeTruthy(); }
  expect(fetch.mock.calls.filter(([url]) => url === '/api/coordinator/messages')).toHaveLength(1);
});
test('unknown cancellation restores words under a fresh ID, releases followers and says so', async () => {
  const id = queued(), errors = vi.spyOn(notify, 'success');
  fetcher(() => reply(conv()), () => reply(conv()), () => reply(conv([], [id]))); mount(); cancel(); await finish();
  await waitFor(() => expect(useDraftStore.getState().entries[outgoingKey(root, id)]).toBeUndefined());
  expect(useDraftStore.getState().entries[key]!.values.doc).toContain('words'); expect(useDraftStore.getState().entries[key]!.values.requestId).not.toBe(id);
  expect(errors).toHaveBeenCalledWith('取り消しました。入力欄に戻しました。', expect.anything());
});
test('cancelled words wait beside a busy draft and can return under a fresh ID once it is empty', async () => {
  const id = queued(); updateDraft(key, { values: values('another draft') });
  fetcher(() => reply(conv()), () => reply(conv()), () => reply(conv([], [id]))); mount(); cancel(); await finish();
  await screen.findByText('取り消しました。'); const back = screen.getByRole<HTMLButtonElement>('button', { name: '入力に戻す' }); expect(back.disabled).toBe(true);
  expect(useDraftStore.getState().entries[key]!.values.doc).toContain('another draft');
  act(() => { updateDraft(key, { values: values() }); }); expect(back.disabled).toBe(false); fireEvent.click(back);
  expect(useDraftStore.getState().entries[key]!.values.requestId).not.toBe(id); expect(useDraftStore.getState().entries[key]!.values.doc).toContain('words');
});
test('cancellation 409 already sent settles admission, leaves input empty, and uses the shared explanation', async () => {
  const id = queued(), errors = vi.spyOn(notify, 'error');
  fetcher(() => reply(conv()), () => reply(conv([turn(id)])), () => reply({ error: { code: 'conflict', retry: 'reread', message: 'already sent', reason: { kind: 'message_has_already_been_sent' } } }, 409));
  mount(); cancel(); await finish();
  expect(holds(useDraftStore.getState().entries, root, cid)).toBe(false); expect(useDraftStore.getState().entries[key]!.values.doc).not.toContain('words');
  await waitFor(() => expect(errors).toHaveBeenCalledWith('もう始まっていたので、取り消せませんでした。', expect.anything()));
});
test('lost cancellation persists last intent across reload, blocks followers, and recovers from a cancelled snapshot', async () => {
  const id = queued(); fetcher(() => reply(conv()), () => reply(conv()), () => Promise.reject(new TypeError('offline')));
  const view = mount(); cancel(); await finish(); await screen.findByText('取り消せたか分かりません。');
  expect(screen.queryByRole('button', { name: '送り直す' })).toBeNull(); expect(holds(useDraftStore.getState().entries, root, cid)).toBe(true);
  view.unmount(); act(() => { useDraftStore.setState({ entries: readDrafts().entries }); }); mount();
  expect(screen.getByText('取り消せたか分かりません。')).toBeTruthy();
  act(() => { reconcileOutbox(conv([], [id]), root, null); });
  expect(holds(useDraftStore.getState().entries, root, cid)).toBe(false); expect(useDraftStore.getState().entries[key]!.values.requestId).not.toBe(id);
});
test('repeated cancel is disabled while in flight; followers wait until confirmation and then each POST once', async () => {
  const id = queued(); const b = crypto.randomUUID(), c = crypto.randomUUID();
  freeze(root, fixed('B'), values('B', b)); freeze(root, fixed('C'), values('C', c));
  let resolve!: (r: Response) => void; const pending = new Promise<Response>(r => { resolve = r; });
  const posted: any[] = []; const fetch = fetcher(() => reply(conv()), () => reply(conv()), () => pending);
  fetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/api/coordinator/messages/withdraw') return pending;
    if (url === '/api/coordinator/messages') { const input = JSON.parse(String(init!.body)); posted.push(input); return reply(conv(posted.map(p => turn(p.id, p.text)), [id])); }
    return reply(conv());
  });
  mount(); const pressed = screen.getAllByRole('button', { name: '取り消す' })[0]!; fireEvent.click(pressed); fireEvent.click(pressed);
  expect(screen.getByText('取り消し中…')).toBeTruthy(); expect(posted).toEqual([]);
  await act(async () => { resolve(reply(conv([], [id]))); });
  await waitFor(() => expect(posted.map(p => p.id)).toEqual([b, c])); await finish();
  expect(fetch.mock.calls.filter(([url]) => url === '/api/coordinator/messages/withdraw')).toHaveLength(1);
});
test('queued cancellation uses no HTTP, restores its words, and does not affect the unknown head', async () => {
  const head = queued(), id = crypto.randomUUID(); freeze(root, fixed('next words'), values('next words', id), { from: key });
  const fetch = fetcher(() => reply(conv())); mount(false);
  expect(screen.queryByText('前の送信を待っています')).toBeNull();
  fireEvent.click(document.querySelector(`[data-coordinator-waiting="${id}"] [data-coordinator-withdraw]`)!);
  await waitFor(() => expect(useDraftStore.getState().entries[outgoingKey(root, id)]).toBeUndefined());
  expect(useDraftStore.getState().entries[key]!.values.doc).toContain('next words'); expect(useDraftStore.getState().entries[outgoingKey(root, head)]).toBeTruthy(); expect(fetch).not.toHaveBeenCalled();
});
test('retry refusal cannot erase a prior unknown POST or restore the draft', async () => {
  const id = queued(); const fetch = fetcher(() => reply({ error: { code: 'question_closed', retry: 'reread', message: 'closed' } }, 409));
  mount(); fireEvent.click(screen.getByRole('button', { name: '送り直す' })); await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === '/api/coordinator/messages')).toBe(true)); await finish();
  expect(useDraftStore.getState().entries[outgoingKey(root, id)]?.values.stage).toBe('posted'); expect(holds(useDraftStore.getState().entries, root, cid)).toBe(true);
  expect(useDraftStore.getState().entries[key]!.values.doc).toContain('words');
});
test('same-ID resend cancelled response restores the words instead of accepting or conflicting', async () => {
  const id = queued(); fetcher(() => reply(conv([], [id]))); mount(); fireEvent.click(screen.getByRole('button', { name: '送り直す' })); await finish();
  await waitFor(() => expect(useDraftStore.getState().entries[key]!.values.doc).toContain('words')); expect(useDraftStore.getState().entries[key]!.values.requestId).not.toBe(id);
});
test('cancelled reader intent returns its card without changing the unrelated draft', async () => {
  const id = queued(); const submission = { taskId: 'T1', title: 'Task', turn: 'Q1', kind: 'intent', phase: 'doing', answer: 'done', expectedWrites: [{ kind: 'reported', toState: 'done' }] };
  // Use the public freeze binding shape from reader/submission rather than a second reader state.
  const entry = useDraftStore.getState().entries[outgoingKey(root, id)]!;
  const { readerSubmissionSchema } = await import('../src/features/reader/submission');
  const binding = readerSubmissionSchema.parse(submission);
  updateDraft(outgoingKey(root, id), { values: { ...entry.values, reader: JSON.stringify([binding]) } });
  updateDraft(key, { values: values('unrelated draft') });
  fetcher(() => reply(conv()), () => reply(conv()), () => reply(conv([], [id]))); mount(); cancel(); await finish();
  expect(holds(useDraftStore.getState().entries, root, cid)).toBe(false); expect(useDraftStore.getState().entries[key]!.values.doc).toContain('unrelated draft');
  expect(useDraftStore.getState().entries[outgoingKey(root, id)]?.values.stage).toBe('refused');
});
test('sending and accepted local rows expose no cancel operation', () => {
  queued(); const item = outgoing(useDraftStore.getState().entries, root)[0]!;
  act(() => { useOutbox.setState({ live: new Set([`ask:${item.key}`]) }); }); mount(false);
  expect(screen.queryByRole('button', { name: '取り消す' })).toBeNull();
});
test('cancelled terminal evidence wins over late acceptance and old snapshots', () => {
  const id = queued(); updateDraft(key, { values: values('busy') });
  reconcileOutbox(conv([], [id]), root, null); reconcileOutbox(conv([turn(id)]), root, null); reconcileOutbox(conv(), root, null);
  mount(false); expect(screen.getByText('取り消しました。')).toBeTruthy(); expect(holds(useDraftStore.getState().entries, root, cid)).toBe(false);
});
for (const language of ['ja', 'en']) test(`${language} uses distinct known-failed and unknown cancellation text`, async () => {
  await i18n.changeLanguage(language);
  expect(i18n.exists('ui:coordinatorCard.withdrawFailed')).toBe(true);
  const texts = ['queuedLocally', 'withdrawing', 'withdrawFailed', 'withdrawUnknown', 'withdrawRestored', 'withdrawn', 'withdrawStarted'].map(name => i18n.t(`ui:coordinatorCard.${name}`));
  expect(texts.every(text => !text.includes('coordinatorCard.'))).toBe(true); expect(new Set(texts).size).toBe(7);
});
for (const [name, response, unknown] of [
  ['typed 403', () => reply({ error: { code: 'forbidden', retry: 'fix', message: 'refused' } }, 403), false],
  ['typed 409', () => reply({ error: { code: 'conflict', retry: 'reread', message: 'refused' } }, 409), false],
  ['typed 503 later', () => reply({ error: { code: 'unavailable', retry: 'later', message: 'later' } }, 503), false],
  ['typed 503 check', () => reply({ error: { code: 'io_failure', retry: 'check', message: 'unknown' } }, 503), true],
  ['empty 502', () => new Response('', { status: 502 }), true],
  ['unreadable 403', () => new Response('<html>', { status: 403 }), true],
  ['broken success', () => reply({ broken: true }), true],
  ['timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError')), true],
] as const) test(`first POST classification: ${name}`, async () => {
  const id = setup(); fetcher(response); mount(); fireEvent.click(document.querySelector('[data-ask-send]')!);
  await waitFor(() => expect(useDraftStore.getState().entries[key]!.values.requestId).not.toBe(id)); await finish();
  expect(holds(useDraftStore.getState().entries, root, cid)).toBe(unknown);
  expect(useDraftStore.getState().entries[key]!.values.doc!.includes('words')).toBe(true);
});
test('cancelled files restore with old file references and next send copies them into its fresh ID', async () => {
  const id = queued(); const entry = useDraftStore.getState().entries[outgoingKey(root, id)]!;
  updateDraft(outgoingKey(root, id), { values: { ...entry.values, attachments: JSON.stringify([{ name: 'note.txt', path: `attachments/${id}/note.txt`, absolutePath: `/api/coordinator/file?requestId=${id}&name=note.txt`, size: 4 }]) } });
  updateDraft(key, { values: { ...useDraftStore.getState().entries[key]!.values, attachments: useDraftStore.getState().entries[outgoingKey(root, id)]!.values.attachments! } });
  fetcher(() => reply(conv()), () => reply(conv()), () => reply(conv([], [id]))); mount(); cancel(); await finish();
  await waitFor(() => expect(useDraftStore.getState().entries[key]!.values.doc).toContain('words'));
  const restored = useDraftStore.getState().entries[key]!.values;
  expect(restored.requestId).not.toBe(id); expect(restored.attachments).toContain(`attachments/${id}/note.txt`);
  cleanup();
  const next = restored.requestId!;
  freeze(root, { ...fixed(), attachments: ['note.txt'] }, restored, { from: key });
  const attempt = begin(root, next)!;
  const original = useDraftStore.getState().entries[outgoingKey(root, next)]!.values;
  const { copyRecoveredFiles } = await import('../src/features/coordinator/editor/recovered-files');
  const attachments = await import('../src/data/attachments'); const copy = vi.spyOn(attachments, 'uploadAttachment').mockResolvedValue({ path: `attachments/${restored.requestId}/note-2.txt`, absolutePath: '/copied', name: 'note-2.txt', size: 4 });
  const copied = await copyRecoveredFiles(original, cid, next);
  expect(copy.mock.calls[0]!.at(-1)).toBeTruthy();
  expect(copied).toEqual(['note-2.txt']);
  expect(attempt.check(copied)).toBe('posted'); attempt.finish();
  useDraftStore.setState(readDrafts());
  const retry = begin(root, next)!;
  expect(retry.checked).toBe(true);
  expect(retry.fixed.attachments).toEqual(['note-2.txt']);
  retry.finish();
});
for (const started of [false, true]) test(`queue cross cancellation failure uses the reason, already-started=${started}`, async () => {
  setup(); setConversationState({ conversation: { ...conv([{ ...turn('queued-message'), waiting: true }]), busy: true } });
  const errors = vi.spyOn(notify, 'error');
  fetcher(() => reply(conv()), () => reply(conv([{ ...turn('queued-message'), waiting: true }])), () => started
    ? reply({ error: { code: 'conflict', retry: 'reread', message: 'sent', reason: { kind: 'message_has_already_been_sent' } } }, 409)
    : Promise.reject(new TypeError('offline')));
  mount(false); fireEvent.click(document.querySelector('[data-coordinator-withdraw]')!);
  await waitFor(() => expect(errors).toHaveBeenCalledWith(started ? 'もう始まっていたので、取り消せませんでした。' : '取り消せませんでした。', expect.anything()));
});
test('cancellation storage failure sends no HTTP and keeps the original request', async () => {
  const id = queued(), fetch = fetcher(() => reply(conv())); mount();
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); }); cancel();
  await act(async () => {}); expect(fetch).not.toHaveBeenCalled(); expect(useDraftStore.getState().entries[outgoingKey(root, id)]?.values.stage).toBe('posted');
});
test('cancellation finishing in another workspace cannot change the current input', async () => {
  const id = queued(); let resolve!: (r: Response) => void; const pending = new Promise<Response>(r => { resolve = r; });
  fetcher(() => reply(conv()), () => reply(conv()), () => pending); mount(); cancel();
  const other = draftKey('/other', 'coordinator', 'other-conversation');
  act(() => { setConversationState({ root: '/other', conversation: { ...conv(), id: 'other-conversation' } }); useDraftStore.setState(state => ({ entries: { ...state.entries, [other]: { status: 'editing', values: values('current draft') } } })); });
  await act(async () => { resolve(reply(conv([], [id]))); }); await finish();
  expect(useDraftStore.getState().entries[other]!.values.doc).toContain('current draft');
});
test('a server queued row retains an unanswered cancellation across reload and retries only withdrawal', async () => {
  setup('unrelated draft'); const id = crypto.randomUUID(), waiting = { ...turn(id), waiting: true };
  setConversationState({ conversation: { ...conv([waiting]), busy: true } });
  let lost = true; const fetch = fetcher(() => { throw new Error('must not resend'); }, () => { if (lost) throw new TypeError('check lost'); return reply(conv([waiting])); }, () => lost ? Promise.reject(new TypeError('reply lost')) : reply(conv([], [id])));
  const view = mount(false); fireEvent.click(document.querySelector('[data-coordinator-withdraw]')!);
  await waitFor(() => expect(useDraftStore.getState().entries[outgoingKey(root, id)]?.values.last).toBe('withdraw')); await finish();
  expect(holds(useDraftStore.getState().entries, root, cid)).toBe(true); expect(screen.getByText('取り消せたか分かりません。')).toBeTruthy();
  view.unmount(); act(() => { useDraftStore.setState(readDrafts()); }); mount(false);
  expect(screen.queryByRole('button', { name: '送り直す' })).toBeNull();
  lost = false; fireEvent.click(document.querySelector('[data-coordinator-withdraw]')!); await finish();
  await waitFor(() => expect(holds(useDraftStore.getState().entries, root, cid)).toBe(false));
  expect(fetch.mock.calls.filter(([url]) => url === '/api/coordinator/messages/withdraw')).toHaveLength(2);
  expect(useDraftStore.getState().entries[key]!.values.doc).toContain('unrelated draft');
});
for (const admitted of [false, true]) test(`cancelling a reader intent returns its actual receipt and card hold, admitted=${admitted}`, async () => {
  queued(); const id = crypto.randomUUID(), task = screenData(tree()).tasks[0]!;
  const payload = { ...fixed('continue'), tasks: [task.id], intent: { task: task.id, action: 'continue' as const, expectedTaskHash: task.hash } };
  const { captureReaderSubmission } = await import('../src/features/coordinator/reader-send');
  const { holdsReaderTurn } = await import('../src/features/coordinator/editor/outbox');
  const { readerTurn } = await import('../src/features/reader/submission');
  const accept = captureReaderSubmission(payload, textDocument('continue'), [task], id, { root, conversationId: cid });
  freeze(root, payload, values('continue', id), undefined, accept.reader); accept();
  if (admitted) {
    const state = conv([{ ...turn(id, 'continue'), tasks: [task.id], intent: payload.intent, waiting: true } as ReturnType<typeof turn>]);
    reconcileOutbox(state, root, null); setConversationState({ conversation: state });
  }
  const fetch = fetcher(() => reply(conv()), () => reply(conv()), () => reply(conv([], [id]))); mount(false);
  const buttons = screen.getAllByRole('button', { name: '取り消す' }); fireEvent.click(buttons[buttons.length - 1]!);
  await waitFor(() => expect([...useReaderSend.getState().receipts.values()].find(receipt => receipt.id === id)?.status).toBe('cancelled'));
  expect(holdsReaderTurn(useDraftStore.getState().entries, root, readerTurn(task))).toBe(false);
  expect(useDraftStore.getState().entries[outgoingKey(root, id)]).toBeUndefined();
  expect(fetch.mock.calls.filter(([url]) => url === '/api/coordinator/messages/withdraw')).toHaveLength(admitted ? 1 : 0);
});
test('a GET issued during withdrawal cannot resurrect its older queued turn after cancellation commits', async () => {
  const id = queued(); let withdrawDone!: (r: Response) => void, readDone!: (r: Response) => void;
  const withdrawal = new Promise<Response>(resolve => { withdrawDone = resolve; }), reading = new Promise<Response>(resolve => { readDone = resolve; });
  fetcher(() => reply(conv()), () => reading as unknown as Response, () => withdrawal); mount(); cancel();
  let refresh!: Promise<void>; act(() => { refresh = useConversation.getState().refresh(); });
  await act(async () => { withdrawDone(reply(conv([], [id]))); }); await finish();
  expect(useDraftStore.getState().entries[key]!.values.requestId).not.toBe(id);
  await act(async () => { readDone(reply(conv([turn(id)]))); await refresh; });
  expect(useConversation.getState().conversation?.turns.some(turn => turn.id === id)).toBe(false);
  expect(screen.queryByText('届いたか分かりません。')).toBeNull();
});
test('a cancelled answer draft returns to its untouched input, while releasing its reader binding', async () => {
  useToasts.setState({ toasts: [] });
  const id = queued(), entry = useDraftStore.getState().entries[outgoingKey(root, id)]!;
  const reader = { taskId: 'T1', title: 'Question', turn: 'Q1', phase: 'doing', kind: 'answer', answer: 'send', expectedWrites: [{ kind: 'answered', question: 'Q1' }] };
  updateDraft(outgoingKey(root, id), { values: { ...entry.values, reader: JSON.stringify([reader]) } });
  fetcher(() => reply(conv()), () => reply(conv()), () => reply(conv([], [id]))); mount(); cancel(); await finish();
  await waitFor(() => expect(useDraftStore.getState().entries[key]!.values.doc).toContain('words'));
  expect(useDraftStore.getState().entries[key]!.values.requestId).not.toBe(id);
  expect(useDraftStore.getState().entries[outgoingKey(root, id)]).toBeUndefined();
  expect(useToasts.getState().toasts).toHaveLength(1);
});
test('a successful check GET from another generation settles admission without drawing that generation', async () => {
  const id = setup(), errors = vi.spyOn(notify, 'error');
  fetcher(() => Promise.reject(new TypeError('reply lost')), () => new Response(JSON.stringify({ ...conversationSnapshot(conv([turn(id)])), generation: 'restarted-serve' })));
  mount(); fireEvent.click(document.querySelector('[data-ask-send]')!);
  await waitFor(() => expect(useOutbox.getState().live.size).toBe(0));
  expect(outgoing(useDraftStore.getState().entries, root)[0]?.stage).toBe('accepted');
  expect(holds(useDraftStore.getState().entries, root, cid)).toBe(false);
  expect(useConversation.getState().conversation?.turns).toEqual([]);
  expect(errors.mock.calls.some(([text]) => String(text).includes('分かりません'))).toBe(false);
});
test('device queued cancellation remains available offline and sends no HTTP', async () => {
  const head = queued(), id = crypto.randomUUID();
  freeze(root, fixed('offline words'), values('offline words', id), { from: key });
  const fetch = fetcher(() => reply(conv())); mount(false);
  const { useConnection } = await import('../src/data/connection');
  try {
    act(() => { useConnection.setState({ offline: true }); });
    const buttons = screen.getAllByRole<HTMLButtonElement>('button', { name: '取り消す' }), local = buttons[buttons.length - 1]!;
    expect(buttons[0]!.disabled).toBe(true);
    expect(local.disabled).toBe(false); fireEvent.click(local);
    expect(useDraftStore.getState().entries[outgoingKey(root, id)]).toBeUndefined();
    expect(useDraftStore.getState().entries[outgoingKey(root, head)]).toBeTruthy();
    expect(useDraftStore.getState().entries[key]!.values.doc).toContain('offline words');
    expect(fetch).not.toHaveBeenCalled();
  } finally { act(() => { useConnection.setState({ offline: false }); }); }
});

// Verify notification ownership, terminal partition, and withdrawal-only recovery.
test('replaces a send notice with its withdrawal notice and clears it after cancellation', async () => {
  useToasts.setState({ toasts: [] });
  const id = setup(); let confirmed = false;
  fetcher(() => Promise.reject(new TypeError('POST cut')), () => reply(conv()), () => confirmed ? reply(conv([], [id])) : Promise.reject(new TypeError('withdraw cut')));
  mount(); fireEvent.click(document.querySelector('[data-ask-send]')!);
  await waitFor(() => expect(useToasts.getState().toasts).toHaveLength(1)); await finish();
  const slot = useToasts.getState().toasts[0]!.id;
  cancel(); await screen.findByText('取り消せたか分かりません。'); await finish();
  expect(useToasts.getState().toasts.map(toast => toast.id)).toEqual([slot]);
  expect(useToasts.getState().toasts[0]!.text).toBe('取り消せたか分かりません。');
  confirmed = true; cancel(); await finish();
  await waitFor(() => expect(useDraftStore.getState().entries[key]!.values.doc).toContain('words'));
  expect(useToasts.getState().toasts.map(toast => toast.text)).toEqual(['取り消しました。入力欄に戻しました。']);
  expect(useToasts.getState().toasts[0]!.id).toBe(slot);
});
for (const outcome of ['accepted', 'refused'] as const) test(`${outcome} clears only that request's uncertain notice`, async () => {
  useToasts.setState({ toasts: [] }); const id = setup();
  fetcher(() => Promise.reject(new TypeError('POST cut'))); mount(); fireEvent.click(document.querySelector('[data-ask-send]')!);
  await waitFor(() => expect(useToasts.getState().toasts).toHaveLength(1)); await finish();
  const slot = useToasts.getState().toasts[0]!.id;
  notify.error('another request remains', { id: 'unrelated-send' });
  act(() => { if (outcome === 'accepted') reconcileOutbox(conv([turn(id)]), root, null); else refuse(root, id, 'refused'); });
  expect(useToasts.getState().toasts.map(toast => toast.id)).toEqual(['unrelated-send']);
  expect(useToasts.getState().toasts.some(toast => toast.id === slot)).toBe(false);
});
for (const busy of [false, true]) test(`refused and cancelled stay in the thread with a waiting head; busy=${busy}`, () => {
  const base = { root, conversationId: cid, at: '', ask: '', attachments: [], refusal: null };
  const head = { ...base, id: 'head', stage: 'unknown' as const };
  const refused = { ...base, id: 'refused', stage: 'refused' as const }, cancelled = { ...base, id: 'cancelled', stage: 'cancelled' as const };
  const tail = { ...base, id: 'tail', stage: 'queued' as const };
  const result = partitionTurns([], [head, refused, cancelled, tail], busy);
  expect(result.localThread.map(row => row.id)).toEqual([...busy ? [] : ['head'], 'refused', 'cancelled']);
  expect(result.localWaiting.map(row => row.id)).toEqual([...busy ? ['head'] : [], 'tail']);
});
test('a withdrawal of unknown outcome cannot begin an ask even through a retained reader callback', async () => {
  const id = queued(); const withdrawal = beginWithdrawal(root, id)!; withdrawal.finish();
  const before = useDraftStore.getState().entries[outgoingKey(root, id)];
  expect(begin(root, id)).toBeNull();
  expect(useDraftStore.getState().entries[outgoingKey(root, id)]).toBe(before);
  expect(useOutbox.getState().live.size).toBe(0);
});
test('an unknown reader withdrawal replaces Check with Cancel and the action retries withdrawal', async () => {
  useToasts.setState({ toasts: [] });
  const id = queued(), task = screenData(tree()).tasks[0]!;
  const { captureReaderSubmission, failReaderSend, reconcileReaderSends } = await import('../src/features/coordinator/reader-send');
  const { ApiError } = await import('../src/data/client');
  const scope = { root, conversationId: cid }, payload = { ...fixed(), tasks: [task.id], intent: { task: task.id, action: 'continue' as const, expectedTaskHash: task.hash } };
  const accept = captureReaderSubmission(payload, textDocument('words'), [task], id, scope, () => { begin(root, id)?.finish(); });
  accept(); failReaderSend(id, scope, new ApiError('reply lost', 'network_error', 'check'));
  const fetch = fetcher(() => reply(conv()), () => reply(conv()), () => Promise.reject(new TypeError('withdraw cut')));
  mount(false); cancel(); await finish();
  await waitFor(() => expect(useToasts.getState().toasts.some(toast => toast.text === '取り消せたか分かりません。')).toBe(true));
  expect(useToasts.getState().toasts).toHaveLength(1);
  const action = useToasts.getState().toasts[0]!.action!;
  expect(action.label).toBe('取り消す');
  await act(async () => { action.run(); }); await finish();
  expect(fetch.mock.calls.filter(([url]) => url === '/api/coordinator/messages/withdraw')).toHaveLength(2);
  expect(fetch.mock.calls.filter(([url]) => url === '/api/coordinator/messages')).toHaveLength(0);
  const notice = useToasts.getState().toasts[0]!;
  act(() => { reconcileReaderSends(conv([turn(id)]), root); });
  expect(useToasts.getState().toasts.find(toast => toast.id === notice.id)).toBe(notice);
});
test('an undrawable cancellation restores input and announces that restoration once', async () => {
  useToasts.setState({ toasts: [] }); const id = queued();
  fetcher(() => reply(conv()), () => reply(conv()), () => new Response(JSON.stringify({ ...conversationSnapshot(conv([], [id])), generation: 'restarted-serve' })));
  mount(); cancel(); await finish();
  expect(useDraftStore.getState().entries[key]!.values.doc).toContain('words');
  expect(useDraftStore.getState().entries[key]!.values.requestId).not.toBe(id);
  expect(useToasts.getState().toasts.map(toast => toast.text)).toEqual(['取り消しました。入力欄に戻しました。']);
  act(() => { reconcileOutbox(conv([], [id]), root, null, false); });
  expect(useToasts.getState().toasts).toHaveLength(1);
});

// Notification wording follows the actual restoration destination, and folded work wins over terminal rows.
test('clearing elsewhere cancels into the visible input, and says so', async () => {
  useToasts.setState({ toasts: [] }); const id = queued(), next = { ...conv(), id: 'cleared-conversation' };
  const nextKey = draftKey(root, 'coordinator', next.id);
  useDraftStore.setState(state => ({ entries: { ...state.entries, [nextKey]: { status: 'editing', values: { ...values(), phase: 'prepared' } } } }));
  fetcher(() => reply(conv()), () => reply(next), () => reply({ error: { code: 'conflict', retry: 'reread', message: 'changed', reason: { kind: 'conversation_has_changed' } } }, 409));
  mount(); cancel(); await finish();
  expect(useConversation.getState().conversation?.id).toBe(next.id);
  expect(useDraftStore.getState().entries[key]!.values.doc).not.toContain('words');
  expect(useDraftStore.getState().entries[nextKey]!.values.doc).toContain('words');
  expect(useDraftStore.getState().entries[outgoingKey(root, id)]).toBeUndefined();
  expect(useToasts.getState().toasts.map(toast => toast.text)).toEqual(['取り消しました。入力欄に戻しました。']);
});
test('clearing elsewhere beside an occupied visible input keeps both: its words stay, the cancelled ones can be taken back', async () => {
  useToasts.setState({ toasts: [] }); const id = queued(), next = { ...conv(), id: 'cleared-conversation' };
  const nextKey = draftKey(root, 'coordinator', next.id);
  useDraftStore.setState(state => ({ entries: { ...state.entries, [nextKey]: { status: 'editing', values: { ...values('new words'), phase: 'composing' } } } }));
  fetcher(() => reply(conv()), () => reply(next), () => reply({ error: { code: 'conflict', retry: 'reread', message: 'changed', reason: { kind: 'conversation_has_changed' } } }, 409));
  mount(); cancel(); await finish();
  expect(useConversation.getState().conversation?.id).toBe(next.id);
  expect(useDraftStore.getState().entries[nextKey]!.values.doc).toContain('new words');
  expect(useDraftStore.getState().entries[nextKey]!.values.doc).not.toContain('"words"');
  const back = await screen.findByRole<HTMLButtonElement>('button', { name: '入力に戻す' });
  expect(back.disabled).toBe(true);
  act(() => { updateDraft(nextKey, { values: { ...values(), requestId: useDraftStore.getState().entries[nextKey]!.values.requestId!, phase: 'composing' } }); });
  await waitFor(() => expect(back.disabled).toBe(false));
  fireEvent.click(back);
  expect(useDraftStore.getState().entries[nextKey]!.values.doc).toContain('words');
  expect(useDraftStore.getState().entries[outgoingKey(root, id)]).toBeUndefined();
});
test('a cancellation answered after the workspace changed returns to the input it left, whatever is in sight there', () => {
  useToasts.setState({ toasts: [] }); const id = queued();
  expect(cancelOutgoing(root, id, draftKey('/other', 'coordinator', cid))).toBe('restored');
  expect(useDraftStore.getState().entries[key]!.values.doc).toContain('words');
  expect(useDraftStore.getState().entries[draftKey('/other', 'coordinator', cid)]).toBeUndefined();
  expect(useToasts.getState().toasts.map(toast => toast.text)).toEqual(['取り消しました。']);
});
test('a cancellation kept beside words of a later conversation stands there, without the cleared one\'s files', () => {
  const id = queued(), record = outgoingKey(root, id), entry = useDraftStore.getState().entries[record]!, nextKey = draftKey(root, 'coordinator', 'later');
  updateDraft(record, { values: { ...entry.values, attachments: JSON.stringify([{ name: 'a.txt', path: 'attachments/x/a.txt', absolutePath: '/old', size: 1 }]), submitted: JSON.stringify({ ...JSON.parse(entry.values.submitted!), attachments: ['a.txt'] }) } });
  useDraftStore.setState(state => ({ entries: { ...state.entries, [nextKey]: { status: 'editing', values: { ...values('new words'), phase: 'composing' } } } }));
  expect(cancelOutgoing(root, id, nextKey)).toBe('kept');
  const kept = useDraftStore.getState().entries[record]!.values;
  expect(kept.attachments).toBeUndefined();
  expect(JSON.parse(kept.submitted!)).toMatchObject({ conversationId: 'later', attachments: [] });
  expect(useDraftStore.getState().entries[nextKey]!.values.doc).toContain('new words');
});
test('cancellation beside an occupied input clears its uncertain notice while keeping the terminal row', async () => {
  useToasts.setState({ toasts: [] }); const id = setup(); let cancelled = false;
  fetcher(() => Promise.reject(new TypeError('cut POST')), () => reply(conv([], cancelled ? [id] : [])), () => { cancelled = true; return reply(conv([], [id])); });
  mount(); fireEvent.click(document.querySelector('[data-ask-send]')!); await finish();
  await waitFor(() => expect(useToasts.getState().toasts).toHaveLength(1));
  const slot = useToasts.getState().toasts[0]!.id;
  act(() => { updateDraft(key, { values: values('occupied input') }); });
  cancel(); await finish(); await screen.findByText('取り消しました。');
  expect(useToasts.getState().toasts.some(toast => toast.id === slot)).toBe(false);
  expect(useDraftStore.getState().entries[key]!.values.doc).toContain('occupied input');
  expect(useDraftStore.getState().entries[outgoingKey(root, id)]?.values.stage).toBe('refused');
});
for (const stage of ['refused', 'cancelled'] as const) for (const activity of ['running', 'warming'] as const)
test(`folded, a ${stage} local row yields only to work the open conversation shows (${activity})`, () => {
  const id = queued();
  const entry = useDraftStore.getState().entries[outgoingKey(root, id)]!;
  updateDraft(outgoingKey(root, id), { values: { ...entry.values, stage: 'refused', last: stage === 'cancelled' ? 'withdraw' : 'ask', refusal: 'refused' } });
  const working = activity === 'running' ? [{ ...turn('working'), status: 'running' as const }] : [];
  setConversationState({ conversation: { ...conv(), turns: working, busy: true, warm: activity === 'warming' ? 'preparing' as const : 'none' as const } });
  render(<TestWorkspace data={screenData(tree())}><ShownConversationProvider><LastWordsPill style={{}} /></ShownConversationProvider></TestWorkspace>);
  const pill = document.querySelector('[data-coordinator-pill]')!;
  // A warm-up is no message's work: the row's own words stay the line's, as in the open conversation.
  expect(pill.getAttribute('data-coordinator-pill-state')).toBe(activity === 'running' ? 'running' : 'unread');
  if (activity === 'running') expect(pill.textContent).toContain(i18n.t('ui:coordinatorCard.thinking'));
  act(() => { setConversationState({ conversation: conv() }); });
  expect(pill.getAttribute('data-coordinator-pill-state')).toBe('unread');
});

// A warm-up alone is preparation; presentation scope is supplied by the caller.
for (const language of ['ja', 'en']) test(`an empty warming conversation keeps the open-conversation pill; ${language}`, async () => {
  await i18n.changeLanguage(language); setup('');
  setConversationState({ conversation: { ...conv(), busy: true, warm: 'preparing' as const } });
  render(<TestWorkspace data={screenData(tree())}><ShownConversationProvider><LastWordsPill style={{}} /></ShownConversationProvider></TestWorkspace>);
  const pill = document.querySelector('[data-coordinator-pill]')!;
  expect(pill.getAttribute('data-coordinator-pill-state')).toBe('none');
  expect(pill.textContent).toBe(i18n.t('ui:coordinatorCard.expand'));
  act(() => { setConversationState({ conversation: conv() }); });
  expect(pill.textContent).toBe(i18n.t('ui:coordinatorCard.expand'));
});
test('outbox uses the supplied input destination instead of reading coordinator presentation', () => {
  useToasts.setState({ toasts: [] }); const id = queued();
  expect(cancelOutgoing(root, id, null)).toBe('restored');
  expect(useDraftStore.getState().entries[key]!.values.doc).toContain('words');
  expect(useToasts.getState().toasts.map(toast => toast.text)).toEqual(['取り消しました。']);
});


test('a pre-send cancellation cannot later issue a server withdrawal for that request', async () => {
  const id = setup(); window.__ALPACAWORK_WRITE_GRACE_MS__ = 5000;
  freeze(root, fixed(), useDraftStore.getState().entries[key]!.values, { from: key });
  offerOutgoingUndo(root, id, document);
  const fetch = fetcher(() => reply(conv()), () => reply(conv()), () => reply(conv([], [id])));
  expect(useUndoOffers.getState().offers.find(offer => offer.id === id)).toBeUndefined();
  expect(cancelUnsent(root, id)).toBe('cancelled');
  await useConversation.getState().messageAction('withdraw', id);
  expect(fetch).not.toHaveBeenCalled();
  expect(beginWithdrawal(root, id)).toBeNull(); expect(begin(root, id)).toBeNull();
});
test('after dispatch only server withdrawal can cancel the request', async () => {
  const id = setup(); window.__ALPACAWORK_WRITE_GRACE_MS__ = 5000;
  const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now);
  freeze(root, fixed(), useDraftStore.getState().entries[key]!.values, { from: key });
  offerOutgoingUndo(root, id, document);
  expect(useUndoOffers.getState().offers.find(offer => offer.id === id)).toBeUndefined();
  vi.mocked(Date.now).mockReturnValue(now + 5000);
  const attempt = begin(root, id)!; attempt.check(); attempt.finish();
  const fetch = fetcher(() => reply(conv()), () => reply(conv()), () => reply(conv([], [id])));
  expect(cancelUnsent(root, id)).toBe('already_dispatched'); expect(cancelUnsent(root, id)).toBe('already_dispatched');
  await useConversation.getState().messageAction('withdraw', id);
  expect(fetch.mock.calls.filter(([url]) => url === '/api/coordinator/messages/withdraw')).toHaveLength(1);
  expect(fetch.mock.calls.filter(([url]) => url === '/api/coordinator/messages')).toHaveLength(0);
  expect(useDraftStore.getState().entries[key]!.values.doc).toContain('words');
  expect(cancelUnsent(root, id)).toBe('gone');
  expect(begin(root, id)).toBeNull();
});

for (const branch of ['started', 'pending'] as const) for (const edited of [false, true]) test(`admission consumes retained input after withdrawal ${branch}, edited=${edited}`, async () => {
  const id = queued('already started words');
  if (edited) updateDraft(key, { values: { ...useDraftStore.getState().entries[key]!.values, doc: JSON.stringify(textDocument('new unsent words')) } });
  const posts: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (String(url) === '/api/coordinator/messages/withdraw') return reply({ error: { code: 'conflict', retry: 'reread', message: 'already sent',
      ...branch === 'started' ? { reason: { kind: 'message_has_already_been_sent' } } : {} } }, 409);
    if (String(url) === '/api/coordinator') {
      if (branch === 'started') throw new TypeError('synthetic read outage');
      return reply(conv([turn(id, 'already started words')]));
    }
    if (String(url) === '/api/coordinator/messages') { posts.push(JSON.parse(String(init?.body))); return reply(conv()); }
    return reply({ status: 'unavailable', profile: 'claude', skills: [] });
  }));
  await act(async () => { await expect(useConversation.getState().messageAction('withdraw', id)).rejects.toBeTruthy(); });
  mount();
  const button = document.querySelector<HTMLButtonElement>('[data-ask-send]')!;
  if (edited) { expect(useDraftStore.getState().entries[key]!.values.doc).toContain('new unsent words'); expect(button.disabled).toBe(false); }
  else { expect(useDraftStore.getState().entries[key]!.values.doc).not.toContain('already started words'); expect(button.disabled).toBe(true); }
  expect(posts).toEqual([]);
});
