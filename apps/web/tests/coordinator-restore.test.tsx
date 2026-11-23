import { deliveryNotice, deliveryNoticeId, endDeliveryNotice } from '../src/features/coordinator/delivery-notice';
import { notify, useToasts } from '../src/lib/notify';
import { i18n, startI18n } from '@alpacawork/i18n';
import { setConversationState } from './conversation-fixture';
import { readIndex } from '../src/data/read-model';
import { render, act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { ShownConversationProvider, useShownConversation } from '../src/features/coordinator/shown';
import { useConversation } from '../src/features/coordinator/coordinator';
import { QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { queryClient } from '../src/data/query-client';
import { receiveFullIndex } from '../src/data/resources';
import { useConnection, workspaceWriteBasis } from '../src/data/connection';
import { readWriteIdentity } from '../src/data/write-identity';
import { askCoordinator } from '../src/data/coordinator';
import { begin, freeze, cancelQueued, canTakeBack, outgoingItem, outgoingDisplay, outgoingFinished, nextDelivery, outgoingBlock, useOutbox, flushLeavingOutbox } from '../src/features/coordinator/editor/outbox';
import { LocalOutcome } from '../src/features/coordinator/LocalOutcome';
import { LastWordsPill } from '../src/features/coordinator/LastWords';
import { deliverOutgoing } from '../src/features/coordinator/deliver';
import { useDraftStore, draftKey } from '../src/features/forms/draft-store';
import { textDocument } from '../src/features/coordinator/editor/document';
import { edited } from '../src/features/coordinator/editor/lifecycle';
import { indexOf, tree } from './fixtures';
import { snapshotJson } from './conversation-fixture';
const root = '/coordinator-restore', conversationId = 'same-conversation', restored = '1f347e6d-caba-4994-aa45-a9cf99182996';
const fixed = { conversationId, text: 'frozen words', attachments: [] };
const conversation = { id: conversationId, nextLaunch: { agent: 'claude', values: {} }, warm: 'none', busy: false, cancelled: [], turns: [] };
function live(restoreId: string) { receiveFullIndex(queryClient, { ...indexOf(tree({ root })), restoreId, generation: restoreId }); useConnection.setState({ state: 'live', offline: false }); }
function admitted(id = crypto.randomUUID()) {
  const from = draftKey(root, 'coordinator', conversationId), values = { requestId: id, doc: JSON.stringify(textDocument(fixed.text)) };
  useDraftStore.setState({ unavailable: false, entries: { ...useDraftStore.getState().entries, [from]: { status: 'editing', values } } });
  expect(freeze(root, fixed, values, { from })).toBe(id);
  vi.setSystemTime(Date.now() + 6_000);
  const attempt = begin(root, id)!; expect(attempt).toBeTruthy(); expect(attempt.check()).toBe('posted'); attempt.finish();
  return id;
}
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); queryClient.clear(); live('initial'); useDraftStore.setState({ unavailable: false, entries: {} }); useOutbox.setState({ live: new Set(), resend: null }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); queryClient.clear(); });

test('normal retransmission uses the fixed request ID/body and admission pin; a direct call after restore carries the old pin', async () => {
  const id = admitted(), fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(snapshotJson(conversation)));
  const input = { ...fixed, id };
  await askCoordinator(input); await askCoordinator(input);
  const first = fetcher.mock.calls[0]![1]!;
  expect(fetcher.mock.calls[1]![1]?.body).toBe(first.body); expect([...new Headers(fetcher.mock.calls[1]![1]?.headers)]).toEqual([...new Headers(first.headers)]);
  expect(new Headers(first.headers).get('X-Alpacawork-Op-Id')).toBe(id);
  expect(new Headers(first.headers).get('X-Alpacawork-Restore-Id')).toBe('initial');
  live(restored); await askCoordinator(input);
  expect(new Headers(fetcher.mock.calls[2]![1]!.headers).get('X-Alpacawork-Restore-Id')).toBe('initial');
  expect(readWriteIdentity(root, id)).toBe('initial');
  const next = admitted(); await askCoordinator({ ...fixed, id: next });
  expect(new Headers(fetcher.mock.calls[3]![1]!.headers).get('X-Alpacawork-Restore-Id')).toBe(restored);
});

test.each([undefined, '{"restoreId":null}', '{bad', '{"restoreId":"unsupported"}', '{"restoreId":"initial","extra":true}'])('old outbox with pin %s cannot resume from any delivery entrance or create a new pin', async pin => {
  const id = admitted(), item = outgoingItem(useDraftStore.getState().entries, root, id)!, pinKey = 'alpacawork-write-identity:' + JSON.stringify([root, id]);
  if (pin === undefined) sessionStorage.removeItem(pinKey); else sessionStorage.setItem(pinKey, pin);
  const record = JSON.stringify(useDraftStore.getState().entries), fetcher = vi.spyOn(globalThis, 'fetch');
  expect(begin(root, id)).toBeNull(); expect(outgoingDisplay(item, false)).toMatchObject({ stage: 'unknown', blocked: true });
  expect(outgoingBlock(root, id)).toBeTruthy(); expect(nextDelivery(useDraftStore.getState().entries, root, conversationId)).toBeNull();
  const resend = () => deliverOutgoing({ root, client: queryClient, surface: document, profile: 'fake', draw: (_turn, work) => work() }, id);
  expect(await resend()).toBe('rejected'); flushLeavingOutbox(root);
  await expect(askCoordinator({ ...fixed, id }, workspaceWriteBasis())).rejects.toMatchObject({ code: 'write_unavailable' });
  expect(fetcher).not.toHaveBeenCalled(); expect(JSON.stringify(useDraftStore.getState().entries)).toBe(record);
  expect(sessionStorage.getItem(pinKey)).toBe(pin ?? null);
});

test('a proven old outbox is kept after restore and does not hold a distinct new admission', async () => {
  const id = admitted(), item = outgoingItem(useDraftStore.getState().entries, root, id)!, before = JSON.stringify(useDraftStore.getState().entries);
  live(restored); const fetcher = vi.spyOn(globalThis, 'fetch');
  expect(outgoingDisplay(item, false)).toMatchObject({ stage: 'unknown', blocked: true }); expect(begin(root, id)).toBeNull();
  expect(JSON.stringify(useDraftStore.getState().entries)).toBe(before);
  const next = admitted(); expect(next).not.toBe(id); expect(readWriteIdentity(root, next)).toBe(restored);
  expect(fetcher).not.toHaveBeenCalled();
});


test('an open conversation reads a changed restore identity without rewriting its outgoing record', async () => {
  setConversationState({root,conversation:{...conversation,busy:false,turns:[],cancelled:[],warm:'none'}});
  const id = admitted(), records = JSON.stringify(useDraftStore.getState().entries);
  function Read() { const shown=useShownConversation();return <output data-testid="projection">{JSON.stringify(shown.local.map(turn=>({id:turn.id,blocked:!!turn.blocked})))}</output>; }
  render(<QueryClientProvider client={queryClient}><ShownConversationProvider><Read/></ShownConversationProvider></QueryClientProvider>);
  expect(JSON.parse(screen.getByTestId('projection').textContent!)).toEqual([{id,blocked:false}]);
  act(()=>{const held=readIndex(queryClient)!;receiveFullIndex(queryClient,{...held,rev:held.rev+1,restoreId:restored});});
  expect(outgoingBlock(root,id)).toBe('restored');
  await waitFor(()=>expect(JSON.parse(screen.getByTestId('projection').textContent!)).toEqual([{id,blocked:true}]));
  expect(JSON.stringify(useDraftStore.getState().entries)).toBe(records);
});

// The same live conversation observes a restore; its standing notice must not keep offering a resend.
test.each(['standing', 'hidden', 'absent'] as const)('restore updates only the same standing delivery notice (%s)', async state => {
  await startI18n();
  setConversationState({ root, conversation: { ...conversation, warm: 'none' } });
  const id = admitted(), noticeId = deliveryNoticeId(root, id), records = JSON.stringify(useDraftStore.getState().entries);
  if (state !== 'absent') deliveryNotice(root, id, 'Delivery unknown. Send again or cancel in conversation.');
  if (state === 'hidden') notify.hide(noticeId);
  const was = useToasts.getState().toasts.find(toast => toast.id === noticeId);
  function Read() { return <output data-testid="block">{String(!!useShownConversation().local[0]?.blocked)}</output>; }
  const view = render(<QueryClientProvider client={queryClient}><ShownConversationProvider><Read /></ShownConversationProvider></QueryClientProvider>);
  // A normal unknown has no restore block and leaves its original notice alone.
  expect(screen.getByTestId('block').textContent).toBe('false');
  act(() => { const index = readIndex(queryClient)!; receiveFullIndex(queryClient, { ...index, rev: index.rev + 1, restoreId: restored }); });
  await waitFor(() => expect(screen.getByTestId('block').textContent).toBe('true'));
  const now = useToasts.getState().toasts.find(toast => toast.id === noticeId);
  if (state === 'standing') {
    expect(now?.text).toBe(i18n.t('problem.code.restore_changed'));
    expect(now?.order).toBe(was?.order); expect(now?.came).toBe(was?.came);
    expect(useToasts.getState().toasts.filter(toast => toast.id === noticeId)).toHaveLength(1);
  } else expect(now).toBeUndefined();
  expect(JSON.stringify(useDraftStore.getState().entries)).toBe(records);
  view.unmount(); endDeliveryNotice(root, id);
});


test.each(['normal', 'queued', 'restored', 'unproven'] as const)('explicit cancellation reports input recovery without claiming the earlier unknown result (%s)', async kind => {
  await startI18n();
  setConversationState({ root, conversation: { ...conversation, warm: 'none' }, open: true, expanded: true });
  const id = admitted(), beforePin = readWriteIdentity(root, id);
  if (kind === 'restored') act(() => { const index = readIndex(queryClient)!; receiveFullIndex(queryClient, { ...index, rev: index.rev + 1, restoreId: restored }); });
  const pinKey = 'alpacawork-write-identity:' + JSON.stringify([root, id]);
  if (kind === 'unproven') sessionStorage.removeItem(pinKey);
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(snapshotJson({ ...conversation, cancelled: [id] })));
  const notices = vi.spyOn(notify, 'success');
  if (kind === 'queued') {
    const entries = useDraftStore.getState().entries, [key, entry] = Object.entries(entries).find(([, x]) => x.values.requestId === id && x.values.stage)!;
    // The ordinary terminal local queue cancellation does not need the original ask's pin.
    useDraftStore.setState({ entries: { ...entries, [key]: { ...entry, values: { ...entry.values, stage: 'queued' } } } });
    sessionStorage.removeItem(pinKey);
    cancelQueued(root, id, draftKey(root, 'coordinator', conversationId));
  } else await useConversation.getState().messageAction('withdraw', id);
  const text = String(notices.mock.calls.at(-1)?.[0]);
  if (kind === 'restored' || kind === 'unproven') expect(text).toBe(i18n.t('ui:coordinatorCard.withdrawRestoredUnknown'));
  else expect(text).toBe(i18n.t('ui:coordinatorCard.withdrawRestored'));
  const posts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(posts.filter(([url]) => String(url).endsWith('/api/coordinator/messages'))).toHaveLength(0);
  if (kind === 'queued') expect(posts).toHaveLength(0);
  else {
    const [url, request] = posts[0]!; expect(String(url)).toContain('/coordinator/messages/withdraw');
    expect(JSON.parse(String(request?.body))).toEqual({ conversationId, id });
    expect(new Headers(request?.headers).get('X-Alpacawork-Op-Id')).not.toBe(id);
    expect(new Headers(request?.headers).get('X-Alpacawork-Restore-Id')).toBe(kind === 'restored' ? restored : 'initial');
  }
  expect(readWriteIdentity(root, id)).toBe(kind === 'unproven' || kind === 'queued' ? null : beforePin);
  const recovered = Object.values(useDraftStore.getState().entries).find(x => !x.values.stage && x.values.doc?.includes('frozen words'))!;
  expect(recovered).toBeTruthy(); expect(recovered.values.requestId).not.toBe(id);
});

test.each(['en', 'ja'] as const)('kept cancellation rows and folded words preserve their evidence and recovery actions (%s)', async language => {
  await startI18n(); await i18n.changeLanguage(language);
  try {
    for (const kind of ['normal', 'queued', 'restored', 'unproven'] as const) {
      queryClient.clear(); live('initial'); useDraftStore.setState({ unavailable: false, entries: {} });
      setConversationState({ root, conversation: { ...conversation, cancelled: [], warm: 'none' }, open: true, expanded: true });
      const id = admitted(), input = draftKey(root, 'coordinator', conversationId);
      const editing = useDraftStore.getState().entries[input]!;
      useDraftStore.setState({ entries: { ...useDraftStore.getState().entries,
        [input]: { ...editing, values: edited(editing.values, () => textDocument('Other input'))!.values } } });
      if (kind === 'restored') { live(restored); setConversationState({ root, conversation: { ...conversation, cancelled: [], warm: 'none' } }); }
      const pinKey = 'alpacawork-write-identity:' + JSON.stringify([root, id]);
      if (kind === 'unproven') sessionStorage.removeItem(pinKey);
      const beforePin = sessionStorage.getItem(pinKey);
      const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(snapshotJson({ ...conversation, cancelled: [id] })));
      const notices = vi.spyOn(notify, 'success');
      if (kind === 'queued') {
        const entries = useDraftStore.getState().entries, [key, entry] = Object.entries(entries).find(([, x]) => x.values.requestId === id && x.values.stage)!;
        useDraftStore.setState({ entries: { ...entries, [key]: { ...entry, values: { ...entry.values, stage: 'queued' } } } });
        cancelQueued(root, id, input);
      } else await useConversation.getState().messageAction('withdraw', id);
      expect(notices).not.toHaveBeenCalled();
      const item = outgoingItem(useDraftStore.getState().entries, root, id)!;
      const display = outgoingDisplay(item, false), unknown = kind === 'restored' || kind === 'unproven';
      expect(outgoingFinished(display)).toBe(true);
      expect(display.stage).toBe('cancelled');
      expect(!!display.blocked).toBe(unknown);
      expect(canTakeBack(useDraftStore.getState().entries, root, id, input)).toBe(false);
      const text = i18n.t(unknown ? 'ui:coordinatorCard.withdrawKeptUnknown' : 'ui:coordinatorCard.withdrawn');
      function Read() { const turn = useShownConversation().local.find(x => x.id === id); return <>{turn && <LocalOutcome turn={turn} />}<LastWordsPill style={{}} /></>; }
      const view = render(<QueryClientProvider client={queryClient}><ShownConversationProvider><Read /></ShownConversationProvider></QueryClientProvider>);
      const back = document.querySelector<HTMLButtonElement>('[data-coordinator-take-back]')!;
      expect(back).not.toBeNull(); expect(back.disabled).toBe(true);
      expect(back.parentElement?.textContent).toContain(text);
      expect(document.querySelector('[data-coordinator-pill]')?.textContent).toContain(text);
      expect(document.querySelector('[data-coordinator-resend]')).toBeNull();
      act(() => { const entries = useDraftStore.getState().entries, entry = entries[input]!;
        useDraftStore.setState({ entries: { ...entries, [input]: { ...entry, values: { ...entry.values, doc: JSON.stringify(textDocument('')) } } } }); });
      await waitFor(() => expect(back.disabled).toBe(false));
      fireEvent.click(back);
      expect(sessionStorage.getItem(pinKey)).toBe(beforePin);
      const recovered = useDraftStore.getState().entries[input]!;
      expect(recovered.values.doc).toContain(fixed.text); expect(recovered.values.requestId).not.toBe(id);
      const posts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
      expect(posts).toHaveLength(kind === 'queued' ? 0 : 1);
      expect(posts.filter(([url]) => String(url).endsWith('/api/coordinator/messages'))).toHaveLength(0);
      if (posts.length) {
        const [, request] = posts[0]!;
        expect(new Headers(request?.headers).get('X-Alpacawork-Op-Id')).not.toBe(id);
        expect(new Headers(request?.headers).get('X-Alpacawork-Restore-Id')).toBe(kind === 'restored' ? restored : 'initial');
      }
      view.unmount(); fetcher.mockRestore(); notices.mockRestore();
    }
  } finally { await i18n.changeLanguage('en'); }
});
