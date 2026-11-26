import { snapshotJson, messageJson, statusJson, served as servedConversation, SERVED } from './conversation-fixture';
import { setConversationState } from './conversation-fixture';
/** Actual Card.retry and Card -> Input -> refresh recovery, below the public HTTP adapter only. */
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { i18n, startI18n } from '@alpacawork/i18n';
import { CoordinatorCard } from '../src/features/coordinator/CoordinatorCard';
import { useConversation } from '../src/features/coordinator/coordinator';
import { begin, freeze, outgoingKey, useOutbox } from '../src/features/coordinator/editor/outbox';
import { textDocument } from '../src/features/coordinator/editor/document';
import { captureReaderSubmission, useReaderSend } from '../src/features/coordinator/reader-send';
import { useDraftStore } from '../src/features/forms/draft-store';
import { queryClient } from '../src/data/query-client';
import { resources } from '../src/data/resources';
import { canSendWrites, detailWriteBasis } from '../src/data/connection';
import { notify } from '../src/lib/notify';
import { TestWorkspace, tree, dto, screenData, viewsOf } from './fixtures';

const root = '/fixture', cid = 'admission-callers', id = 'unknown-request';
const conversation = (turns: any[] = []) => servedConversation({ id: cid, nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, admitted: {}, cancelled: [], turns });
const response = (value: unknown, status = 200) => new Response(snapshotJson(value), { status });
const fixedTurn = (input: any) => ({ id: input.id, at: '2026-10-23T09:00:00Z', ask: input.text,
  tasks: input.tasks, answers: input.answers, intent: input.intent, attachments: input.attachments,
  status: 'queued', waiting: true, answer: null, seen: false, answeredAt: null, error: null, result: null });
const served = () => tree({ tasks: [dto({ id: 'T1' })] });
beforeAll(async () => { await startI18n(); await i18n.changeLanguage('en'); });
beforeEach(() => {
  queryClient.clear(); setConversationState(useConversation.getInitialState());
  useOutbox.setState({ live: new Set(), resend: null }); useDraftStore.setState({ entries: {}, unavailable: false });
});
afterEach(({ task }) => {
  Object.assign(task.meta, { receipts: [...useReaderSend.getState().receipts.values()], dom: document.body.innerHTML, drafts: structuredClone(useDraftStore.getState().entries),
    worker: { pool: process.env.VITEST_POOL_ID, worker: process.env.VITEST_WORKER_ID } });
  cleanup(); queryClient.clear(); vi.unstubAllGlobals(); useOutbox.setState({ live: new Set(), resend: null });
});

  test('Card.retry intent: revoke detail after rendering, final adapter blocks; real GET restores retry', async ({ task }) => {
    const fixture = served(), data = screenData(fixture), detail = viewsOf(fixture)[0]!;
    const input = { id: 'failed-request', text: 'same words', tasks: ['T1'], attachments: [],
      intent: { task: 'T1', action: 'continue' } };
    const failed = { ...fixedTurn(input), status: 'failed', waiting: false, error: 'conversation_busy', answeredAt: '2026-10-23T09:01:00Z', seen: true };
    setConversationState({ root, conversation: conversation([failed]), open: true, expanded: true, read: true });
    let refused = true; const requests: { path: string; method: string; body?: any }[] = []; Object.assign(task.meta, { http: requests });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'; requests.push({ path: url, method, ...(method === 'POST' ? { body: JSON.parse(String(init?.body)) } : {}) });
      if (url.includes('/task/view')) return refused ? response({}, 403) : response(detail);
      if (url === '/api/coordinator/messages') { const sent = JSON.parse(String(init?.body)); return new Response(messageJson(conversation([failed, fixedTurn(sent)]), sent.id)); }
      if (url.includes('/skills')) return response({ status: 'unavailable', profile: 'claude', skills: [] });
      return response(conversation([failed]));
    }));
    render(<TestWorkspace data={data}><CoordinatorCard /></TestWorkspace>);
    const retry = await screen.findByRole('button', { name: 'Send again' });
    expect(canSendWrites(detailWriteBasis('T1', detail.task.hash))).toBe(true);
    await act(async () => { await queryClient.fetchQuery({ ...resources.taskView(root, 'T1'), staleTime: 0 }).catch(() => {}); });
    expect(canSendWrites()).toBe(true); expect(canSendWrites(detailWriteBasis('T1', detail.task.hash))).toBe(false);
    // Same actual DOM button; no rerendered disabled flag grants the final transport authority.
    expect(retry).not.toHaveProperty('disabled', true);
    const failure = vi.spyOn(notify, 'failure'); fireEvent.click(retry);
    await waitFor(() => expect(failure.mock.calls.length > 0 || requests.some(r => r.path === '/api/coordinator/messages')).toBe(true));
    expect(requests.filter(r => r.path === '/api/coordinator/messages'), JSON.stringify(requests)).toHaveLength(0);
    expect(failure).toHaveBeenCalled();
    refused = false;
    await act(async () => { await queryClient.fetchQuery({ ...resources.taskView(root, 'T1'), staleTime: 0 }); });
    expect(canSendWrites(detailWriteBasis('T1', detail.task.hash))).toBe(true);
    fireEvent.click(retry);
    await waitFor(() => expect(requests.filter(r => r.path === '/api/coordinator/messages')).toHaveLength(1));
    expect(requests.find(r => r.path === '/api/coordinator/messages')?.body).toMatchObject({ text: input.text, ...('answers' in input ? { answers: input.answers } : { intent: input.intent }) });
    console.info('real Card.retry', JSON.stringify({ meaning: 'intent', requests }));
  });

for (const meaning of ['answers', 'intent'] as const) for (const matches of [true, false])
  test(`Card unknown recovery ${meaning}: snapshot matching=${matches}, receipt GET precedes any resend`, async ({ task }) => {
    const fixture = served(), data = screenData(fixture);
    const fixed = { conversationId: cid, text: 'fixed words 1-Yes', tasks: ['T1'], attachments: [],
      ...(meaning === 'answers' ? { answers: [{ task: 'T1', question: 'Q1' }] } : { intent: { task: 'T1', action: 'continue' as const } }) };
    // An unrelated earlier turn: the conversation is not empty, so only this request is checked.
    const other = fixedTurn({ id: 'unrelated-request', text: 'earlier words', tasks: [], attachments: [] });
    setConversationState({ root, conversation: conversation([other]), open: true, expanded: true, read: true });
    const doc = { type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [
      { type: 'text' as const, text: 'fixed words ' },
      { type: 'answerLabel' as const, attrs: { task: 'T1', question: 'Q1', n: '1', name: 'Yes', answer: '1-Yes' } },
    ] }] };
    const capture = captureReaderSubmission(fixed, doc, data.tasks, id, { root, conversationId: cid }, undefined, null);
    expect(capture.reader).toHaveLength(1);
    expect(freeze(root, fixed, { requestId: id, doc: JSON.stringify(doc) }, undefined, capture.reader)).toBe(id); capture();
    const attempt = begin(root, id)!; expect(attempt.check()).toBe('posted'); attempt.finish();
    const requests: { path: string; method: string }[] = []; Object.assign(task.meta, { http: requests }); let release!: (value: Response) => void;
    const gate = new Promise<Response>(resolve => { release = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ path: url, method: init?.method ?? 'GET' });
      if (url.includes('/task/view')) return response({}, 403);
      if (url === '/api/coordinator') return gate;
      if (url === '/api/coordinator/messages') return new Response(messageJson(conversation([other, fixedTurn({ ...fixed, id })]), id));
      // Not among the snapshot's turns, the message's own status says serve never took it.
      if (url === `/api/coordinator/messages/${id}/status`) return new Response(statusJson(id, 'missing'));
      if (url.includes('/skills')) return response({ status: 'unavailable', profile: 'claude', skills: [] });
      return response(conversation());
    }));
    render(<TestWorkspace data={data}><CoordinatorCard /></TestWorkspace>);
    await act(async () => { await queryClient.fetchQuery({ ...resources.taskView(root, 'T1'), staleTime: 0 }).catch(() => {}); });
    expect(canSendWrites()).toBe(true); expect(canSendWrites(detailWriteBasis('T1', data.tasks[0]!.hash))).toBe(false);
    const check = document.querySelector('[data-coordinator-resend]')!; expect(check).toBeTruthy();
    fireEvent.click(check);
    await waitFor(() => expect(requests.some(r => r.path === '/api/coordinator')).toBe(true));
    expect(useDraftStore.getState().entries[outgoingKey(root, id)]?.values.stage).toBe('posted');
    expect(requests.filter(r => r.method === 'POST'), JSON.stringify(requests)).toHaveLength(0);
    await act(async () => { release(response(conversation(matches ? [other, fixedTurn({ ...fixed, id })] : [other]))); });
    await waitFor(() => expect(useOutbox.getState().live.size).toBe(0));
    const entry = useDraftStore.getState().entries[outgoingKey(root, id)];
    const receipt = [...useReaderSend.getState().receipts.values()].find(each => each.id === id)!;
    const admitted = matches || meaning === 'answers';
    expect(receipt).toBeTruthy(); expect(receipt.admitted).toBe(admitted); expect(receipt.status).toBe('pending');
    expect(entry?.values.stage).toBe(admitted ? 'accepted' : 'posted');
    expect(JSON.parse(entry!.values.submitted!)).toEqual(fixed);
    expect(requests.filter(r => r.method === 'POST'), JSON.stringify(requests)).toHaveLength(!matches && meaning === 'answers' ? 1 : 0);
    console.info('real Card recovery', JSON.stringify({ meaning, matches, requests, remaining: entry?.values.stage ?? null }));
  });

for (const raw of [JSON.stringify({task:'T1',action:'approve'}), '{broken JSON'])
 test(`historical retry meaning stays input and cannot become a new request: ${raw}`,async()=>{
  const {draftKey}=await import('../src/features/forms/draft-store');
  const {markReaderOperation}=await import('../src/features/coordinator/editor/document');
  const data=screenData(served()), key=draftKey(root,'coordinator',cid);
  const values={doc:JSON.stringify(markReaderOperation(textDocument('Original historical words'))),requestId:'retained-input',readerRetry:raw};
  useDraftStore.setState({entries:{[key]:{status:'editing',values}}});
  setConversationState({root,conversation:conversation(),open:true,expanded:true,read:true});
  const posts:unknown[]=[];
  vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
   if(init?.method==='POST' && url === '/api/coordinator/messages')posts.push(JSON.parse(String(init.body)));
   return response(url.includes('/skills')?{status:'unavailable',profile:'claude',skills:[],reason:'fixture unavailable'}:conversation());
  }));
  const view=render(<TestWorkspace data={data}><CoordinatorCard/></TestWorkspace>);
  const send=view.container.querySelector<HTMLButtonElement>('[data-ask-send]')!;
  await waitFor(()=>expect(send.disabled).toBe(false));
  fireEvent.click(send);
  expect(posts).toEqual([]);
  expect(useDraftStore.getState().entries[key]?.values).toMatchObject(values);
 });
