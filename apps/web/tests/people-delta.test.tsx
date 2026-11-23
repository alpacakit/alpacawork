import { memo } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { startI18n } from '@alpacawork/i18n';
import type { IndexPatchDTO } from '@alpacawork/contract/control';
import { usePeopleFor } from '../src/data/queries';
import { applyIndexPatch } from '../src/data/resources';
import { serverPatch } from './receipt-fixture';
import { mapWorkspace } from '../src/data/map';
import { createWorkspaceStore, publishWorkspace, WorkspaceContext } from '../src/data/workspace-store';
import { queryClient } from '../src/data/query-client';
import { indexPeople, sameForFeed } from '../src/domain/people';
import { useViewStore } from '../src/state/view-store';
import { baselines, dto, indexOf, run, tree, PROJECT_TASK } from './fixtures';

beforeAll(() => startI18n());
beforeEach(() => useViewStore.setState({ ...useViewStore.getInitialState() }));
afterEach(() => { cleanup(); queryClient.clear(); });

test('real patches preserve unrelated Run subscribers, but publish subtree Run changes', () => {
  const source = tree({ tasks: [dto({ id: 'T1', title: 'Parent', hash: '1'.repeat(64) }),
    dto({ id: 'T11', parentId: 'T1', path: 'tasks/T11', title: 'Child', hash: '2'.repeat(64) }),
    dto({ id: 'T2', path: 'tasks/T2', title: 'Sibling', hash: '3'.repeat(64) })],
    runs: [run('R1', { taskId: 'T11', state: 'failed', reason: 'exit' }), run('R2', { taskId: 'T2', placementId: 'P2' })] });
  let index = indexOf(source);
  const baseline = baselines(source.tasks);
  let people = indexPeople(index);
  const project = () => ({ ...mapWorkspace(index, baseline), people, drawing: { root: index.root, restoredAt: null },
    info: { root: index.root, rev: index.rev, checkpointAt: baseline.checkpoint.at, writable: index.writable,
      errors: index.errors, staleIds: index.staleIds, runs: index.runs, profiles: index.profiles, attachmentBytes: index.attachmentBytes, projects: index.projects,
      presence: index.presence, host: index.host, coordinatorWork: index.coordinatorWork, counts: index.counts, home: index.home } });
  const store = createWorkspaceStore(project());
  const taskIds = ['T1', 'T11', 'T2'] as const;
  const calls: Record<typeof taskIds[number], number> = { T1: 0, T11: 0, T2: 0 };
  const Probe = memo(function Probe({ id }: { id: typeof taskIds[number] }) {
    const selected = usePeopleFor(id, true);
    calls[id]++;
    return <output data-testid={`runs-${id}`}>{JSON.stringify({
      runs: selected.runsByTask.get(id)?.map(run => [run.id, run.state]) ?? [],
      failures: selected.failuresByTask.get(id)?.map(failure => [failure.run.id, failure.resolvedBy?.id ?? null]) ?? [],
    })}</output>;
  });
  function Forest() {
    return <>{taskIds.map(id => <Probe key={id} id={id} />)}</>;
  }
  const view = render(<QueryClientProvider client={queryClient}><WorkspaceContext value={store}><Forest /></WorkspaceContext></QueryClientProvider>);
  const probe = (id: string) => JSON.parse(screen.getByTestId(`runs-${id}`).textContent!);
  const counts: { step: string; subscribers: number[] }[] = [];
  const delta = (step: string, change: Partial<IndexPatchDTO>) => {
    const before = { ...calls };
    const next = applyIndexPatch(index, { ...serverPatch(index, []), ...change })!;
    index = next;
    people = indexPeople(index, people);
    act(() => publishWorkspace(store, project()));
    counts.push({ step, subscribers: taskIds.map(id => calls[id] - before[id]) });
  };
  const priorRuns = people.runsByTask.get('T11');
  delta('unrelated Task', { tasks: { upsert: [{ ...index.tasks.find(task => task.id === 'T2')!, title: 'Renamed sibling', hash: '4'.repeat(64), version: 2 }], remove: [] } });
  const unchangedRuns = people.runsByTask.get('T11') === priorRuns;
  const continuation = run('R3', { taskId: 'T11', resumes: 'R1', state: 'queued', startedAt: null, endedAt: null });
  delta('add Run', { runs: { upsert: [continuation], remove: [] } });
  expect(probe('T11')).toEqual({ runs: [['R1', 'failed'], ['R3', 'queued']], failures: [['R1', null]] });
  delta('end Run', { runs: { upsert: [{ ...continuation, state: 'succeeded', startedAt: '2026-09-24T09:00:00Z', endedAt: '2026-09-24T09:01:00Z' }], remove: [] } });
  expect(probe('T11')).toEqual({ runs: [['R1', 'failed'], ['R3', 'succeeded']], failures: [['R1', 'R3']] });
  delta('remove continuation', { runs: { upsert: [], remove: ['R3'] } });
  expect(probe('T11')).toEqual({ runs: [['R1', 'failed']], failures: [['R1', null]] });
  delta('remove last Run', { runs: { upsert: [], remove: ['R1'] } });
  expect(probe('T11')).toEqual({ runs: [], failures: [] });
  // The optimized projection must render exactly as a full rebuild at the same patch revision.
  const html = view.container.innerHTML;
  people = indexPeople(index);
  act(() => publishWorkspace(store, project()));
  expect(view.container.innerHTML).toBe(html);
  console.log('Run patch render counts (T1 ancestor, T11 target, T2 sibling):', JSON.stringify(counts));
  expect(unchangedRuns).toBe(true);
  expect(counts).toEqual([
    { step: 'unrelated Task', subscribers: [0, 0, 1] },
    ...['add Run', 'end Run', 'remove continuation', 'remove last Run'].map(step =>
      ({ step, subscribers: [1, 1, 0] })),
  ]);
});

test('a feed is told of its own crew, its own Runs and any Run awaiting a decision, and of nothing else', () => {
  const index = indexOf(tree({ tasks: [dto({ id: 'T1' }), dto({ id: 'T2', path: 'tasks/T2' })], runs: [run('R1', { taskId: 'T1' }), run('R2', { taskId: 'T2', placementId: 'P2' })] }));
  const base = indexPeople(index), [own, other] = index.runs as [typeof index.runs[0], typeof index.runs[0]];
  const after = (runs: typeof index.runs) => indexPeople({ ...index, runs }, base);
  expect(sameForFeed(base, after([own, other]), 'T1')).toBe(true);
  expect(sameForFeed(base, after([own, { ...other, state: 'running' }]), 'T1')).toBe(true);
  expect(sameForFeed(base, after([{ ...own, state: 'running' }, other]), 'T1')).toBe(false);
  expect(sameForFeed(base, after([own, { ...other, state: 'needs_review' }]), 'T1')).toBe(false);
});
