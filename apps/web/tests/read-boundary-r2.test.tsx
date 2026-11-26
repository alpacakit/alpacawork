import type { QueryKey } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render } from '@testing-library/react';
import { queryClient as client } from '../src/data/query-client';
import { acceptCoordinatorSnapshot, receiveFullIndex, resources, assessRead, applyReadEvidence } from '../src/data/resources';
import { captureReadProof, getReadProof, readQuery, taskReadState } from '../src/data/read-model';
import { readDemandStamp, readRecoveryPending, requestReadRecovery, requestRead, readDemandPending } from '../src/data/read-demand';
import { rowWriteBasis, detailWriteBasis, writeAccess, useConnection } from '../src/data/connection';
import { requireWriteAccess } from '../src/data/client';
import { dto, tree, indexOf, served0, viewsOf, screenData, TestWorkspace } from './fixtures';
import { conversationSnapshot, SERVED } from './conversation-fixture';
beforeEach(() => { client.clear(); useConnection.setState({ state: 'live', offline: false }); });
afterEach(() => { client.clear(); vi.restoreAllMocks(); });
for (const later of [false, true]) test(`coordinator receipt cannot complete a GET demand; later demand=${later}`, async () => {
  const index = indexOf(tree()); receiveFullIndex(client, index);
  const key: QueryKey = ['coordinator', index.root];
  const snapshot = conversationSnapshot({ id: 'C1', nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, cancelled: [], turns: [] });
  const query = client.getQueryCache().build(client, { queryKey: key });
  requestRead(query); requestReadRecovery(query);
  const served = readDemandStamp(query);
  await client.fetchQuery({ queryKey: key, queryFn: async () => {
    const proof = captureReadProof(index, key);
    if (later) { requestRead(query); requestReadRecovery(query); }
    acceptCoordinatorSnapshot(client, snapshot, proof);
    return snapshot;
  }});
  expect(query.state.fetchStatus).toBe('idle');
  expect(readRecoveryPending(query)).toBe(later);
  expect(readDemandPending(query)).toBe(true);
});
test('History-only 403 withdraws History without revoking a valid Task view', async () => {
  const source = tree(), index = indexOf(source); receiveFullIndex(client, index);
  const view = resources.taskView(index.root, 'T1'), past = resources.history(index.root, 'T1');
  let denied = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async path => String(path).includes('/history')
    ? denied ? new Response('', { status: 403 }) : Response.json({ ...served0, events: [], oldestKey: null, hasOlder: false })
    : Response.json(viewsOf(source).find(v => v.task.id === 'T1')));
  await client.fetchQuery(view); await client.fetchQuery(past);
  denied = true; await client.fetchQuery({ ...past, staleTime: 0 }).catch(() => {});
  expect(assessRead(client, readQuery(client, past.queryKey)!)).toMatchObject({ state: 'refused', persist: false });
  expect(assessRead(client, readQuery(client, view.queryKey)!)).toMatchObject({ state: 'current', project: true });
  const shown = taskReadState(client, index.root, 'T1', true);
  expect(shown.assessment).toMatchObject({ state: 'current', display: true, project: true });
  expect(shown.view?.task.id).toBe('T1');
  expect(shown.history).toBeUndefined();
});
test('row authority permits child creation without detail; stale, refused and foreign bases never send', () => {
  const task = dto(), index = indexOf(tree({ tasks: [task] })); receiveFullIndex(client, index);
  const basis = rowWriteBasis(task.id, task.hash);
  expect(client.getQueryData(resources.taskView(index.root, task.id).queryKey)).toBeUndefined();
  expect(writeAccess(basis)).toBe('allowed');
  expect(writeAccess(detailWriteBasis(task.id, task.hash))).toBe('conflict');
  expect(() => requireWriteAccess({ ...basis, root: '/other' })).toThrowError(expect.objectContaining({ code: 'conflict', retry: 'reread' }));
  applyReadEvidence(client, { kind: 'refused', query: client.getQueryCache().build(client, { queryKey: resources.taskView(index.root, task.id).queryKey as QueryKey }) });
  expect(() => requireWriteAccess(basis)).toThrowError(expect.objectContaining({ code: 'forbidden', retry: 'fix' }));
  useConnection.setState({ offline: true });
  expect(() => requireWriteAccess(basis)).toThrowError(expect.objectContaining({ code: 'write_unavailable', retry: 'later' }));
});
test('TestWorkspace redraw does not repair an uncertain or demanded acquisition', () => {
  const data = screenData(), key = resources.taskView(data.info.root, 'T1').queryKey;
  const query = readQuery(client, key)!;
  const view = render(<TestWorkspace data={data}><div /></TestWorkspace>);
  requestRead(query); const proof = getReadProof(query);
  view.rerender(<TestWorkspace data={data}><span /></TestWorkspace>);
  expect(getReadProof(query)).toEqual(proof);
  expect(readDemandPending(query)).toBe(true);
});
