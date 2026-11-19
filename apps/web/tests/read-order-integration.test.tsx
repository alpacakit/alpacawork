import { afterEach, expect, test, vi } from 'vitest';
import { dehydrate, hydrate, QueryClient } from '@tanstack/react-query';
import { projectedIndexSchema, taskRowSchema, type ProjectedIndexDTO, type TaskRowDTO, type TaskProjectedViewDTO } from '@alpacawork/contract/control';
import { captureReadProof, serverReadFacts, pageRow, recordReadProof } from '../src/data/read-model';
import { requestRead } from '../src/data/read-demand';
import { receivePatch, receiveFullIndex, resources, showWrittenTask } from '../src/data/resources';
import { mapWorkspace, rowTask } from '../src/data/map';
import { readerTask } from '../src/data/queries';
import { serverPatch, serverView, jsonAnswer } from './receipt-fixture';
import { byMoved } from '@alpacawork/contract/moved';
import { headOf, baselines, dto, indexOf, logEntry, rowOf, tree, viewsOf } from './fixtures';

const clients: QueryClient[] = [];
const client = () => { const c = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }); clients.push(c); return c; };
afterEach(() => { clients.forEach(c => c.clear()); clients.length = 0; vi.restoreAllMocks(); });
// The list alone owns a Task's order (movedAt): a view carries none, so a receipt or a view GET cannot move it, and
// the next patch does.
test('server order survives demand and receipt until the next SSE', async () => {
  const value = tree({ tasks: [dto({ state: 'doing' }), dto({ id: 'T2', title: 'Other task' })] });
  const original = indexOf(value), oldRow = { ...original.tasks.find(row => row.id === 'T1')!, movedAt: 1_790_000_000_123 };
  const index = { ...original, tasks: original.tasks.filter(row => row.id !== 'T1').concat([oldRow]) };
  const c = client(); receiveFullIndex(c, index);
  const key = resources.taskView(index.root, 'T1').queryKey;
  c.setQueryData(key, serverView(value, 'T1'));
  recordReadProof(c.getQueryCache().find({ queryKey: key })!, captureReadProof(index, key));
  const written = { ...value.tasks.find(task => task.id === 'T1')!, state: 'doing' as const, lifecycle: 'active' as const,
    values: { notes: 'Committed body' }, version: 2, hash: 'e'.repeat(64), log: [logEntry({ at: '2026-10-21T01:00:00Z' })] };
  const nextOrder = 1_800_000_000_456;
  const served = tree({ tasks: [written, value.tasks.find(task => task.id === 'T2')!] });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonAnswer(serverView(served, 'T1')));
  const receipt = showWrittenTask(c, headOf(written), index);
  // Check before a GET/SSE can repair the poisoned index.
  projectedIndexSchema.parse(c.getQueryData(['index']));
  expect(serverReadFacts(c)!.tasks.find(row => row.id === 'T2')?.title).toBe('Other task');
  expect(c.getQueryData<TaskProjectedViewDTO>(key)?.task).toMatchObject({ values: written.values, version: 2, hash: written.hash });
  expect(readerTask(c, index.root, 'T1')?.movedAt).toBe(oldRow.movedAt);
  const heldIndexRow = c.getQueryData<ProjectedIndexDTO>(['index'])!.tasks.find(row => row.id === 'T1');
  if (heldIndexRow) expect(heldIndexRow.movedAt).toBe(oldRow.movedAt);
  await receipt;
  // A normal GET is the source of the server's new subtree order.
  await c.fetchQuery({ ...resources.taskView(index.root, 'T1'), staleTime: 0 });
  projectedIndexSchema.parse(c.getQueryData(['index']));
  expect(c.getQueryData<TaskProjectedViewDTO>(key)?.task).toMatchObject({ values: written.values, version: 2 });
  expect(readerTask(c, index.root, 'T1')).toMatchObject({ hash: written.hash, version: 2 });
  const beforeSSE = c.getQueryData<ProjectedIndexDTO>(['index'])!;
  const server = { ...indexOf(served).tasks.find(row => row.id === 'T1')!, movedAt: nextOrder };
  expect(receivePatch(c, serverPatch(beforeSSE, [server]))).not.toBeNull();
  projectedIndexSchema.parse(c.getQueryData(['index']));
  expect(serverReadFacts(c)!.tasks.find(row => row.id === 'T1')?.movedAt).toBe(nextOrder);
  expect(readerTask(c, index.root, 'T1')?.movedAt).toBe(nextOrder);
  const restored = client(); hydrate(restored, JSON.parse(JSON.stringify(dehydrate(c))));
  projectedIndexSchema.parse(restored.getQueryData(['index']));
  expect(restored.getQueryData<TaskProjectedViewDTO>(key)?.task).toMatchObject({ values: written.values, version: 2 });
  expect(restored.getQueryData<ProjectedIndexDTO>(['index'])!.tasks.find(row => row.id === 'T1')?.movedAt).toBe(nextOrder);
});
