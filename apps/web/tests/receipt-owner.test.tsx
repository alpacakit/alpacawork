/** Production Owner regressions for the selected receipt boundaries. */
import { expect, test, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { taskWriteResultSchema, type ProjectedIndexDTO } from '@alpacawork/contract/control';
import { queryClient as client } from '../src/data/query-client';
import { captureReadBoundary, cutReadScope, displayReadFacts, readEntry, readProtections, readScope, serverReadFacts, losesReadProtection, taskReadState, getReadProof, readQuery } from '../src/data/read-model';
import { receiveFullIndex, receivePatch, resources, showWrittenTask, recoverReads } from '../src/data/resources';
import { rowWriteBasis, workspaceWriteBasis, canSendWrites, useConnection } from '../src/data/connection';
import { writeTask } from '../src/data/task-write';
import { useDraftStore, draftKey } from '../src/features/forms/draft-store';
import { useDialogStore } from '../src/state/dialog-store';
import { setupForms } from './forms-fixture';
import { headOf, dto, tree, indexOf, screenData, TestWorkspace } from './fixtures';
import { jsonAnswer, serverView, serverPatch } from './receipt-fixture';
setupForms();
beforeEach(() => useConnection.setState({ state: 'live', offline: false }));
afterEach(() => client.clear());

test.each(['full', 'delta'] as const)('a %s publication after recovery retains the current verification era', async publication => {
  const index = indexOf(tree()); receiveFullIndex(client, index);
  cutReadScope(client);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonAnswer(index));
  await recoverReads(client);
  const era = readScope(client)!.era;
  expect(era).toBeGreaterThan(0);
  expect(serverReadFacts(client)).toBeDefined();
  // JSON transport produces a new object; Query structurally shares its unchanged fields.
  if (publication === 'full') receiveFullIndex(client, JSON.parse(JSON.stringify({ ...index, rev: index.rev + 1 })));
  else receivePatch(client, JSON.parse(JSON.stringify(serverPatch(index, []))));
  expect(getReadProof(readQuery(client, ['index'])!)?.era).toBe(era);
  expect(serverReadFacts(client)?.rev).toBe(index.rev + 1);
});

test('pure closure counts undefined refusal, maximum version and redundant same-version evidence without an ID ledger', async () => {
  const value = tree(), index = indexOf(value); receiveFullIndex(client, index);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonAnswer(serverView(value, 'T1')));
  await client.fetchQuery(resources.taskView(index.root, 'T1'));
  const all = client.getQueryCache().getAll().map(readEntry), detail = all.find(read => read.key[0] === 'task')!;
  expect(losesReadProtection(index, all, all.filter(read => read !== detail))).toBe(false);
  const refusal = { ...detail, data: undefined, refused: true };
  expect(readProtections(index, [refusal]).refusals.has('T1')).toBe(true);
  expect(losesReadProtection(index, [...all, refusal], all)).toBe(true);
  const higher = { ...detail, proof: { ...detail.proof!, minimumVersion: 9 } };
  expect(losesReadProtection(index, [...all, higher], all)).toBe(true);
});

test('SSE full and delta keep B visible but cannot anchor; explicit recovery joins one full Query GET and leaves inactive sources alone', async () => {
  const value = tree(), index = indexOf(value); receiveFullIndex(client, index);
  const paths: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    paths.push(String(url)); return jsonAnswer(String(url).includes('workspace/live') ? client.getQueryData(['index']) : serverView(value, 'T1'));
  });
  await client.fetchQuery(resources.taskView(index.root, 'T1'));
  const held = taskReadState(client, index.root, 'T1').view;
  cutReadScope(client);
  receiveFullIndex(client, { ...index, rev: index.rev + 1 });
  receivePatch(client, serverPatch(client.getQueryData<ProjectedIndexDTO>(['index'])!, []));
  expect(serverReadFacts(client)).toBeUndefined();
  expect(displayReadFacts(client)?.tasks.some(row => row.id === 'T1')).toBe(true);
  expect(taskReadState(client, index.root, 'T1').view).toBe(held);
  expect(taskReadState(client, index.root, 'T1').assessment).toMatchObject({ state: 'unverified', display: true, project: false });
  expect(canSendWrites(rowWriteBasis('T1'))).toBe(false);
  const before = paths.length;
  await Promise.all([recoverReads(client), recoverReads(client)]);
  expect(paths.slice(before)).toEqual(['/api/workspace/live']);
  expect(readScope(client)?.anchored).toBe(true);
  expect(taskReadState(client, index.root, 'T1').assessment.project).toBe(false);
});

test('a full index GET started before the cut cannot anchor even if its response arrives after it', async () => {
  const index = indexOf(tree()); receiveFullIndex(client, index);
  let release!: (response: Response) => void;
  vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue(jsonAnswer(index));
  const pending = client.fetchQuery({ ...resources.index(), staleTime: 0 });
  cutReadScope(client); release(jsonAnswer(index)); await pending;
  expect(serverReadFacts(client)).toBeUndefined();
  expect(readScope(client)?.anchored).toBe(false);
  await client.fetchQuery({ ...resources.index(), staleTime: 0 });
  expect(serverReadFacts(client)).toBeDefined();
});

test('validated POST across scope ABA confirms transport but cannot apply to the new session', async () => {
  const index = indexOf(tree()); receiveFullIndex(client, index);
  let release!: (response: Response) => void;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const started = captureReadBoundary(client);
  const pending = writeTask(client, 'task/new', { title: 'Committed' }, taskWriteResultSchema, 'aba-post', workspaceWriteBasis());
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  receiveFullIndex(client, { ...index, generation: 'B' }); receiveFullIndex(client, index);
  expect(captureReadBoundary(client)?.session).not.toBe(started?.session);
  release(jsonAnswer({ task: headOf(dto({ id: 'T9', version: 2 })) }));
  await expect(pending).resolves.toMatchObject({ task: { id: 'T9' }, local: 'scope-changed' });
  expect(client.getQueryData(resources.taskView(index.root, 'T9').queryKey)).toBeUndefined();
  expect(fetcher).toHaveBeenCalledOnce();
});

