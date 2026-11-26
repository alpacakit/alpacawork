import { Workbench } from "../src/features/shell/Workbench";
import { snapshotJson, SERVED } from './conversation-fixture';
/**
 * Receipt display probes (test only). Each case states a requirement of the receipt plan (scope scalar + same Task
 * Query detail admission + server/display API split) against the actual production callers.
 */
import { startRequiredReadSession, receiveFullIndex, resources, observeReadRefusals, readerTaskRow } from '../src/data/resources';
import { taskReadState } from '../src/data/read-model';
import { beforeAll, beforeEach, afterEach, afterAll, test, expect, vi } from 'vitest';
vi.hoisted(() => vi.resetModules());
import { render, cleanup, waitFor, act, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { startI18n } from '@alpacawork/i18n';
import { Workspace } from '../src/data/Workspace';
import { queryClient } from '../src/data/query-client';
import { canSendWrites, rowWriteBasis, useConnection } from '../src/data/connection';
import { captureReadProof, serverReadFacts, getReadProof, readQuery, recordReadProof } from '../src/data/read-model';
import { useReadStore } from '../src/state/read-store';
import { useViewStore } from '../src/state/view-store';
import { usePersonalSettings } from '../src/data/personal-settings';
import { useWriteIntentStore } from '../src/data/write-intent';
import { defaultSettings, DEFAULT_LIMITS } from '@alpacawork/contract';
import type { ControlTreeDTO, ControlIndexDTO } from '@alpacawork/contract/control';
import { taskBaseline } from '../src/data/notice-model';
import { dto, homeFixture, indexOf, timelineAxisAnswer, tree, viewsOf, PROJECT_TASK } from './fixtures';
import { problemResponse } from './problem';

const { fetchEventSource } = vi.hoisted(() => ({ fetchEventSource: vi.fn() }));
vi.mock('@microsoft/fetch-event-source', () => ({ fetchEventSource }));
type Stream = { onmessage: (event: { id: string; event: string; data: string }) => void };
let stream: Stream;
let stopRequired: (() => void) | undefined;
const flushReads = () => new Promise<void>(resolve => setTimeout(resolve, 20));
const person = { id: 'P1', taskId: 'T1', agentId: 'A1', profileKey: 'codex', responsible: true, active: true,
  revision: 1, startedAt: '2026-09-24T09:00:00Z', endedAt: null, headRunId: null,
  runtime: { displayState: 'idle', reason: null, sourceRunIds: [], runningCount: 0, queuedCount: 0,
    since: null, lastOutputAt: null, activityKind: null, toolName: null } } as any;

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
  history.replaceState(null, '', '/');
  fetchEventSource.mockImplementation((_url, options) => { stream = options; return new Promise(() => {}); });
});
afterEach(() => { cleanup(); stopRequired?.(); vi.restoreAllMocks(); });
afterAll(() => { vi.doUnmock('@microsoft/fetch-event-source'); vi.resetModules(); });

/**
 * An explicit refusal withdraws A's detail from its Query; A's past index row may stay as a dated list row, but
 * it is not a server basis for A's row writes, Task read (read-store readableTask = serverReadFacts row + row basis),
 * or A's current detail (readerTaskRow, people).
 */
test('a refused live Task keeps no server basis for its row, Task read or current detail (held and lost refusal)', async () => {
  const value = tree({ tasks: [dto({ id: 'T1' })], placements: [person] });
  const index = indexOf(value);
  receiveFullIndex(queryClient, index);
  useConnection.setState({ state: 'live', fresh: true, writable: true, offline: false });
  const options = resources.taskView(index.root, 'T1'), key = options.queryKey;
  queryClient.setQueryData(key, viewsOf(value).find(view => view.task.id === 'T1'));
  recordReadProof(readQuery(queryClient, key)!, captureReadProof(index, key));
  const hash = index.tasks.find(row => row.id === 'T1')!.hash;
  // Control: before the refusal the live row is a server basis.
  expect(canSendWrites(rowWriteBasis('T1', hash))).toBe(true);
  observeReadRefusals(queryClient);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 403 }));
  await act(async () => { await queryClient.fetchQuery({ ...options, staleTime: 0 }).catch(() => {}); await flushReads(); });
  expect(taskReadState(queryClient, index.root, 'T1').assessment.state).toBe('refused');
  const observe = (phase: string) => ({ phase,
    rowBasis: canSendWrites(rowWriteBasis('T1', hash)),
    serverRow: !!serverReadFacts(queryClient)?.tasks.some(row => row.id === 'T1'),
    serverPlacements: (serverReadFacts(queryClient)?.placements ?? []).filter(each => each.taskId === 'T1').map(each => each.id),
    readerRow: !!readerTaskRow(queryClient, index.root, 'T1') });
  const held = observe('refusal held');
  act(() => { queryClient.removeQueries({ queryKey: key, exact: true }); });
  const lost = observe('refused Query removed');
  console.log('preflight-refused-live', JSON.stringify({ held, lost }));
  for (const seen of [held, lost])
    expect.soft(seen).toEqual({ phase: seen.phase, rowBasis: false, serverRow: false, serverPlacements: [], readerRow: false });
});

/**
 * Workspace keeps its frame when display is unverified: when the index read is not projectable (what a scope cut makes
 * it until its anchor), the Reader, list and coordinator card stay mounted. Here the index is made non-projectable by an
 * unproven local index value, by which serverReadFacts returns undefined.
 */
test('the Workspace frame, Reader and coordinator card stay mounted while serverReadFacts is absent', async () => {
  let served: ControlTreeDTO = tree({ home: homeFixture([{ taskId: 'T1', section: 'doing' }]) });
  const values = defaultSettings();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    const path = String(url), target = new URL(path, 'http://screen');
    if (path === '/api/commands/config/get') return new Response(snapshotJson({ hash: 'c'.repeat(64), limits: { ...DEFAULT_LIMITS }, agentsText: 'agents: {}\n' }));
    if (target.pathname === '/api/task/view') {
      const view = viewsOf(served).find(each => each.task.id === target.searchParams.get('task'));
      return view ? new Response(snapshotJson(view)) : problemResponse('not_found', 'No task');
    }
    if (target.pathname === '/api/task/history') return new Response(snapshotJson({ events: [], nextBefore: null }));
    if (path === '/api/coordinator') return new Response(snapshotJson({ id: 'conversation-1', nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, admitted: {}, cancelled: [], turns: [] }));
    if (path === '/api/commands/settings/get') return new Response(snapshotJson({ values, revision: 'person-1' }));
    if (path === '/api/person/notices') return new Response(snapshotJson({ state: null, revision: null, initialBaselines: Object.fromEntries(indexOf(served).tasks.map(row => [row.id, taskBaseline(row)])) }));
    if (path.startsWith('/api/task/timeline-axis?')) {
      const params = new URL(path, 'http://fixture/').searchParams;
      return new Response(snapshotJson(timelineAxisAnswer(served, params.get('lanes')!.split(','))));
    }
    return problemResponse('not_found', 'Not found');
  });
  history.replaceState(null, '', '/?task=T1');
  render(<QueryClientProvider client={queryClient}><Workspace><Workbench /></Workspace></QueryClientProvider>);
  await waitFor(() => expect(fetchEventSource).toHaveBeenCalled());
  await act(async () => stream.onmessage({ id: 'a:1', event: 'index', data: JSON.stringify({ ...indexOf(served), generation: 'a' }) }));
  await screen.findAllByText('Task one');
  const reader = await waitFor(() => { const found = document.querySelector('aside[data-reader-mode]'); expect(found).toBeTruthy(); return found!; });
  const card = await waitFor(() => { const found = document.querySelector('[data-coordinator-card]'); expect(found).toBeTruthy(); return found!; });
  expect(serverReadFacts(queryClient)).toBeTruthy();
  let probe: unknown;
  await act(async () => {
    // A changed value (structural sharing keeps an equal copy as the proven object) without read evidence.
    queryClient.setQueryData<ControlIndexDTO>(['index'], held => ({ ...held!, rev: held!.rev + 1 }));
    const indexQuery = readQuery(queryClient, ['index'])!;
    probe = { sync: serverReadFacts(queryClient) === undefined, proof: getReadProof(indexQuery) };
    await flushReads();
    probe = { ...probe as object, later: serverReadFacts(queryClient) === undefined, laterProof: getReadProof(indexQuery), same: readQuery(queryClient, ['index']) === indexQuery };
  });
  console.log('preflight-workspace-probe', JSON.stringify(probe));
  const after = { facts: serverReadFacts(queryClient) === undefined, readerKept: reader.isConnected, cardKept: card.isConnected,
    readerNow: !!document.querySelector('aside[data-reader-mode]'), skeleton: !!document.querySelector('[data-skeleton], [aria-busy=true]') };
  console.log('preflight-workspace-unmount', JSON.stringify(after));
  expect(after.facts).toBe(true);
  expect.soft(after.readerKept).toBe(true);
  expect.soft(after.cardKept).toBe(true);
  served = tree();
});
