import { MessageDelivery } from '../src/features/coordinator/MessageDelivery';
import { snapshotJson } from './conversation-fixture';
import { setConversationState } from './conversation-fixture';
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { i18n, startI18n } from "@alpacawork/i18n";
import { useWaiting, WaitingRows } from "../src/features/coordinator/CoordinatorQueue";
import { LocalOutcome } from '../src/features/coordinator/LocalOutcome';
import { LastWordsPill } from "../src/features/coordinator/LastWords";
import { useViewStore } from "../src/state/view-store";
import { CoordinatorThread } from "../src/features/coordinator/CoordinatorThread";
import { useConversation } from "../src/features/coordinator/coordinator";
import type { CoordinatorTurn } from "../src/data/coordinator";
import { ShownConversationProvider } from '../src/features/coordinator/shown';
import { begin, beginWithdrawal, freeze, outgoingKey, offerOutgoingUndo, useOutbox } from '../src/features/coordinator/editor/outbox';
import { draftKey, useDraftStore } from '../src/features/forms/draft-store';
import { textDocument } from '../src/features/coordinator/editor/document';
import { useConnection } from '../src/data/connection';
import { endSendGrace } from '../src/data/send-grace';
import { useUndoOffers } from '../src/data/undo-offers';
import { dto, screenData, tree, TestWorkspace, openReference } from "./fixtures";

function QueueRows() {
  const queue = useWaiting();
  return queue.count ? <WaitingRows queue={queue} open={() => {}} /> : null;
}

const message = (id: string, status: CoordinatorTurn["status"], rest: Partial<CoordinatorTurn> = {}): CoordinatorTurn => ({
  id, at: '2026-10-15T12:00:00Z', ask: `message ${id}`, attachments: [], status, waiting: status === "queued" || status === "sending",
  // Replies are read unless a case says otherwise: an unread one is folded when the conversation opens.
  answer: null, seen: status === 'succeeded' || status === 'failed', answeredAt: null, error: null, result: null, ...rest,
});
const state = (turns: CoordinatorTurn[]) => ({ id: "conversation", agent: "fake", warm: 'none' as const, busy: false, cancelled: [], turns });
const reply = (turns: CoordinatorTurn[], cancelled: string[] = []) => new Response(snapshotJson({ ...state(turns), cancelled }), { status: 200 });
beforeAll(async () => { await startI18n(); await i18n.changeLanguage("en"); });
afterEach(() => { for (const offer of useUndoOffers.getState().offers) endSendGrace(offer.id); useOutbox.setState({ live: new Set() }); useConnection.setState({ offline: false }); cleanup(); vi.unstubAllGlobals(); setConversationState({ conversation: null, open: false, read: true, error: null }); });

test("shared waiting rows expand the whole message and its attachments", () => {
  const running = message("work", "running");
  const waiting = message("next", "queued", { ask: 'Long text\nContinued', attachments: ['one.png', 'two.png', 'notes.txt'] });
  setConversationState({ conversation: state([running, waiting]) });
  render(<TestWorkspace><QueueRows /></TestWorkspace>);
  expect(screen.queryByText('message work')).toBeNull();
  const text = screen.getByRole('button', { name: /Long text\s+Continued/ });
  expect(text.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(text);
  expect(text.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('button', { name: 'Enlarge one.png' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Enlarge two.png' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'notes.txt' })).toBeTruthy();
});

test("withdraw and send now call the server for their own message; sending cannot be withdrawn", async () => {
  const running = message('work', 'running'), a = message('a', 'queued'), b = message('b', 'queued');
  setConversationState({ conversation: state([running, a, b]) });
  const fetcher = vi.fn().mockResolvedValueOnce(reply([running, b], ['a']))
    .mockResolvedValueOnce(reply([running, { ...b, status: 'sending', waiting: true, into: running.id }]));
  vi.stubGlobal('fetch', fetcher);
  render(<TestWorkspace><QueueRows /></TestWorkspace>);
  fireEvent.click(within(document.querySelector('[data-coordinator-waiting=a]')!).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(document.querySelector('[data-coordinator-waiting=a]')).toBeNull());
  expect(fetcher.mock.calls[0]![0]).toBe('/api/coordinator/messages/withdraw');
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ conversationId: 'conversation', id: 'a' });
  fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
  await screen.findByText('Sending…');
  expect(fetcher.mock.calls[1]![0]).toBe('/api/coordinator/messages/send-now');
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({ conversationId: 'conversation', id: 'b' });
  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Send now' })).toBeNull();
});

test("send now is absent without a running turn, and a rejected action refreshes the authoritative queue", async () => {
  const a = message('a', 'queued');
  setConversationState({ conversation: state([a]) });
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(snapshotJson({ error: { code: 'conflict', message: 'Already sent', retry: 'fix' } }), { status: 409 }))
    .mockResolvedValueOnce(reply([{ ...a, status: 'running', waiting: false }]));
  vi.stubGlobal('fetch', fetcher);
  render(<TestWorkspace><QueueRows /></TestWorkspace>);
  expect(screen.queryByRole('button', { name: 'Send now' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(document.querySelector('[data-coordinator-waiting]')).toBeNull());
});

test("the thread groups joined instructions, shows image overflow in the existing viewer, and the reply's date and copy", async () => {
  const answered = message('work', 'succeeded', { answer: 'Checked', answeredAt: '2026-10-15T12:00:03Z',
    attachments: ['1.png', '2.png', '3.png', '4.png', '5.png'] });
  const joined = message('joined', 'joined', { into: answered.id, tasks: ['T3'] });
  render(<TestWorkspace><CoordinatorThread turns={[answered, joined, message('waiting', 'queued')]} retry={() => {}} /></TestWorkspace>);
  expect(screen.queryByText('message waiting')).not.toBeNull();
  expect(document.querySelectorAll('[data-coordinator-turn]')).toHaveLength(2);
  expect(screen.getByText('Sent during work', { exact: false })).toBeTruthy();
  // The screen's viewing is no part of a message.
  expect(screen.queryByText('Viewing', { exact: false })).toBeNull();
  const meta = document.querySelector('[data-coordinator-answer-meta]')!;
  expect(meta.querySelector('time')?.getAttribute('datetime')).toBe(answered.answeredAt);
  expect(meta.textContent).toContain('3 seconds');
  expect(within(meta as HTMLElement).getByRole('button', { name: 'Copy reply' })).toBeTruthy();
  expect(document.querySelectorAll('[data-coordinator-files] button')).toHaveLength(4);
  expect(screen.queryByRole('button', { name: 'Enlarge 4.png' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show 2 more' }));
  await waitFor(() => expect(document.querySelector('[data-image-slider-modal]')).not.toBeNull());
  expect(document.querySelectorAll('[data-image-slider-modal] img').length).toBeGreaterThan(0);
});

test("a message's video is a thumbnail beside its images, and plays in the same slider", async () => {
  const sent = message('sent', 'succeeded', { answer: 'Seen', answeredAt: '2026-10-15T12:00:03Z',
    attachments: ['shot.png', 'clip.mp4', 'notes.txt'] });
  render(<TestWorkspace><CoordinatorThread turns={[sent]} retry={() => {}} /></TestWorkspace>);
  const files = document.querySelector('[data-coordinator-files]')!;
  expect(within(files as HTMLElement).queryByRole('link', { name: 'clip.mp4' })).toBeNull();
  expect(within(files as HTMLElement).getByRole('link', { name: 'notes.txt' })).toBeTruthy();
  const tile = screen.getByRole('button', { name: 'Enlarge clip.mp4' });
  expect(tile.querySelector('video')?.getAttribute('src')).toMatch(/^\/api\/coordinator\/file\?requestId=sent&name=clip\.mp4(#|$)/);
  fireEvent.click(tile);
  const slider = await waitFor(() => screen.getByRole('dialog', { name: 'clip.mp4' }));
  expect(slider.querySelector('video[data-image-slider-large]')?.getAttribute('src')).toMatch(/^\/api\/coordinator\/file\?requestId=sent&name=clip\.mp4(#|$)/);
  expect(slider.querySelector('[data-image-slider-count]')?.textContent).toBe('2 of 2');
  fireEvent.click(within(slider).getByRole('button', { name: /Previous item/ }));
  await waitFor(() => expect(screen.getByRole('dialog', { name: 'shot.png' }).querySelector('img[data-image-slider-large]')).not.toBeNull());
});

test("a waiting message led by a video shows its first frame", () => {
  setConversationState({ conversation: state([message('work', 'running'), message('next', 'queued', { ask: '', attachments: ['clip.mp4'] })]) });
  render(<TestWorkspace><QueueRows /></TestWorkspace>);
  const row = document.querySelector('[data-coordinator-waiting=next]')!;
  expect(row.querySelector('img')).toBeNull();
  expect(row.querySelector('video')?.getAttribute('src')).toMatch(/^\/api\/coordinator\/file\?requestId=next&name=clip\.mp4(#|$)/);
});

test("English queue controls and reply metadata are translated", async () => {
  await act(() => i18n.changeLanguage('en'));
  setConversationState({ conversation: state([message('work', 'running'), message('next', 'queued')]) });
  render(<TestWorkspace><QueueRows /><CoordinatorThread turns={[message('done', 'succeeded', { answer: 'Done', answeredAt: '2026-10-15T12:00:02Z' })]} retry={() => {}} /></TestWorkspace>);
  expect(screen.getByRole('button', { name: 'Send now' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Copy reply' })).toBeTruthy();
  expect(screen.getByText('· 2 seconds')).toBeTruthy();
  await act(() => i18n.changeLanguage('en'));
});

test("an answer arriving before joined or waiting messages still marks the coordinator unread", async () => {
  const running = message('work', 'running'), joined = message('joined', 'joined', { into: running.id }), queued = message('wait', 'queued');
  setConversationState({ conversation: state([running, joined, queued]), open: false, read: true });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply([{ ...running, status: 'succeeded', waiting: false, answer: 'Done', answeredAt: '2026-10-15T12:01:00Z', seen: false }, joined, queued])));
  await useConversation.getState().refresh();
  expect(useConversation.getState().read).toBe(false);
});


test("task, answer and skill labels remain readable and clickable in the timeline", () => {
  const openTask = vi.spyOn(useViewStore.getState(), 'openTask');
  render(<TestWorkspace data={screenData(tree({ tasks: [dto({ id: "T3", title: "Screen preview" })] }))}><CoordinatorThread turns={[message('labelled', 'succeeded', {
    ask: 'T3（Screen preview） 1-Option1 /alpacawork Send these words unchanged too.', answer: 'Done', answeredAt: '2026-10-15T12:00:03Z',
  })]} skills={[{ name: 'alpacawork' }]} retry={() => {}} /></TestWorkspace>);
  const task = screen.getByRole('button', { name: /T3\s*Screen preview/ });
  expect(screen.getByText('1 Option1')).toBeTruthy();
  expect(screen.getByText('alpacawork')).toBeTruthy();
  expect(screen.getByText('Send these words unchanged too.', { exact: false })).toBeTruthy();
  fireEvent.click(task);
  expect(openTask).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog', { name: 'T3' }).textContent).toContain('Screen preview');
  fireEvent.keyDown(document, { key: 'Escape' });
  openReference(task);
  expect(openTask).toHaveBeenCalledWith('T3', { reader: true });
});

test("the folded conversation's notice shows an unread answer even with a waiting message after it", () => {
  setConversationState({ conversation: state([message('answered', 'succeeded', {
    answer: 'Done', answeredAt: '2026-10-15T12:00:03Z', seen: false,
  }), message('waiting', 'queued')]), open: false, read: false });
  render(<TestWorkspace><LastWordsPill style={{}} /></TestWorkspace>);
  // Its notice: the answer's first sentence with the purple dot.
  expect(document.querySelector('[data-coordinator-pill] [data-coordinator-unseen]')).not.toBeNull();
  expect(document.querySelector('[data-coordinator-pill]')?.textContent).toContain('Done');
});


function localQueue(text = 'Local words', attachments: string[] = [], grace = 0) {
  const root = '/fixture', conversationId = 'conversation', id = crypto.randomUUID();
  setConversationState({ root, conversation: { ...state([message('work', 'running'), message('server', 'queued', { ask: 'Server words', attachments })]), busy: true } });
  const key = draftKey(root, 'coordinator', conversationId);
  const values = { requestId: id, doc: JSON.stringify(textDocument(text)), phase: 'composing' };
  useDraftStore.setState({ unavailable: false, entries: { [key]: { status: 'editing', values } } });
  window.__ALPACAWORK_WRITE_GRACE_MS__ = grace;
  freeze(root, { conversationId, text, selected: {}, attachments }, values,
    { from: key });
  if (grace) offerOutgoingUndo(root, id, document);
  return { root, id, key };
}
function sharedQueue() { return render(<TestWorkspace><ShownConversationProvider><QueueRows /></ShownConversationProvider></TestWorkspace>); }

test('queue local sends share the server row disclosure, thumbnail, attachment expansion and cancel position', () => {
  const { id } = localQueue('Local words\nA second line', ['one.png', 'two.png', 'notes.txt']);
  sharedQueue();
  const local = screen.getByText(/Local words/).closest('li')!, server = document.querySelector('[data-coordinator-waiting=server]')!;
  const localText = within(local).getByRole('button', { name: /Local words/ });
  const serverText = within(server as HTMLElement).getByRole('button', { name: 'Server words' });
  expect(localText.className).toBe(serverText.className);
  expect(localText.getAttribute('aria-expanded')).toBe('false');
  expect(localText.querySelector('img')?.getAttribute('src')).toContain(`requestId=${id}`);
  expect(local.className).toBe(server.className);
  expect(within(local).getByRole('button', { name: 'Cancel' }).className).toBe(within(server as HTMLElement).getByRole('button', { name: 'Cancel' }).className);
  fireEvent.click(localText);
  expect(localText.getAttribute('aria-expanded')).toBe('true');
  expect(within(local).getByRole('button', { name: 'Enlarge two.png' })).toBeTruthy();
  expect(within(local).getByRole('link', { name: 'notes.txt' })).toBeTruthy();
  expect(local.getAttribute('data-coordinator-waiting')).toBe(id);
});
test('queue local sends expose no Send now and no redundant waiting sentence', () => {
  const { id } = localQueue(); sharedQueue();
  const row = screen.getByText('Local words').closest('li')!;
  expect(within(row).queryByRole('button', { name: 'Send now' })).toBeNull();
  expect(within(document.querySelector('[data-coordinator-waiting=server]')! as HTMLElement).getByRole('button', { name: 'Send now' })).toBeTruthy();
  expect(row.textContent).not.toContain('Waiting for the previous send');
  expect(row.querySelector('[role=status], [role=alert]')).toBeNull();
  expect(row.getAttribute('data-coordinator-waiting')).toBe(id);
});
test('queue the shared close icon cancels local waiting offline without HTTP and restores the original input', async () => {
  const { id, key } = localQueue(); sharedQueue();
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  act(() => { useConnection.setState({ offline: true }); });
  const row = screen.getByText('Local words').closest('li')!;
  const close = row.querySelector<HTMLButtonElement>('button[data-coordinator-withdraw].grid')!;
  expect(close).not.toBeNull(); expect(close.disabled).toBe(false);
  await act(async () => { fireEvent.click(close); });
  expect(fetcher).not.toHaveBeenCalled();
  expect(useDraftStore.getState().entries[outgoingKey('/fixture', id)]).toBeUndefined();
  expect(useDraftStore.getState().entries[key]!.values.doc).toContain('Local words');
  expect(useDraftStore.getState().entries[key]!.values.requestId).not.toBe(id);
});
test('queue the same close icon uses the common cancellation during grace and retains its terminal request ID', async () => {
  const { id, key } = localQueue('Grace words', [], 5000); sharedQueue();
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const row = screen.getByText('Grace words').closest('li')!;
  expect(within(row).queryByRole('button', { name: 'Undo' })).toBeNull();
  expect(row.textContent).not.toContain('Waiting');
  const close = row.querySelector('button[data-coordinator-withdraw].grid')!;
  expect(close).not.toBeNull();
  await act(async () => { fireEvent.click(close); });
  expect(fetcher).not.toHaveBeenCalled();
  expect(useDraftStore.getState().entries[key]!.values.doc).toContain('Grace words');
  expect(useDraftStore.getState().entries[outgoingKey('/fixture', id)]?.values).toMatchObject({ cancelled: '1', last: 'withdraw', taken: '1' });
  expect(useUndoOffers.getState().offers.some(offer => offer.id === id)).toBe(false);
});
test('queue uncertain local sends keep the shared outcome wording and underline actions', () => {
  const { id } = localQueue(); const attempt = begin('/fixture', id)!; attempt.check(); attempt.finish();
  sharedQueue(); const row = screen.getByText('Local words').closest('li')!;
  expect(within(row).getByRole('alert').textContent).toContain('Couldn\'t confirm whether it arrived.');
  const resend = row.querySelector('[data-coordinator-resend]')!;
  expect(resend.classList.contains('underline')).toBe(true);
  expect(within(row).getByRole('button', { name: 'Send again' })).toBeTruthy();
  expect(row.querySelector('button[data-coordinator-withdraw].grid')).not.toBeNull();
});


for (const kind of ['localUnknown', 'serverWithdrawUnknown', 'grace', 'localSending', 'serverWithdrawing', 'serverSending'] as const)
test(`queue owns the only cancellation control for ${kind} while retaining its status`, () => {
  const server = kind.startsWith('server');
  let id: string;
  if (server) {
    const status = kind === 'serverSending' ? 'sending' : 'queued';
    setConversationState({ root: '/fixture', conversation: { ...state([message('work', 'running'), message('server', status,
      kind === 'serverWithdrawUnknown' ? { joinRequested: true } : {})]), busy: true } });
    id = 'server';
    if (kind !== 'serverSending') {
      const attempt = beginWithdrawal('/fixture', id, useConversation.getState().conversation)!;
      if (kind === 'serverWithdrawUnknown') attempt.finish();
    }
  } else {
    ({ id } = localQueue('Local state words', [], kind === 'grace' ? 5000 : 0));
    if (kind !== 'grace') {
      const attempt = begin('/fixture', id)!; attempt.check();
      if (kind === 'localUnknown') attempt.finish();
    }
  }
  sharedQueue();
  const row = document.querySelector(`[data-coordinator-waiting="${id}"]`)! as HTMLElement;
  // In its grace a waiting message says nothing of itself; the others keep their status.
  const expected = { localUnknown: 'Couldn\'t confirm whether it arrived.', serverWithdrawUnknown: 'Couldn\'t confirm whether it was cancelled.', grace: null,
    localSending: null, serverWithdrawing: 'Cancelling…', serverSending: 'Sending…' }[kind];
  if (expected) expect(row.textContent).toContain(expected);
  else expect(row.textContent).not.toContain('Waiting');
  if (kind === 'serverWithdrawUnknown') {
    expect(row.querySelector('[data-coordinator-row-control] [data-coordinator-withdraw]')).not.toBeNull();
    expect(row.querySelector('[data-coordinator-row-control] [role=status]')).toBeNull();
    expect(row.querySelector('[role=alert]')?.textContent).toBe('Couldn\'t confirm whether it was cancelled.');
    expect(row.querySelector('[role=alert] button')).toBeNull();
  }
  const controls = row.querySelectorAll('[data-coordinator-withdraw], [data-coordinator-cancel-unsent]');
  expect(controls).toHaveLength(kind === 'serverWithdrawing' || kind === 'serverSending' ? 0 : 1);
  if (controls.length) expect(controls[0]!.classList.contains('grid')).toBe(true);
  expect(row.querySelector('[data-coordinator-cancel-unsent]')).toBeNull();
  if (kind === 'localUnknown') {
    const resend = within(row).getByRole('button', { name: 'Send again' });
    expect(resend.classList.contains('underline')).toBe(true);
  }
});
for (const kind of ['unknown', 'withdrawUnknown', 'grace'] as const)
test(`conversation flow keeps its inline cancellation by default for ${kind}`, () => {
  const turn = { id: 'inline', at: '', ask: '', attachments: [], root: '/fixture', conversationId: 'conversation',
    stage: kind === 'grace' ? 'waiting' as const : 'unknown' as const, last: kind === 'withdrawUnknown' ? 'withdraw' as const : 'ask' as const, refusal: null };
  render(<TestWorkspace><LocalOutcome turn={turn} /></TestWorkspace>);
  const control = document.querySelector('[data-coordinator-withdraw], [data-coordinator-cancel-unsent]')!;
  expect(control).not.toBeNull(); expect(control.classList.contains('underline')).toBe(true);
  expect(control.classList.contains('grid')).toBe(false);
  expect(control.textContent).toBe(kind === 'grace' ? 'Undo' : 'Cancel');
  if (kind === 'grace') expect(document.body.textContent).not.toContain('Waiting');
  expect(screen.queryByRole('button', { name: 'Send again' }) !== null).toBe(kind === 'unknown');
});

test('finished delivery rows keep only their recovery action, with no second cancellation', () => {
  for (const stage of ['refused', 'cancelled'] as const) {
    const view = render(<TestWorkspace><MessageDelivery turn={{ id: 'finished', at: '', ask: 'Words to recover', attachments: [] }}
      local={{ id: 'finished', at: '', ask: 'Words to recover', attachments: [], root: '/fixture', conversationId: 'conversation', stage, refusal: 'refused' }} /></TestWorkspace>);
    expect(view.container.querySelector('[data-coordinator-take-back]')).not.toBeNull();
    expect(view.container.querySelector('[data-coordinator-withdraw], [data-coordinator-cancel-unsent]')).toBeNull();
    view.unmount();
  }
});
