import { rememberWriteIdentity } from '../src/data/write-identity';
import { announceConversation, SERVED } from './conversation-fixture';
import { snapshotJson } from './conversation-fixture';
import { setConversationState } from './conversation-fixture';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { useConversation } from '../src/features/coordinator/coordinator';
import { queryClient } from '../src/data/query-client';
import { intentAbout, reconcileReaderSends, useReaderSend } from '../src/features/coordinator/reader-send';
import { captureReaderIntent, captureReaderSend } from './reader-send-fixture';
import { taskReferencesIn, textDocument, taskLabel, emptyDocument } from '../src/features/coordinator/editor/document';
import { useSitting } from '../src/features/reader/next-question';
import { useViewStore } from '../src/state/view-store';
import { at, dto, logEntry, screenData, taskFixture, tree, userBall } from './fixtures';
/** T3 waits on the user's review of R1 (its ball, as the server sends it); T4's title holds T3's ID. */
const data = screenData(tree({ tasks: [taskFixture({ id: 'T3', state: 'waiting', log: [logEntry({ id: 'L1', kind: 'reported', toState: 'waiting' })],
  ball: userBall('review', 'L1', at, { aboutRunId: 'R1' }) }), dto({ id: 'T4', title: 'Title containing T3 (complete)' })] }));
const { tasks, people } = data;
const task = tasks[0]!;
const scope = { root: '/fixture', conversationId: 'c' };
const snapshot = (id = 'c', cancelled: string[] = [], turns: any[] = []) => ({ id, cancelled, turns, nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false });
const queued = { id: 'message', at: '', ask: 'Fix T3', attachments: [], status: 'queued', waiting: true, answer: null, seen: false, answeredAt: null, error: null, result: null };
/** The Run that answered the message ended, and it wrote on T3 (the review the message answers). */
const carried = { ...queued, status: 'succeeded', waiting: false, result: { writes: [{ task: 'T3', record: 'L9', kind: 'request_accepted' }], refused: [] } };
const response = (value: unknown) => new Response(snapshotJson(value));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const admit = (id = 'message', ownScope = scope) => captureReaderIntent(intentAbout(task, 'continue', people), useSitting.getState().card, tasks, id, ownScope, () => {})();
const receipt = (id = 'message', ownScope = scope) => [...useReaderSend.getState().receipts.values()].find(receipt=>receipt.root===ownScope.root&&receipt.conversationId===ownScope.conversationId&&receipt.id===id);
beforeEach(() => {
  queryClient.clear(); data.seed();
  rememberWriteIdentity(scope.root, 'message', 'initial');
  useReaderSend.setState({ receipts: new Map() });
  useSitting.setState(useSitting.getInitialState());
  useViewStore.getState().openTask(task.id, { reader: true });
  useSitting.setState({ card: { taskId: task.id } });
  setConversationState({ root: scope.root, conversation: snapshot(), open: false, error: null });
});
afterEach(() => vi.unstubAllGlobals());

for (const text of ['Fix the flow for T3', 'T3']) test(`ordinary text has no answer receipt: ${text}`, () => {
  expect(captureReaderSend(textDocument(text), tasks, 'message', scope)()).toBe(false);
  reconcileReaderSends(snapshot('c', [], [{ ...queued, status: 'succeeded', result: { writes: [], refused: [] } }]), scope.root);
  expect(receipt()).toBeUndefined();
  expect(keptDepartures()).toEqual([]);
});
for (const text of ['https://example.test/?task=T3', 'https://host/T3', '/T3', 'C:\\T3', 'files/T3', 'T3/file', 'T999', 'other/T3', 'T4（Title containing T3 (complete)）', 'unknown/T4（T3）']) test(`raw negative: ${text}`, () => {
  expect(captureReaderSend(textDocument(text), tasks, 'message', scope)()).toBe(false);
  expect(keptDepartures()).toEqual([]);
});
test('an ID names that task by format, with the same resolver as completion', () => {
  expect(taskReferencesIn(textDocument('Fix T3'), tasks)).toEqual(new Set(['T3']));
  expect(taskReferencesIn(textDocument('Change T999'), tasks)).toEqual(new Set(['T999']));
});
test('labels are opaque: answer names and a complete task title do not target an embedded ID', () => {
  const doc = emptyDocument();
  doc.content[0]!.content = [taskLabel(tasks[1]!), { type: 'answerLabel', attrs: { question: 'Q1', task: 'T4', n: '1', name: 'T3', answer: '1-T3' } }];
  expect(taskReferencesIn(doc, tasks)).toEqual(new Set(['T4']));
});
test('a terminal fact survives a newer displayed snapshot and a later queued ask reply', async () => {
  admit(); const cancel = deferred<Response>();
  const fetcher = vi.fn().mockReturnValueOnce(cancel.promise).mockImplementation(() => Promise.resolve(response(snapshot('c', [], [queued]))));
  vi.stubGlobal('fetch', fetcher);
  const pending = useConversation.getState().messageAction('withdraw', 'message');
  await useConversation.getState().refresh(); // A later request wins the display race.
  cancel.resolve(response(snapshot('c', ['message']))); await pending;
  expect(receipt()?.status).toBe('cancelled'); expect(keptDepartures()).toEqual([]);
  await useConversation.getState().ask({ conversationId: 'c', id: 'message', text: queued.ask, attachments: [] });
  expect(receipt()?.status).toBe('cancelled'); expect(keptDepartures()).toEqual([]);
});
test('another device cancellation read settles even with an older ask response in flight', async () => {
  admit(); const ask = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(ask.promise).mockResolvedValue(response(snapshot('c', ['message']))));
  const pending = useConversation.getState().ask({ conversationId: 'c', id: 'message', text: queued.ask, attachments: [] });
  await useConversation.getState().refresh();
  ask.resolve(response(snapshot('c', [], [queued]))); await pending;
  expect(receipt()?.status).toBe('cancelled'); expect(keptDepartures()).toEqual([]);
  expect(useConversation.getState().conversation?.cancelled).toEqual(['message']);
});
test('turn absence cannot prove cancellation and root/conversation/message must all match', () => {
  admit();
  reconcileReaderSends(snapshot(), scope.root);
  reconcileReaderSends(snapshot('other', ['message']), scope.root);
  reconcileReaderSends(snapshot('c', ['message']), '/another-root');
  reconcileReaderSends(snapshot('c', ['another-message']), scope.root);
  expect(receipt()?.status).toBe('pending'); expect(keptDepartures()).toEqual([task.id]);
});
test('clear reply loss closes its scope after formal GET; delayed old snapshots and retries cannot return or send to it', async () => {
  admit(); const oldRead = deferred<Response>();
  const fetcher = vi.fn().mockReturnValueOnce(oldRead.promise).mockRejectedValueOnce(new Error('clear reply lost')).mockResolvedValue(response(snapshot('new')));
  vi.stubGlobal('fetch', fetcher);
  const pending = useConversation.getState().refresh();
  // No answer to the clear (a write): its caller gets it as unknown, in the screen's words.
  await expect(useConversation.getState().clear()).resolves.toBeUndefined();
  oldRead.resolve(response(snapshot('c', [], [queued]))); await pending;
  expect(useConversation.getState().conversation?.id).toBe('new');
  expect(receipt()?.status).toBe('closed'); expect(keptDepartures()).toEqual([]);
  const calls = fetcher.mock.calls.length;
  await expect(useConversation.getState().ask({ conversationId: 'c', id: 'message', text: queued.ask, attachments: [] })).rejects.toThrow('changed');
  expect(fetcher.mock.calls.length).toBe(calls);
});
test('scope closure preserves a carried-out message and a later separate operation', async () => {
  admit(); reconcileReaderSends(snapshot('c', [], [carried]), scope.root);
  useSitting.setState({ card: { taskId: task.id }, sent: null });
  admit('another', { ...scope, conversationId: 'new' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(snapshot('new'))));
  await useConversation.getState().refresh();
  expect(receipt()?.status).toBe('confirmed');
  expect(receipt('another', { ...scope, conversationId: 'new' })?.status).toBe('pending');
});
test('identical message IDs in different conversation scopes keep separate receipts and departure ownership', () => {
  admit();
  useSitting.setState({ card: { taskId: task.id }, sent: null });
  const other = { ...scope, conversationId: 'new' };
  admit('message', other);
  const departure = useSitting.getState().departures[task.id];
  reconcileReaderSends(snapshot('c', ['message']), scope.root);
  expect(receipt()?.status).toBe('cancelled'); expect(receipt('message', other)?.status).toBe('pending');
  expect(useSitting.getState().departures[task.id]).toBe(departure);
});
test('a carried-out message stays confirmed under delayed queued errors and cancellation facts', () => {
  admit(); reconcileReaderSends(snapshot('c', [], [carried]), scope.root);
  reconcileReaderSends(snapshot('c', [], [{ ...queued, deliveryError: 'closed' }]), scope.root);
  reconcileReaderSends(snapshot('c', ['message']), scope.root);
  expect(receipt()?.status).toBe('confirmed');
});
for (const next of [snapshot('another', ['message']), snapshot('c')]) test(`ask cannot complete from another scope or absent message: ${next.id}`, async () => {
  admit(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(next)));
  await expect(useConversation.getState().ask({ conversationId: 'c', id: 'message', text: queued.ask, attachments: [] })).rejects.toMatchObject({ retry: 'check' });
  expect(receipt()?.status).toBe('pending'); expect(useConversation.getState().conversation?.id).toBe('c');
});

test('clear then rejected GET carries unread version demand into the replacement scope', async () => {
  const clear = deferred<Response>(), oldRead = deferred<Response>();
  const external = { ...queued, id: 'external' };
  const fetcher = vi.fn().mockReturnValueOnce(clear.promise).mockReturnValueOnce(oldRead.promise)
    .mockResolvedValue(response(snapshot('new', [], [external])));
  vi.stubGlobal('fetch', fetcher);
  const clearing = useConversation.getState().clear();
  announceConversation('sol-clear-get-reverse');
  clear.resolve(response(snapshot('new'))); await clearing;
  expect(useConversation.getState().conversation?.turns).toEqual([]);
  oldRead.resolve(response(snapshot('new', [], [external])));
  await vi.waitFor(() => expect(useConversation.getState().conversation?.turns.map(turn => turn.id)).toEqual(['external']));
  expect(fetcher).toHaveBeenCalledTimes(3);
  announceConversation('sol-clear-get-reverse');
  expect(fetcher).toHaveBeenCalledTimes(3);
});
test('same-scope superseded read satisfies demand without an extra read', async () => {
  const older = deferred<Response>();
  const fetcher = vi.fn().mockReturnValueOnce(older.promise).mockResolvedValue(response(snapshot('c', [], [queued])));
  vi.stubGlobal('fetch', fetcher);
  announceConversation('sol-same-scope');
  await useConversation.getState().refresh();
  older.resolve(response(snapshot()));
  await vi.waitFor(() => expect(useConversation.getState().conversation?.turns).toHaveLength(1));
  await Promise.resolve(); await Promise.resolve();
  announceConversation('sol-same-scope');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
test('failed old-scope GET continues the read demand after clear', async () => {
  const clear = deferred<Response>(); let reject!: (error: Error) => void;
  const oldRead = new Promise<Response>((_resolve, fail) => { reject = fail; });
  const fetcher = vi.fn().mockReturnValueOnce(clear.promise).mockReturnValueOnce(oldRead)
    .mockResolvedValue(response(snapshot('new', [], [queued])));
  vi.stubGlobal('fetch', fetcher);
  const clearing = useConversation.getState().clear(); announceConversation('sol-failed-old-read');
  clear.resolve(response(snapshot('new'))); await clearing;
  reject(new Error('old read failed'));
  await vi.waitFor(() => expect(useConversation.getState().conversation?.turns).toHaveLength(1));
  expect(fetcher).toHaveBeenCalledTimes(3);
});
test('ordinary annotation keeps outer and following task references but ignores nested IDs', () => {
  const text = 'T3（Note T4（T999）） and T4';
  expect(taskReferencesIn(textDocument(text), tasks)).toEqual(new Set(['T3', 'T4']));
  expect(taskReferencesIn(textDocument('T999（T3） and T4'), tasks)).toEqual(new Set(['T999', 'T4']));
  expect(taskReferencesIn(textDocument('T3（Reference:https://example.test/T4） and T4'), tasks)).toEqual(new Set(['T3', 'T4']));
  for (const text of ['/T999（T3）', 'https://example.test/T999（T3）', 'other/T999（T3）'])
    expect(taskReferencesIn(textDocument(text), tasks)).toEqual(new Set());
  expect(taskReferencesIn(textDocument('T999（Note T3）'), tasks)).toEqual(new Set(['T999']));
  expect(captureReaderSend(textDocument('T4（Note T3） and T3'), tasks, 'annotation', scope)()).toBe(false);
  expect(keptDepartures()).toEqual([]);
});

test('a failed first conversation read stays in its scope and can later recover', async () => {
  vi.useFakeTimers();
  try {
    setConversationState({ root: scope.root, conversation: null, error: null });
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(response(snapshot('first')));
    vi.stubGlobal('fetch', fetcher);
    await useConversation.getState().refresh();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(useConversation.getState().conversation).toBeNull();
    // The read's failure stands (the input says the conversation could not be loaded); its raw cause is not kept as words.
    expect(useConversation.getState().error).toBeTruthy();
    await useConversation.getState().refresh();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(useConversation.getState().conversation?.id).toBe('first');
    expect(useConversation.getState().error).toBeNull();
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
});

const keptDepartures = () => Object.entries(useSitting.getState().departures).filter(([, each]) => ['pending','confirmed','unconfirmed'].includes(each.status())).map(([id])=>id);
