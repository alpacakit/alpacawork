import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { QueryObserver } from '@tanstack/react-query';
import { waitFor } from '@testing-library/react';
import { queryClient as client } from '../src/data/query-client';
import { acceptedGet, captureReadProof, cutReadScope, getReadProof, readAcceptedSequence, readAcquisition, readGetTicket, readQuery, readRefused } from '../src/data/read-model';
import { resources, receiveFullIndex, captureResourceRead, acceptPersonalRead, applyReadEvidence, fetchAcceptedResource, assessRead } from '../src/data/resources';
import { ApiError } from '../src/data/client';
import { createNoticeStore } from '../src/data/notice-store';
import { useConnection } from '../src/data/connection';
import { dto, tree, indexOf, viewsOf } from './fixtures';

beforeEach(() => { client.clear(); useConnection.setState({ state: 'live', fresh: true, writable: true, offline: false }); });
afterEach(() => { client.clear(); vi.restoreAllMocks(); });
const json = (value: unknown) => Response.json(value);
const person = { values: { theme: 'light' }, revision: 's1' };

for (const direct of [false, true]) test(`GET resolved before receipt cannot roll back its value or acquire the receipt (direct=${direct})`, async () => {
  const index = indexOf(tree()); index.person.settings = 's1'; receiveFullIndex(client, index);
  const options = resources.personalSettings(index.root);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(person)); await client.fetchQuery(options);
  const query = readQuery(client, options.queryKey)!, time = getReadProof(query)!.acquiredAt;
  const order: string[] = [];
  const stop = client.getQueryCache().subscribe(event => { if (event.query === query && event.type === 'updated' && event.action.type === 'success') order.push(event.action.manual ? 'manual' : 'GET-setData'); });
  const fetcher = vi.mocked(fetch).mockImplementation(() => {
    const started = captureResourceRead(client, options.queryKey);
    // Registered inside queryFn's actual transport before Query.fetch attaches its await continuation.
    // The retryer is resolved when this runs, so cancel alone cannot protect the final setData window.
    void query.promise!.then(() => {
      order.push('raw-resolved');
      expect(acceptPersonalRead(client, options.queryKey, { values: { theme: 'dark' }, revision: 's2' }, started)).toBe(true);
    });
    return Promise.resolve(json(person));
  });
  const reading = direct ? fetchAcceptedResource(client, { ...options, staleTime: 0 }) : client.fetchQuery({ ...options, staleTime: 0 });
  const ticket = readGetTicket(query)!;
  if (direct) await expect(reading).rejects.toMatchObject({ revert: true }); else await expect(reading).resolves.toEqual(person);
  expect(order).toEqual(['raw-resolved', 'manual', 'GET-setData']);
  expect(query.state).toMatchObject({ data: { revision: 's2', values: { theme: 'dark' } }, status: 'success', error: null, fetchStatus: 'idle' });
  expect(readAcquisition(query)?.source).toBe('derived'); expect(readAcceptedSequence(query)).toBe(0); expect(getReadProof(query)!.acquiredAt).toBe(time);
  expect(acceptedGet(ticket, person)).toBe(false); expect(fetcher).toHaveBeenCalledTimes(2); stop();
});

test('initial no-old refusal in the final setData window restores the same error and reason, idle and no acquired GET', async () => {
  const value = tree({ tasks: [dto()] }), index = indexOf(value); receiveFullIndex(client, index);
  const options = resources.history(index.root, 'T1'), reason = { kind: 'history_revalidation_unavailable' as const };
  const error = new ApiError('permission revoked', 'forbidden', 'fix', undefined, [], reason);
  let ticket: ReturnType<typeof readGetTicket>;
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    const query = readQuery(client, options.queryKey)!; ticket = readGetTicket(query);
    void query.promise!.then(() => { query.setState({ error, status: 'error' }); applyReadEvidence(client, { kind: 'refused', query }); });
    return Promise.resolve(json({ generation: 'a', sourcePv: 0, events: [], oldestKey: null, hasOlder: false }));
  });
  await client.fetchQuery(options);
  const query = readQuery(client, options.queryKey)!;
  expect(readRefused(query)).toBe(true); expect(query.state.data).toBeUndefined(); expect(query.state.error).toBe(error);
  expect((query.state.error as ApiError).reason).toBe(reason); expect(query.state.fetchStatus).toBe('idle'); expect(query.state.status).toBe('error');
  expect(assessRead(client, query)).toMatchObject({ display: false, persist: false, state: 'refused' });
  expect(readAcceptedSequence(query)).toBe(0); expect(ticket?.cancelled).toBeUndefined(); expect(readGetTicket(query)).toBeUndefined();
});

test('equal GETs have distinct acquisitions while manual/select/placeholder input uses standard structural sharing', async () => {
  const index = indexOf(tree()); index.person.settings = 's1'; receiveFullIndex(client, index);
  const options = resources.personalSettings(index.root);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json(person)); await client.fetchQuery(options);
  const query = readQuery(client, options.queryKey)!, first = query.state.data, acquisition = readAcquisition(query)!;
  await client.fetchQuery({ ...options, staleTime: 0 });
  expect(query.state.data).toBe(first); expect(readAcquisition(query)!.id).not.toBe(acquisition.id); expect(readAcceptedSequence(query)).toBeGreaterThan(acquisition.issued);
  const observer = new QueryObserver(client, { ...options, select: data => data.revision, placeholderData: person });
  const stop = observer.subscribe(() => {}); expect(observer.getCurrentResult().data).toBe('s1');
  client.setQueryData(options.queryKey, { ...person }); expect(query.state.data).toBe(first); expect(observer.getCurrentResult().data).toBe('s1');
  stop(); observer.destroy();
});

test('queryFn invalidation cancels the actual Query before throwing and leaves it idle with held content', async () => {
  const value = tree({ tasks: [dto()] }), index = indexOf(value); receiveFullIndex(client, index);
  const options = resources.taskView(index.root, 'T1'); const response = viewsOf(value)[0];
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(response)); await client.fetchQuery(options);
  const query = readQuery(client, options.queryKey)!, held = query.state.data;
  let release!: (value: Response) => void;
  vi.mocked(fetch).mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const reading = client.fetchQuery({ ...options, staleTime: 0 }); cutReadScope(client); release(json(response)); await reading;
  expect(query.state.fetchStatus).toBe('idle'); expect(query.state.data).toBe(held); expect(assessRead(client, query).project).toBe(false);
});

for (const change of ['revision', 'scope', 'query'] as const) test(`late index GET discard preserves its replacement after ${change} changes`, async () => {
  const index = indexOf(tree()); receiveFullIndex(client, index);
  let releaseOld!: (response: Response) => void, releaseNew!: (response: Response) => void;
  const fetcher = vi.spyOn(globalThis, 'fetch')
    .mockImplementationOnce(() => new Promise(resolve => { releaseOld = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { releaseNew = resolve; }));
  const old = client.fetchQuery({ ...resources.index(), staleTime: 0 }).catch(() => {});
  await client.cancelQueries({ queryKey: ['index'], exact: true });
  if (change === 'query') client.removeQueries({ queryKey: ['index'], exact: true });
  const current = { ...index, rev: index.rev + 1, ...(change === 'scope' ? { generation: 'replacement-generation' } : {}) };
  receiveFullIndex(client, current);
  const replacement = client.fetchQuery({ ...resources.index(), staleTime: 0 });
  const query = readQuery(client, ['index'])!;
  try {
    releaseOld(json(index)); await old;
    // The cancelled flight's transport still resolves after its Query promise has reverted.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(query.state.fetchStatus).toBe('fetching');
    releaseNew(json(current));
    await expect(replacement).resolves.toEqual(current);
    await waitFor(() => expect(query.state.fetchStatus).toBe('idle'));
    expect(query.state).toMatchObject({ status: 'success', error: null, data: current });
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { releaseOld(json(index)); releaseNew(json(current)); }
});

test('an older index response still cancels its own current execution and retains the published index', async () => {
  const index = indexOf(tree()), current = { ...index, rev: index.rev + 1 };
  receiveFullIndex(client, index);
  let release!: (response: Response) => void;
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const reading = client.fetchQuery({ ...resources.index(), staleTime: 0 });
  receiveFullIndex(client, current); release(json(index));
  await reading;
  expect(readQuery(client, ['index'])!.state).toMatchObject({ status: 'success', fetchStatus: 'idle', data: current });
});


test('notice-store discards its raw null GET and starts zero initialization POSTs after a receipt wins the final window', async () => {
  const index = indexOf(tree()); index.person.notices = null; receiveFullIndex(client, index);
  const key = resources.notices(index.root).queryKey;
  const saved = { state: { version: 4 as const, checkpoint: { at: '2026-10-01T00:00:00Z', tasks: {} }, reads: {} }, revision: 'newer-notice' };
  const posts: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, input) => {
    if (input?.method === 'POST') { posts.push(String(url)); return Promise.resolve(json(saved)); }
    const query = readQuery(client, key)!; const started = captureResourceRead(client, key);
    void query.promise!.then(() => { expect(acceptPersonalRead(client, key, saved, started)).toBe(true); });
    return Promise.resolve(json({ state: null, revision: null, initialBaselines: {} }));
  });
  const store = createNoticeStore(); store.getState().bind(index.root);
  await store.getState().reload();
  expect(client.getQueryData(key)).toEqual(saved); expect(posts).toEqual([]);
  expect(readQuery(client, key)!.state).toMatchObject({ fetchStatus: 'idle', status: 'success', error: null });
});

test('a rejected GET overtaken before the error reducer cannot revoke the newer receipt', async () => {
  const index = indexOf(tree()); index.person.settings = 's1'; receiveFullIndex(client, index);
  const options = resources.personalSettings(index.root);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(person)); await client.fetchQuery(options);
  const query = readQuery(client, options.queryKey)!;
  vi.mocked(fetch).mockImplementation(() => {
    const started = captureResourceRead(client, options.queryKey);
    void query.promise!.catch(() => { acceptPersonalRead(client, options.queryKey, { values: { theme: 'dark' }, revision: 's2' }, started); });
    return Promise.resolve(Response.json({ error: { code: 'forbidden', message: 'Obsolete GET denied', retry: 'fix' } }, { status: 403 }));
  });
  await client.fetchQuery({ ...options, staleTime: 0 }).catch(() => {});
  expect(query.state).toMatchObject({ data: { revision: 's2' }, status: 'success', error: null, fetchStatus: 'idle' });
  expect(readRefused(query)).toBe(false); expect(getReadProof(query)?.marker).toBe('s2');
});


test('a receipt canceling an obsolete GET leaves one successor GET able to certify the outstanding demand', async () => {
  const index = indexOf(tree()); index.person.settings = 's1'; receiveFullIndex(client, index);
  const options = resources.personalSettings(index.root), newer = { values: { theme: 'dark' }, revision: 's2' };
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(person)); await client.fetchQuery(options);
  const query = readQuery(client, options.queryKey)!, started = captureResourceRead(client, options.queryKey);
  const observer = new QueryObserver(client, options), stop = observer.subscribe(() => {});
  let release!: (response: Response) => void;
  const fetcher = vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue(json(newer));
  try {
    receiveFullIndex(client, { ...index, rev: index.rev + 1, person: { ...index.person, settings: 's2' } });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(acceptPersonalRead(client, options.queryKey, newer, started)).toBe(true);
    await vi.waitFor(() => expect(assessRead(client, query).project).toBe(true));
    expect(fetcher).toHaveBeenCalledTimes(3); expect(readAcquisition(query)?.source).toBe('get');
    release(json(person)); await Promise.resolve(); await Promise.resolve();
    expect(query.state).toMatchObject({data:newer,fetchStatus:'idle',status:'success',error:null});
  } finally { stop(); observer.destroy(); }
});
