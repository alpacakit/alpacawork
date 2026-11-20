import { setConversationState } from './conversation-fixture';
import { useRef } from 'react';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { i18n, startI18n } from '@alpacawork/i18n';
import type { CoordinatorTurn } from '../src/data/coordinator';
import { CoordinatorThread } from '../src/features/coordinator/CoordinatorThread';
import { LastWordsPill } from '../src/features/coordinator/LastWords';
import { ThreadQueue } from '../src/features/coordinator/ThreadQueue';
import { ShownConversationProvider, partitionTurns, type LocalTurn } from '../src/features/coordinator/shown';
import { useConversation } from '../src/features/coordinator/coordinator';
import { useDraftStore, updateDraft } from '../src/features/forms/draft-store';
import { begin, beginWithdrawal, reconcileOutbox, cancelOutgoing, cancelUnsent, refuse, freeze, offerOutgoingUndo, outgoingKey, useOutbox } from '../src/features/coordinator/editor/outbox';
import { draftKey } from '../src/features/forms/draft-store';
import { textDocument } from '../src/features/coordinator/editor/document';
import { useUndoOffers } from '../src/data/undo-offers';
import { endSendGrace } from '../src/data/send-grace';
import { TestWorkspace } from './fixtures';

const turn = (extra: Partial<CoordinatorTurn> = {}): CoordinatorTurn => ({ id: 'first', at: new Date().toISOString(), ask: 'One instruction',
  attachments: [], status: 'queued', waiting: false, answer: null, answeredAt: null, seen: false, error: null, result: null, ...extra });
const conversation = (turns: CoordinatorTurn[] = [], busy = false) => ({ id: 'waiting-test', agent: null, warm: 'none' as const, busy, cancelled: [], turns });
function Surface() {
  const turns = useConversation(state => state.conversation?.turns ?? []);
  const expanded = useConversation(state => state.expanded);
  const area = useRef<HTMLDivElement>(null), bodyArea = useRef<HTMLDivElement>(null);
  return <TestWorkspace><ShownConversationProvider>
    <LastWordsPill style={{}} />
    <div ref={bodyArea}><div data-card-scroll><CoordinatorThread turns={turns} retry={() => {}} /></div></div>
    {expanded && <ThreadQueue area={bodyArea} />}
    <div ref={area}>{!expanded && <ThreadQueue area={area} folded />}</div>
  </ShownConversationProvider></TestWorkspace>;
}
beforeAll(async () => { await startI18n(); await i18n.changeLanguage('en'); });
afterEach(() => { for (const offer of useUndoOffers.getState().offers) endSendGrace(offer.id); vi.useRealTimers(); cleanup(); vi.unstubAllGlobals(); setConversationState({ conversation: null }); useDraftStore.setState({ entries: {} }); useOutbox.setState({ live: new Set() }); });

test.each([false, true])('an accepted queued snapshot with no predecessor stays one sending chat row and never enters the queue (expanded=%s)', expanded => {
  setConversationState({ root: '/fixture', expanded, conversation: conversation([turn()]) });
  render(<Surface />);
  const row = document.querySelector('[data-coordinator-turn=queued]')!;
  expect(row).not.toBeNull();
  expect(row.textContent).toContain('One instruction');
  expect(row.textContent).toContain('Sending…');
  expect(document.querySelectorAll('[data-coordinator-turn]')).toHaveLength(1);
  expect(document.querySelector('[data-coordinator-queue-button], [data-coordinator-queue-over]')).toBeNull();
  expect(document.querySelector('[data-ask-thinking]')).toBeNull();
  fireEvent.click(row.querySelector('[data-exchange-toggle]')!);
  expect(row.getAttribute('data-exchange')).toBe('folded');
  expect(row.textContent).toContain('Sending…');
  expect(row.querySelector('[role=alert]')).toBeNull();
  act(() => setConversationState({ conversation: conversation([turn({ status: 'running' })], true) }));
  expect(document.querySelector('[data-coordinator-turn=running]')).toBe(row);
  expect(document.querySelector('[data-coordinator-queue-button], [data-coordinator-queue-over]')).toBeNull();
});

test.each([false, true])('the local sending row keeps its DOM identity when serve accepts it as queued (expanded=%s)', expanded => {
  const root = '/fixture', cid = 'waiting-test', id = crypto.randomUUID(), key = draftKey(root, 'coordinator', cid);
  setConversationState({ root, expanded, conversation: conversation() });
  useDraftStore.setState({ unavailable: false, entries: { [key]: { status: 'editing', values: { body: '', doc: JSON.stringify(textDocument('One instruction')), requestId: id } } } });
  freeze(root, { conversationId: cid, text: 'One instruction', attachments: [], selected: {} }, { body: '', doc: JSON.stringify(textDocument('One instruction')), requestId: id }, { from: key });
  const attempt = begin(root, id)!; attempt.check();
  render(<Surface />);
  const row = document.querySelector('[data-coordinator-local=sending]')!;
  expect(row).not.toBeNull();
  expect(document.querySelector('[data-coordinator-queue-button], [data-coordinator-queue-over]')).toBeNull();
  act(() => setConversationState({ conversation: conversation([turn({ id })]) }));
  expect(document.querySelector('[data-coordinator-turn=queued]')).toBe(row);
  expect(document.querySelector('[data-coordinator-local]')).toBeNull();
  expect(screen.getAllByText('One instruction', { exact: true })).toHaveLength(1);
  expect(document.querySelector('[data-coordinator-queue-button], [data-coordinator-queue-over]')).toBeNull();
  attempt.finish();
});

test.each([false, true])('only blocked accepted turns are queued; removing the predecessor promotes the same instruction once (expanded=%s)', expanded => {
  const first = turn({ status: 'running' }), next = turn({ id: 'next', ask: 'Next instruction', waiting: true });
  setConversationState({ root: '/fixture', expanded, conversation: conversation([first, next], true) }); render(<Surface />);
  const row = document.querySelector('[data-coordinator-thread] [data-coordinator-waiting=next]')!;
  expect(row.textContent).toContain('Queued');
  expect(row.querySelector('[data-exchange-toggle]')).toBeNull();
  expect(document.querySelectorAll('[data-coordinator-queue-button]')).toHaveLength(expanded ? 0 : 1);
  expect(document.querySelector('[data-coordinator-queue-over]')).toBeNull();
  act(() => setConversationState({ conversation: { ...conversation([{ ...next, waiting: false }], true), cancelled: ['first'] } }));
  expect(document.querySelector('[data-coordinator-queue-button], [data-coordinator-queue-over]')).toBeNull();
  expect(document.querySelectorAll('[data-coordinator-turn]')).toHaveLength(1);
  expect(screen.getAllByText('Next instruction', { exact: true })).toHaveLength(1);
});


test('local rows use serve busy or an earlier unresolved local row, while refusals do not hold the next', () => {
  const local = (id: string, stage: LocalTurn['stage']): LocalTurn => ({ id, stage, at: '', ask: id, attachments: [], root: '/fixture', conversationId: 'waiting-test', refusal: null });
  const rows = [local('refused', 'refused'), local('unknown', 'unknown'), local('sending', 'sending')];
  const partition = partitionTurns([turn(),
    turn({ id: 'joined', status: 'joined', into: 'first' }),
    turn({ id: 'other', status: 'joined', into: 'second' }),
    turn({ id: 'joined-next', status: 'joined', into: 'first' }),
  ], rows, false);
  expect(partition.thread.map(turn => turn.id)).toEqual(['first']);
  expect(partition.joined.get('first')?.map(turn => turn.id)).toEqual(['joined', 'joined-next']);
  expect(partition.joined.get('second')?.map(turn => turn.id)).toEqual(['other']);
  expect(partition.localThread.map(turn => turn.id)).toEqual(['refused', 'unknown']);
  expect(partition.localWaiting.map(turn => turn.id)).toEqual(['sending']);
  const busy = partitionTurns([], rows, true);
  expect(busy.localThread).toEqual([rows[0]]);
  expect(busy.localWaiting).toEqual(rows.slice(1));
});

test('a failed message sent again is drawn once, as the one sent in its place, unless another message joined it', () => {
  const failed = (id: string, extra: Partial<CoordinatorTurn> = {}) => turn({ id, status: 'failed', error: 'exit', answeredAt: new Date().toISOString(), seen: true, ...extra });
  const partition = partitionTurns([failed('a', { sentAgain: true }), failed('b', { sentAgain: true }), turn({ id: 'c' }),
    failed('d', { sentAgain: true }), turn({ id: 'joined', status: 'joined', into: 'd' }), turn({ id: 'e' })]);
  expect(partition.thread.map(turn => turn.id)).toEqual(['c', 'd', 'e']);
  expect(partition.joined.get('d')?.map(turn => turn.id)).toEqual(['joined']);
});

test('the folded pill and message say waiting before dispatch, then sending only after begin', () => {
  const root = '/fixture', cid = 'waiting-test', id = crypto.randomUUID(), key = draftKey(root, 'coordinator', cid);
  setConversationState({ root, expanded: false, conversation: conversation() });
  window.__ALPACAWORK_WRITE_GRACE_MS__ = 5000;
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const values = { body: '', doc: JSON.stringify(textDocument('Five second message')), requestId: id };
  useDraftStore.setState({ unavailable: false, entries: { [key]: { status: 'editing', values } } });
  freeze(root, { conversationId: cid, text: 'Five second message', attachments: [], selected: {} }, values,
    { from: key });
  render(<Surface />);
  const pill = document.querySelector('[data-coordinator-pill]')!;
  const row = document.querySelector('[data-coordinator-local=waiting]')!;
  expect(row).not.toBeNull();
  expect(pill.textContent).toBe('Sending soonUndo');
  expect(pill.getAttribute('data-coordinator-pill-state')).toBe('waiting');
  // The message and folded pill share the grace status and cancellation.
  expect(row.textContent).not.toContain('Waiting');
  expect(row.querySelector('[data-coordinator-cancel-unsent]')!.textContent).toBe('Undo');
  expect(row.textContent).toContain('Sending soon');
  expect(pill.querySelector('.animate-pulse')).toBeNull();
  clock.mockReturnValue(now + 4999);
  expect(begin(root, id)).toBeNull();
  expect(pill.textContent).toBe('Sending soonUndo');
  clock.mockReturnValue(now + 5000);
  act(() => { const attempt = begin(root, id)!; expect(attempt).not.toBeNull(); attempt.check(); });
  expect(document.querySelector('[data-coordinator-local=sending]')).toBe(row);
  expect(row.textContent).toContain('Sending…');
  expect(document.querySelector('[data-coordinator-pill]')!.textContent).toBe('Sending…');
  expect(document.querySelector('[data-coordinator-pill]')!.getAttribute('data-coordinator-pill-state')).toBe('running');
  clock.mockRestore();
});


function mixedQueue(text: string) {
  const root = '/fixture', cid = 'waiting-test', id = crypto.randomUUID(), key = draftKey(root, 'coordinator', cid);
  const values = { doc: JSON.stringify(textDocument(text)), requestId: id };
  useDraftStore.setState(state => ({ entries: { ...state.entries, [key]: { status: 'editing', values } } }));
  freeze(root, { conversationId: cid, text, attachments: [], selected: {} }, values,
    { from: key });
  return id;
}
test('an elapsed grace behind an unknown send uses the queue close icon even before its clock callback runs', () => {
  setConversationState({ root: '/fixture', expanded: true, conversation: conversation() });
  const first = mixedQueue('Unknown predecessor'), attempt = begin('/fixture', first)!;
  attempt.check(); attempt.finish();
  window.__ALPACAWORK_WRITE_GRACE_MS__ = 5000;
  const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now);
  const second = mixedQueue('Follower after grace');
  vi.mocked(Date.now).mockReturnValue(now + 5000);
  render(<Surface />);
  expect(document.querySelector('[data-coordinator-queue-button]')).toBeNull();
  const row = screen.getByText('Follower after grace').closest('li')!;
  expect(row.textContent).toContain('Queued');
  expect(row.textContent).not.toContain('Sending soonUndo');
  expect(row.querySelector('[data-coordinator-withdraw]')).not.toBeNull();
  expect(row.querySelector('[data-coordinator-cancel-unsent]')).toBeNull();
  expect(begin('/fixture', second)).toBeNull();
});
test('cancelling the head during grace leaves its follower within its own grace and sends neither request', async () => {
  setConversationState({ root: '/fixture', expanded: false, conversation: conversation() });
  window.__ALPACAWORK_WRITE_GRACE_MS__ = 5000; vi.useFakeTimers();
  const first = mixedQueue('First grace'); offerOutgoingUndo('/fixture', first, document);
  expect(useUndoOffers.getState().offers).toHaveLength(0);
  const undo = () => cancelUnsent('/fixture', first);
  const second = mixedQueue('Second grace'); offerOutgoingUndo('/fixture', second, document);
  render(<Surface />);
  await act(async () => { expect(await undo()).toBe('cancelled'); });
  expect(document.querySelector('[data-coordinator-pill]')!.textContent).toBe('Sending soonUndo');
  expect(begin('/fixture', first)).toBeNull(); expect(begin('/fixture', second)).toBeNull();
  expect(useDraftStore.getState().entries[outgoingKey('/fixture', first)]?.values.stage).toBe('refused');
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(begin('/fixture', second)).not.toBeNull();
});
test('a grace clock expiring behind an unknown send changes the action to local cancellation without releasing that predecessor', async () => {
  setConversationState({ root: '/fixture', expanded: true, conversation: conversation() });
  const first = mixedQueue('Unknown predecessor'), attempt = begin('/fixture', first)!;
  attempt.check(); attempt.finish();
  window.__ALPACAWORK_WRITE_GRACE_MS__ = 5000; vi.useFakeTimers();
  const second = mixedQueue('Timed follower'); offerOutgoingUndo('/fixture', second, document);
  render(<Surface />);
  const row = screen.getByText('Timed follower').closest('li')!;
  expect(row.querySelector('[data-coordinator-cancel-unsent]')).not.toBeNull();
  expect(row.querySelectorAll('button.grid[data-coordinator-withdraw]')).toHaveLength(0);
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(row.textContent).toContain('Queued');
  expect(row.textContent).not.toContain('Sending soonUndo');
  expect(row.querySelector('[data-coordinator-withdraw]')).not.toBeNull();
  expect(begin('/fixture', second)).toBeNull();
  await act(async () => { await useConversation.getState().messageAction('withdraw', second); });
  expect(useDraftStore.getState().entries[outgoingKey('/fixture', second)]).toBeUndefined();
  expect(useDraftStore.getState().entries[outgoingKey('/fixture', first)]?.values.stage).toBe('posted');
  expect(useUndoOffers.getState().offers).toHaveLength(0);
});


test('undo keeps its recoverable cancelled row in the approved muted status style', () => {
  setConversationState({ root: '/fixture', expanded: false, conversation: conversation() });
  window.__ALPACAWORK_WRITE_GRACE_MS__ = 5000;
  const id = mixedQueue('Cancelled before sending');
  const key = draftKey('/fixture', 'coordinator', 'waiting-test');
  useDraftStore.setState(state => ({ entries: { ...state.entries,
    [key]: { status: 'editing', values: { doc: JSON.stringify(textDocument('New words')), requestId: crypto.randomUUID(), phase: 'composing' } } } }));
  expect(cancelUnsent('/fixture', id)).toBe('cancelled');
  render(<Surface />);
  const status = document.querySelector('[data-coordinator-local=refused] [role=status]')!;
  expect(status).not.toBeNull();
  expect(status.classList.contains('text-muted')).toBe(true);
  expect(status.classList.contains('text-error')).toBe(false);
  expect(status.textContent).toContain('Undone');
});


for (const unfinished of ['grace', 'queued', 'sending', 'unknown', 'withdrawing', 'withdrawUnknown'] as const)
for (const terminal of ['refused', 'cancelled', 'undone'] as const)
test(`folded ${unfinished} remains visible ahead of a newer ${terminal} row`, () => {
  setConversationState({ root: '/fixture', expanded: false, conversation: conversation() });
  window.__ALPACAWORK_WRITE_GRACE_MS__ = unfinished === 'grace' ? 5000 : 0;
  const first = mixedQueue('Still unresolved');
  if (unfinished !== 'grace' && unfinished !== 'queued') {
    const attempt = begin('/fixture', first)!; attempt.check();
    if (unfinished !== 'sending') attempt.finish();
    if (unfinished === 'withdrawing' || unfinished === 'withdrawUnknown') {
      const withdrawal = beginWithdrawal('/fixture', first)!;
      if (unfinished === 'withdrawUnknown') withdrawal.finish();
    }
  }
  const second = mixedQueue('Later terminal words');
  const key = draftKey('/fixture', 'coordinator', 'waiting-test');
  useDraftStore.setState(state => ({ entries: { ...state.entries,
    [key]: { status: 'editing', values: { doc: JSON.stringify(textDocument('New input')), requestId: crypto.randomUUID(), phase: 'composing' } } } }));
  if (terminal === 'refused') refuse('/fixture', second, 'later refusal');
  else if (terminal === 'cancelled') cancelOutgoing('/fixture', second, key);
  else cancelUnsent('/fixture', second);
  render(<Surface />);
  const expected = { grace: ['Sending soonUndo', 'waiting'], queued: ['Queued', 'waiting'],
    sending: ['Sending…', 'running'], unknown: ['Couldn\'t confirm whether it arrived.', 'unread'],
    withdrawing: ['Cancelling…', 'running'], withdrawUnknown: ['Couldn\'t confirm whether it was cancelled.', 'unread'] }[unfinished];
  const pill = document.querySelector('[data-coordinator-pill]')!;
  expect(pill.textContent).toBe(expected[0]);
  expect(pill.getAttribute('data-coordinator-pill-state')).toBe(expected[1]);
});
test('when all local rows are finished the folded line shows the latest outcome', () => {
  setConversationState({ root: '/fixture', expanded: false, conversation: conversation() });
  const first = mixedQueue('Earlier'), second = mixedQueue('Latest');
  const key = draftKey('/fixture', 'coordinator', 'waiting-test');
  useDraftStore.setState(state => ({ entries: { ...state.entries,
    [key]: { status: 'editing', values: { doc: JSON.stringify(textDocument('Occupied')), requestId: crypto.randomUUID(), phase: 'composing' } } } }));
  refuse('/fixture', first, 'earlier refusal'); refuse('/fixture', second, 'latest refusal');
  render(<Surface />);
  expect(document.querySelector('[data-coordinator-pill]')!.textContent).toContain('latest refusal');
});

test('preparation projects accepted queued messages as waiting, without a Send now action', () => {
  setConversationState({ root: '/fixture', expanded: true, conversation: { ...conversation([turn()], true), warm: 'preparing' } });
  render(<Surface />);
  const row = document.querySelector('[data-coordinator-thread] [data-coordinator-waiting=first]')!;
  expect(row.textContent).toContain('Starting the coordinator');
  expect(row.querySelector('[data-coordinator-send-now]')).toBeNull();
  expect(row.querySelector('[data-coordinator-posting]')).toBeNull();
});

// The folded line says what the open conversation's row says, from the same facts: never at work while the row waits.
test.each([
  ['the coordinator is starting', { ...conversation([turn()], true), warm: 'preparing' as const }, 'Starting the coordinator'],
  ['it waits its turn', conversation([turn({ waiting: true })], true), 'Queued'],
  ['it is on its way', conversation([turn()]), 'Sending…'],
  ['it is at work', conversation([turn({ status: 'running' })], true), 'Working on it…'],
  ['it is sent now to the work under way', conversation([turn({ id: 'work', status: 'running' }), turn({ waiting: true, joinRequested: true })], true), 'Sending…'],
  ['it is handed to the work under way', conversation([turn({ id: 'work', status: 'running' }), turn({ status: 'sending', waiting: true })], true), 'Sending…'],
  ['it is taken back while the coordinator starts', { ...conversation([turn()], true), warm: 'preparing' as const }, 'Cancelling…', true],
])('the folded line and the row say the same while %s', (_, value, words, withdraw = false) => {
  setConversationState({ root: '/fixture', expanded: true, conversation: value });
  if (withdraw) beginWithdrawal('/fixture', 'first', value);
  render(<Surface />);
  expect(document.querySelector('[data-coordinator-thread] [data-coordinator-message=first]')!.textContent).toContain(words);
  expect(document.querySelector('[data-coordinator-pill]')!.textContent).toContain(words);
});

test('waiting messages and later recoverable words keep their original send order in the open thread', () => {
  setConversationState({ root: '/fixture', expanded: true, conversation: conversation([turn({ status: 'running' })], true) });
  const first = mixedQueue('Earlier waiting words'), attempt = begin('/fixture', first)!;
  attempt.check(); attempt.finish();
  const second = mixedQueue('Later recoverable words');
  useDraftStore.setState(state => ({ entries: { ...state.entries,
    [draftKey('/fixture', 'coordinator', 'waiting-test')]: { status: 'editing', values: { doc: JSON.stringify(textDocument('New input')), requestId: crypto.randomUUID() } } } }));
  refuse('/fixture', second, 'refused');
  render(<Surface />);
  expect([...document.querySelectorAll('[data-coordinator-thread] [data-coordinator-local]')].map(row => row.getAttribute('data-coordinator-message'))).toEqual([first, second]);
});


test('an earlier cancelled recovery row precedes later server waiting words, even with equal send timestamps', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-05T00:01:00Z'));
  const root = '/fixture', key = draftKey(root, 'coordinator', 'waiting-test');
  const work = turn({ id: 'work', status: 'running', at: '2026-11-05T00:00:00Z' });
  setConversationState({ root, expanded: true, conversation: conversation([work], true) });
  const first = mixedQueue('Earlier cancelled');
  reconcileOutbox(conversation([work, turn({ id: first, ask: 'Earlier cancelled', waiting: true })], true), root, key);
  const values = useDraftStore.getState().entries[key]!.values;
  updateDraft(key, { values: { ...values, doc: JSON.stringify(textDocument('Later waiting')), phase: 'composing' } });
  expect(cancelOutgoing(root, first, key)).toBe('kept');
  const next = useDraftStore.getState().entries[key]!.values, second = next.requestId!;
  expect(freeze(root, { conversationId: 'waiting-test', text: 'Later waiting', attachments: [], selected: {} }, next, { from: key })).toBe(second);
  // A newer unsent draft keeps cancellation recoverable on its row. With an empty prepared input,
  // admission restores it into that input instead.
  const current = useDraftStore.getState().entries[key]!.values;
  updateDraft(key, { values: { ...current, doc: JSON.stringify(textDocument('Newer unsent words')), phase: 'composing' } });
  const snapshot = { ...conversation([work, turn({ id: second, ask: 'Later waiting', waiting: true })], true), cancelled: [first] };
  reconcileOutbox(snapshot, root, key);
  setConversationState({ conversation: snapshot });
  render(<Surface />);
  const ids = [...document.querySelectorAll('[data-coordinator-thread] [data-coordinator-message]')].map(row => row.getAttribute('data-coordinator-message'));
  expect(ids.filter(id => id !== 'work')).toEqual([first, second]);
});
