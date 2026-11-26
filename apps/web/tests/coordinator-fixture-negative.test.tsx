/** Transport answers stay independent of announced index evidence. */
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { i18n, startI18n } from '@alpacawork/i18n';
import type { CoordinatorConversation, CoordinatorSnapshot } from '../src/data/coordinator';
import { CoordinatorThread } from '../src/features/coordinator/CoordinatorThread';
import { ShownConversationProvider } from '../src/features/coordinator/shown';
import { useConversation } from '../src/features/coordinator/coordinator';
import { queryClient } from '../src/data/query-client';
import { basisForRead, canSendWrites, useConnection } from '../src/data/connection';
import { coordinatorReadState, readIndex, readQuery } from '../src/data/read-model';
import { receiveFullIndex } from '../src/data/resources';
import { useDraftStore } from '../src/features/forms/draft-store';
import { useOutbox } from '../src/features/coordinator/editor/outbox';
import { readConversationThroughOwner, SERVED } from './conversation-fixture';
import { indexOf, screenData, TestWorkspace, tree } from './fixtures';

const root = '/fixture', generation = 'independent-index-generation', cid = 'independent-index-cid';
const revision = 'a'.repeat(64), at = '2026-10-24T10:00:00Z', words = 'Acquired through actual coordinator GET';
const conversation: CoordinatorConversation = { id: cid, nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, cancelled: [], turns: [
  { id: 'independent-turn', at, ask: words, attachments: [], status: 'succeeded', waiting: false,
    answer: 'Actual acquired answer', answeredAt: at, seen: true, error: null, result: null },
] };
const envelope: CoordinatorSnapshot = { root, generation, revision, conversation };
const baseline = () => {
  const index = indexOf(tree({ root }));
  return { ...index, generation, person: { ...index.person, coordinator: { id: cid, revision } } };
};
type Answer = { value: unknown; status: number };
let answer: Answer, requests: { path: string; method: string; answer: Answer }[];
function Consumer() {
  // Keep getSnapshot stable when no conversation was admitted; an allocated [] selector loops in React.
  const value = useConversation(state => state.conversation);
  return <CoordinatorThread turns={value?.turns ?? []} retry={() => { throw new Error('No retry action belongs to this read-only group'); }} />;
}
beforeAll(async () => { await startI18n(); await i18n.changeLanguage('en'); });
beforeEach(() => {
  queryClient.clear(); sessionStorage.clear(); localStorage.clear();
  useConnection.setState(useConnection.getInitialState());
  useConversation.setState({ ...useConversation.getInitialState(), root, open: true, expanded: true });
  useDraftStore.setState({ entries: {}, unavailable: false }); useOutbox.setState({ live: new Set(), resend: null });
  answer = { value: envelope, status: 200 }; requests = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const record = { path: String(url), method: init?.method ?? 'GET', answer: structuredClone(answer) };
    requests.push(record);
    if (record.path !== '/api/coordinator' || record.method !== 'GET')
      throw new Error('Unexpected transport: ' + JSON.stringify(record));
    // Intentionally raw: no snapshotJson, schema defaults, or envelope rewrite in the fixture.
    return new Response(JSON.stringify(record.answer.value), { status: record.answer.status });
  }));
});
afterEach(async ({ task }) => {
  const read = coordinatorReadState(queryClient, root), query = readQuery(queryClient, ['coordinator', root]);
  Object.assign(task.meta, { fixedSource: '15d64fb5a89dac7ddbe32f96384e458c50333baa',
    index: readIndex(queryClient), http: requests, assessment: read.assessment,
    query: query ? { data: query.state.data, status: query.state.status, fetchStatus: query.state.fetchStatus,
      fetchFailureCount: query.state.fetchFailureCount, error: query.state.error && {
        message: query.state.error.message, code: (query.state.error as any).code, detail: (query.state.error as any).detail } } : null,
    projected: useConversation.getState().conversation, dom: document.body.innerHTML,
    access: { workspace: canSendWrites(), conversation: canSendWrites(basisForRead(['coordinator', root])) } });
  cleanup(); await queryClient.cancelQueries(); queryClient.clear(); vi.unstubAllGlobals();
});
async function acquire() {
  const data = screenData(tree({ root }));
  expect(readQuery(queryClient, ['coordinator', root])).toBeUndefined();
  expect(useConversation.getState().conversation).toBeNull();
  await readConversationThroughOwner(conversation, root, baseline());
  render(<TestWorkspace data={data}><ShownConversationProvider><Consumer /></ShownConversationProvider></TestWorkspace>);
  expect(requests.some(request => request.path === '/api/coordinator' && request.method === 'GET')).toBe(true);
  // Announced identity is fixed, including when the envelope disagrees or is absent.
  expect(readIndex(queryClient)).toMatchObject({ root, generation, person: { coordinator: { id: cid, revision } } });
}
function noPosts() { expect(requests.filter(request => request.method === 'POST')).toEqual([]); }
function absent() {
  expect(useConversation.getState().conversation).toBeNull();
  expect(coordinatorReadState(queryClient, root).snapshot).toBeUndefined();
  expect(document.querySelector('[data-coordinator-message]')).toBeNull();
  expect(document.body.textContent).not.toContain(words);
  expect(canSendWrites(basisForRead(['coordinator', root]))).toBe(false);
  // A conversation GET does not own the workspace's independent write permission.
  expect(canSendWrites()).toBe(true);
  noPosts();
}
async function current() {
  await acquire();
  await waitFor(() => expect(document.querySelector('[data-coordinator-message="independent-turn"]')?.textContent).toContain(words));
  expect(useConversation.getState().conversation).toEqual(conversation);
  expect(coordinatorReadState(queryClient, root).assessment).toMatchObject({ state: 'current', display: true, project: true });
  expect(canSendWrites(basisForRead(['coordinator', root]))).toBe(true);
  noPosts();
}
test('N1 current control: independent live index and real GET populate the normal consumer', async () => { await current(); });
test.each(['root', 'generation'] as const)('N2/N3 foreign %s: raw response cannot repair the independent index or become content', async field => {
  answer = { value: { ...envelope, [field]: 'foreign-' + field }, status: 200 };
  await acquire();
  expect(useConversation.getState().error).toContain('another scope');
  absent();
});
test('N4 retained HTTP refusal: forbidden withdraws this conversation without revoking unrelated workspace access', async () => {
  await current();
  answer = { value: { error: { code: 'forbidden', message: 'Conversation access denied', retry: 'fix' } }, status: 403 };
  await act(async () => { await useConversation.getState().refresh(); });
  await waitFor(() => expect(coordinatorReadState(queryClient, root).assessment.state).toBe('refused'));
  expect(useConversation.getState().error).toContain('Conversation access denied');
  absent();
});
test('N5 initial missing conversation: a successful HTTP status cannot manufacture default-ready content', async () => {
  answer = { value: { root, generation, revision }, status: 200 };
  await acquire();
  expect(useConversation.getState().error).toBeTruthy();
  expect(readQuery(queryClient, ['coordinator', root])?.state.data).toBeUndefined();
  absent();
});
test('N6 initial malformed conversation: invalid turns never reach the consumer', async () => {
  answer = { value: { ...envelope, conversation: { ...conversation, turns: 'invalid turns' } }, status: 200 };
  await acquire();
  expect(useConversation.getState().error).toBeTruthy();
  expect(readQuery(queryClient, ['coordinator', root])?.state.data).toBeUndefined();
  absent();
});
test('N7 retained 503: changed announced revision preserves legitimate unverified words and acquisition time without write promotion', async () => {
  await current();
  const acquiredAt = coordinatorReadState(queryClient, root).assessment.acquiredAt;
  expect(acquiredAt).toBeTypeOf('number');
  answer = { value: { error: { code: 'unavailable', message: 'Temporary read failure', retry: 'later' } }, status: 503 };
  // The existing demand owner requests the active conversation after new index evidence.
  await act(async () => {
    const index = baseline();
    receiveFullIndex(queryClient, { ...index, rev: index.rev + 1, person: { ...index.person, coordinator: { id: cid, revision: 'b'.repeat(64) } } });
  });
  await waitFor(() => expect(useConversation.getState().error).toContain('Temporary read failure'));
  expect(requests.some(request => request.answer.status === 503)).toBe(true);
  expect(coordinatorReadState(queryClient, root).assessment).toMatchObject({ state: 'unverified', display: true, project: false, acquiredAt });
  expect(useConversation.getState().conversation).toEqual(conversation);
  expect(document.querySelector('[data-coordinator-message="independent-turn"]')?.textContent).toContain(words);
  expect(canSendWrites(basisForRead(['coordinator', root]))).toBe(false);
  expect(canSendWrites()).toBe(true);
  noPosts();
});

