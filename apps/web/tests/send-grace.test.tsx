import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { watchUndoOffers } from '../src/features/undo/undo-toast';
import { Toaster } from '../src/components/ui/toaster';
import { useToasts } from '../src/lib/notify';
import { startI18n } from '@alpacawork/i18n';
import { admitDirectIntent, resumeDirectIntents } from '../src/data/direct-write';
import { intentKey, readWriteIntents, useWriteIntentStore, reloadedWrites, reloadedWaiting } from '../src/data/write-intent';
import { useUndoOffers } from '../src/data/undo-offers';
import { endSendGrace, flushSendGrace } from '../src/data/send-grace';
import { workspaceWriteBasis, rowWriteBasis, useConnection } from '../src/data/connection';
import { queryClient } from '../src/data/query-client';
import { draftKey, readDrafts, useDraftStore } from '../src/features/forms/draft-store';
import { begin, beginWithdrawal, cancelUnsent, freeze, nextDelivery, offerOutgoingUndo, resumeQueuedOutgoing, flushLeavingOutbox, outgoingKey, useOutbox } from '../src/features/coordinator/editor/outbox';
import { textDocument } from '../src/features/coordinator/editor/document';
import { setConversationState, SERVED } from './conversation-fixture';
import { CoordinatorThread } from '../src/features/coordinator/CoordinatorThread';
import { ShownConversationProvider } from '../src/features/coordinator/shown';
import { TestWorkspace, dto, screenData, tree } from './fixtures';
import { written, refusal } from './forms-fixture';

const root = '/fixture', key = intentKey(root, 'task/archive', 'T1');
beforeAll(startI18n);
beforeEach(() => {
  queryClient.clear();
  useConnection.setState({offline:false});
  render(<TestWorkspace data={screenData(tree())}><span /></TestWorkspace>);
  // The shipped grace, not a test value: these timings are the product's three seconds.
  delete window.__ALPACAWORK_WRITE_GRACE_MS__;
  vi.useFakeTimers();
});
afterEach(() => {
  for (const offer of useUndoOffers.getState().offers) endSendGrace(offer.id);
  for (const entry of Object.values(useDraftStore.getState().entries))
    if (entry.values.submitted && entry.values.requestId) endSendGrace(entry.values.requestId);
  cleanup(); vi.useRealTimers(); vi.restoreAllMocks();
});
function press(operationKey = key) {
  const result = admitDirectIntent(queryClient, operationKey, { path: 'task/archive', response: 'task', label: 'T1' },
    () => ({ task: 'T1', expectedTaskHash: dto().hash }), rowWriteBasis('T1'));
  expect(result.kind).toBe('accepted');
  return result.kind === 'accepted' ? result : (() => { throw Error('rejected'); })();
}
const posts = (fetcher: ReturnType<typeof vi.spyOn>) => fetcher.mock.calls.filter((call: unknown[]) => (call[1] as RequestInit | undefined)?.method === 'POST');

test('a real direct sender makes zero POSTs at 2999ms and exactly one at 3000ms, under its admitted ID', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => written());
  const result = press();
  expect(useUndoOffers.getState().offers).toHaveLength(1);
  await act(() => vi.advanceTimersByTimeAsync(2999));
  expect(posts(fetcher)).toHaveLength(0);
  await act(() => vi.advanceTimersByTimeAsync(1));
  await result.result;
  expect(posts(fetcher)).toHaveLength(1);
  expect(new Headers(posts(fetcher)[0]![1]!.headers).get('X-Alpacawork-Op-Id')).toBe(result.id);
  expect(useUndoOffers.getState().offers).toHaveLength(0);
});

test('a hold waits the same three seconds as a message: undo at 2999ms keeps it unsent, else it goes at 3000ms', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => written());
  const hold = (operationKey: string) => {
    const result = admitDirectIntent(queryClient, operationKey, { path: 'task/report', response: 'task', label: 'T1' },
      id => ({ task: 'T1', state: 'held', opId: id }), rowWriteBasis('T1'), { draft: { choice: 'hold' } });
    return result.kind === 'accepted' ? result : (() => { throw Error('rejected'); })();
  };
  const undone = hold(intentKey(root, 'task/report', 'T1'));
  expect(useUndoOffers.getState().offers[0]!.until - useUndoOffers.getState().offers[0]!.at).toBe(3000);
  await act(() => vi.advanceTimersByTimeAsync(2999));
  expect(await useUndoOffers.getState().offers[0]!.undo()).toBe('cancelled');
  await expect(undone.result).rejects.toMatchObject({ code: 'cancelled' });
  const sent = hold(intentKey(root, 'task/report', 'T2'));
  await act(() => vi.advanceTimersByTimeAsync(2999));
  expect(posts(fetcher)).toHaveLength(0);
  await act(() => vi.advanceTimersByTimeAsync(1));
  await sent.result;
  expect(posts(fetcher)).toHaveLength(1);
  expect(useUndoOffers.getState().offers).toHaveLength(0);
});

test('undo cancels without a POST; the same task remains busy throughout its grace', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => written());
  const result = press();
  const second = admitDirectIntent(queryClient, intentKey(root, 'task/delete', 'T1'), { path: 'task/delete', response: 'task', label: 'T1' }, () => ({ task: 'T1' }), rowWriteBasis('T1'));
  expect(second.kind).toBe('rejected');
  expect(await useUndoOffers.getState().offers[0]!.undo()).toBe('cancelled');
  await expect(result.result).rejects.toMatchObject({ code: 'cancelled' });
  await act(() => vi.advanceTimersByTimeAsync(6000));
  expect(posts(fetcher)).toHaveLength(0);
  expect(useWriteIntentStore.getState().entries[key]?.status).toBe('cancelled');
});

test('a press that lands past the deadline but before the grace is released still cancels: what shows the button decides', async () => {
  // A tap queued behind a busy page runs before the overdue release timer (input goes first): the button was still
  // there and nothing had been sent, so taking it back must not be refused by the clock.
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => written());
  const result = press();
  vi.setSystemTime(Date.now() + 3200);
  expect(useUndoOffers.getState().offers).toHaveLength(1);
  expect(await useUndoOffers.getState().offers[0]!.undo()).toBe('cancelled');
  await expect(result.result).rejects.toMatchObject({ code: 'cancelled' });
  expect(useUndoOffers.getState().offers).toHaveLength(0);
  await act(() => vi.advanceTimersByTimeAsync(6000));
  expect(posts(fetcher)).toHaveLength(0);
});

test('once the grace is released its offer is gone in the same step, and a stale undo says it already went', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => written());
  const result = press();
  const offer = useUndoOffers.getState().offers[0]!;
  await act(() => vi.advanceTimersByTimeAsync(3000));
  await result.result;
  expect(useUndoOffers.getState().offers).toHaveLength(0);
  expect(await offer.undo()).toBe('already_dispatched');
  expect(posts(fetcher)).toHaveLength(1);
});

for (const event of ['hidden','pagehide'] as const) test(`${event} releases the same direct request with keepalive before its deadline`, async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => written());
  const result = press();
  if (event === 'hidden') {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
  } else window.dispatchEvent(new Event('pagehide'));
  await result.result;
  expect(posts(fetcher)).toHaveLength(1);
  expect(posts(fetcher)[0]![1]?.keepalive).toBe(true);
  expect(useUndoOffers.getState().offers).toHaveLength(0);
  await act(() => vi.advanceTimersByTimeAsync(3000));
  expect(posts(fetcher)).toHaveLength(1);
});

test.each(['run/stop','project-settings','server-settings'])('%s is immediate and offers no undo', async operation => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => written());
  await press(intentKey(root, operation, 'T1')).result;
  expect(posts(fetcher)).toHaveLength(1);
  expect(useUndoOffers.getState().offers).toHaveLength(0);
});

test('a reload checks a previously pending direct write once with the same ID and never recreates its offer', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Promise<Response>(() => {}));
  const original = press();
  window.dispatchEvent(new Event('pagehide'));
  const loaded = readWriteIntents();
  expect(loaded.entries[key]?.status).toBe('unconfirmed');
  useWriteIntentStore.setState(loaded);
  fetcher.mockImplementation(async () => refusal(503));
  await act(async () => { resumeDirectIntents(queryClient, root); });
  expect(posts(fetcher)).toHaveLength(2);
  expect(useWriteIntentStore.getState().entries[key]?.status).toBe('unconfirmed');
  expect(useUndoOffers.getState().offers).toHaveLength(0);
  expect(reloadedWrites.size).toBe(0);
  await act(async () => { resumeDirectIntents(queryClient, root); resumeDirectIntents(queryClient, root); });
  expect(posts(fetcher)).toHaveLength(2);
  expect(new Headers(posts(fetcher)[1]![1]!.headers).get('X-Alpacawork-Op-Id')).toBe(original.id);
});

test('reload releases saved unsent requests without restarting three seconds or announcing them', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => written());
  const original = press();
  endSendGrace(original.id);
  useWriteIntentStore.setState(readWriteIntents());
  expect(reloadedWaiting.has(key)).toBe(true);
  await act(async () => { resumeDirectIntents(queryClient, root); });
  expect(posts(fetcher)).toHaveLength(1);
  expect(useUndoOffers.getState().offers).toHaveLength(0);
});

test('disconnection at the deadline takes the existing definite refusal path, without an offline retry queue', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => written());
  const result = press();
  useConnection.setState({ offline: true });
  await act(() => vi.advanceTimersByTimeAsync(3000));
  await expect(result.result).rejects.toMatchObject({ retry: 'later' });
  expect(useWriteIntentStore.getState().entries[key]?.status).toBe('refused');
  expect(posts(fetcher)).toHaveLength(0);
});

function queued(text: string, id = crypto.randomUUID()) {
  const input = draftKey(root,'coordinator','C1');
  const values = { requestId:id, doc:JSON.stringify(textDocument(text)) };
  useDraftStore.setState(state => ({ entries: { ...state.entries, [input]: {status:'editing',values} } }));
  const fixed = { conversationId:'C1',text,attachments:[] };
  expect(freeze(root,fixed,values,{from:input})).toBe(id);
  offerOutgoingUndo(root,id,document);
  return {id,input};
}
test('the coordinator head and begin share the deadline; later requests never overtake a pending predecessor', async () => {
  useOutbox.setState({live:new Set(),resend:null});
  const first = queued('first'), second = queued('second');
  expect(nextDelivery(useDraftStore.getState().entries,root,'C1')).toBeNull();
  expect(begin(root,first.id)).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(2999));
  expect(begin(root,first.id)).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(useUndoOffers.getState().offers).toHaveLength(0);
  const attempt = begin(root,first.id)!;
  expect(attempt).not.toBeNull();
  expect(begin(root,second.id)).toBeNull();
  expect(attempt.check()).toBe('posted'); attempt.finish();
  expect(nextDelivery(useDraftStore.getState().entries,root,'C1')).toBeNull();
  expect(cancelUnsent(root,first.id)).toBe('already_dispatched');
});

test('cancelled coordinator words do not overwrite newer input and cannot be sent or offered again', () => {
  useOutbox.setState({live:new Set(),resend:null});
  const {id,input} = queued('original');
  useDraftStore.setState(state => ({entries:{...state.entries,[input]:{status:'editing',values:{requestId:'new',doc:JSON.stringify(textDocument('newer'))}}}}));
  expect(cancelUnsent(root,id)).toBe('cancelled');
  expect(useDraftStore.getState().entries[input]?.values.requestId).toBe('new');
  expect(useDraftStore.getState().entries[outgoingKey(root,id)]?.values.stage).toBe('refused');
  expect(useDraftStore.getState().entries[outgoingKey(root,id)]?.values.cancelled).toBe('1');
  expect(begin(root,id)).toBeNull();
  expect(useUndoOffers.getState().offers).toHaveLength(0);
});

test('storage failure refuses admission without sending or offering a way back', () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  vi.spyOn(Storage.prototype,'setItem').mockImplementation(() => { throw Error('disk'); });
  const result = admitDirectIntent(queryClient,key,{path:'task/archive',response:'task',label:'T1'},()=>({task:'T1'}),rowWriteBasis('T1'));
  expect(result.kind).toBe('rejected');
  expect(posts(fetcher)).toHaveLength(0);
  expect(useUndoOffers.getState().offers).toHaveLength(0);
});


test('reloaded coordinator grace has no orphan clock: it becomes eligible once without a new offer', () => {
  useOutbox.setState({live:new Set(),resend:null});
  const {id}=queued('restore unsent');
  endSendGrace(id);
  useDraftStore.setState(readDrafts());
  expect(nextDelivery(useDraftStore.getState().entries,root,'C1')).toBeNull();
  resumeQueuedOutgoing(root);
  expect(nextDelivery(useDraftStore.getState().entries,root,'C1')?.requestId).toBe(id);
  expect(useUndoOffers.getState().offers).toHaveLength(0);
  resumeQueuedOutgoing(root);
  expect(useUndoOffers.getState().offers).toHaveLength(0);
});


test('task cancellation is immediate even with report recovery and the full three-second clock', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => written());
  const result = admitDirectIntent(queryClient,intentKey(root,'task/report','T1'),{path:'task/report',response:'task',label:'T1'},
    id => ({task:'T1',state:'stopped',opId:id}),rowWriteBasis('T1'),{draft:{choice:'stop'}});
  expect(result.kind).toBe('accepted');
  if(result.kind==='accepted') await result.result;
  expect(posts(fetcher)).toHaveLength(1);
  expect(useUndoOffers.getState().offers).toHaveLength(0);
});

test.each(['plain','copies','skills'])('pagehide flushes only an eligible plain coordinator head, not %s preflight or its followers', mode => {
  const first=queued('head'), second=queued('follower');
  const head=outgoingKey(root,first.id);
  if(mode==='copies') useDraftStore.setState(state=>({entries:{...state.entries,[head]:{...state.entries[head]!,values:{...state.entries[head]!.values,readerCopies:'{"file":"copy-id"}'}}}}));
  if(mode==='skills') {
    const doc={type:'doc',content:[{type:'paragraph',content:[{type:'skillLabel',attrs:{name:'skill',invocation:'/'}}]}]};
    useDraftStore.setState(state=>({entries:{...state.entries,[head]:{...state.entries[head]!,values:{...state.entries[head]!.values,doc:JSON.stringify(doc)}}}}));
  }
  const resend=vi.fn((id:string,_keepalive?:boolean,_leaving?:boolean)=>{const attempt=begin(root,id); if(attempt) attempt.check(); return Promise.resolve();});
  useOutbox.setState({live:new Set(),resend});
  flushLeavingOutbox(root);
  expect(resend).toHaveBeenCalledTimes(mode==='plain'?1:0);
  if(mode==='plain') expect(resend).toHaveBeenCalledWith(first.id,true,true);
  expect(useDraftStore.getState().entries[outgoingKey(root,second.id)]?.values.stage).toBe('queued');
});


function showQueuedConversation() {
  const view = render(<TestWorkspace><ShownConversationProvider><CoordinatorThread turns={[]} retry={() => {}} /><Toaster /></ShownConversationProvider></TestWorkspace>);
  // No server in this fixture; opening the recovered input may refresh its conversation.
  act(() => setConversationState({ root, open: true, expanded: true, refresh: async () => {}, conversation: {
    id: 'C1', nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, admitted: {}, cancelled: [], turns: [],
  } }));
  return view;
}

test('cancelling grace from its message preserves newer input and never dispatches after the deadline', async () => {
  useOutbox.setState({ live: new Set(), resend: null });
  useToasts.setState({ toasts: [], held: new Map(), covered: new Map(), hidden: new Set() });
  const stop = watchUndoOffers();
  try {
    showQueuedConversation();
    let id = '', input = '';
    act(() => { ({ id, input } = queued('Cancel via inline undo')); });
    expect(document.querySelector('[data-coordinator-local]')?.textContent).toContain('Cancel via inline undo');
    expect(document.querySelector('[data-toast]')).toBeNull();
    expect(useUndoOffers.getState().offers).toHaveLength(0);
    act(() => useDraftStore.setState(state => ({ entries: { ...state.entries, [input]: { status: 'editing',
      values: { requestId: crypto.randomUUID(), doc: JSON.stringify(textDocument('New input')), phase: 'composing' } } } })));
    const resend = vi.fn(async () => {}); useOutbox.setState({ resend });
    const fetcher = vi.spyOn(globalThis, 'fetch');
    fireEvent.click(document.querySelector('[data-coordinator-cancel-unsent]')!);
    expect(JSON.parse(useDraftStore.getState().entries[input]!.values.doc!)).toEqual(textDocument('New input'));
    expect(document.querySelector('[data-coordinator-cancel-unsent]')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(6000));
    expect(resend).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
    expect(begin(root, id)).toBeNull();
  } finally {
    act(() => { stop(); });
    useToasts.setState({ toasts: [] });
  }
});
test('inline undo of a card send retains its terminal identity across reload and forbids a later withdrawal', async () => {
  useOutbox.setState({ live: new Set(), resend: null });
  const id = crypto.randomUUID();
  const fixed = { conversationId: 'C1', text: 'Card send', attachments: [], intent: { action: 'continue' as const, task: 'T1', expectedTaskHash: dto().hash } };
  const values = { requestId: id, doc: JSON.stringify(textDocument('Card send')) };
  showQueuedConversation();
  act(() => {
    expect(freeze(root, fixed, values)).toBe(id);
    offerOutgoingUndo(root, id, document);
  });
  const fetcher = vi.spyOn(globalThis, 'fetch');
  fireEvent.click(document.querySelector('[data-coordinator-cancel-unsent]')!);
  expect(document.querySelector('[data-coordinator-cancel-unsent]')).toBeNull();
  useDraftStore.setState(readDrafts());
  const conversation = { id: 'C1', nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, turns: [], admitted: {}, cancelled: [] };
  expect(beginWithdrawal(root, id, conversation)).toBeNull();
  expect(begin(root, id)).toBeNull();
  expect(useUndoOffers.getState().offers.some(offer => offer.id === id)).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});
