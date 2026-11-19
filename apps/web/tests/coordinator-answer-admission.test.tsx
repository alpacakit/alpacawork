import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import type { ProjectedIndexDTO } from '@alpacawork/contract/control';
import { i18n, startI18n } from '@alpacawork/i18n';
import { CoordinatorInput } from '../src/features/coordinator/CoordinatorInput';
import { useConversation } from '../src/features/coordinator/coordinator';
import { useDraftStore } from '../src/features/forms/draft-store';
import { useOutbox } from '../src/features/coordinator/editor/outbox';
import { useReaderSend } from '../src/features/coordinator/reader-send';
import { queryClient } from '../src/data/query-client';
import { notify } from '../src/lib/notify';
import { receiveFullIndex } from '../src/data/resources';
import { setConversationState, snapshotJson } from './conversation-fixture';
import { TestWorkspace, tree, dto, screenData, decideItem, questionFixture } from './fixtures';

const cid = 'fixed-answer-admission';
const conversation = (turns: any[] = []) => ({ id: cid, agent: null, warm: 'none' as const, busy: false, cancelled: [], turns });
const doc = (question: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [
  { type: 'answerLabel', attrs: { task: 'T1', question, n: '1', name: 'Yes', answer: '1-Yes' } },
] }] });
beforeAll(() => startI18n());
beforeEach(() => {
  queryClient.clear(); useDraftStore.setState({ entries: {}, unavailable: false });
  useOutbox.setState({ live: new Set(), resend: null }); useReaderSend.setState({ receipts: new Map() });
  setConversationState(useConversation.getInitialState());
  setConversationState({ root: '/fixture', conversation: conversation(), open: true, expanded: true, read: true });
});
afterEach(() => { cleanup(); queryClient.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test('consecutive fixed-question answers reach HTTP despite Task changes and unavailable detail GET', async () => {
  const served = tree({ tasks: [dto({ id: 'T1' })], questions: [questionFixture({ id: 'Q1', taskId: 'T1', decide: [decideItem('Question')] })] });
  const data = screenData(served), posts: any[] = [], gets: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/task/view')) { gets.push(url); throw new TypeError('detail connection unavailable'); }
    if (url === '/api/coordinator/messages') {
      const input = JSON.parse(String(init?.body)); posts.push(input);
      return new Response(snapshotJson(conversation(posts.map(each => ({ id: each.id, at: new Date().toISOString(), ask: each.text,
        answers: each.answers, attachments: [], status: 'queued', waiting: true, answer: null, seen: false, answeredAt: null, error: null, result: null })))));
    }
    return new Response(snapshotJson(url.includes('/skills') ? { status: 'unavailable', profile: 'claude', skills: [] } : conversation()));
  }));
  render(<TestWorkspace data={data}><CoordinatorInput launch={{ selected: {}, picker: null }} profile="claude" /></TestWorkspace>);
  const input = document.querySelector('[data-one-input]') as HTMLElement & { editor: Editor };
  await waitFor(() => expect(input.editor).toBeTruthy());
  for (const [i, question] of ['Q1', 'Q2'].entries()) {
    act(() => {
      // Another request/Run updates this Task while the person answers its fixed question.
      const index = queryClient.getQueryData<ProjectedIndexDTO>(['index'])!;
      receiveFullIndex(queryClient, { ...index, rev: index.rev + i + 1, tasks: index.tasks.map(row => ({ ...row, movedAt: row.movedAt + i + 1 })) });
      input.editor.commands.setContent(doc(question));
    });
    const send = document.querySelector<HTMLButtonElement>('[data-ask-send]')!;
    await waitFor(() => expect(send.disabled).toBe(false)); fireEvent.click(send);
    await waitFor(() => expect(posts).toHaveLength(i + 1));
    await waitFor(() => expect(useOutbox.getState().live.size).toBe(0));
  }
  expect(posts.map(each => each.answers)).toEqual([[{ task: 'T1', question: 'Q1' }], [{ task: 'T1', question: 'Q2' }]]);
  expect(posts[0].id).not.toBe(posts[1].id);
  expect(gets).toEqual([]);
});

test('a failed pre-send read returns the unsent draft without asking to fix its input', async () => {
  const data = screenData(tree({ tasks: [dto({ id: 'T1' })], questions: [questionFixture({ id: 'Q1', taskId: 'T1', decide: [decideItem('Question')] })] }));
  let attempted = false, posts = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/skills')) { attempted = true; throw new TypeError('offline'); }
    if (url === '/api/coordinator/messages') posts++;
    return new Response(snapshotJson(conversation()));
  }));
  const notice = vi.spyOn(notify, 'error');
  render(<TestWorkspace data={data}><CoordinatorInput launch={{ selected: {}, picker: null }} profile="claude" /></TestWorkspace>);
  const input = document.querySelector('[data-one-input]') as HTMLElement & { editor: Editor };
  await waitFor(() => expect(input.editor).toBeTruthy());
  act(() => input.editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: [
    ...doc('Q1').content[0]!.content,
    { type: 'skillLabel', attrs: { name: 'fixture-skill', invocation: '/' } },
    { type: 'text', text: ' original words' },
  ] }] }));
  fireEvent.click(document.querySelector('[data-ask-send]')!);
  await waitFor(() => expect(attempted).toBe(true));
  await waitFor(() => expect(useOutbox.getState().live.size).toBe(0));
  expect(posts).toBe(0);
  expect(Object.values(useDraftStore.getState().entries).some(entry => entry.values.doc?.includes('original words'))).toBe(true);
  const details = notice.mock.calls.map(call => call[1]?.detail).join(' ');
  expect(details).toContain(i18n.t('problem.retry.later'));
  expect(details).not.toContain(i18n.t('problem.retry.fix'));
});
