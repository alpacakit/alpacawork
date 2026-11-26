import { snapshotJson, messageJson, servedJson, served, SERVED } from './conversation-fixture';
import { setConversationState } from './conversation-fixture';
/** Coordinator async boundaries, not Task POST ABA nor the seen ACK. */
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { startI18n } from '@alpacawork/i18n';
import { CoordinatorInput } from '../src/features/coordinator/CoordinatorInput';
import { useConversation } from '../src/features/coordinator/coordinator';
import { useDraftStore } from '../src/features/forms/draft-store';
import { availableInput, begin, freeze, outgoingKey, useOutbox } from '../src/features/coordinator/editor/outbox';
import { textDocument, type Document } from '../src/features/coordinator/editor/document';
import { useReaderSend } from '../src/features/coordinator/reader-send';
import { useSitting } from '../src/features/reader/next-question';
import { useViewStore } from '../src/state/view-store';
import { notify } from '../src/lib/notify';
import { queryClient } from '../src/data/query-client';
import { receiveFullIndex } from '../src/data/resources';
import { TestWorkspace, tree, dto, decideItem, questionFixture, indexOf, screenData, viewsOf } from './fixtures';

const cid = 'aba-conversation';
const conv = (turns: any[] = []) => served({ id: cid, nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, admitted: {}, cancelled: [], turns });
const reply = (value: unknown) => new Response(snapshotJson(value));
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; };
const tick = async () => { await act(async () => { await new Promise(done => setTimeout(done, 10)); }); };
const asked = [decideItem('Proceed?', [['Yes', 'Proceed']])];
const skill = { name: 'fixture-skill', invocation: '/' as const };
const catalog = { status: 'ready', profile: 'claude', skills: [{ ...skill, description: 'fixture' }] };
const document = (stage: string): Document => ({ type: 'doc', content: [{ type: 'paragraph', content: [
  { type: 'text', text: 'old answer' },
  { type: 'answerLabel', attrs: { task: 'T1', question: 'Q1', n: '1', name: 'Yes', answer: '1-Yes' } },
  ...stage === 'preflight' ? [{ type: 'skillLabel' as const, attrs: skill }] : [],
] }] });
beforeAll(() => startI18n());
beforeEach(() => {
  queryClient.clear(); useDraftStore.setState({ entries: {}, unavailable: false });
  setConversationState(useConversation.getInitialState());
  setConversationState({ root: '/fixture', conversation: conv(), open: true, expanded: true, read: true });
  useOutbox.setState({ live: new Set(), resend: null });
  useReaderSend.setState({ receipts: new Map() });
  useSitting.setState(useSitting.getInitialState()); useViewStore.setState(useViewStore.getInitialState());
});
afterEach(async () => { cleanup(); await tick(); queryClient.clear(); vi.unstubAllGlobals(); useOutbox.setState({ live: new Set(), resend: null }); });

test('a send whose checks a new read session ended, its conversation already read again, goes back and holds no later send', async () => {
  const served = tree({ tasks: [dto({ id: 'T1' })], questions: [questionFixture({ id: 'Q1', taskId: 'T1', decide: asked })] });
  const data = screenData(served), index = { ...indexOf(served), person: queryClient.getQueryData<import('@alpacawork/contract/control').ControlIndexDTO>(['index'])!.person };
  const gate = deferred<Response>();
  let preflighting = false;
  const fetcher = vi.fn().mockImplementation(async (url: string) => {
    if (url.startsWith('/api/coordinator/skills') && useOutbox.getState().live.size > 0) { preflighting = true; return gate.promise; }
    if (url.startsWith('/api/coordinator/skills')) return reply(catalog);
    if (url.includes('task/view')) return reply(viewsOf(served).find(v => v.task.id === new URL(url, 'http://fixture').searchParams.get('task')));
    return reply(conv());
  });
  vi.stubGlobal('fetch', fetcher);
  render(<TestWorkspace data={data}><CoordinatorInput launch={{ next: { agent: 'claude', values: {} }, ready: false }} /></TestWorkspace>);
  act(() => receiveFullIndex(queryClient, index));
  const input = window.document.querySelector('[data-one-input]') as HTMLElement & { editor: Editor };
  await waitFor(() => expect(input?.editor).toBeTruthy());
  await tick();
  act(() => input.editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'old words' }, { type: 'skillLabel', attrs: skill }] }] }));
  fireEvent.click(window.document.querySelector('[data-ask-send]')!);
  await waitFor(() => expect(preflighting).toBe(true));
  const id = Object.values(useDraftStore.getState().entries).find(entry => entry.values.submitted)!.values.requestId!;
  act(() => {
    receiveFullIndex(queryClient, { ...index, generation: 'b' });
    receiveFullIndex(queryClient, index);
    setConversationState({ conversation: conv(), open: true, expanded: true });
  });
  await tick();
  expect(useDraftStore.getState().entries[outgoingKey(index.root, id)]?.values.stage).toBe('checking');
  await act(async () => { gate.resolve(reply(catalog)); });
  await waitFor(() => expect(useOutbox.getState().live.size).toBe(0)); await tick();
  expect(useDraftStore.getState().entries[outgoingKey(index.root, id)]).toBeUndefined();
  expect(JSON.stringify(input.editor.getJSON())).toContain('old words');
  expect(fetcher.mock.calls.filter(([url]) => url === '/api/coordinator/messages')).toHaveLength(0);
});

test('an attempt that could not save its checkpoint keeps the notice saying so when it ends', async () => {
  const served = tree({ tasks: [dto({ id: 'T1' })], questions: [questionFixture({ id: 'Q1', taskId: 'T1', decide: asked })] });
  const data = screenData(served), index = { ...indexOf(served), person: queryClient.getQueryData<import('@alpacawork/contract/control').ControlIndexDTO>(['index'])!.person };
  const gate = deferred<Response>();
  let preflighting = false;
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
    if (url.startsWith('/api/coordinator/skills') && useOutbox.getState().live.size > 0) { preflighting = true; return gate.promise; }
    if (url.startsWith('/api/coordinator/skills')) return reply(catalog);
    if (url.includes('task/view')) return reply(viewsOf(served).find(v => v.task.id === new URL(url, 'http://fixture').searchParams.get('task')));
    return reply(conv());
  }));
  render(<TestWorkspace data={data}><CoordinatorInput launch={{ next: { agent: 'claude', values: {} }, ready: false }} /></TestWorkspace>);
  act(() => receiveFullIndex(queryClient, index));
  const input = window.document.querySelector('[data-one-input]') as HTMLElement & { editor: Editor };
  await waitFor(() => expect(input?.editor).toBeTruthy());
  await tick();
  act(() => input.editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'old words' }, { type: 'skillLabel', attrs: skill }] }] }));
  fireEvent.click(window.document.querySelector('[data-ask-send]')!);
  await waitFor(() => expect(preflighting).toBe(true));
  const error = vi.spyOn(notify, 'error'), dismiss = vi.spyOn(notify, 'dismiss');
  act(() => useDraftStore.setState({ unavailable: true }));
  await act(async () => { gate.resolve(reply(catalog)); });
  await waitFor(() => expect(useOutbox.getState().live.size).toBe(0)); await tick();
  expect(error).toHaveBeenCalled();
  const said = error.mock.invocationCallOrder.at(-1)!;
  expect(dismiss.mock.invocationCallOrder.filter(order => order > said)).toEqual([]);
  error.mockRestore(); dismiss.mockRestore();
});

for (const boundary of ['root', 'generation'] as const) for (const stage of ['preflight', 'POST/draw', 'refresh/draw'] as const)
  test(`${boundary} ABA during coordinator ${stage}: retain old acceptance, leave new input/DOM/focus/turn alone`, async () => {
    const served = tree({ tasks: [dto({ id: 'T1' }), dto({ id: 'T2' })], questions: [questionFixture({ id: 'Q1', taskId: 'T1', decide: asked })] });
    const data = screenData(served), index = { ...indexOf(served), person: queryClient.getQueryData<import('@alpacawork/contract/control').ControlIndexDTO>(['index'])!.person };
    const gate = deferred<Response>();
    let preflighting = false, submitted: any = null, skills = 0, reads = 0;
    const fetcher = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/coordinator/skills')) {
        skills++;
        if (stage === 'preflight' && useOutbox.getState().live.size > 0) { preflighting = true; return gate.promise; }
        return reply(catalog);
      }
      if (url === '/api/coordinator' && stage === 'refresh/draw' && ++reads === 1) return gate.promise;
      // A new-session follow-up GET is a new server snapshot, never a consumed old Response.
      if (url === '/api/coordinator') return reply(conv());
      if (url === '/api/coordinator/messages') { submitted = JSON.parse(String(init?.body)); return stage === 'POST/draw' ? gate.promise : new Response(messageJson(accepted(), submitted.id)); }
      if (url.includes('task/view')) return reply(viewsOf(served).find(v => v.task.id === new URL(url, 'http://fixture').searchParams.get('task')));
      return reply(conv());
    });
    const accepted = () => conv([{ id: submitted.id, at: new Date().toISOString(), ask: submitted.text,
      ...(submitted.tasks ? { tasks: submitted.tasks } : {}), ...(submitted.answers ? { answers: submitted.answers } : {}), attachments: [],
      status: 'queued', waiting: true, answer: null, seen: false, answeredAt: null, error: null, result: null }]);
    vi.stubGlobal('fetch', fetcher);
    render(<TestWorkspace data={data}><CoordinatorInput launch={{ next: { agent: 'claude', values: {} }, ready: false }} /></TestWorkspace>);
    act(() => receiveFullIndex(queryClient, index));
    const input = window.document.querySelector('[data-one-input]') as HTMLElement & { editor: Editor };
    await waitFor(() => expect(input?.editor).toBeTruthy());
    await tick();
    act(() => input.editor.commands.setContent(document(stage)));
    let refreshing: Promise<void> | undefined;
    if (stage === 'refresh/draw') {
      submitted = { id: crypto.randomUUID(), text: 'old accepted request', attachments: [] };
      const fixed = { conversationId: cid, text: submitted.text, attachments: [] };
      freeze(index.root, fixed, { requestId: submitted.id, doc: JSON.stringify(textDocument(submitted.text)) });
      const attempt = begin(index.root, submitted.id)!; expect(attempt.check()).toBe('posted'); attempt.finish();
      act(() => { refreshing = useConversation.getState().refresh(); });
    } else fireEvent.click(window.document.querySelector('[data-ask-send]')!);
    await waitFor(() => expect(stage === 'preflight' ? preflighting : !!submitted).toBe(true));
    const old = Object.values(useDraftStore.getState().entries).find(entry => entry.values.submitted)!;
    const oldId = old.values.requestId!, frozen = old.values.submitted;
    // Actual read admission entrance: A -> B -> A with the original strings restored.
    act(() => {
      receiveFullIndex(queryClient, { ...index, ...(boundary === 'root' ? { root: '/other-root' } : { generation: 'b' }) });
      if (boundary === 'root') setConversationState({ root: '/other-root' });
      receiveFullIndex(queryClient, index);
      if (boundary === 'root') setConversationState({ root: index.root });
      setConversationState({ conversation: conv(), open: true, expanded: true, focusRequested: false });
      useViewStore.getState().openTask('T2', { reader: true });
      useSitting.setState({ card: { taskId: 'T2' }, departures: {}, sent: null, emptied: null } as never);
      input.editor.commands.setContent(textDocument('NEW INPUT AFTER ABA'));
    });
    input.focus(); await tick();
    const before = { doc: input.editor.getJSON(), visible: Object.fromEntries(Object.entries(useDraftStore.getState().entries).filter(([, entry]) => !entry.values.submitted)
        .map(([key, entry]) => [key, { requestId: entry.values.requestId, values: availableInput(useDraftStore.getState().entries, index.root, key) }])),
      card: useSitting.getState().card, selected: useViewStore.getState().selected };
    await act(async () => {
      gate.resolve(stage === 'preflight' ? reply(catalog) : stage === 'POST/draw' ? new Response(messageJson(accepted(), submitted.id)) : reply(accepted()));
      await refreshing;
    });
    await waitFor(() => expect(useOutbox.getState().live.size).toBe(0)); await tick();
    await waitFor(() => expect(useConversation.getState().trying).toBe(false));
    expect.soft(window.document.querySelector('[data-one-input]')).toBe(input);
    expect.soft(input.editor.getJSON()).toEqual(before.doc);
    expect.soft(window.document.activeElement).toBe(input);
    expect.soft(useSitting.getState().card).toEqual(before.card);
    expect.soft(useViewStore.getState().selected).toBe(before.selected);
    if (stage !== 'POST/draw' && stage !== 'refresh/draw') expect.soft(fetcher.mock.calls.filter(([url]) => url === '/api/coordinator/messages')).toHaveLength(0);
    else {
      expect.soft(useConversation.getState().conversation?.turns).toEqual([]);
      expect.soft(useDraftStore.getState().entries[outgoingKey(index.root, oldId)]?.values).toMatchObject({ stage: 'accepted', submitted: frozen });
      expect.soft(fetcher.mock.calls.filter(([url]) => url === '/api/coordinator/messages')).toHaveLength(stage === 'POST/draw' ? 1 : 0);
    }
    // Admission may consume the hidden old portion, never the new composing request or its visible input.
    for (const [key, visible] of Object.entries(before.visible)) {
      expect.soft(useDraftStore.getState().entries[key]?.values.requestId).toBe(visible.requestId);
      expect.soft(availableInput(useDraftStore.getState().entries, index.root, key)).toEqual(visible.values);
    }
  });

test.each(['the first send', 'a resend of the same ID after an unknown answer'])('a message serve refuses because the settings turned its AI to a Codex row (%s) goes back, and the next send goes with the Codex mark', async way => {
  const served = tree({ tasks: [dto({ id: 'T1' })] });
  const codex = { status: 'ready', profile: 'codex-team', skills: [{ name: skill.name, invocation: '$', description: 'fixture' }] };
  let lost = way !== 'the first send';
  const posts: any[] = [];
  const fetcher = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/coordinator/skills')) return reply(posts.length ? codex : catalog);
    if (url === '/api/coordinator/messages') {
      const body = JSON.parse(String(init?.body));
      posts.push(body);
      if (lost) { lost = false; throw new TypeError('network'); }
      if (!body.text.includes('$')) return new Response(JSON.stringify({ error: { code: 'conflict', message: 'Coordinator AI changed', retry: 'fix',
        reason: { kind: 'skill_invocation_mismatch' } } }), { status: 409 });
      return new Response(messageJson(conv([{ id: body.id, at: new Date().toISOString(), ask: body.text, attachments: [], status: 'queued', waiting: true, answer: null, answeredAt: null, seen: false, error: null, result: null }]), body.id));
    }
    // An unanswered send serve never took: its status says it is missing.
    return new Response(servedJson(url, init, conv()));
  });
  vi.stubGlobal('fetch', fetcher);
  const input = (agent: string) => <TestWorkspace data={screenData(served)}><CoordinatorInput launch={{ next: { agent, values: {} }, ready: false }} /></TestWorkspace>;
  const view = render(input('claude'));
  const editor = window.document.querySelector('[data-one-input]') as HTMLElement & { editor: Editor };
  await waitFor(() => expect(editor?.editor).toBeTruthy());
  await tick();
  act(() => editor.editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'use it ' }, { type: 'skillLabel', attrs: skill }] }] }));
  fireEvent.click(window.document.querySelector('[data-ask-send]')!);
  await waitFor(() => expect(posts).toHaveLength(1));
  if (way !== 'the first send') {
    // Not answered: the same request goes again, as it was.
    await waitFor(() => expect(useOutbox.getState().live.size).toBe(0)); await tick();
    await act(async () => { await useOutbox.getState().resend!(posts[0].id); });
    expect(posts[1]).toMatchObject({ id: posts[0].id, text: posts[0].text });
  }
  await waitFor(() => expect(useOutbox.getState().live.size).toBe(0)); await tick();
  expect(posts.at(-1).text).toBe('use it /fixture-skill');
  // Refused: the words and the skill's chip are back in the input.
  await waitFor(() => expect(JSON.stringify(editor.editor.getJSON())).toContain('use it'));
  expect(window.document.querySelectorAll('[data-one-input-area] [data-label=skill]')).toHaveLength(1);
  // The conversation now goes to the Codex row; pressed once with nothing changed, the words go with its mark.
  view.rerender(input('codex-team'));
  await tick();
  const before = posts.length;
  await waitFor(() => expect(window.document.querySelector<HTMLButtonElement>('[data-ask-send]')!.disabled).toBe(false));
  fireEvent.click(window.document.querySelector('[data-ask-send]')!);
  await waitFor(() => expect(posts).toHaveLength(before + 1));
  expect(posts.at(-1).text).toBe('use it $fixture-skill');
});
