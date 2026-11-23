import { readConversationThroughOwner } from './conversation-fixture';
import { queryClient } from '../src/data/query-client';
import { snapshotJson } from './conversation-fixture';
import { setConversationState } from './conversation-fixture';
/** Render the real editor and thread against controlled transport ordering. */
import { useRef } from 'react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { i18n, startI18n } from '@alpacawork/i18n';
import { CoordinatorInput } from '../src/features/coordinator/CoordinatorInput';
import { CoordinatorThread } from '../src/features/coordinator/CoordinatorThread';
import { ThreadQueue } from '../src/features/coordinator/ThreadQueue';
import { ShownConversationProvider } from '../src/features/coordinator/shown';
import { useConversation } from '../src/features/coordinator/coordinator';
import { textDocument } from '../src/features/coordinator/editor/document';
import { useOutbox } from '../src/features/coordinator/editor/outbox';
import { draftKey, readDrafts, useDraftStore } from '../src/features/forms/draft-store';
import { useReaderSend } from '../src/features/coordinator/reader-send';
import { useSitting } from '../src/features/reader/next-question';
import { useViewStore } from '../src/state/view-store';
import { Toaster } from '../src/components/ui/toaster';
import { notify, useToasts } from '../src/lib/notify';
import { TestWorkspace } from './fixtures';

const root = '/fixture', cid = 'migration-delivery', key = draftKey(root, 'coordinator', cid);
const snapshot = (turns: any[] = [], busy = false) => ({ id: cid, nextLaunch: { agent: 'claude', values: {} }, warm: 'none' as const, busy, cancelled: [], turns });
const turn = (input: any, extra = {}) => ({ ...input.tasks?.length ? { tasks: input.tasks } : {}, ...input.skills?.length ? { skills: input.skills } : {}, id: input.id, at: '2026-10-16T00:00:00Z', ask: input.text, attachments: [],
  status: 'succeeded', waiting: false, answer: 'Done', seen: true, answeredAt: '2026-10-16T00:00:01Z', error: null, result: { writes: [], refused: [] }, ...extra });
const reply = (value: unknown, status = 200) => new Response(snapshotJson(value), { status });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function Surface() {
  const turns = useConversation(state => state.conversation?.turns ?? []);
  const area = useRef<HTMLDivElement>(null);
  return <TestWorkspace><ShownConversationProvider><div ref={area}>
    <CoordinatorThread turns={turns} retry={() => {}} />
  </div><ThreadQueue area={area} /><Toaster /><CoordinatorInput launch={{ next: { agent: 'claude', values: {} }, ready: false }} profile="claude" /></ShownConversationProvider></TestWorkspace>;
}
beforeAll(async () => { await startI18n(); await i18n.changeLanguage('en'); });
beforeEach(() => {
  sessionStorage.clear(); useOutbox.setState({ live: new Set(), resend: null });
  useDraftStore.setState({ entries: {}, unavailable: false }); useReaderSend.setState({ receipts: new Map() });
  useViewStore.setState(useViewStore.getInitialState()); useSitting.setState(useSitting.getInitialState());
  queryClient.clear();
  useConversation.setState({ root, open: true, expanded: true, engaged: false, error: null, wanted: true });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); for (const toast of useToasts.getState().toasts) notify.dismiss(toast.id); });
function words(text: string) {
  const editor = (document.querySelector('[data-one-input]') as HTMLElement & { editor: import('@tiptap/react').Editor }).editor;
  act(() => { editor.commands.setContent(textDocument(text)); });
}
const field = () => document.querySelector('[data-one-input]')!;
const send = () => document.querySelector<HTMLButtonElement>('[data-ask-send]')!;
const rows = (stage?: string) => document.querySelectorAll(stage ? `[data-coordinator-local="${stage}"]` : '[data-coordinator-local]');
async function mount(deliver: (body: any) => Promise<Response>, get: () => ReturnType<typeof snapshot> = () => snapshot()) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url) === '/api/coordinator/messages') return deliver(JSON.parse(String(init?.body)));
    if (String(url) === '/api/coordinator') return reply(get());
    return reply({ status: 'ready', profile: 'claude', skills: [{ name: 'alpacawork', invocation: '/', description: 'Distributed skill' }] });
  });
  await readConversationThroughOwner(get(), root);
  return render(<Surface />);
}

test('event before the POST answer draws the turn once; the late reply leaves the real input usable', async () => {
  const response = deferred<Response>(); let body: any;
  let server = snapshot();
  await mount(async input => { body = input; return response.promise; }, () => server);
  expect(field().getAttribute('contenteditable')).toBe('true');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Attach' }).disabled).toBe(false);
  words('Event arrives first'); fireEvent.click(send());
  await waitFor(() => expect(body).toBeTruthy());
  server = snapshot([turn(body)]);
  await act(async () => { await useConversation.getState().refresh(); });
  await waitFor(() => expect(document.querySelectorAll('[data-coordinator-turn=succeeded]')).toHaveLength(1));
  expect(rows()).toHaveLength(0); expect(screen.getAllByText('Event arrives first', { exact: true })).toHaveLength(1);
  await act(async () => { response.resolve(reply(server)); });
  expect(screen.getAllByText('Event arrives first', { exact: true })).toHaveLength(1);
  expect(send().disabled).toBe(true); words('Next'); expect(send().disabled).toBe(false);
});

test('a refusal restores retained words beside newer input without duplicating or sending them', async () => {
  const refusal = () => reply({ error: { code: 'conflict', message: 'refused', retry: 'reread' } }, 409);
  const response = deferred<Response>(); let posts = 0;
  await mount(async () => ++posts === 1 ? refusal() : response.promise);
  words('Returned instruction'); fireEvent.click(send());
  await waitFor(() => expect(field().textContent).toContain('Returned instruction'));
  // Said by the shared toast, as other failures are, not over the words.
  await waitFor(() => expect(document.querySelector('[data-toast]')?.textContent).toContain('Not sent (the server refused it)'));
  expect(document.querySelectorAll('[data-toast]')).toHaveLength(1);
  expect(document.querySelector('[data-one-input-area] [role=alert]')).toBeNull(); expect(rows()).toHaveLength(0);
  words('Retained instruction'); fireEvent.click(send()); await waitFor(() => expect(posts).toBe(2));
  words('Draft'); await act(async () => { response.resolve(refusal()); });
  await waitFor(() => expect(field().textContent).toBe('Retained instructionDraft'));
  expect(rows()).toHaveLength(0);
  expect(posts).toBe(2);
  expect(document.querySelector('[data-coordinator-take-back]')).toBeNull();
});

test('an unknown send survives remount and resends the exact ID and payload before its queued successor', async () => {
  const bodies: any[] = []; let server = snapshot(), cut = true;
  const view = await mount(async input => {
    bodies.push(input); if (cut) throw new Error('connection lost');
    server = snapshot([...server.turns, turn(input)]); return reply(server);
  }, () => server);
  words('Disconnected instruction'); fireEvent.click(send());
  await waitFor(() => expect(rows('unknown')).toHaveLength(1));
  expect(rows('unknown')[0]!.textContent).toContain('Disconnected instruction');
  expect(rows('unknown')[0]!.querySelector('[data-coordinator-resend]')).toBeTruthy();
  expect(rows('unknown')[0]!.querySelector('[data-coordinator-withdraw]')).toBeTruthy();
  expect(field().textContent).toBe('');
  expect(document.querySelector('[data-toast]')).toBeNull();
  words('Later instruction'); expect(send().disabled).toBe(false); fireEvent.click(send());
  expect(bodies).toHaveLength(1);
  view.unmount(); useDraftStore.setState(readDrafts()); useOutbox.setState({ live: new Set(), resend: null });
  render(<Surface />);
  expect(rows('unknown')).toHaveLength(1); expect(rows('unknown')[0]!.textContent).toContain('Disconnected instruction'); expect(bodies).toHaveLength(1);
  cut = false; fireEvent.click(document.querySelector('[data-coordinator-resend]')!);
  await waitFor(() => expect(document.querySelectorAll('[data-coordinator-turn=succeeded]')).toHaveLength(2));
  expect(rows()).toHaveLength(0); expect(bodies).toHaveLength(3); expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[2].text).toBe('Later instruction'); expect(bodies[2].id).not.toBe(bodies[0].id);
  expect(field().textContent).not.toContain('Later instruction'); expect(send().disabled).toBe(true);
});

test('failed send now preserves the exact message in the thread for retry', async () => {
  const first = turn({ id: 'work', text: 'At work' }, { status: 'running', answer: null, answeredAt: null });
  const next = turn({ id: 'next', text: 'Keep these exact words after failure' }, { status: 'queued', waiting: true, answer: null, answeredAt: null });
  const current = snapshot([first, next], true);

  let attempts = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url) === '/api/coordinator/messages/send-now') {
      expect(JSON.parse(String(init?.body))).toEqual({ conversationId: cid, id: 'next' });
      if (++attempts === 1) throw new Error('lost send-now');
      return reply(snapshot([first, { ...next, status: 'joined', waiting: false, into: first.id }], true));
    }
    if (String(url) === '/api/coordinator') return reply(current);
    return reply({ status: 'unavailable', skills: [] });
  });
  await readConversationThroughOwner(current, root);
  render(<Surface />);
  fireEvent.click(document.querySelector('[data-coordinator-send-now]')!);
  await waitFor(() => expect((document.querySelector('[data-coordinator-send-now]') as HTMLButtonElement).disabled).toBe(false));
  expect(attempts).toBe(1); expect(useConversation.getState().conversation?.turns.find(turn => turn.id === next.id)?.status).toBe('queued');
  expect(document.querySelector('[data-coordinator-thread]')?.textContent).toContain(next.ask);
  fireEvent.click(document.querySelector('[data-coordinator-send-now]')!);
  await waitFor(() => expect(useConversation.getState().conversation?.turns.find(turn => turn.id === next.id)?.status).toBe('joined'));
  expect(document.querySelector('[data-coordinator-queue-over]')).toBeNull(); expect(document.querySelector('[data-coordinator-queue-button]')).toBeNull();
});

test('version mismatch keeps words and skill labels in the input; updating never posts, a person sends once', async () => {
  const command = 'npx --yes --package=alpacawork@0.3.0 alpacawork skills update --package-version 0.3.0';
  let current = false, posts = 0, server = snapshot();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url) === '/api/coordinator/messages') {
      posts++;
      const input = JSON.parse(String(init?.body));
      expect(input.skills).toEqual(['alpacawork']);
      if (!current) return reply({ error: { code: 'conflict', message: 'version mismatch', retry: 'reread', reason: {
        kind: 'managed_skills_version', skill: 'alpacawork', expectedVersion: '0.3.0', currentVersion: '0.2.0', command,
      } } }, 409);
      server = snapshot([turn(input)]); return reply(server);
    }
    if (String(url) === '/api/coordinator') return reply(server);
    return reply({ status: 'ready', profile: 'claude', skills: [{ name: 'alpacawork', invocation: '/', description: 'Distributed skill' }] });
  });
  await readConversationThroughOwner(server, root); render(<Surface />);
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'skillLabel', attrs: { name: 'alpacawork', invocation: '/' } }, { type: 'text', text: ' Keep this instruction' },
  ] }] };
  const editor = (field() as HTMLElement & { editor: import('@tiptap/react').Editor }).editor;
  act(() => { editor.commands.setContent(doc); });
  const before = useDraftStore.getState().entries[key]!.values.doc;
  fireEvent.click(send());
  expect(useDraftStore.getState().entries[key]!.values.doc).toBe(before);
  await waitFor(() => expect(document.querySelector('[data-toast]')?.textContent).toContain(command));
  expect(field().textContent).toContain('Keep this instruction');
  expect(useDraftStore.getState().entries[key]!.values.doc).toBe(before);
  expect(Object.keys(useDraftStore.getState().entries)).toEqual([key]);
  expect(rows()).toHaveLength(0); expect(posts).toBe(1);
  current = true;
  // Refreshing after a local update is read-only and cannot send anything.
  await act(async () => { await useConversation.getState().refresh(); });
  expect(posts).toBe(1); expect(useDraftStore.getState().entries[key]!.values.doc).toBe(before);
  fireEvent.click(send());
  await waitFor(() => expect(server.turns).toHaveLength(1));
  await waitFor(() => expect(field().textContent).not.toContain('Keep this instruction'));
  expect(posts).toBe(2); expect(rows()).toHaveLength(0);
});

for (const queuedNext of [false, true]) test(`appended input excludes the first accepted message; queue next=${queuedNext}`, async () => {
  const response = deferred<Response>(), bodies: any[] = []; let server = snapshot();
  await mount(async input => {
    bodies.push(input);
    if (bodies.length === 1) return response.promise;
    server = snapshot([...server.turns, turn(input)]); return reply(server);
  }, () => server);
  words('First.'); fireEvent.click(send()); await waitFor(() => expect(bodies).toHaveLength(1));
  const editor = (field() as HTMLElement & { editor: import('@tiptap/react').Editor }).editor;
  act(() => { editor.commands.insertContentAt(editor.state.doc.content.size - 1, 'Second.'); });
  if (queuedNext) { fireEvent.click(send()); expect(bodies).toHaveLength(1); }
  server = snapshot([turn(bodies[0])]);
  await act(async () => { response.resolve(reply(server)); });
  if (!queuedNext) {
    await waitFor(() => expect(field().textContent).toBe('Second.'));
    fireEvent.click(send());
  }
  await waitFor(() => expect(bodies).toHaveLength(2));
  await waitFor(() => expect(field().textContent).toBe(''));
  expect(bodies.map(body => body.text)).toEqual(['First.', 'Second.']);
  expect(new Set(bodies.map(body => body.id)).size).toBe(2);
});

test('refusal leaves original skill and appended words in the input, with no duplicate refused row', async () => {
  const response = deferred<Response>(); let body: any;
  await mount(async input => { body = input; return response.promise; });
  const editor = (field() as HTMLElement & { editor: import('@tiptap/react').Editor }).editor;
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'skillLabel', attrs: { name: 'alpacawork', invocation: '/' } }, { type: 'text', text: ' Original.' },
  ] }] };
  act(() => { editor.commands.setContent(doc); }); fireEvent.click(send());
  await waitFor(() => expect(body).toBeTruthy());
  act(() => { editor.commands.insertContentAt(editor.state.doc.content.size - 1, 'Added.'); });
  const before = useDraftStore.getState().entries[key]!.values.doc;
  await act(async () => { response.resolve(reply({ error: { code: 'conflict', message: 'refused', retry: 'reread' } }, 409)); });
  await waitFor(() => expect(rows()).toHaveLength(0));
  await waitFor(() => expect(document.querySelector('[data-toast]')?.textContent).toContain('Not sent'));
  expect(useDraftStore.getState().entries[key]!.values.doc).toBe(before);
  expect(field().textContent).toContain('Original.Added.');
  expect(document.querySelectorAll('[data-one-input-area] [data-label=skill]')).toHaveLength(1);
  expect(Object.keys(useDraftStore.getState().entries)).toEqual([key]);
});

test('head refusal retains its words while the queued successor consumes only its own accepted portion', async () => {
  const response = deferred<Response>(), bodies: any[] = []; let server = snapshot();
  await mount(async input => {
    bodies.push(input); if (bodies.length === 1) return response.promise;
    server = snapshot([turn(input)]); return reply(server);
  }, () => server);
  words('First.'); fireEvent.click(send()); await waitFor(() => expect(bodies).toHaveLength(1));
  const editor = (field() as HTMLElement & { editor: import('@tiptap/react').Editor }).editor;
  act(() => { editor.commands.insertContentAt(editor.state.doc.content.size - 1, 'Second.'); }); fireEvent.click(send());
  await act(async () => { response.resolve(reply({ error: { code: 'conflict', message: 'refused', retry: 'reread' } }, 409)); });
  await waitFor(() => expect(bodies).toHaveLength(2));
  await waitFor(() => expect(field().textContent).toBe('First.'));
  expect(bodies.map(body => body.text)).toEqual(['First.', 'Second.']); expect(rows()).toHaveLength(0);
});

for (const [original, next] of [
  ['見本の花を描いてください。', '次は「見本の花を描いてください。」を英訳してください。'],
  ['はい', 'はい、あと見本T2も読んでください。'], ['1', '1枚だけ描いてください。'],
] as const) for (const queuedNext of [false, true]) test(`fix5 position: ${original}, next queued=${queuedNext}`, async () => {
  const gate = deferred<Response>(), bodies: any[] = []; let server = snapshot();
  await mount(async input => { bodies.push(input); if (bodies.length === 1) return gate.promise;
    server = snapshot([...server.turns, turn(input)]); return reply(server); }, () => server);
  words(original); fireEvent.click(send()); await waitFor(() => expect(bodies).toHaveLength(1));
  const editor = (field() as HTMLElement & { editor: import('@tiptap/react').Editor }).editor;
  act(() => { editor.commands.insertContentAt(editor.state.doc.content.size - 1, next); });
  if (queuedNext) { fireEvent.click(send()); expect(bodies).toHaveLength(1); }
  server = snapshot([turn(bodies[0])]); await act(async () => { gate.resolve(reply(server)); });
  if (!queuedNext) { await waitFor(() => expect(field().textContent).toBe(next)); fireEvent.click(send()); }
  await waitFor(() => expect(bodies).toHaveLength(2));
  expect(bodies.map(body => body.text)).toEqual([original, next]);
  await waitFor(() => expect(field().textContent).toBe('')); expect(rows()).toHaveLength(0);
});

for (const labelled of [false, true]) test(`fix5 position: refused head and accepted successor, context=${labelled}`, async () => {
  const gate = deferred<Response>(), bodies: any[] = []; let server = snapshot();
  await mount(async input => { bodies.push(input); if (bodies.length === 1) return gate.promise;
    server = snapshot([...server.turns, turn(input)]); return reply(server); }, () => server);
  const editor = (field() as HTMLElement & { editor: import('@tiptap/react').Editor }).editor;
  act(() => { editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: [
    ...labelled ? [{ type: 'taskLabel', attrs: { id: 'T1', title: 'Local task' } }] : [], { type: 'text', text: ' First.' },
  ] }] }); });
  fireEvent.click(send()); await waitFor(() => expect(bodies).toHaveLength(1));
  act(() => { editor.commands.insertContentAt(editor.state.doc.content.size - 1, 'Second.'); }); fireEvent.click(send());
  await act(async () => { gate.resolve(reply({ error: { code: 'conflict', retry: 'reread', message: 'refused' } }, 409)); });
  await waitFor(() => expect(bodies).toHaveLength(2));
  await waitFor(() => expect(field().textContent?.trim()).toBe('First.'));
  expect(bodies[1].text).not.toContain('First.'); expect(bodies[1].text).toContain('Second.');
  if (labelled) expect(bodies[1].tasks).toEqual(['T1']);
  fireEvent.click(send()); await waitFor(() => expect(bodies).toHaveLength(3));
  expect(bodies[2].text).toContain('First.'); expect(bodies[2].text).not.toContain('Second.');
  await waitFor(() => expect(field().textContent).toBe('')); expect(rows()).toHaveLength(0);
});

test('fix5 position: rewriting the original preserves the complete new instruction', async () => {
  const gate = deferred<Response>(), bodies: any[] = []; let server = snapshot();
  await mount(async input => { bodies.push(input); if (bodies.length === 1) return gate.promise;
    server = snapshot([...server.turns, turn(input)]); return reply(server); }, () => server);
  words('一覧を作って'); fireEvent.click(send()); await waitFor(() => expect(bodies).toHaveLength(1));
  words('表を作ってください'); server = snapshot([turn(bodies[0])]);
  await act(async () => { gate.resolve(reply(server)); });
  await waitFor(() => expect(useOutbox.getState().live.size).toBe(0)); expect(field().textContent).toBe('表を作ってください');
  fireEvent.click(send()); await waitFor(() => expect(bodies).toHaveLength(2));
  expect(bodies.map(body => body.text)).toEqual(['一覧を作って', '表を作ってください']);
});

test('fix5 position: a quote with a hard break in a new paragraph consumes only the original paragraph', async () => {
  const gate = deferred<Response>(), bodies: any[] = []; let server = snapshot();
  await mount(async input => { bodies.push(input); if (bodies.length === 1) return gate.promise;
    server = snapshot([...server.turns, turn(input)]); return reply(server); }, () => server);
  words('はい'); fireEvent.click(send()); await waitFor(() => expect(bodies).toHaveLength(1));
  const editor = (field() as HTMLElement & { editor: import('@tiptap/react').Editor }).editor;
  act(() => { editor.commands.insertContentAt(editor.state.doc.content.size - 1, [
    { type: 'paragraph', content: [{ type: 'text', text: 'はい、あと' }, { type: 'hardBreak' }, { type: 'text', text: '確認してください。' }] },
  ]); });
  // The editor already shows only the new paragraph; the original remains hidden until admission.
  const quote = editor.getJSON();
  expect(quote.content?.at(-1)?.content).toEqual([
    { type: 'text', text: 'はい、あと' }, { type: 'hardBreak' }, { type: 'text', text: '確認してください。' },
  ]);
  server = snapshot([turn(bodies[0])]); await act(async () => { gate.resolve(reply(server)); });
  await waitFor(() => expect(rows()).toHaveLength(0));
  expect(editor.getJSON()).toEqual(quote);
  expect(bodies[0].text).toBe('はい');
  fireEvent.click(send()); await waitFor(() => expect(bodies).toHaveLength(2));
  expect(bodies[1].text.trim()).toBe('はい、あと\n確認してください。');
});


test('fix5 position: changing Task context keeps the new label while admitted words are consumed', async () => {
  const gate = deferred<Response>(), bodies: any[] = []; let server = snapshot();
  await mount(async input => { bodies.push(input); if (bodies.length === 1) return gate.promise;
    server = snapshot([...server.turns, turn(input)]); return reply(server); }, () => server);
  const editor = (field() as HTMLElement & { editor: import('@tiptap/react').Editor }).editor;
  act(() => { editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'taskLabel', attrs: { id: 'T1', title: 'First task' } }, { type: 'text', text: ' First.' },
  ] }] }); });
  fireEvent.click(send()); await waitFor(() => expect(bodies).toHaveLength(1));
  act(() => { editor.commands.insertContentAt({ from: 1, to: 2 }, { type: 'taskLabel', attrs: { id: 'T2', title: 'New task' } }); });
  server = snapshot([turn(bodies[0])]); await act(async () => { gate.resolve(reply(server)); });
  await waitFor(() => expect(field().textContent).not.toContain('First.'));
  const doc = JSON.parse(useDraftStore.getState().entries[key]!.values.doc!);
  expect(doc.content[0].content).toEqual([{ type: 'taskLabel', attrs: { id: 'T2', title: 'New task' } }]);
  expect(send().disabled).toBe(true);
});

test('removing Task context during admission never restores the sent recipient', async () => {
  const gate = deferred<Response>(); let body: any, server = snapshot();
  await mount(async input => { body = input; return gate.promise; }, () => server);
  const editor = (field() as HTMLElement & { editor: import('@tiptap/react').Editor }).editor;
  act(() => { editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'taskLabel', attrs: { id: 'T1', title: 'First task' } }, { type: 'text', text: ' First.' },
  ] }] }); });
  fireEvent.click(send()); await waitFor(() => expect(body).toBeTruthy());
  act(() => { editor.commands.deleteRange({ from: 1, to: 2 }); });
  server = snapshot([turn(body)]); await act(async () => { gate.resolve(reply(server)); });
  await waitFor(() => expect(field().textContent).not.toContain('First.'));
  expect(field().textContent).not.toContain('First task');
  expect(JSON.parse(useDraftStore.getState().entries[key]!.values.doc!).content[0].content ?? []).toEqual([]);
  expect(send().disabled).toBe(true);
});
