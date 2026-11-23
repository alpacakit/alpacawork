import { afterEach, describe, expect, test, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { projectedIndexSchema } from '@alpacawork/contract/control';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { getReadProof, readAcquisition, readIndex, readQuery, recordReadProof, READ_TASK_AGE, READ_MAX_BYTES } from '../src/data/read-model';
import { applyReadEvidence, onReadEvent, receiveFullIndex, resources } from '../src/data/resources';
import { restoreReadPersistence, startReadPersistence, useReadPersistence } from '../src/data/read-persistence';
import { checkpointFixture } from './checkpoint-fixture';
import { dto, indexOf, timelineAnswer, tree, viewsOf } from './fixtures';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(stop => stop()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const slot = (disk: any, kind = 'task') => disk.slots.find((value: any) => value.key[0] === kind);
const client = () => {
  const value = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  cleanup.push(() => value.clear()); return value;
};
function start(value: QueryClient) {
  const registration = vi.spyOn(window, 'addEventListener');
  const stop = startReadPersistence(value, changed => onReadEvent(value, changed));
  const flush = registration.mock.calls.find(([type]) => type === 'pagehide')![1] as () => void;
  registration.mockRestore(); cleanup.push(stop); return { flush, stop };
}
async function fixture(clock = Date.now()) {
  let now = clock; vi.spyOn(Date, 'now').mockImplementation(() => now);
  const storage = checkpointFixture(); vi.stubGlobal('indexedDB', storage.factory);
  const source = tree({ tasks: [dto({ id: 'T1', body: 'ACQUIRED WORDS' })] }), initial = indexOf(source);
  const index = { ...initial, person: { ...initial.person, settings: 'noop-settings' } };
  let view = viewsOf(source).find(value => value.task.id === 'T1')!;
  vi.stubGlobal('fetch', async (input: string) => {
    const path = new URL(String(input), 'http://fixture').pathname;
    if (path === '/api/commands/settings/get') return Response.json({ values: {}, revision: index.person.settings });
    if (path === '/api/person/notices') return Response.json({ state: null, revision: index.person.notices });
    if (path === '/api/task/view') return Response.json(view);
    if (path === '/api/task/timeline') return Response.json(timelineAnswer(source, ['T1']));
    throw new Error('Unexpected noop fixture HTTP ' + input);
  });
  const value = client(); await restoreReadPersistence(value); receiveFullIndex(value, index);
  await value.fetchQuery(resources.personalSettings(index.root)); await value.fetchQuery(resources.notices(index.root));
  await value.fetchQuery(resources.taskView(index.root, 'T1'));
  const timeline = resources.timelineLane(index.root, 'T1', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
  await value.fetchQuery(timeline);
  const writer = start(value); writer.flush();
  await waitFor(() => expect(slot(storage.read(), 'task-timeline')).toBeDefined());
  const query = readQuery(value, ['task', index.root, 'T1'])!;
  return { storage, value, index, query, writer, timeline, advance: (ms = 1000) => { now += ms; return now; },
    changeBody: (body: string) => { view = { ...view, task: { ...view.task, values: { notes: body } } }; } };
}
async function flush(h: { storage: ReturnType<typeof checkpointFixture>; writer: ReturnType<typeof start> }) {
  const before = h.storage.counts(), revision = h.storage.read().control.revision;
  h.writer.flush(); await waitFor(() => expect(h.storage.read().control.revision).toBeGreaterThan(revision)); return before;
}
function writes(h: Awaited<ReturnType<typeof fixture>>, before: ReturnType<ReturnType<typeof checkpointFixture>['counts']>, slots: number) {
  expect(h.storage.counts().committed - before.committed).toBe(1);
  // Each successful writer transaction puts its control once; all other puts are actual slots.
  expect(h.storage.counts().puts - before.puts).toBe(1 + slots);
}

test('inactive no-op flushes retain the exact committed snapshots, put only control and never stringify shared payloads', async () => {
  const h = await fixture(), disk = h.storage.read();
  const data = [h.query.state.data, h.value.getQueryData(h.timeline.queryKey)];
  const stringify = vi.spyOn(JSON, 'stringify');
  for (let at = 0; at < 2; at++) {
    const now = h.advance(), before = await flush(h); writes(h, before, 0);
    expect(h.storage.read().slots).toEqual(disk.slots);
    expect(h.storage.read().control).toMatchObject({ savedAt: now, revision: disk.control.revision + at + 1, epoch: disk.control.epoch });
  }
  expect(stringify.mock.calls.filter(([value]) => data.some(item => item === value))).toHaveLength(0);
  expect(useReadPersistence.getState()).toMatchObject({ status: 'saved', savedAt: h.storage.read().control.savedAt });
});

test('repeated checkpoints reuse the immutable normalized index instead of cloning it through the codec', async () => {
  const h = await fixture(), data = readIndex(h.value)!;
  const parse = vi.spyOn(projectedIndexSchema._zod, 'run');
  for (let n = 0; n < 3; n++) { h.advance(); await flush(h); }
  expect(parse).not.toHaveBeenCalled();
  expect(readIndex(h.value)).toBe(data);
});

test('an active timeless index keeps its exact slot on unrelated flushes', async () => {
  const h = await fixture(), disk = h.storage.read();
  const observer = new QueryObserver(h.value, { queryKey: ['index'], staleTime: Infinity, refetchOnMount: false });
  const stop = observer.subscribe(() => {}); cleanup.push(() => { stop(); observer.destroy(); });
  h.advance(); const before = await flush(h); writes(h, before, 0);
  expect(slot(h.storage.read(), 'index')).toEqual(slot(disk, 'index'));
  expect(h.storage.read().control.indexReceivedAt).toBe(disk.control.indexReceivedAt);
});

test('new observer option functions do not rewrite an otherwise unchanged active index', async () => {
  const h = await fixture(), disk = h.storage.read(), data = readIndex(h.value)!;
  const observer = new QueryObserver(h.value, { queryKey: ['index'], staleTime: Infinity, refetchOnMount: false });
  const stop = observer.subscribe(() => {}); cleanup.push(() => { stop(); observer.destroy(); });
  h.advance();
  observer.setOptions({ queryKey: ['index'], queryFn: async () => data, staleTime: Infinity, refetchOnMount: false });
  const before = await flush(h); writes(h, before, 0);
  expect(slot(h.storage.read(), 'index')).toEqual(slot(disk, 'index'));
});

test('a new index acquisition with the same data pointer still writes its proof and renews the envelope', async () => {
  const h = await fixture(), disk = h.storage.read(), data = readIndex(h.value)!;
  const now = h.advance(); receiveFullIndex(h.value, data);
  expect(readIndex(h.value)).toBe(data);
  const before = await flush(h); writes(h, before, 1);
  const saved = slot(h.storage.read(), 'index');
  expect(saved.acquisitionId).not.toBe(slot(disk, 'index').acquisitionId);
  expect(saved).toMatchObject({ acquiredAt: now, usedAt: now, query: { dehydratedAt: now } });
  expect(h.storage.read().control.indexReceivedAt).toBe(now);
});

test('an active slot saves usedAt and its fresh serialization time once a step of its lifetime has passed', async () => {
  const h = await fixture(), disk = h.storage.read();
  const observer = new QueryObserver(h.value, { ...resources.taskView(h.index.root, 'T1'), staleTime: Infinity, refetchOnMount: false });
  const stop = observer.subscribe(() => {}); cleanup.push(() => { stop(); observer.destroy(); });
  // In use within the step, the stored read is not written again for its use clock alone.
  h.advance(); writes(h, await flush(h), 0);
  const now = h.advance(10 * 60_000), before = await flush(h); writes(h, before, 1);
  expect(slot(h.storage.read())).toMatchObject({ usedAt: now, query: { dehydratedAt: now } });
  expect(slot(h.storage.read()).acquisitionId).toBe(slot(disk).acquisitionId);
  expect(slot(h.storage.read(), 'task-timeline')).toEqual(slot(disk, 'task-timeline'));
});

test('non-checkpoint Query updates and observers do not schedule active payload rewrites', async () => {
  const h = await fixture();
  const active = new QueryObserver(h.value, { ...resources.taskView(h.index.root, 'T1'), staleTime: Infinity, refetchOnMount: false });
  const unsubscribe = active.subscribe(() => {}); cleanup.push(() => { unsubscribe(); active.destroy(); });
  h.advance(); await flush(h);
  const before = h.storage.counts(), disk = h.storage.read();
  for (const key of [['host-status', h.index.root], ['task-file-text', h.index.root, 'T1', 'report.md', 'revision'], ['coordinator-skills', h.index.root, 'conversation', 'profile']]) {
    h.value.setQueryData(key, { value: 1 });
    await h.value.invalidateQueries({ queryKey: key, exact: true, refetchType: 'none' });
    try { await h.value.fetchQuery({ queryKey: key, queryFn: () => Promise.reject(new Error('Unstored read failed')), retry: false }); } catch {}
    const observer = new QueryObserver(h.value, { queryKey: key, enabled: false });
    const stop = observer.subscribe(() => {}); stop(); observer.destroy();
    h.value.removeQueries({ queryKey: key, exact: true });
  }
  h.advance(); await new Promise(resolve => setTimeout(resolve, 500));
  expect(h.storage.counts()).toEqual(before);
  expect(h.storage.read()).toEqual(disk);
  // A real checkpoint acquisition still schedules automatically, without an explicit pagehide flush.
  const acquisition = readAcquisition(h.query)?.id;
  await h.value.fetchQuery({ ...resources.taskView(h.index.root, 'T1'), staleTime: 0 });
  await waitFor(() => expect(slot(h.storage.read()).acquisitionId).not.toBe(acquisition));
});

test('a new GET of the same data pointer still commits the new acquisition, proof and Query state', async () => {
  const h = await fixture(), disk = h.storage.read(), data = h.query.state.data;
  const now = h.advance(); await h.value.fetchQuery({ ...resources.taskView(h.index.root, 'T1'), staleTime: 0 });
  expect(h.query.state.data).toBe(data); expect(readAcquisition(h.query)?.id).not.toBe(slot(disk).acquisitionId);
  const before = await flush(h); writes(h, before, 1);
  expect(slot(h.storage.read())).toMatchObject({ acquiredAt: now, query: { dehydratedAt: now, state: { dataUpdatedAt: now } } });
  expect(slot(h.storage.read()).acquisitionId).toBe(readAcquisition(h.query)?.id);
  expect(slot(h.storage.read()).slotId).not.toBe(slot(disk).slotId);
});

test('a proof change on the same acquisition is a real metadata write', async () => {
  const h = await fixture(), disk = h.storage.read(), now = h.advance();
  recordReadProof(h.query, { ...getReadProof(h.query)!, uncertain: true }, slot(disk).usedAt);
  const before = await flush(h); writes(h, before, 1);
  expect(slot(h.storage.read())).toMatchObject({ acquisitionId: slot(disk).acquisitionId,
    qualification: { proof: { uncertain: true } }, query: { dehydratedAt: now } });
});

test.each(['body', 'invalid-body', 'proof'] as const)("another tab's altered %s is inspected again and repaired", async kind => {
  const h = await fixture(), raw = h.storage.read(), saved = slot(raw);
  if (kind === 'proof') saved.qualification.proof.generation = 'foreign';
  else saved.query.state.data.task.values = kind === 'body' ? { notes: 'RAW ALTERED WORDS' } : 'malformed';
  raw.control.revision++; // Another writer's commit advances the revision this tab last wrote.
  h.storage.replace(raw); h.advance();
  const before = await flush(h); writes(h, before, 1);
  expect(slot(h.storage.read()).query.state.data.task.values.notes).toBe('ACQUIRED WORDS');
  expect(slot(h.storage.read()).qualification.proof.generation).toBe(h.index.generation);
});

test('a lawful timestamp-only raw difference remains the actual snapshot used on disk and after restore', async () => {
  const h = await fixture(), raw = h.storage.read();
  for (const value of raw.slots) value.query.dehydratedAt = 123;
  h.storage.replace(raw); h.advance();
  const before = await flush(h); writes(h, before, 0); expect(h.storage.read().slots).toEqual(raw.slots);
  h.writer.stop(); const restored = client(); await restoreReadPersistence(restored);
  const query = readQuery(restored, h.query.queryKey)!;
  expect(query.state).toMatchObject({ status: 'success', dataUpdatedAt: slot(raw).query.state.dataUpdatedAt, data: slot(raw).query.state.data });
  const writer = start(restored), next = { storage: h.storage, writer };
  h.advance(); const counts = await flush(next); writes(h, counts, 0);
  expect(h.storage.read().slots).toEqual(raw.slots);
});

test('inactive no-ops do not renew the retention deadline', async () => {
  const h = await fixture(), raw = h.storage.read(); h.advance(READ_TASK_AGE + 1);
  const before = await flush(h); writes(h, before, 0);
  expect(slot(h.storage.read())).toBeUndefined();
  expect(slot(h.storage.read(), 'task-timeline')).toEqual(slot(raw, 'task-timeline'));
});

test('budget selection counts the retained snapshot timestamp even when a fresh timestamp would exceed the exact byte limit', async () => {
  const h = await fixture(123), bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const initial = h.storage.read(), size = READ_MAX_BYTES - 1 - bytes(initial) + slot(initial).query.state.data.task.values.notes.length;
  h.changeBody('x'.repeat(size)); await h.value.fetchQuery({ ...resources.taskView(h.index.root, 'T1'), staleTime: 0 });
  await flush(h); const filled = h.storage.read(); expect(bytes(filled)).toBe(READ_MAX_BYTES - 1);
  h.advance(); const before = await flush(h); writes(h, before, 0);
  const retained = h.storage.read(); expect(retained.slots).toEqual(filled.slots); expect(bytes(retained)).toBe(READ_MAX_BYTES);
  const hypothetical = structuredClone(retained);
  for (const value of hypothetical.slots) value.query.dehydratedAt = retained.control.savedAt;
  expect(bytes(hypothetical)).toBeGreaterThan(READ_MAX_BYTES);
  expect(useReadPersistence.getState().status).toBe('saved');
});

test('another writer new acquisition is read from the current transaction and cannot be replaced by an older binding', async () => {
  const h = await fixture(), other = client(); await restoreReadPersistence(other);
  h.advance(); receiveFullIndex(other, h.index); h.changeBody('ACQUIRED IN OTHER CONNECTION');
  await other.fetchQuery({ ...resources.taskView(h.index.root, 'T1'), staleTime: 0 });
  const writer = start(other); await flush({ storage: h.storage, writer }); writer.stop();
  const external = h.storage.read(); expect(slot(external).query.state.data.task.values.notes).toBe('ACQUIRED IN OTHER CONNECTION');
  h.advance(); const before = await flush(h); writes(h, before, 0);
  expect(h.storage.read().slots).toEqual(external.slots);
});

test('abort cannot report or retain an uncommitted snapshot and an explicit retry writes the actual changed slot', async () => {
  const h = await fixture(), disk = h.storage.read(); h.advance(); h.changeBody('NEW ACQUIRED WORDS');
  await h.value.fetchQuery({ ...resources.taskView(h.index.root, 'T1'), staleTime: 0 });
  h.storage.failNextWrite(new DOMException('quota', 'QuotaExceededError')); h.writer.flush();
  await waitFor(() => expect(useReadPersistence.getState().status).toBe('unavailable'));
  expect(h.storage.read()).toEqual(disk); expect(h.query.state.data).toMatchObject({ task: { values: { notes: 'NEW ACQUIRED WORDS' } } });
  const now = h.advance(), before = await flush(h); writes(h, before, 1);
  expect(slot(h.storage.read()).query).toMatchObject({ dehydratedAt: now, state: { data: { task: { values: { notes: 'NEW ACQUIRED WORDS' } } } } });
});

test('refusal, root generation and stop still withdraw old writes without a snapshot cache', async () => {
  const h = await fixture(); h.advance(); applyReadEvidence(h.value, { kind: 'refused', query: h.query });
  await waitFor(() => expect(slot(h.storage.read())).toBeUndefined());
  receiveFullIndex(h.value, { ...h.index, generation: 'new-generation', rev: h.index.rev + 1 });
  await h.value.fetchQuery({ ...resources.personalSettings(h.index.root), staleTime: 0 });
  await h.value.fetchQuery({ ...resources.notices(h.index.root), staleTime: 0 }); h.writer.flush();
  await waitFor(() => expect(slot(h.storage.read(), 'index').query.state.data.generation).toBe('new-generation'));
  expect(slot(h.storage.read())).toBeUndefined(); expect(slot(h.storage.read(), 'task-timeline')).toBeUndefined();
  h.writer.stop(); const disk = h.storage.read(), counts = h.storage.counts(); h.advance(); h.writer.flush();
  await new Promise(resolve => setTimeout(resolve, 0)); expect(h.storage.read()).toEqual(disk); expect(h.storage.counts()).toEqual(counts);
  expect(readIndex(h.value)?.generation).toBe('new-generation');
});

describe('chronology windows', () => {
  const windows = (disk: any) => disk.slots.filter((value: any) => value.key[0] === 'task-timeline').map((value: any) => `${value.key[4]}..${value.key[5]}`).sort();
  const FROM = '2026-01-01T00:00:00.000Z', TO = '2026-01-02T00:00:00.000Z', LATER = '2026-01-02T00:05:00.000Z';
  async function saveWindow(h: Awaited<ReturnType<typeof fixture>>, from: string, to: string) {
    h.advance(); await h.value.fetchQuery(resources.timelineLane(h.index.root, 'T1', from, to)); await flush(h);
  }

  test('a turn of the window end leaves one stored copy, and a restart restores that one', async () => {
    const h = await fixture();
    await saveWindow(h, FROM, LATER);
    expect(windows(h.storage.read())).toEqual([`${FROM}..${LATER}`]);
    h.writer.stop();
    const next = client(); await restoreReadPersistence(next);
    expect(next.getQueryData(resources.timelineLane(h.index.root, 'T1', FROM, LATER).queryKey)).toBeDefined();
    expect(next.getQueryData(h.timeline.queryKey)).toBeUndefined();
    expect(h.storage.read().control.cut).toBe(false);
  });

  test('a checkpoint already holding both windows restores only the later one', async () => {
    const h = await fixture(), raw = h.storage.readRaw(), stored = raw.slots.find((value: any) => value.key[0] === 'task-timeline');
    const key = [...stored.key.slice(0, 5), LATER], hash = JSON.stringify(key);
    raw.slots.push({ ...stored, key, hash, slotId: 'later-slot', query: { ...stored.query, queryKey: key, queryHash: hash } });
    h.writer.stop(); h.storage.replaceRaw(raw);
    const next = client(); await restoreReadPersistence(next);
    expect(next.getQueryData(key)).toBeDefined();
    expect(next.getQueryData(h.timeline.queryKey)).toBeUndefined();
  });

  test('a later window acquired before the earlier one proves nothing about it: both are restored', async () => {
    const h = await fixture(), raw = h.storage.readRaw(), stored = raw.slots.find((value: any) => value.key[0] === 'task-timeline');
    const key = [...stored.key.slice(0, 5), LATER], hash = JSON.stringify(key), acquiredAt = stored.acquiredAt - 5000;
    raw.slots.push({ ...stored, key, hash, slotId: 'later-slot', acquiredAt, qualification: { ...stored.qualification, proof: { ...stored.qualification.proof, acquiredAt } },
      query: { ...stored.query, queryKey: key, queryHash: hash } });
    h.writer.stop(); h.storage.replaceRaw(raw);
    const next = client(); await restoreReadPersistence(next);
    expect(next.getQueryData(key)).toBeDefined();
    expect(next.getQueryData(h.timeline.queryKey)).toBeDefined();
  });

  test('a window that adds something stays: another start, or one still shown', async () => {
    const h = await fixture();
    await saveWindow(h, '2025-12-01T00:00:00.000Z', TO);
    expect(windows(h.storage.read())).toEqual(['2025-12-01T00:00:00.000Z..' + TO, `${FROM}..${TO}`]);

    const shown = new QueryObserver(h.value, h.timeline); cleanup.push(shown.subscribe(() => {}));
    await saveWindow(h, FROM, LATER);
    expect(windows(h.storage.read())).toContain(`${FROM}..${TO}`);
    cleanup.pop()!();
  });
});
