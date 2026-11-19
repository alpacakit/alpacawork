/** Formal product oracle for finite refusal admission. No xfail, duplicated evaluator, or diagnostic inversion. */
import { afterEach, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { taskProjectedPageSchema } from '@alpacawork/contract/control';
import { queryClient as client } from '../src/data/query-client';
import { canSendWrites, detailWriteBasis, useConnection } from '../src/data/connection';
import { serverReadFacts, READ_TASK_AGE, taskReadState } from '../src/data/read-model';
import { observeReadRefusals, receiveFullIndex, resources } from '../src/data/resources';
import { useViewStore } from '../src/state/view-store';
import { Reader } from '../src/features/reader/Reader';
import { dto, historyFixture, screenData, TestWorkspace, tree } from './fixtures';
import { setupForms } from './forms-fixture';
import { historyWindowAnswer, jsonAnswer, serverPage, serverPageRow, serverView } from './receipt-fixture';

setupForms();
afterEach(() => { client.clear(); vi.useRealTimers(); });
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });

for (const loss of ['remove', 'expiry'] as const)
test(`403 A → ${loss} → old page/GET cannot revive actual Reader details; B editor survives; full GET then Task GET recovers`, async () => {
  const person = { id: 'P1', taskId: 'T1', agentId: 'A1', profileKey: 'codex', responsible: true, active: true,
    revision: 1, startedAt: '2026-09-24T09:00:00Z', endedAt: null, headRunId: null,
    runtime: { displayState: 'idle' as const, reason: null, sourceRunIds: [], runningCount: 0, queuedCount: 0,
      since: null, lastOutputAt: null, activityKind: null, toolName: null } };
  const a = dto({ state: 'done', title: 'Closed A', body: 'A SECRET BODY' });
  const b = dto({ id: 'T2', title: 'Known B', body: 'B ACQUIRED BODY' });
  const value = tree({ tasks: [a, b], placements: [person], history: {
    T1: historyFixture([{ id: 'HA', kind: 'comment', title: 'A SECRET HISTORY', summary: 'A secret history text' }]),
  } });
  const seeded = screenData(value), root = value.root;
  // screenData intentionally lists all supplied Tasks. The real live endpoint
  // excludes a closed Task and its placements; retain those only in its view.
  // TestWorkspace must not reseed the broad shorthand index on mount.
  const data = { ...seeded, seed: () => {} };
  const initial = client.getQueryData<any>(['index'])!;
  const index = { ...initial, tasks: initial.tasks.filter((t: { id: string }) => t.id !== a.id), placements: [] };
  receiveFullIndex(client, index);
  const av = serverView(value, a.id), bv = serverView(value, b.id);
  const page = taskProjectedPageSchema.parse(serverPage([serverPageRow(value, a.id)]));
  let stage: 'old' | 'refused' | 'recovered' = 'old';
  const recovered = serverView(tree({ tasks: [{ ...a, values: { notes: 'A REAUTHORIZED BODY' }, version: 2, hash: 'e'.repeat(64) }, b] }), a.id);
  const traffic: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    const path = String(url); traffic.push(path);
    if (path.startsWith('/api/workspace/live')) return jsonAnswer({ ...index, rev: index.rev + 1 });
    if (path.startsWith('/api/task/finished')) return jsonAnswer(page);
    if (path.startsWith('/api/task/history')) return jsonAnswer(historyWindowAnswer(path.includes('T1') ? value.history.T1 : []));
    if (path.startsWith('/api/task/view')) return path.includes('T2') ? jsonAnswer(bv)
      : stage === 'refused' ? new Response('', { status: 403 }) : jsonAnswer(stage === 'old' ? av : recovered);
    throw Error(`Unexpected request ${path}`);
  });
  useViewStore.setState(state => ({ selected: a.id, reader: { ...state.reader, open: true, pane: 'about' } }));
  observeReadRefusals(client);
  render(<TestWorkspace data={data}><Reader mode="docked" />{/* Another input mounted beside the Reader: it keeps its DOM, text and selection. */}<textarea aria-label="本文" /></TestWorkspace>);
  await settle();
  expect(document.body.textContent).toContain(String(a.values?.notes));
  await act(async () => { useViewStore.setState(state => ({ reader: { ...state.reader, pane: 'task' } })); });
  await settle(); expect(document.body.textContent).toContain('A SECRET HISTORY');
  await act(async () => { useViewStore.setState(state => ({ reader: { ...state.reader, pane: 'about' } })); });
  await settle();
  // The old closed page is a real resource fetch, not a second cache or row injection.
  await act(async () => { await client.fetchInfiniteQuery({ ...resources.finished(root, null), staleTime: 0 }); });
  const input = screen.getByRole('textbox', { name: '本文' }) as HTMLTextAreaElement;
  input.focus(); fireEvent.change(input, { target: { value: 'B UNSENT TEXT' } }); input.setSelectionRange(2, 7);
  const kept = () => {
    expect.soft(screen.getByRole('textbox', { name: '本文' })).toBe(input);
    expect.soft(input.value).toBe('B UNSENT TEXT');
    expect.soft([input.selectionStart, input.selectionEnd]).toEqual([2, 7]);
    expect.soft(document.activeElement).toBe(input);
    expect.soft(taskReadState(client, root, b.id).view?.task.values?.notes).toBe(b.values?.notes);
  };
  stage = 'refused';
  await act(async () => { await client.fetchQuery({ ...resources.taskView(root, a.id), staleTime: 0 }).catch(() => undefined); });
  await settle();
  expect.soft(taskReadState(client, root, a.id).view).toBeUndefined();
  expect.soft(document.body.textContent).not.toContain(String(a.values?.notes));
  kept();
  // Only B stays mounted while A's refusal group becomes inactive and finite.
  await act(async () => { useViewStore.setState(state => ({ selected: b.id, reader: { ...state.reader, open: true } })); });
  await settle(); input.focus(); input.setSelectionRange(2, 7);
  if (loss === 'remove') client.removeQueries({ queryKey: resources.taskView(root, a.id).queryKey, exact: true });
  else {
    vi.useFakeTimers(); await act(async () => { client.getQueryCache().find({ queryKey: resources.taskView(root, a.id).queryKey, exact: true })!.setState({}); await vi.advanceTimersByTimeAsync(READ_TASK_AGE + 1); }); vi.useRealTimers();
  }
  expect(client.getQueryData(resources.taskView(root, a.id).queryKey)).toBeUndefined();
  stage = 'old';
  // Fault injection: an old successful source before any new full live anchor.
  await act(async () => { await client.fetchQuery({ ...resources.taskView(root, a.id), staleTime: 0 }).catch(() => undefined); });
  expect.soft(taskReadState(client, root, a.id, true).view).toBeUndefined();
  expect.soft((serverReadFacts(client)?.placements ?? []).some(p => p.id === person.id)).toBe(false);
  expect.soft(canSendWrites(detailWriteBasis(a.id, a.hash))).toBe(false);
  kept(); // No focus repair between refusal/retention/admission and this check.
  await act(async () => { useViewStore.setState(state => ({ selected: a.id, reader: { ...state.reader, open: true } })); });
  await settle();
  expect.soft(document.body.textContent).not.toContain(String(a.values?.notes));
  await act(async () => { useViewStore.setState(state => ({ reader: { ...state.reader, pane: 'task' } })); });
  await settle();
  expect.soft(document.body.textContent).not.toContain('A SECRET HISTORY');
  await act(async () => { useViewStore.setState(state => ({ reader: { ...state.reader, pane: 'about' } })); });
  await settle();
  // Opening another Reader is deliberate navigation, whose focus policy is
  // outside this oracle. The B input's identity/text/selection still survive.
  expect.soft(screen.getByRole('textbox', { name: '本文' })).toBe(input);
  expect.soft(input.value).toBe('B UNSENT TEXT');
  expect.soft([input.selectionStart, input.selectionEnd]).toEqual([2, 7]);
  stage = 'recovered';
  const start = traffic.length;
  await act(async () => {
    await client.fetchQuery({ ...resources.index(), staleTime: 0 });
    await client.fetchQuery({ ...resources.taskView(root, a.id), staleTime: 0 });
  });
  await settle();
  expect.soft(document.body.textContent).toContain('A REAUTHORIZED BODY');
  expect.soft(canSendWrites(detailWriteBasis(a.id, recovered.task.hash))).toBe(true);
  expect.soft(traffic.slice(start).filter(path => path.startsWith('/api/workspace/live'))).toHaveLength(1);
  expect.soft(traffic.slice(start).filter(path => path.startsWith('/api/task/view') && path.includes('T1'))).toHaveLength(1);
  console.log('refusal-lifetime-http', JSON.stringify({ loss, traffic,
    recovery: { assessment: taskReadState(client, root, a.id).assessment,
      view: taskReadState(client, root, a.id).view, connection: useConnection.getState(), index: client.getQueryData(['index']) } }));
});
