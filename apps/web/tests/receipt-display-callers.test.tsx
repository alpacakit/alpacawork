import { Workbench } from "../src/features/shell/Workbench";
import * as directWrites from '../src/data/direct-write';
import { snapshotJson } from './conversation-fixture';
/**
 * Regression for the receipt display contract's server-only callers. The whole Workspace is mounted, so the
 * actual feed adapter, Workspace mapping, read-store, Reader (useShowCard → observeReaderTurns) and connection gate run.
 * The fixture server answers HTTP and the SSE transport only with contract DTOs; no index, row or view is injected
 * into the QueryCache, and no read evaluator or receipt type is supplied by the test.
 */
import { startRequiredReadSession, resources } from '../src/data/resources';
import { beforeAll, beforeEach, afterEach, afterAll, test, expect, vi } from 'vitest';
vi.hoisted(() => vi.resetModules());
import { render, cleanup, waitFor, act, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { startI18n } from '@alpacawork/i18n';
import { Workspace } from '../src/data/Workspace';
import { queryClient } from '../src/data/query-client';
import { canSendWrites, rowWriteBasis, useConnection } from '../src/data/connection';
import { coordinatorWriteBasis } from '../src/data/coordinator';
import { rereadWorkspaceIndex } from '../src/data/queries';
import { markRead, useReadStore } from '../src/state/read-store';
import { useViewStore } from '../src/state/view-store';
import { usePersonalSettings } from '../src/data/personal-settings';
import { useWriteIntentStore } from '../src/data/write-intent';
import { useDraftStore } from '../src/features/forms/draft-store';
import { holdsReaderTurn, outgoingKey } from '../src/features/coordinator/editor/outbox';
import { emptyDocument } from '../src/features/coordinator/editor/document';
import { readerTurn } from '../src/features/reader/submission';
import { rowTask } from '../src/data/map';
import { NOTICE_VERSION, taskBaseline } from '../src/data/notice-model';
import { defaultSettings, DEFAULT_LIMITS } from '@alpacawork/contract';
import type { ControlTreeDTO } from '@alpacawork/contract/control';
import { at, homeFixture, indexOf, logEntry, taskFixture, timelineAxisAnswer, tree, userBall, viewsOf, PROJECT_TASK } from './fixtures';
import { historyWindowAnswer } from './receipt-fixture';
import { problemResponse } from './problem';

const { fetchEventSource } = vi.hoisted(() => ({ fetchEventSource: vi.fn() }));
vi.mock('@microsoft/fetch-event-source', () => ({ fetchEventSource }));
type Stream = { onmessage: (event: { id: string; event: string; data: string }) => void };
let stream: Stream;
let stopRequired: (() => void) | undefined;
const root = '/fixture';
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
const person = (id: string, taskId: string) => ({ id, taskId, agentId: `A-${id}`, profileKey: 'codex', responsible: true, active: true,
  revision: 1, startedAt: '2026-09-24T09:00:00Z', endedAt: null, headRunId: null,
  runtime: { displayState: 'idle' as const, reason: null, sourceRunIds: [], runningCount: 0, queuedCount: 0,
    since: null, lastOutputAt: null, activityKind: null, toolName: null } });
const waiting = (id: string, title: string, body: string, turn: string, extra: string[] = []) => taskFixture({ id, title, values: { notes: body }, state: 'waiting',
  log: [logEntry({ id: `${id}-L0` }), ...[turn, ...extra].map((each, n) => logEntry({ id: each, kind: 'reported', toState: n === 0 ? 'waiting' : null,
    at: `2026-09-24T1${n}:00:00Z`, title: `Report ${each}` }))], ball: userBall('review', [turn, ...extra].at(-1)!, at) });
/** The server's tree at a revision: A (T1) and B (T2) both wait on the user, each with its own responsible person. */
const served = (aTurns: string[] = ['A1'], bTurns: string[] = ['B1']): ControlTreeDTO => tree({
  tasks: [waiting('T1', 'Refused A', 'A SECRET BODY', aTurns[0]!, aTurns.slice(1)), waiting('T2', 'Known B', 'B ACQUIRED BODY', bTurns[0]!, bTurns.slice(1))],
  placements: [person('P1', 'T1'), person('P2', 'T2')],
  home: homeFixture([{ taskId: 'T1', section: 'review' }, { taskId: 'T2', section: 'review' }]) });
const notices = 'n1';
/** The server's index at `rev`, from projection version `rev`: each Task's view and History require the version that last changed it. */
const changedAt = new Map<string, { task: string; rev: number }>();
const index = (value: ControlTreeDTO, rev: number, generation = 'a') => {
  for (const task of value.tasks) {
    const held = changedAt.get(task.id), now = JSON.stringify(task);
    if (held?.task !== now) changedAt.set(task.id, { task: now, rev });
  }
  const required = Object.fromEntries([...changedAt].map(([id, { rev }]) => [id, rev]));
  return { ...indexOf(value, rev, { view: required, history: required } as never), sourcePv: rev as never, generation,
    person: { settings: null, notices, coordinator: { id: 'conversation-1', revision: '0'.repeat(64) } } };
};

let current = served();
let aView: 'served' | 'refused' = 'served';
let live = index(current, 1);
const saves: { reads: string[] }[] = [];
const http: string[] = [];
/** Complete live GETs are held from the loss until the anchor step: one the product may start by itself at the cut
 * cannot anchor before the pre-anchor observations. Held requests are counted when they are made. */
let holdLive = false;
const liveWaiters: (() => void)[] = [];
/** B's own view GET held, so what the anchor alone gives back is seen apart from B's read. */
let holdB = false;
const bWaiters: (() => void)[] = [];
const releaseLive = (all = true) => { if (all) holdLive = false; (all ? liveWaiters.splice(0) : liveWaiters.splice(0, 1)).forEach(release => release()); };
/** The anchor: a complete live GET through the index Query (joining one already started after the cut). */
const anchor = async (...more: Promise<unknown>[]) => {
  const fetched = queryClient.fetchQuery({ ...resources.index(), staleTime: 0 });
  releaseLive();
  await act(async () => { await Promise.all([fetched, ...more]); });
  await settle(); await settle();
};
function serve() {
  const values = defaultSettings();
  const checkpoint = { at, tasks: Object.fromEntries(indexOf(current).tasks.map(row => [row.id, taskBaseline(row)])) };
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const path = String(url), target = new URL(path, 'http://screen');
    http.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/api/commands/config/get') return new Response(snapshotJson({ hash: 'c'.repeat(64), limits: { ...DEFAULT_LIMITS }, agentsText: 'agents: {}\n' }));
    if (target.pathname === '/api/workspace/live') {
      if (holdLive) await new Promise<void>(resolve => liveWaiters.push(resolve));
      return new Response(snapshotJson(live));
    }
    if (target.pathname === '/api/task/view') {
      const id = target.searchParams.get('task');
      if (id === 'T2' && holdB) await new Promise<void>(resolve => bWaiters.push(resolve));
      if (id === 'T1' && aView === 'refused') return problemResponse('forbidden', 'Refused');
      const view = viewsOf(current, live.sourcePv).find(each => each.task.id === id);
      return view ? new Response(snapshotJson(view)) : problemResponse('not_found', 'No task');
    }
    if (target.pathname === '/api/task/history') return new Response(snapshotJson({ ...historyWindowAnswer(), sourcePv: live.sourcePv }));
    if (path === '/api/coordinator') return new Response(snapshotJson({ id: 'conversation-1', nextLaunch: { agent: 'claude', values: {} }, warm: 'none' as const, busy: false, cancelled: [], turns: [] }));
    if (path === '/api/commands/settings/get') return new Response(snapshotJson({ values, revision: 'person-1' }));
    if (path === '/api/person/notices') return new Response(snapshotJson({ state: { version: NOTICE_VERSION, checkpoint, reads: {} }, revision: notices }));
    // The fixture server keeps the notice revision the live index names and does not retain Task reads, so every
    // admitted read attempt reaches it and the next attempt still has news to save. Admission is the screen's.
    if (path === '/api/person/notices/save') {
      const input = JSON.parse(String(init?.body));
      saves.push({ reads: Object.keys(input.state.reads) });
      return new Response(snapshotJson({ state: { ...input.state, reads: {} }, revision: notices }));
    }
    if (path.startsWith('/api/task/timeline-axis?')) {
      const params = new URL(path, 'http://fixture/').searchParams;
      return new Response(snapshotJson(timelineAxisAnswer(current, params.get('lanes')!.split(','))));
    }
    return problemResponse('not_found', 'Not found');
  });
}
const sendIndex = async (value: ControlTreeDTO, rev: number, generation = 'a') => {
  current = value; live = index(value, rev, generation);
  await act(async () => stream.onmessage({ id: `${generation}:${rev}`, event: 'index', data: JSON.stringify(live) }));
  await settle();
};
/** The screen's own read of A (the Reader would make the same request through the same Query). */
const readA = async () => { await act(async () => { await queryClient.fetchQuery({ ...resources.taskView(root, 'T1'), staleTime: 0 }).catch(() => undefined); }); await settle(); };
const evictA = async () => { act(() => { queryClient.removeQueries({ queryKey: resources.taskView(root, 'T1').queryKey, exact: true });
  queryClient.removeQueries({ queryKey: ['task-history', root, 'T1'], exact: true }); }); await settle(); };
/** A Task read is attempted through the actual entry; only an admitted read reaches the server. */
const reads = async (id: string) => { const before = saves.length; await act(async () => { await markRead(id); }); await settle(); return saves.length > before; };
const unreadDot = (id: string) => !!document.querySelector(`[data-row="${id}"] [data-unread]`);
/** A Task read is still needed for a structured claim on it: an intent or an answer. A recipient label is no claim and
 * needs no read: free words, whatever they are addressed to, go on the workspace basis alone. */
const operation = (id: string) => canSendWrites(coordinatorWriteBasis({ intent: { task: id }, answers: [{ task: id }] }));
const freeWords = () => canSendWrites(coordinatorWriteBasis({}));

beforeAll(() => startI18n());
beforeEach(() => {
  localStorage.removeItem('alpacawork.navigation.v2');
  queryClient.clear();
  stopRequired?.(); stopRequired = startRequiredReadSession(queryClient);
  useReadStore.setState(useReadStore.getInitialState(), true);
  usePersonalSettings.setState(usePersonalSettings.getInitialState(), true);
  useWriteIntentStore.setState({ entries: {}, unavailable: false });
  useConnection.setState({ offline: false, lastReceivedAt: undefined });
  useViewStore.setState(useViewStore.getInitialState());
  changedAt.clear(); current = served(); aView = 'served'; live = index(current, 1); saves.length = 0; http.length = 0; holdLive = false; liveWaiters.length = 0; holdB = false; bWaiters.length = 0;
  fetchEventSource.mockImplementation((_url, options) => { stream = options; return new Promise(() => {}); });
});
afterEach(() => { cleanup(); stopRequired?.(); vi.restoreAllMocks(); });
afterAll(() => { vi.doUnmock('@microsoft/fetch-event-source'); vi.resetModules(); });

async function mount(task: string) {
  serve();
  history.replaceState(null, '', `/?task=${task}`);
  render(<QueryClientProvider client={queryClient}><Workspace><Workbench /></Workspace></QueryClientProvider>);
  await waitFor(() => expect(fetchEventSource).toHaveBeenCalled());
  await sendIndex(current, 1);
  await screen.findAllByText('Known B');
  await waitFor(() => expect(useReadStore.getState().status).toBe('ready'));
  await waitFor(() => expect(document.querySelector('aside[data-reader-mode]')).toBeTruthy());
}

test('M2/M5: a refused live A gives no Task read, row or operation (intent/answers) basis while held, lost and read before the anchor; free words stay sendable; the anchor and A GET restore them', async () => {
  await mount('T2');
  // Both Tasks gain a server report: unread news, so a Task read has something to save.
  await sendIndex(served(['A1', 'A2'], ['B1', 'B2']), 2);
  await readA();
  const observe = async (phase: string) => ({ phase,
    row: canSendWrites(rowWriteBasis('T1')), operation: operation('T1'), free: freeWords(), read: await reads('T1') });
  // Control: the same gate admits B's read and B's operations while A is refused (no cut yet).
  aView = 'refused'; await readA();
  const control = { phase: 'refusal-held B control', row: canSendWrites(rowWriteBasis('T2')), operation: operation('T2'), free: freeWords(), read: await reads('T2') };
  expect(control).toEqual({ phase: 'refusal-held B control', row: true, operation: true, free: true, read: true });
  const held = await observe('refusal-held');
  holdLive = true;
  await evictA();
  const lost = await observe('refusal-lost');
  aView = 'served'; await readA();
  const early = await observe('pre-anchor-get');
  console.log('callers-refused-A', JSON.stringify({ control, held, lost, early, saves }));
  for (const seen of [held, lost, early]) expect.soft(seen).toEqual({ phase: seen.phase, row: false, operation: false, free: true, read: false });
  // Positive side: a complete live GET started now, then A's own GET.
  await anchor();
  await readA();
  expect.soft(await observe('recovered')).toEqual({ phase: 'recovered', row: true, operation: true, free: true, read: true });
});

test('M4/M5/M6: after the unique refusal is lost, an SSE full index alone neither qualifies B, nor makes news, nor ends B\'s settled reader turn; the same-revision GET anchor (one HTTP for both callers) does', async () => {
  await mount('T2');
  // B's explicit operation was settled earlier in this tab; its protection lasts until a fresh observation ends the turn.
  const b = rowTask(indexOf(current).tasks.find(row => row.id === 'T2')!);
  const binding = { ...readerTurn(b), kind: 'intent' as const, title: b.title, answer: 'send' as const, expectedWrites: [{ kind: 'request_accepted' }] };
  const request = crypto.randomUUID();
  act(() => useDraftStore.setState(state => ({ entries: { ...state.entries, [outgoingKey(root, request)]: { status: 'editing',
    values: { doc: JSON.stringify(emptyDocument()), requestId: request, reader: JSON.stringify([binding]), stage: 'settled' } } } })));
  const settled = () => holdsReaderTurn(useDraftStore.getState().entries, root, binding);
  expect(settled()).toBe(true);
  await readA();
  aView = 'refused'; await readA();
  expect(canSendWrites(rowWriteBasis('T2'))).toBe(true);
  expect(unreadDot('T2')).toBe(false);
  const cut = http.length;
  holdLive = true;
  await evictA();
  // The server publishes B's next turn through SSE (a full index). It is a server update, not the anchor.
  const next = served(['A1'], ['B1', 'B2']);
  await sendIndex(next, 2);
  const sse = { phase: 'sse-full', row: canSendWrites(rowWriteBasis('T2')), operation: operation('T2'), free: freeWords(),
    news: unreadDot('T2'), settled: settled() };
  // Two callers ask for the complete live index at once after the cut: one GET serves both, and its same
  // revision as the held SSE index still makes it the anchor.
  await anchor(rereadWorkspaceIndex(queryClient));
  const anchored = { phase: 'anchor', row: canSendWrites(rowWriteBasis('T2')), operation: operation('T2'), free: freeWords(),
    news: unreadDot('T2'), settled: settled() };
  const recovery = http.slice(cut).filter(each => each.startsWith('GET '));
  console.log('callers-sse-anchor', JSON.stringify({ sse, anchored, recovery }));
  expect.soft(sse, 'SSE full is not an anchor').toEqual({ phase: 'sse-full', row: false, operation: false, free: true, news: false, settled: true });
  expect.soft(anchored, 'the GET anchor restores server facts').toEqual({ phase: 'anchor', row: true, operation: true, free: true, news: true, settled: false });
  expect.soft(recovery.filter(each => each.includes('/api/workspace/live')), 'one complete live GET for the loss and both callers').toHaveLength(1);
  // Task reads in this window also follow the SSE update and the Reader's read-ahead of the next question (A); the
  // Task GET budget at the anchor is checked in the PWA oracle, where no SSE update falls inside the window.
});

test('M6: a complete live GET started before the unique protection loss cannot become the anchor', async () => {
  await mount('T2');
  await readA();
  aView = 'refused'; await readA();
  // The GET leaves before the loss and answers after it; any GET started after the loss stays held meanwhile.
  holdLive = true;
  const early = queryClient.fetchQuery({ ...resources.index(), staleTime: 0 });
  await settle();
  await evictA();
  releaseLive(false); await act(async () => { await early; }); await settle();
  const before = { row: canSendWrites(rowWriteBasis('T2')), operation: operation('T2'), free: freeWords() };
  // A GET started after the loss is the anchor. The page then reads B again by itself; B's GET is held here.
  holdB = true;
  await anchor();
  const after = { row: canSendWrites(rowWriteBasis('T2')), operation: operation('T2'), free: freeWords() };
  // An operation on B (intent/answers) rests on B's own complete GET after the anchor, not on its row.
  holdB = false; bWaiters.splice(0).forEach(release => release());
  await act(async () => { await queryClient.fetchQuery({ ...resources.taskView(root, 'T2'), staleTime: 0 }); }); await settle();
  const read = { row: canSendWrites(rowWriteBasis('T2')), operation: operation('T2'), free: freeWords() };
  console.log('callers-pre-cut-get', JSON.stringify({ before, after, read }));
  expect.soft(before, 'a pre-cut GET answered after the cut does not anchor').toEqual({ row: false, operation: false, free: true });
  expect.soft(after, 'the anchor gives the row back; an operation still waits for B\'s own GET').toEqual({ row: true, operation: false, free: true });
  expect.soft(read).toEqual({ row: true, operation: true, free: true });
});


test('connection idempotence retains live generation/root write recovery and notice freshness through actual Workspace', async () => {
  const resume = vi.spyOn(directWrites, 'resumeDirectIntents');
  await mount('T2');
  await waitFor(() => expect(resume).toHaveBeenCalledWith(queryClient, root));
  resume.mockClear();
  await sendIndex(current, 2, 'generation-replaced-live');
  await waitFor(() => expect(resume).toHaveBeenCalledWith(queryClient, root));
  expect(canSendWrites()).toBe(true);
  resume.mockClear();
  const other = { ...served(), root: '/other-live-root' };
  await sendIndex(other, 1, 'other-root-generation');
  await waitFor(() => expect(resume).toHaveBeenCalledWith(queryClient, other.root));
  await waitFor(() => expect(useReadStore.getState()).toMatchObject({ root: other.root, fresh: true, status: 'ready' }));
  expect(canSendWrites()).toBe(true);
  expect(canSendWrites({ kind: 'workspace', root, generation: 'generation-replaced-live' })).toBe(false);
});
