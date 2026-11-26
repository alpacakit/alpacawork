import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { i18n, startI18n } from '@alpacawork/i18n';
import { snapshotJson, setConversationState, SERVED, serving, servedJson, messageJson } from './conversation-fixture';
import { TestWorkspace, screenData, tree } from './fixtures';
import { CoordinatorCard } from '../src/features/coordinator/CoordinatorCard';
import { ShownConversationProvider } from '../src/features/coordinator/shown';
import { WaitingRows, useWaiting, rowControl } from '../src/features/coordinator/CoordinatorQueue';
import { useConversation } from '../src/features/coordinator/coordinator';
import { begin, beginWithdrawal, freeze, outgoingKey, useOutbox, canTakeBack, takeBack, reconcileOutbox, refuse as refuseOutgoing } from '../src/features/coordinator/editor/outbox';
import { useDraftStore, draftKey, updateDraft } from '../src/features/forms/draft-store';
import { taskLabel, textDocument } from '../src/features/coordinator/editor/document';
import { notify, useToasts } from '../src/lib/notify';
import { press } from '../src/features/coordinator/press';
import type { CoordinatorTurn } from '../src/data/coordinator';
import { CoordinatorThread } from '../src/features/coordinator/CoordinatorThread';
import { CoordinatorInput } from '../src/features/coordinator/CoordinatorInput';
import * as recoveredFiles from '../src/features/coordinator/editor/recovered-files';
import { readDrafts } from '../src/features/forms/draft-store';
import { deliveryNoticeId } from '../src/features/coordinator/delivery-notice';

const root = '/fixture', cid = 'ack-conversation';
const turn = (id: string, status: CoordinatorTurn['status']): CoordinatorTurn => ({ id, status, ask: id, at: '2026-10-31T15:00:00Z',
  attachments: [], waiting: status === 'queued' || status === 'sending', answer: null, answeredAt: null, error: null, result: null, seen: false });
const work = turn('working', 'running'), queued = turn('waiting', 'queued');
const conversation = (turns = [work, queued], cancelled: string[] = []) => ({ id: cid, nextLaunch: { agent: 'fake', values: {} }, ...SERVED, busy: true, turns, cancelled });
const response = (value: unknown) => new Response(snapshotJson(value));
/** A send's, withdrawal's or send-now's answer: the snapshot and where that message now is. */
const answer = (value: ReturnType<typeof conversation>, id: string, status?: Parameters<typeof messageJson>[2]) => new Response(messageJson(value, id, status));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function Rows() { return <WaitingRows queue={useWaiting()} open={() => {}} />; }
function mount() { return render(<TestWorkspace><ShownConversationProvider><Rows /></ShownConversationProvider></TestWorkspace>); }
/** Clear conversation is in the usage menu, opened from the send row. */
function openClear() {
  fireEvent.click(document.querySelector('[data-coordinator-context]')!);
  return document.querySelector<HTMLButtonElement>('[data-coordinator-clear]')!;
}
/** While clearing, the conversation's column takes no presses. */
const clearing = () => document.querySelector('[data-reading-column][aria-busy=true]');
function mountInput() { return render(<TestWorkspace><ShownConversationProvider><Rows /><CoordinatorThread turns={[]} retry={() => {}} /><CoordinatorInput launch={{ next: { agent: 'fake', values: {} }, ready: false }} /></ShownConversationProvider></TestWorkspace>); }
function local() {
  const key = draftKey(root, 'coordinator', cid), id = crypto.randomUUID();
  const values = { requestId: id, doc: JSON.stringify(textDocument('Local words')), phase: 'composing' };
  useDraftStore.setState({ entries: { [key]: { status: 'editing', values } }, unavailable: false });
  freeze(root, { conversationId: cid, text: 'Local words', attachments: [] }, values,
    { from: key });
  return { id, key };
}
beforeAll(() => startI18n());
beforeEach(async () => { useToasts.setState({ toasts: [] }); await i18n.changeLanguage('en'); screenData(tree()); setConversationState({ root, conversation: conversation(), open: true, expanded: true, engaged: false }); });
// Withdrawals a test's serve answered are this page's knowledge: the next test starts with none.
afterEach(() => { cleanup(); vi.unstubAllGlobals(); useOutbox.setState({ live: new Set() }); setConversationState({ conversation: null }); });

test('send-now replaces its button immediately and admits one POST in the same event', async () => {
  const pending = deferred<Response>(); const fetcher = vi.fn(() => pending.promise); vi.stubGlobal('fetch', fetcher); mount();
  const button = screen.getByRole('button', { name: 'Send now' });
  act(() => { button.click(); button.click(); });
  expect(screen.queryByRole('button', { name: 'Send now' })).toBeNull();
  expect(screen.getByText('Sending…')).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => { pending.resolve(response(conversation([work, { ...queued, joinRequested: true }]))); });
});

test('clear replaces the confirmed button and admits one POST in the same event', async () => {
  const pending = deferred<Response>();
  const fetcher = vi.fn((url: string) => url === '/api/coordinator/clear' ? pending.promise : Promise.resolve(response(conversation())));
  vi.stubGlobal('fetch', fetcher);
  render(<TestWorkspace><CoordinatorCard /></TestWorkspace>);
  const clear = openClear();
  fireEvent.click(clear);
  act(() => { clear.click(); clear.click(); });
  expect(document.querySelector('button[data-coordinator-clear]')).toBeNull();
  expect(clearing()).not.toBeNull();
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/coordinator/clear')).toHaveLength(1);
  await act(async () => { pending.resolve(response({ ...conversation([]), id: 'new-conversation' })); });
});

test('a withdrawal during checking prevents the pending ask from posting', async () => {
  const { id } = local(), ask = begin(root, id)!;
  const fetcher = vi.fn(serving(conversation([work], [id]))); vi.stubGlobal('fetch', fetcher);
  const withdrawing = useConversation.getState().messageAction('withdraw', id);
  expect(useDraftStore.getState().entries[outgoingKey(root, id)]?.values.last).toBe('withdraw');
  expect(ask.check()).toBe('retained');
  await withdrawing; ask.finish();
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/coordinator/messages/withdraw']);
});

test('ask and withdraw release only their own live attempt', () => {
  const { id } = local(), ask = begin(root, id)!; ask.check();
  const withdrawal = beginWithdrawal(root, id, conversation());
  expect(withdrawal).not.toBeNull();
  ask.finish();
  expect(beginWithdrawal(root, id, conversation())).toBeNull();
  withdrawal!.finish();
  expect(beginWithdrawal(root, id, conversation())).not.toBeNull();
});

test.each([
  [{ closing: false, deliveryError: true, sending: false, requested: true, server: true, running: true }, 'cancel'],
  [{ closing: false, deliveryError: true, sending: false, requested: false, server: true, running: true }, 'cancel'],
  [{ closing: false, withdrawal: 'unknown', sending: false, requested: true, server: true, running: true }, 'cancel'],
  [{ closing: false, withdrawal: 'unknown', sending: true, requested: true, server: true, running: true }, 'handing'],
  [{ closing: true, withdrawal: 'live', sending: true, requested: true, server: true, running: true }, 'closing'],
  [{ closing: false, withdrawal: 'live', sending: true, requested: true, server: true, running: true }, 'withdrawing'],
  [{ closing: false, withdrawal: undefined, sending: true, requested: true, server: true, running: true }, 'handing'],
  [{ closing: false, withdrawal: undefined, sending: false, requested: true, server: true, running: true }, 'requested'],
  [{ closing: false, withdrawal: undefined, sending: false, requested: false, server: true, running: true }, 'send-now'],
  [{ closing: false, withdrawal: undefined, sending: false, requested: false, server: false, running: true }, 'cancel'],
  [{ closing: false, withdrawal: undefined, sending: false, requested: false, server: true, running: false }, 'cancel'],
] as const)('row control precedence %j → %s', (input, expected) => { expect(rowControl(input)).toBe(expected); });

for (const end of ['running', 'cancelled', 'changed', 'requested'] as const) test(`send-now failure is silent when a read proves ${end}`, async () => {
  const failure = vi.spyOn(notify, 'error');
  const after = end === 'changed' ? { ...conversation([]), id: 'new-conversation' }
    : end === 'cancelled' ? conversation([work], [queued.id])
    : conversation([work, { ...queued, ...(end === 'requested' ? { joinRequested: true as const } : { status: 'running' as const, waiting: false }) }]);
  const fetcher = vi.fn((url: string, init?: RequestInit) => Promise.resolve(url.endsWith('/send-now') ? new Response('', { status: 503 }) : new Response(servedJson(url, init, after))));
  vi.stubGlobal('fetch', fetcher); mount(); fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
  // Not in the read, the message's own status is asked too.
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(end === 'cancelled' ? 3 : 2));
  await waitFor(() => expect(document.querySelector('[data-coordinator-row-control=requested]') !== null || !document.querySelector('[data-coordinator-waiting]')).toBe(true));
  expect(failure).not.toHaveBeenCalled();
});

test('a lost send-now restores the original operation and emits one notification after one check', async () => {
  const failure = vi.spyOn(notify, 'error');
  const fetcher = vi.fn((url: string) => Promise.resolve(url.endsWith('/send-now') ? new Response('', { status: 503 }) : response(conversation())));
  vi.stubGlobal('fetch', fetcher); mount();
  const send = screen.getByRole('button', { name: 'Send now' }); act(() => { send.click(); send.click(); });
  await waitFor(() => expect(failure).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('button', { name: 'Send now' })).toBeTruthy();
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/coordinator/messages/send-now', '/api/coordinator']);
});

test('a superseded answer keeps its optimistic acknowledgement through the recovery read', async () => {
  const post = deferred<Response>(), check = deferred<Response>(); let reads = 0;
  const fetcher = vi.fn((url: string) => url.endsWith('/send-now') ? post.promise : ++reads === 1 ? Promise.resolve(response(conversation())) : check.promise);
  vi.stubGlobal('fetch', fetcher); mount(); fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
  await act(() => useConversation.getState().refresh());
  await act(async () => { post.resolve(response(conversation([work, { ...queued, joinRequested: true }]))); });
  await waitFor(() => expect(reads).toBe(2));
  expect(screen.queryByRole('button', { name: 'Send now' })).toBeNull(); expect(screen.getByText('Sending…')).toBeTruthy();
  await act(async () => { check.resolve(response(conversation([work, { ...queued, joinRequested: true }]))); });
});

test('real input checking can be withdrawn before its asynchronous file preflight returns', async () => {
  const { id } = local(), files = deferred<void>();
  vi.spyOn(recoveredFiles, 'copyRecoveredFiles').mockImplementation(() => files.promise.then(() => undefined));
  const fetcher = vi.fn((url: string) => Promise.resolve(url.endsWith('/withdraw') ? response(conversation([work], [id])) : response(conversation())));
  vi.stubGlobal('fetch', fetcher); mountInput();
  await waitFor(() => expect(recoveredFiles.copyRecoveredFiles).toHaveBeenCalled());
  fireEvent.click(document.querySelector(`[data-coordinator-waiting="${id}"] [data-coordinator-withdraw]`)!);
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url.endsWith('/withdraw'))).toBe(true));
  await act(async () => { files.resolve(); });
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/coordinator/messages')).toHaveLength(0);
  expect(useDraftStore.getState().entries[draftKey(root, 'coordinator', cid)]!.values.doc).toContain('Local words');
});

test('real input admission can be withdrawn without a late ask failure destroying recovered words', async () => {
  const { id, key } = local(), ask = deferred<Response>();
  const fetcher = vi.fn((url: string) => url === '/api/coordinator/messages' ? ask.promise
    : Promise.resolve(url.endsWith('/withdraw') ? response(conversation([work], [id])) : response(conversation())));
  vi.stubGlobal('fetch', fetcher); mountInput();
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === '/api/coordinator/messages')).toHaveLength(1));
  const cancel = document.querySelector<HTMLButtonElement>(`[data-coordinator-waiting="${id}"] [data-coordinator-withdraw]`)!;
  expect(cancel.disabled).toBe(false); fireEvent.click(cancel);
  await waitFor(() => expect(useDraftStore.getState().entries[key]!.values.doc).toContain('Local words'));
  await act(async () => { ask.resolve(response(conversation([work], [id]))); });
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/coordinator/messages')).toHaveLength(1);
  expect(useDraftStore.getState().entries[key]!.values.doc).toContain('Local words');
});

test.each([false, true])('withdrawal unknown restores the same right close icon and survives reload (ask live=%s)', async askLive => {
  const { id } = local(), ask = begin(root, id)!; ask.check();
  if (!askLive) ask.finish();
  const first = deferred<Response>(), retry = deferred<Response>(); let posts = 0;
  const fetcher = vi.fn((url: string, init?: RequestInit) => url.endsWith('/withdraw') ? ++posts === 1 ? first.promise : retry.promise : Promise.resolve(new Response(servedJson(url, init, conversation()))));
  vi.stubGlobal('fetch', fetcher); const view = mount();
  const row = () => document.querySelector<HTMLElement>(`[data-coordinator-waiting="${id}"]`)!;
  const close = () => row().querySelector<HTMLButtonElement>('[data-coordinator-row-control] button[data-coordinator-withdraw]')!;
  try {
    fireEvent.click(close());
    expect(row().querySelector('[data-coordinator-row-control]')?.textContent).toBe('Cancelling…');
    expect(row().querySelector('[data-coordinator-withdraw]')).toBeNull();
    await act(async () => { first.resolve(new Response('', { status: 503 })); });
    await waitFor(() => expect(row().querySelector('[role=alert]')?.textContent).toBe('Couldn\'t confirm whether it was cancelled.'));
    const assertUnknown = () => {
      expect(close()).not.toBeNull(); expect(close().disabled).toBe(false);
      expect(row().querySelectorAll('[data-coordinator-withdraw]')).toHaveLength(1);
      expect(row().querySelector('[role=alert] button')).toBeNull();
      expect(row().querySelector('[data-coordinator-row-control] [role=status]')).toBeNull();
      expect(row().querySelector('[data-coordinator-send-now]')).toBeNull();
    };
    assertUnknown();
    act(() => ask.finish());
    view.unmount(); useDraftStore.setState({ entries: readDrafts().entries }); mount();
    expect(row().querySelector('[role=alert]')?.textContent).toBe('Couldn\'t confirm whether it was cancelled.');
    assertUnknown();
    const cancel = close(); act(() => { cancel.click(); cancel.click(); });
    expect(row().querySelector('[data-coordinator-row-control]')?.textContent).toBe('Cancelling…');
    expect(posts).toBe(2);
    expect(fetcher.mock.calls.filter(([url]) => url === '/api/coordinator')).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/withdraw')).map(call => JSON.parse((call[1] as RequestInit).body as string)))
      .toEqual([{ conversationId: cid, id }, { conversationId: cid, id }]);
    await act(async () => { retry.resolve(answer(conversation([work], [id]), id)); });
    expect(row()).toBeNull();
  } finally { ask.finish(); }
});

for (const changed of [false, true]) test(`clear failure after one read: changed=${changed}`, async () => {
  const pending = deferred<Response>(), failure = vi.spyOn(notify, 'error');
  const after = changed ? { ...conversation([]), id: 'new-conversation' } : conversation();
  const fetcher = vi.fn((url: string) => url.endsWith('/clear') ? pending.promise : Promise.resolve(response(after)));
  vi.stubGlobal('fetch', fetcher); render(<TestWorkspace><CoordinatorCard /></TestWorkspace>);
  const clear = openClear(); fireEvent.click(clear);
  act(() => { clear.click(); clear.click(); });
  await act(async () => { pending.resolve(new Response('', { status: 503 })); });
  expect(failure).toHaveBeenCalledTimes(changed ? 0 : 1);
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/coordinator')).toHaveLength(1);
  // Kept, the conversation can be cleared again; cleared after all, the new one is shown.
  await waitFor(() => expect(clearing()).toBeNull());
  expect(useConversation.getState().conversation?.id).toBe(changed ? 'new-conversation' : cid);
  if (!changed) expect(openClear().disabled).toBe(false);
});

test('the central sender waits for clear, and never posts an old conversation after it changes', async () => {
  const pending = deferred<Response>();
  const fetcher = vi.fn((url: string) => url.endsWith('/clear') ? pending.promise : Promise.resolve(response(conversation())));
  vi.stubGlobal('fetch', fetcher); render(<TestWorkspace><CoordinatorCard /></TestWorkspace>);
  const clear = openClear(); fireEvent.click(clear); fireEvent.click(clear);
  const sending = useConversation.getState().ask({ conversationId: cid, id: 'reader-request', text: 'Reader send', attachments: [] });
  const result = expect(sending).rejects.toThrow('changed');
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/coordinator/messages')).toHaveLength(0);
  await act(async () => { pending.resolve(response({ ...conversation([]), id: 'new-conversation' })); await result; });
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/coordinator/messages')).toHaveLength(0);
});

test('the real sender recovers words refused after crossing the clear gate', async () => {
  const { id, key } = local(), files = deferred<void>(), clearing = deferred<Response>();
  vi.spyOn(recoveredFiles, 'copyRecoveredFiles').mockImplementation(() => files.promise.then(() => undefined));
  const next = { ...conversation([]), id: 'after-clear' };
  const fetcher = vi.fn((url: string) => url.endsWith('/clear') ? clearing.promise : Promise.resolve(response(next)));
  vi.stubGlobal('fetch', fetcher); mountInput();
  await waitFor(() => expect(recoveredFiles.copyRecoveredFiles).toHaveBeenCalled());
  let flight!: Promise<void>;
  act(() => { flight = press({ root, conversationId: cid, target: cid, action: 'clear' }, () => useConversation.getState().clear()); });
  await act(async () => { files.resolve(); });
  await waitFor(() => expect(useDraftStore.getState().entries[outgoingKey(root, id)]?.values.stage).toBe('posted'));
  await act(async () => { clearing.resolve(response(next)); await flight; });
  await waitFor(() => expect(useDraftStore.getState().entries[draftKey(root, 'coordinator', next.id)]?.values.doc).toContain('Local words'));
  await act(() => useConversation.getState().refresh());
  expect(useDraftStore.getState().entries[draftKey(root, 'coordinator', next.id)]?.values.doc).toContain('Local words');
  expect(readDrafts().entries[draftKey(root, 'coordinator', next.id)]?.values.doc).toContain('Local words');
  expect(readDrafts().entries[key]?.values.doc).not.toContain('Local words');
  expect(useDraftStore.getState().entries[outgoingKey(root, id)]).toBeUndefined();
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/coordinator/messages')).toHaveLength(0);
});

test.each([false, true])('deliveryError shows only the close icon (requested=%s)', requested => {
  setConversationState({ conversation: conversation([work, { ...queued, deliveryError: 'closed', ...requested ? { joinRequested: true } : {} }]) });
  mount();
  const controls = document.querySelector('[data-coordinator-row-control]')!;
  expect(controls.querySelectorAll('button')).toHaveLength(1);
  expect(controls.querySelector('[data-coordinator-withdraw]')).not.toBeNull();
  expect(controls.querySelector('[role=status]')).toBeNull();
  expect(controls.querySelector('[data-coordinator-send-now]')).toBeNull();
});

test('a requested row can be withdrawn through the same close icon', async () => {
  const removing = deferred<Response>();
  const fetcher = vi.fn((url: string, init?: RequestInit) => url.endsWith('/withdraw') ? removing.promise : Promise.resolve(new Response(servedJson(url, init, conversation([work, { ...queued, joinRequested: true }])))));
  vi.stubGlobal('fetch', fetcher); mount();
  fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
  await waitFor(() => expect(useConversation.getState().conversation?.turns.at(-1)?.joinRequested).toBe(true));
  const status = screen.getByText('Sending…');
  expect(status.querySelector('svg')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByText('Cancelling…')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  await act(async () => { removing.resolve(answer(conversation([work], [queued.id]), queued.id)); });
  expect(document.querySelector(`[data-coordinator-waiting="${queued.id}"]`)).toBeNull();
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/coordinator/messages/send-now', '/api/coordinator/messages/withdraw']);
});

for (const action of ['send-now', 'clear'] as const) for (const read of ['same', 'changed', 'lost'] as const)
test(`${action} reports its own outcome after one ${read} check`, async () => {
  await i18n.changeLanguage('ja');
  const fetcher = vi.fn((url: string) => Promise.resolve(url === '/api/coordinator'
    ? read === 'lost' ? new Response('', { status: 503 }) : response(read === 'changed' ? { ...conversation([]), id: 'after-clear' } : conversation())
    : new Response('', { status: 503 })));
  vi.stubGlobal('fetch', fetcher);
  if (action === 'clear') {
    render(<TestWorkspace><CoordinatorCard /></TestWorkspace>);
    const clear = openClear();
    fireEvent.click(clear); fireEvent.click(clear);
  } else { mount(); fireEvent.click(screen.getByRole('button', { name: '今すぐ送る' })); }
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === '/api/coordinator')).toHaveLength(1));
  await waitFor(() => expect(clearing() ?? document.querySelector('[data-coordinator-row-control="requested"]')).toBeNull());
  const texts = useToasts.getState().toasts.map(toast => toast.text);
  const expected = action === 'clear' ? read === 'lost' ? '会話を削除できたか分かりません。' : '会話を削除できませんでした。'
    : read === 'lost' ? '送信できたか分かりません。' : '送信できませんでした。列で待っています。';
  expect(texts.filter(text => text === expected)).toHaveLength(read === 'changed' ? 0 : 1);
  expect(texts).not.toContain('保存結果を確認してください。');
});

test.each(['send-now', 'withdraw', 'clear'] as const)('keyboard focus stays at %s through replacement and failure', async action => {
  const pending = deferred<Response>();
  const fetcher = vi.fn((url: string) => url === '/api/coordinator' ? Promise.resolve(response(conversation())) : pending.promise);
  vi.stubGlobal('fetch', fetcher);
  if (action === 'clear') render(<TestWorkspace><CoordinatorCard /></TestWorkspace>); else mount();
  const selector = action === 'clear' ? '[data-coordinator-clear]' : action === 'withdraw' ? '[data-coordinator-withdraw]' : '[data-coordinator-send-now]';
  const button = action === 'clear' ? openClear() : document.querySelector<HTMLButtonElement>(selector)!;
  if (action === 'clear') fireEvent.click(button);
  button.focus(); expect(document.activeElement).toBe(button);
  // A keyboard activation dispatches a detail=0 click, unlike a pointer press.
  fireEvent.click(button, { detail: 0 });
  // Clear closes its menu: focus goes back to the menu's button, where clear is pressed again.
  const place = action === 'clear' ? document.querySelector('[data-coordinator-context]')! : document.querySelector('[data-coordinator-row-control]')!;
  if (action === 'clear') await waitFor(() => expect(document.activeElement).toBe(place));
  expect(document.activeElement).not.toBe(document.body); expect(place.contains(document.activeElement)).toBe(true);
  await act(async () => { pending.resolve(new Response('', { status: 503 })); });
  expect(document.activeElement).not.toBe(document.body); expect(place.contains(document.activeElement)).toBe(true);
  if (action === 'clear') { expect(document.activeElement).toBe(place); expect(openClear().disabled).toBe(false); return; }
  expect(document.querySelector(selector)).not.toBeNull();
  expect(document.activeElement).toBe(document.querySelector(selector));
});

for (const occupied of ['empty', 'prepared', 'busy'] as const) for (const attachments of [0, 1, 4])
test(`a late server refusal is recoverable in the current conversation (occupied=${occupied}, files=${attachments})`, async () => {
  const { id, key } = local(), pending = deferred<Response>();
  if (attachments) {
    const entry = useDraftStore.getState().entries[outgoingKey(root, id)]!;
    const names = Array.from({ length: attachments }, (_, n) => attachments === 1 ? 'report.txt' : `report-${n}.txt`);
    updateDraft(outgoingKey(root, id), { values: { ...entry.values, attachments: JSON.stringify(names.map(name => ({ name, path: `attachments/${id}/${name}`, absolutePath: `/api/coordinator/file?requestId=${id}&name=${name}`, size: 4 }))),
      submitted: JSON.stringify({ ...JSON.parse(entry.values.submitted!), attachments: names }),
      completedUploads: JSON.stringify(['old-upload']), removeOps: '{}', readerCopies: '{}' } });
    updateDraft(key, { values: { ...useDraftStore.getState().entries[key]!.values, attachments: useDraftStore.getState().entries[outgoingKey(root, id)]!.values.attachments! } });
  }
  const fetcher = vi.fn((url: string, init?: RequestInit) => url === '/api/coordinator/messages' ? pending.promise : serving({ ...conversation([]), id: 'current' })(url, init));
  vi.stubGlobal('fetch', fetcher); mountInput();
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === '/api/coordinator/messages')).toHaveLength(1));
  act(() => setConversationState({ conversation: { ...conversation([]), id: 'current' } }));
  const visible = draftKey(root, 'coordinator', 'current');
  if (occupied === 'prepared') act(() => { updateDraft(visible, { values: { ...useDraftStore.getState().entries[visible]!.values, phase: 'prepared', doc: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [taskLabel({ id: 'T1', title: 'Screen seed' })] }] }) } }); });
  if (occupied === 'busy') act(() => { updateDraft(visible, { values: { ...useDraftStore.getState().entries[visible]!.values, doc: JSON.stringify(textDocument('New unsent words')), phase: 'composing' } }); });
  await act(async () => { pending.resolve(new Response(JSON.stringify({ error: { code: 'conflict', retry: 'reread', message: 'changed', reason: { kind: 'conversation_has_changed' } } }), { status: 409 })); });
  if (occupied === 'busy') {
    await waitFor(() => expect(screen.getByRole('button', { name: 'Return to input' })).toBeTruthy());
    expect(useDraftStore.getState().entries[visible]!.values.doc).toContain('New unsent words');
    expect(readDrafts().entries[outgoingKey(root, id)]!.values.doc).toContain('Local words');
    await act(() => useConversation.getState().refresh());
    expect(readDrafts().entries[outgoingKey(root, id)]!.values.doc).toContain('Local words');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Return to input' }).disabled).toBe(true);
    act(() => { updateDraft(visible, { values: { ...useDraftStore.getState().entries[visible]!.values, doc: JSON.stringify(textDocument('')), phase: 'prepared' } }); });
    const notice = useToasts.getState().toasts.find(toast => toast.id === deliveryNoticeId(root, id));
    expect(notice?.text).toContain("It's still in the chat");
    if (attachments) expect(notice?.text).toContain(attachments === 1 ? 'Reattach report.txt.' : 'Reattach 4 attachments.');
    if (attachments) {
      expect(readDrafts().entries[outgoingKey(root, id)]!.values.attachments).toBeUndefined();
      expect(JSON.parse(readDrafts().entries[outgoingKey(root, id)]!.values.submitted!).attachments).toEqual([]);
      expect(document.querySelector('[data-coordinator-thread] [data-attachment]')).toBeNull();
    }
    notify.error('An unrelated message', { id: 'unrelated' });
    fireEvent.click(screen.getByRole('button', { name: 'Return to input' }));
    expect(useToasts.getState().toasts.some(toast => toast.id === deliveryNoticeId(root, id))).toBe(false);
    expect(useToasts.getState().toasts.some(toast => toast.id === 'unrelated')).toBe(true);
  }
  await waitFor(() => expect(useDraftStore.getState().entries[visible]?.values.doc).toContain('Local words'));
  expect(readDrafts().entries[visible]!.values.doc).toContain('Local words');
  expect(readDrafts().entries[key]?.values.doc).not.toContain('Local words');
  expect(readDrafts().entries[outgoingKey(root, id)]).toBeUndefined();
  expect(useDraftStore.getState().entries[visible]!.values.requestId).not.toBe(id);
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/coordinator/messages')).toHaveLength(1);
  if (attachments) {
    if (occupied !== 'busy') expect(useToasts.getState().toasts.map(toast => toast.text).join(' ')).toContain(attachments === 1 ? 'Reattach report.txt.' : 'Reattach 4 attachments.');
    fetcher.mockImplementation((url: string) => Promise.resolve(url.startsWith('/api/coordinator/file') ? new Response('', { status: 404 }) : response({ ...conversation([]), id: 'current' })));
    const values = useDraftStore.getState().entries[visible]!.values;
    for (const field of ['attachments', 'uploadOps', 'removeOps', 'completedUploads', 'readerCopies']) expect(values[field]).toBeUndefined();
    expect(document.querySelector('[data-attachment]')).toBeNull();
    const reads = fetcher.mock.calls.length;
    await recoveredFiles.copyRecoveredFiles(values, 'current', values.requestId!);
    expect(fetcher.mock.calls).toHaveLength(reads); // No stale file to fetch or remove before this text can be sent.
    expect(fetcher.mock.calls.filter(([url]) => url === '/api/coordinator/messages')).toHaveLength(1);
    expect(readDrafts().entries[visible]!.values.attachments).toBeUndefined();
    fetcher.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/coordinator/messages') {
        const sent = JSON.parse(init!.body as string);
        expect(sent.conversationId).toBe('current'); expect(sent.attachments).toEqual([]);
        return Promise.resolve(answer({ ...conversation([{ ...queued, id: sent.id, ask: sent.text }]), id: 'current' }, sent.id));
      }
      return Promise.resolve(new Response('', { status: 404 }));
    });
    // An explicit new send succeeds as text, with no removal/copy of the cleared files.
    act(() => { freeze(root, { conversationId: 'current', text: 'Local words', attachments: [] }, values,
      { from: visible }); });
    await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === '/api/coordinator/messages')).toHaveLength(2));
    await waitFor(() => expect(useConversation.getState().conversation?.turns.some(turn => turn.id === values.requestId && turn.ask === 'Local words')).toBe(true));
    expect(fetcher.mock.calls.some(([url]) => url.startsWith('/api/coordinator/file'))).toBe(false);
  }
});

for (const read of ['queued', 'absent', 'lost'] as const)
test(`withdrawal uses the common recovery rule (${read})`, async () => {
  await i18n.changeLanguage('ja');
  const fetcher = vi.fn((url: string, init?: RequestInit) => Promise.resolve(url.endsWith('/withdraw') || read === 'lost' ? new Response('', { status: 503 })
    : new Response(servedJson(url, init, conversation(read === 'absent' ? [work] : [work, queued])))));
  vi.stubGlobal('fetch', fetcher);
  if (read === 'queued') render(<TestWorkspace><CoordinatorCard /></TestWorkspace>); else mount();
  fireEvent.click(screen.getByRole('button', { name: '取り消す' }));
  await waitFor(() => expect(document.querySelector('[data-coordinator-row-control=withdrawing]')).toBeNull());
  const outcome = read === 'queued' ? '取り消せませんでした。' : '取り消せたか分かりません。';
  // A queued rejection needs a notice; uncertainty already carried by the actual row needs no duplicate.
  await waitFor(() => expect(screen.queryAllByText(outcome).length + useToasts.getState().toasts.filter(toast => toast.text === outcome).length).toBe(1));
  // One check: the conversation, then the message's own status when the conversation no longer holds it.
  const status = `/api/coordinator/messages/${queued.id}/status`;
  expect(fetcher.mock.calls.slice(0, 3).map(([url]) => url)).toEqual(['/api/coordinator/messages/withdraw', '/api/coordinator', ...read === 'absent' ? [status] : []]);
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/coordinator')).toHaveLength(1);
  expect(document.querySelector('[data-coordinator-row-control] [data-coordinator-withdraw]')).not.toBeNull();
  if (read === 'queued') {
    expect(useToasts.getState().toasts.filter(toast => toast.text === '取り消せませんでした。')).toHaveLength(1);
    expect(screen.queryByText('取り消せたか分かりません。')).toBeNull();
    expect(screen.getByRole('button', { name: '今すぐ送る' })).toBeTruthy();
  }
});

for (const nextSending of [false, true]) test.each(['send-now', 'withdraw'] as const)(`%s success moves focus to the next operable queue control (next sending=${nextSending})`, async action => {
  const remaining = [{ ...queued, id: 'next', ...nextSending ? { status: 'sending' as const } : {} }, ...nextSending ? [{ ...queued, id: 'last' }] : []];
  setConversationState({ conversation: conversation([work, queued, ...remaining]) });
  const pending = deferred<Response>(); vi.stubGlobal('fetch', vi.fn(() => pending.promise)); mount();
  const first = document.querySelector<HTMLElement>(`[data-coordinator-waiting="${queued.id}"]`)!;
  const control = first.querySelector<HTMLButtonElement>(action === 'withdraw' ? '[data-coordinator-withdraw]' : '[data-coordinator-send-now]')!;
  control.focus(); fireEvent.click(control, { detail: 0 });
  await act(async () => { pending.resolve(answer(conversation([work, ...remaining], action === 'withdraw' ? [queued.id] : []), queued.id, action === 'withdraw' ? 'withdrawn' : 'running')); });
  expect(document.activeElement).not.toBe(document.body);
  expect(document.activeElement?.closest('[data-coordinator-waiting]')?.getAttribute('data-coordinator-waiting')).toBe(nextSending ? 'last' : 'next');
});

test('the last queue removal focuses the queue itself', async () => {
  const pending = deferred<Response>(); vi.stubGlobal('fetch', vi.fn(() => pending.promise)); mount();
  const cancel = screen.getByRole('button', { name: 'Cancel' }); cancel.focus(); fireEvent.click(cancel, { detail: 0 });
  await act(async () => { pending.resolve(answer(conversation([work], [queued.id]), queued.id)); });
  expect(document.activeElement).toBe(screen.getByRole('list', { name: 'Messages waiting to be sent' }));
});

test('clear success focuses the input', async () => {
  const pending = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/clear') ? pending.promise : Promise.resolve(response({ ...conversation([]), id: 'current' }))));
  render(<TestWorkspace><CoordinatorCard /></TestWorkspace>);
  const clear = openClear();
  fireEvent.click(clear); clear.focus(); fireEvent.click(clear, { detail: 0 });
  await act(async () => { pending.resolve(response({ ...conversation([]), id: 'current' })); });
  await waitFor(() => expect(document.activeElement).toBe(document.querySelector('[data-one-input]')));
});

test('a blurred operation never takes focus back on the next snapshot', async () => {
  mount();
  const cancel = screen.getByRole('button', { name: 'Cancel' }); cancel.focus(); cancel.blur();
  expect(document.activeElement).toBe(document.body);
  act(() => setConversationState({ conversation: conversation([work, { ...queued, status: 'sending' }]) }));
  expect(document.activeElement).toBe(document.body);
});


test.each([false, true])('reader-bound refusals keep their document and bindings across clear (occupied=%s)', occupied => {
  const { id } = local(), key = outgoingKey(root, id), visible = draftKey(root, 'coordinator', 'current');
  const reader = { taskId: 'T1', title: 'Reader target', turn: 'question', kind: 'answer', phase: 'waiting', answer: 'send', expectedWrites: null };
  const entry = useDraftStore.getState().entries[key]!;
  updateDraft(key, { values: { ...entry.values, reader: JSON.stringify([reader]),
    attachments: JSON.stringify([{ name: 'reader.txt', path: `attachments/${id}/reader.txt`, absolutePath: '/old-reader-file', size: 1 }]),
    submitted: JSON.stringify({ ...JSON.parse(entry.values.submitted!), attachments: ['reader.txt'] }) } });
  useDraftStore.setState(state => ({ entries: { ...state.entries, [visible]: { status: 'editing', values: { requestId: crypto.randomUUID(), doc: JSON.stringify(textDocument(occupied ? 'New words' : '')), phase: occupied ? 'composing' : 'prepared' } } } }));
  expect(refuseOutgoing(root, id, 'conversation changed', false, visible)).toBe(occupied ? 'kept' : 'restored');
  expect(readDrafts().entries[occupied ? key : visible]!.values.attachments).toBeUndefined();
  if (occupied) {
    expect(readDrafts().entries[visible]!.values.doc).toContain('New words');
    expect(readDrafts().entries[key]!.values.doc).toContain('Local words');
    expect(readDrafts().entries[key]!.values.reader).toContain('question');
  } else {
    expect(readDrafts().entries[visible]!.values.doc).toContain('Local words');
    expect(readDrafts().entries[visible]!.values.readerDraftTask).toBe('T1');
    expect(JSON.parse(readDrafts().entries[visible]!.values.readerDraftTurn!)).toEqual(reader);
    expect(readDrafts().entries[key]).toBeUndefined();
  }
});

test('words refused in their own conversation go back to a later conversation without its files', () => {
  const { id, key: input } = local(), key = outgoingKey(root, id), entry = useDraftStore.getState().entries[key]!;
  const file = JSON.stringify([{ name: 'a.txt', path: `attachments/${id}/a.txt`, absolutePath: '/old-file', size: 1 }]);
  updateDraft(key, { values: { ...entry.values, attachments: file, submitted: JSON.stringify({ ...JSON.parse(entry.values.submitted!), attachments: ['a.txt'] }) } });
  updateDraft(input, { values: { requestId: crypto.randomUUID(), doc: JSON.stringify(textDocument('Occupied')), phase: 'composing' } });
  // Refused while its own conversation is in sight, it keeps its files: they can still go back there.
  expect(refuseOutgoing(root, id, 'Refused', false, input)).toBe('kept');
  expect(useDraftStore.getState().entries[key]!.values.attachments).toBe(file);
  const visible = draftKey(root, 'coordinator', 'after-clear');
  expect(canTakeBack(useDraftStore.getState().entries, root, id, visible)).toBe(true);
  expect(takeBack(root, id, visible)).toBe(true);
  const back = useDraftStore.getState().entries[visible]!.values;
  expect(back.doc).toContain('Local words');
  expect(back.attachments).toBeUndefined();
  expect(useDraftStore.getState().entries[input]!.values.doc).toContain('Occupied');
});
test('refused on its own, words wait beside a draft the person has touched, even one emptied again', () => {
  const { id, key: input } = local(), fresh = useDraftStore.getState().entries[input]!.values.requestId!;
  updateDraft(input, { values: { requestId: fresh, doc: JSON.stringify(textDocument('')), phase: 'composing' } });
  expect(refuseOutgoing(root, id, 'Refused', false, input)).toBe('kept');
  expect(useDraftStore.getState().entries[input]!.values.doc).not.toContain('Local words');
});
test('an ID conflict with files is not taken back by hand into a later conversation', () => {
  const { id } = local(), key = outgoingKey(root, id), entry = useDraftStore.getState().entries[key]!;
  updateDraft(key, { values: { ...entry.values, attachments: JSON.stringify([{ name: 'a.txt', path: `attachments/${id}/a.txt`, absolutePath: '/old-file', size: 1 }]),
    submitted: JSON.stringify({ ...JSON.parse(entry.values.submitted!), attachments: ['a.txt'] }) } });
  expect(refuseOutgoing(root, id, 'ID conflict', true, draftKey(root, 'coordinator', cid))).toBe('kept');
  expect(takeBack(root, id, draftKey(root, 'coordinator', 'after-clear'))).toBe(false);
  expect(useDraftStore.getState().entries[key]!.values.attachments).toBeDefined();
});
test('words refused in sight of their own conversation keep their files when taken back there', () => {
  const { id, key: input } = local(), key = outgoingKey(root, id), entry = useDraftStore.getState().entries[key]!;
  const file = JSON.stringify([{ name: 'a.txt', path: `attachments/${id}/a.txt`, absolutePath: '/old-file', size: 1 }]);
  updateDraft(key, { values: { ...entry.values, attachments: file, submitted: JSON.stringify({ ...JSON.parse(entry.values.submitted!), attachments: ['a.txt'] }) } });
  updateDraft(input, { values: { requestId: crypto.randomUUID(), doc: JSON.stringify(textDocument('Occupied')), phase: 'composing' } });
  expect(refuseOutgoing(root, id, 'Refused', false, input)).toBe('kept');
  updateDraft(input, { values: { requestId: crypto.randomUUID(), doc: JSON.stringify(textDocument('')), phase: 'composing' } });
  expect(takeBack(root, id, input)).toBe(true);
  expect(useDraftStore.getState().entries[input]!.values.attachments).toBe(file);
});
test('an existing same-conversation ID conflict with files stays blocked across later conversations', () => {
  const { id } = local(), key = outgoingKey(root, id), entry = useDraftStore.getState().entries[key]!;
  updateDraft(key, { values: { ...entry.values, attachments: JSON.stringify([{ name: 'a.txt', path: `attachments/${id}/a.txt`, absolutePath: '/old-file', size: 1 }]),
    submitted: JSON.stringify({ ...JSON.parse(entry.values.submitted!), attachments: ['a.txt'] }) } });
  expect(refuseOutgoing(root, id, 'ID conflict', true, draftKey(root, 'coordinator', cid))).toBe('kept');
  for (const current of ['after-clear', 'after-another-clear']) {
    const visible = draftKey(root, 'coordinator', current);
    reconcileOutbox({ ...conversation([]), id: current }, root, visible);
    expect(readDrafts().entries[key]!.values.stage).toBe('refused');
    expect(canTakeBack(readDrafts().entries, root, id, visible)).toBe(false);
  }
});
