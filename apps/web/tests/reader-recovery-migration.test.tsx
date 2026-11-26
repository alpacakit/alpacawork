import { readConversationThroughOwner, SERVED } from './conversation-fixture';
import { snapshotJson } from './conversation-fixture';
import { setConversationState } from './conversation-fixture';
/** Keyboard → actual reader send → rendered recovery toast, without replacing recovery rules. */
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { i18n, startI18n } from '@alpacawork/i18n';
import { CoordinatorCard } from '../src/features/coordinator/CoordinatorCard';
import { Reader } from '../src/features/reader/Reader';
import { Toaster } from '../src/components/ui/toaster';
import { notify, useToasts } from '../src/lib/notify';
import { useViewStore } from '../src/state/view-store';
import { useSitting } from '../src/features/reader/next-question';
import { useReaderSend } from '../src/features/coordinator/reader-send';
import { useConversation } from '../src/features/coordinator/coordinator';
import { useDraftStore } from '../src/features/forms/draft-store';
import { useOutbox } from '../src/features/coordinator/editor/outbox';
import { useTaskActionSlot } from '../src/features/coordinator/task-action-slot';
import { dismissRecovery, useDirectWriteRecovery } from '../src/features/reader/recovery';
import { useWriteIntentStore } from '../src/data/write-intent';
import { useDialogStore } from '../src/state/dialog-store';
import { queryClient } from '../src/data/query-client';
import { at, homeFixture, logEntry, decideItem, questionFixture, screenData, taskFixture, TestWorkspace, tree, userBall } from './fixtures';
const cid = 'reader-recovery-migration';
const conversation = { id: cid, nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, cancelled: [], turns: [] };
const refusal = () => new Response(snapshotJson({ error: { code: 'conflict', message: 'Refused', retry: 'reread' } }), { status: 409 });
const data = () => screenData(tree({ tasks: ['T1', 'T2'].map((id, i) => taskFixture({ id, title: `Review card ${i + 1}`, state: 'doing',
  log: [logEntry({ id: `Q${i + 1}`, kind: 'asked', title: 'Please review', description: 'This is a report', askedTo: null, actor: { kind: 'placement', placementId: `P${i + 1}` } })],
  ball: userBall('question', `Q${i + 1}`, at, { questionId: `Q${i + 1}` }) })),
  home: homeFixture([{ taskId: 'T1', section: 'review' }, { taskId: 'T2', section: 'review' }]),
  questions: ['T1', 'T2'].map((taskId, i) => questionFixture({ id: `Q${i + 1}`, taskId, decide: [decideItem('Choose', [['Option1 Proceed', 'Select it']])] })) }));
beforeAll(async () => { await startI18n(); await i18n.changeLanguage('en'); });
beforeEach(() => {
  sessionStorage.clear(); localStorage.clear(); useDraftStore.setState({ entries: {}, unavailable: false }); useOutbox.setState({ live: new Set(), resend: null });
  useReaderSend.setState({ receipts: new Map() }); useTaskActionSlot.setState({ element: null, inThread: false, page: null });
  useViewStore.setState(useViewStore.getInitialState()); useSitting.setState(useSitting.getInitialState());
  useDialogStore.setState({ dialog: null }); queryClient.clear();
  useConversation.setState({ root: '/fixture', open: false, expanded: false, engaged: false, error: null, wanted: false, focusRequested: false });
});
afterEach(() => { cleanup(); vi.restoreAllMocks();
  for (const entry of Object.values(useWriteIntentStore.getState().entries)) if (entry.reader) dismissRecovery(entry.reader.taskId, entry.operationId);
  for (const receipt of useReaderSend.getState().receipts.values()) dismissRecovery(receipt.task.id, JSON.stringify([receipt.root, receipt.conversationId, receipt.id, receipt.task.id, receipt.binding.turn]));
  for (const toast of useToasts.getState().toasts) notify.dismiss(toast.id); useToasts.setState({ hidden: new Set() });
});
function Recovery() { useDirectWriteRecovery(); return <Toaster />; }
async function mount(deliver: (input: any, opId: string | null) => Response | Promise<Response>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url) === '/api/commands/task/report') return deliver(JSON.parse(String(init?.body)), new Headers(init?.headers).get('X-Alpacawork-Op-Id'));
    if (String(url) === '/api/coordinator') return new Response(snapshotJson(conversation));
    return new Response(snapshotJson({ status: 'unavailable', profile: 'claude', skills: [], reason: 'unavailable' }));
  });
  data(); await readConversationThroughOwner(conversation);
  act(() => useViewStore.getState().openTask('T1', { reader: true }));
  render(<TestWorkspace data={data()}><Reader mode="docked" /><CoordinatorCard /><Recovery /></TestWorkspace>);
  expect(document.querySelector('[data-reader-task-id]')?.textContent).toBe('T1');
}
const hold = () => fireEvent.keyDown(document.body, { key: 'h' });
const toast = () => document.querySelector<HTMLElement>('[data-toast]')!;
const action = (name: string) => within(toast()).getByRole('button', { name });
const shown = () => document.querySelector('[data-reader-task-id]')?.textContent;

test('opening a refused card consumes its recovery entrance; another actual hold failure shows it again', async () => {
  await mount(() => refusal()); hold();
  await waitFor(() => expect(action('Open')).toBeTruthy()); fireEvent.click(action('Open'));
  await waitFor(() => expect(shown()).toBe('T1')); expect(toast()).toBeNull();
  expect(screen.getByRole('dialog', { name: 'Change the state of T1' })).toBeTruthy();
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Change the state of T1' })).toBeNull()); hold();
  await waitFor(() => expect(action('Open')).toBeTruthy()); expect(shown()).toBe('T2');
});

test('a refused Check replaces the same rendered unknown toast with Open', async () => {
  let requests = 0; await mount(() => { if (++requests === 1) throw new Error('connection lost'); return refusal(); }); hold();
  await waitFor(() => expect(action('Check')).toBeTruthy()); expect(shown()).toBe('T2'); const original = toast();
  fireEvent.click(action('Check')); await waitFor(() => expect(action('Open')).toBeTruthy());
  expect(toast()?.textContent).toContain('Review card 1');
  expect(within(toast()).queryByRole('button', { name: 'Check' })).toBeNull(); expect(toast()).toBe(original); expect(original.isConnected).toBe(true);
});

for (const next of ['Check', 'Open']) test(`hiding a previous hold permits the next operation's ${next} with a new request and toast ID`, async () => {
  const bodies: any[] = [];
  const opIds: (string | null)[] = [];
  await mount((input, opId) => { bodies.push(input); opIds.push(opId); if (bodies.length > 1 && next === 'Check') throw new Error('connection lost'); return refusal(); });
  hold(); await waitFor(() => expect(action('Open')).toBeTruthy()); const firstId = toast().getAttribute('data-toast-id');
  fireEvent.click(action('Close notification')); expect(toast()).toBeNull();
  data(); await readConversationThroughOwner(conversation);
  act(() => useViewStore.getState().openTask('T1', { reader: true })); expect(shown()).toBe('T1'); hold();
  await waitFor(() => expect(action(next)).toBeTruthy()); expect(bodies).toHaveLength(2); expect(opIds[1]).not.toBe(opIds[0]);
  expect(bodies[0]).toMatchObject({ task: 'T1', state: 'held' });
  expect(bodies[1]).toMatchObject({ task: 'T1', state: 'held' });
  expect(toast().getAttribute('data-toast-id')).not.toBe(firstId);
});
