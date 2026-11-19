import { afterEach, expect, test, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { personalSettingsResponseSchema } from '@alpacawork/contract';
import { projectedIndexSchema } from '@alpacawork/contract/control';
import { captureReadProof, cutReadScope, evaluateRead, isReadDataImmutable, readIndex, readNormalized, readCheckpointIndex } from '../src/data/read-model';
import { receiveFullIndex } from '../src/data/resources';
import { dto, indexOf, tree, viewsOf } from './fixtures';

const clients: QueryClient[] = [];
afterEach(() => { clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); });
const source = () => tree({ tasks: [dto({ id: 'T1' })] });
const canonical = () => projectedIndexSchema.parse(indexOf(source()));
const entry = (data: ReturnType<typeof canonical>) => ({ key: ['index'], data, proof: captureReadProof(data, ['index']) });
function installCodec(codec: z.ZodType) {
  return vi.spyOn(projectedIndexSchema, 'safeParse').mockImplementation(value => codec.safeParse(value) as ReturnType<typeof projectedIndexSchema.safeParse>);
}

test('structure transfers its unpublished parse output once, and later normalization is fresh', () => {
  const data = canonical(), parse = vi.spyOn(projectedIndexSchema, 'safeParse');
  for (let n = 0; n < 4; n++) expect(evaluateRead(data, entry(data)).state).toBe('current');
  expect(parse).toHaveBeenCalledTimes(1); expect(isReadDataImmutable(data)).toBe(true);
  const first = readNormalized(['index'], data)!;
  expect(first.data).toEqual(data); expect(first.data).not.toBe(data); expect(parse).toHaveBeenCalledTimes(1);
  const output = first.data as typeof data;
  output.tasks[0]!.title = 'MUTATED PUBLISHED OUTPUT';
  output.requiredPv.view.changed = 7 as never;
  const second = readNormalized(['index'], data)!;
  expect(second.data).toEqual(data); expect(second.data).not.toBe(first.data); expect(parse).toHaveBeenCalledTimes(2);
  const third = readNormalized(['index'], data)!;
  expect(third.data).toEqual(data); expect(third.data).not.toBe(second.data); expect(parse).toHaveBeenCalledTimes(3);
  for (let n = 0; n < 4; n++) expect(evaluateRead(data, entry(data)).state).toBe('current');
  expect(parse).toHaveBeenCalledTimes(3); // Bool callers never refill the consumed output.
  expect(readNormalized(['index', null], data)).toBeUndefined();
});

test('an index a browser saved before a row fact existed is not restored, so the row is read afresh', () => {
  const saved = canonical() as unknown as { tasks: { rowFacts: Record<string, unknown> }[] };
  delete saved.tasks[0]!.rowFacts.runningRuns;
  expect(readNormalized(['index'], saved)).toBeUndefined();
});

test('a direct cold normalized call neither reparses nor retains its published result', () => {
  const data = canonical(), parse = vi.spyOn(projectedIndexSchema, 'safeParse');
  const first = readNormalized(['index'], data)!;
  expect(parse).toHaveBeenCalledTimes(1);
  (first.data as typeof data).tasks[0]!.title = 'DIRECT OUTPUT MUTATION';
  expect(readNormalized(['index'], data)?.data).toEqual(data);
  expect(parse).toHaveBeenCalledTimes(2);
  expect(evaluateRead(data, entry(data)).state).toBe('current'); expect(parse).toHaveBeenCalledTimes(2);
  const clone = structuredClone(data);
  expect(readNormalized(['index'], clone)?.data).toEqual(data); expect(parse).toHaveBeenCalledTimes(3);
});

test.each(['transform', 'default', 'order', 'null-prototype', 'strip'] as const)('noncanonical %s retains actual normalized semantics before and after one-use transfer', mode => {
  const data = canonical(), base = projectedIndexSchema.clone();
  if (mode === 'null-prototype') Object.setPrototypeOf(data, null);
  if (mode === 'strip') (data.tasks[0]!.usage = { runs: 1, runMs: 1, tokens: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, extra: 'TOKEN EXTRA' }, tokensUnknown: 0, extra: 'RAW EXTRA' } as typeof data.tasks[number]['usage']);
  const codec = mode === 'default' ? base.extend({ normalizedDefault: z.string().default('ACTUAL DEFAULT') })
    : mode === 'transform' ? base.transform(value => ({ ...value, rev: value.rev + 5 }))
    : mode === 'order' ? base.transform(({ rev, ...rest }) => ({ rev, ...rest })) : base;
  const expected = codec.parse(data), parse = installCodec(codec);
  expect(evaluateRead(data, entry(data)).state).toBe('current'); expect(parse).toHaveBeenCalledTimes(1);
  const first = readNormalized(['index'], data)!, second = readNormalized(['index'], data)!;
  expect(first.data).toEqual(expected); expect(second.data).toEqual(expected);
  expect(first.data).not.toBe(data); expect(second.data).not.toBe(first.data);
  if (mode === 'order') expect(Object.keys(second.data as object)[0]).toBe('rev');
  if (mode === 'null-prototype') expect(Object.getPrototypeOf(second.data)).not.toBeNull();
  expect(parse).toHaveBeenCalledTimes(2);
});

test('falsy codec output is actual normalized data, never a failure or a missing pending value', () => {
  for (const value of [false, null, 0, '', undefined]) {
    const data = canonical(), codec = projectedIndexSchema.clone().transform(() => value), parse = installCodec(codec);
    expect(evaluateRead(data, entry(data)).state).toBe('current');
    expect(readNormalized(['index'], data)).toEqual({ data: value }); expect(parse).toHaveBeenCalledTimes(1);
    expect(readNormalized(['index'], data)).toEqual({ data: value }); expect(parse).toHaveBeenCalledTimes(2);
    parse.mockRestore();
  }
});

test('one raw value has separate one-use outputs for separate complete semantic keys', () => {
  const index = canonical(); index.person.settings = 'settings-revision';
  const data = { values: {}, revision: index.person.settings };
  const firstKey = ['person-settings', index.root], otherKey = ['person-settings', index.root + '/other'];
  const parse = vi.spyOn(personalSettingsResponseSchema, 'safeParse');
  expect(evaluateRead(index, { key: firstKey, data, proof: captureReadProof(index, firstKey) }).state).toBe('current');
  expect(evaluateRead(index, { key: otherKey, data, proof: captureReadProof(index, otherKey) }).state).toBe('invalid');
  expect(parse).toHaveBeenCalledTimes(2); // Full-key structure is independent of current qualification.
  const first = readNormalized(firstKey, data)!, other = readNormalized(otherKey, data)!;
  expect(first.data).toEqual(data); expect(other.data).toEqual(data); expect(other.data).not.toBe(first.data);
  expect(parse).toHaveBeenCalledTimes(2);
  readNormalized(firstKey, data); expect(parse).toHaveBeenCalledTimes(3);
  readNormalized(otherKey, data); expect(parse).toHaveBeenCalledTimes(4);
});

test('a failed parse creates neither a structure proof nor a pending successful output', () => {
  const data = { ...canonical(), rev: -1 }, parse = vi.spyOn(projectedIndexSchema, 'safeParse');
  expect(evaluateRead(data, entry(data)).state).toBe('invalid');
  expect(readNormalized(['index'], data)).toBeUndefined();
  expect(parse).toHaveBeenCalledTimes(2);
});

test('normalization rejects hostile JSON input before the codec and preserves full-key qualification', () => {
  const data = canonical(), parse = vi.spyOn(projectedIndexSchema, 'safeParse'), getter = vi.fn(() => data.rev);
  for (const corrupt of [
    (value: any) => Object.defineProperty(value, 'rev', { get: getter, enumerable: true }),
    (value: any) => Object.setPrototypeOf(value, Object.create(null)),
    (value: any) => { value.tasks.length += 1; },
    (value: any) => { value.extra = value; },
    (value: any) => { value.rev = Infinity; },
  ]) {
    const raw = structuredClone(data); corrupt(raw); expect(readNormalized(['index'], raw)).toBeUndefined();
  }
  expect(getter).not.toHaveBeenCalled(); expect(parse).not.toHaveBeenCalled();
  const view = viewsOf(source()).find(item => item.task.id === 'T1')!;
  expect(readNormalized(['task', data.root, 'T1'], view)).toBeDefined();
  expect(readNormalized(['task', data.root, 'T2'], view)).toBeUndefined();
});

test('checkpoint contexts stay detached from the live index scope after taking a normalized output', () => {
  const data = canonical(), client = new QueryClient(); clients.push(client); receiveFullIndex(client, data);
  const live = readIndex(client)!;
  const normalized = readNormalized(['index'], live)!;
  expect(normalized.data).not.toBe(live);
  // A context that has moved on: it requires a later version of T1's view than the one read.
  const context = { ...normalized.data as typeof data, requiredPv: { ...data.requiredPv, view: { T1: 1 } } } as unknown as typeof data, another = { ...normalized.data as typeof data };
  expect(context).not.toBe(another); expect(context.tasks).not.toBe(live.tasks);
  const view = viewsOf(source()).find(item => item.task.id === 'T1')!;
  const key = ['task', live.root, 'T1'], read = { key, data: view, proof: captureReadProof(live, key) };
  cutReadScope(client);
  expect(evaluateRead(live, read)).toMatchObject({ state: 'unverified', persist: true });
  expect(evaluateRead(context, read)).toMatchObject({ state: 'obsolete', persist: false });
});

test('checkpoint normalization shares immutable JSON while mutable publication stays isolated', () => {
  const data = canonical(), parse = vi.spyOn(projectedIndexSchema, 'safeParse');
  const snapshot = readCheckpointIndex(data)!;
  expect(snapshot).toBe(data); expect(isReadDataImmutable(snapshot)).toBe(true);
  expect(readCheckpointIndex(data)).toBe(snapshot); expect(parse).toHaveBeenCalledTimes(1);
  const mutable = readNormalized(['index'], data)!.data as typeof data;
  mutable.tasks[0]!.title = 'MUTATED PUBLICATION';
  expect(readCheckpointIndex(data)).toBe(snapshot);
  expect(snapshot.tasks[0]!.title).toBe(data.tasks[0]!.title);
  expect(snapshot.tasks[0]!.title).not.toBe('MUTATED PUBLICATION');
  expect(parse).toHaveBeenCalledTimes(2);
});

test('checkpoint normalization preserves transformed values and does not reuse another codec output', () => {
  const data = canonical(), base = projectedIndexSchema.clone();
  const before = readCheckpointIndex(data)!;
  const parse = installCodec(base.transform(value => ({ ...value, root: 'normalized-other-root' })));
  const transformed = readCheckpointIndex(data)!;
  expect(transformed.root).toBe('normalized-other-root'); expect(data.root).toBe(before.root);
  expect(isReadDataImmutable(transformed)).toBe(true); expect(transformed.tasks).toBe(data.tasks);
  expect(readCheckpointIndex(data)).toBe(transformed); expect(parse).toHaveBeenCalledTimes(1);
  parse.mockRestore();
  expect(readCheckpointIndex(data)?.root).toBe(data.root);
});

test('a pending parse from the previous codec cannot supply a checkpoint snapshot', () => {
  const data = canonical(), base = projectedIndexSchema.clone();
  expect(evaluateRead(data, entry(data)).state).toBe('current');
  const parse = installCodec(base.transform(value => ({ ...value, root: 'normalized-after-pending' })));
  expect(readCheckpointIndex(data)?.root).toBe('normalized-after-pending');
  expect(parse).toHaveBeenCalledTimes(1);
});
