import { expect, test } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { ProjectedIndexDTO, TaskProjectedViewDTO } from '@alpacawork/contract/control';
import { resources } from '../src/data/resources';
import { captureReadProof, evaluateRead, serverReadFacts, type ReadEntry } from '../src/data/read-model';
import { receiveFullIndex } from '../src/data/resources';
import { dto, indexOf, tree, viewsOf } from './fixtures';

const served = tree({ tasks: [dto({ id: 'T1' })] });
const key = ['task', served.root, 'T1'];
/** T1's view as read from `sourcePv` (and `generation`), judged against a list that requires `required` of it. */
function judge(sourcePv: number, required: number, change: Partial<TaskProjectedViewDTO> = {}) {
  const index = indexOf(served, 1, required ? { view: { T1: required } } as never : {});
  const view = { ...viewsOf(served, sourcePv)[0]!, ...change };
  const read: ReadEntry = { key, data: view, proof: { ...captureReadProof(index, key), sourcePv } };
  return evaluateRead(index, read);
}

test('a read from the version its resource requires, or a later one, is current', () => {
  expect(judge(4, 4)).toMatchObject({ state: 'current', needsRead: false });
  expect(judge(5, 4)).toMatchObject({ state: 'current', needsRead: false });
  // A resource the list does not name has not changed this generation.
  expect(judge(0, 0)).toMatchObject({ state: 'current' });
});

test('a read from an older version is read again', () => {
  expect(judge(3, 4)).toMatchObject({ state: 'obsolete', needsRead: true });
});

test('a read of another generation is never compared', () => {
  expect(judge(9, 4, { generation: 'b' })).toMatchObject({ state: 'invalid', display: false });
});

test('a view ahead of the list is current, and the list keeps the Task among its facts', () => {
  const client = new QueryClient();
  const index: ProjectedIndexDTO = indexOf(served, 1, { view: { T1: 2 } } as never);
  receiveFullIndex(client, index);
  const view = viewsOf(served, 3)[0]!;
  const ahead = { ...view, task: { ...view.task, version: view.task.version + 1 }, row: { ...view.row, version: view.row.version + 1 } };
  expect(evaluateRead(index, { key, data: ahead, proof: { ...captureReadProof(index, key), sourcePv: 3 } }).state).toBe('current');
  client.setQueryData(resources.taskView(served.root, 'T1').queryKey, ahead);
  expect(serverReadFacts(client)?.tasks.map(row => row.id)).toContain('T1');
});
