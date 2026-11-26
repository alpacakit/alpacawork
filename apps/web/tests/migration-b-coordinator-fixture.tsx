import { readConversationThroughOwner, SERVED } from './conversation-fixture';
import { snapshotJson } from './conversation-fixture';
import { setConversationState } from './conversation-fixture';
import { afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { startI18n, i18n } from '@alpacawork/i18n';
import { Reader } from '../src/features/reader/Reader';
import { CoordinatorCard } from '../src/features/coordinator/CoordinatorCard';
import { useConversation } from '../src/features/coordinator/coordinator';
import { useViewStore } from '../src/state/view-store';
import { useOutbox } from '../src/features/coordinator/editor/outbox';
import { queryClient } from '../src/data/query-client';
import { notify, useToasts } from '../src/lib/notify';
import { TestWorkspace, screenData, taskFixture, tree, viewsOf } from './fixtures';

export const conversation = { id: 'migration-conversation', nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, admitted: {}, cancelled: [], turns: [] };
export const first = { id: 'T285', title: 'Retained first' }, second = { id: 'T253', title: 'Retained second' };
export const value = () => tree({ tasks: [taskFixture({ ...first, state: 'done' }), taskFixture(second)] });
export const field = () => screen.getByRole('textbox') as HTMLElement & { editor: Editor };
export const labels = () => [...field().closest('[data-label-editor]')!.querySelectorAll('[data-label-layer] [data-label=task] .tabular-nums')].map(el => el.textContent);
export const key = JSON.stringify(['/fixture', 'coordinator', conversation.id]);
export const json = (value: unknown) => new Response(snapshotJson(value));
export function setupCoordinator() {
  beforeAll(() => startI18n());
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    // jsdom has no native motion; its geometry is never used as evidence in these contracts.
    Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
    queryClient.clear();
    // The app reads its address before it shows anything; these contracts start from there.
    useViewStore.setState({ ...useViewStore.getInitialState(), navigationReady: true });
    useOutbox.setState({ live: new Set(), resend: null });
    screenData(value()); // Serve this fixture's index before arranging its qualified conversation.
    setConversationState({ ...useConversation.getInitialState(), root: '/fixture', open: true, expanded: true, read: true, error: null });
  });
  afterEach(() => {
    cleanup(); queryClient.clear(); vi.unstubAllGlobals();
    setConversationState(useConversation.getInitialState());
    useOutbox.setState({ live: new Set(), resend: null });
    for (const toast of useToasts.getState().toasts) notify.dismiss(toast.id);
  });
}
export function transport() {
  const posts: Record<string, any>[] = [];
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.startsWith('/api/coordinator/skills')) return json({ status: 'unavailable', profile: 'claude', skills: [], reason: 'test' });
    if (path.startsWith('/api/task/view')) return json(viewsOf(value()).find(view => view.task.id === new URL(path, 'http://fixture').searchParams.get('task')));
    if (path === '/api/coordinator/messages') {
      const body = JSON.parse(String(init?.body)); posts.push(body);
      return json({ ...conversation, turns: posts.map(post => ({ id: post.id, at: new Date().toISOString(), ask: post.text, tasks: post.tasks,
        attachments: [], status: 'succeeded', waiting: false, answer: 'Done', answeredAt: new Date().toISOString(), seen: true, error: null, result: null })) });
    }
    return json(conversation);
  });
  return { posts, fetcher };
}
export async function mountCoordinator(reader = false) {
  await readConversationThroughOwner(conversation);
  return render(<TestWorkspace data={screenData(value())}><>{reader && <Reader mode="docked" />}<CoordinatorCard /></></TestWorkspace>);
}
export const openTask = (id: string) => act(() => useViewStore.getState().openTask(id, { reader: true }));
