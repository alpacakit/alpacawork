import { describe, expect, test } from 'vitest';
import { dehydrate, hashKey, hydrate, QueryClient, type DehydratedState } from '@tanstack/react-query';
import { configureReadRetention, READ_MAX_BYTES } from '../src/data/read-model';
import { readDataSize, readSize } from '../src/data/read-retention';
import { selectRetainedReads } from './retained-reads';
import { dto, indexOf, tree } from './fixtures';
function fixture(n = 1, body = 'body') {
  const client = new QueryClient(); configureReadRetention(client);
  const index = indexOf(tree({ tasks: [dto()] }));
  client.setQueryData(['index'], index);
  client.setQueryData(['person-settings', index.root], { values: {}, revision: index.person.settings });
  client.setQueryData(['person-notices', index.root], { state: null, revision: index.person.notices });
  for (let at = 1; at <= n; at++) client.setQueryData(['task', index.root, 'T' + at], { task: { id: 'T' + at, body } });
  const reads = dehydrate(client).queries.map((read, at) => ({ ...read, meta: { readUsedAt: Date.now() + at } }));
  const record = (queries: DehydratedState['queries']) => ({ snapshot: { mutations: [], queries } });
  return { client, index, reads, record };
}
describe('pure disk selection; memory lifetime has its own controller', () => {
  test('payload and envelope sizes equal actual JSON UTF8, including omission and escaped text', () => {
    const record = (data: unknown) => ({ key: ['task', '/😀', 'T1'], query: { state: { data, status: 'success' } } });
    for (const data of [undefined, null, false, 0, '', '日本語 😀\n"\\', [], { body: '日本語 😀\n"\\', rows: [1, null] }]) {
      expect(readDataSize(data, record)).toBe(readSize(record(data)));
    }
    const data = { body: 'before' };
    expect(readDataSize(data, record)).toBe(readSize(record(data)));
    data.body = 'after 😀';
    expect(readDataSize(data, record)).toBe(readSize(record(data)));
  });
  test('101 optional Tasks retain 100 complete Task/History groups without memory mutation', () => {
    const { client, index, reads, record } = fixture(101);
    const first = reads.find(read => read.queryKey[2] === 'T1')!;
    const history = { ...first, queryKey: ['task-history', index.root, 'T1'], queryHash: 'history' };
    const result = selectRetainedReads([...reads, history], Date.now(), readSize(record([])));
    expect(result.queries.filter(read => read.queryKey[0] === 'task')).toHaveLength(100);
    expect(result.queries).not.toContain(first); expect(result.queries).not.toContain(history);
    expect(client.getQueryData(first.queryKey)).toBeDefined(); client.clear();
  });
  test('huge active optional group is omitted without pushing out any mandatory basis read', () => {
    const { client, reads, record } = fixture(1, 'x'.repeat(READ_MAX_BYTES));
    const detail = reads.find(read => read.queryKey[0] === 'task')!;
    const result = selectRetainedReads(reads, Date.now(), readSize(record([])), new Set([detail.queryHash]));
    expect(result.queries).toEqual(reads.filter(read => read !== detail));
    expect(result.partial).toBe(true); expect(result.unavailable).toBe(false);
    expect(client.getQueryData(detail.queryKey)).toBeDefined(); client.clear();
  });
  test('missing required person or extracts is distinct from oversized mandatory basis', () => {
    const { client, reads, record } = fixture();
    expect(selectRetainedReads(reads.filter(read => read.queryKey[0] !== 'person-notices'), Date.now(), readSize(record([])))).toMatchObject({ absent: [hashKey(reads.find(read => read.queryKey[0] === 'person-notices')!.queryKey)], unavailable: false });
    const huge = reads.map((read, i) => i ? read : { ...read, state: { ...read.state, data: { ...(read.state.data as object), errors: [{ message: 'x'.repeat(READ_MAX_BYTES) }] } } });
    expect(selectRetainedReads(huge, Date.now(), readSize(record([])))).toMatchObject({ absent: [], unavailable: true, queries: [] });
    client.clear();
  });
  test('serialized adapter accounts for the complete 8MiB envelope', () => {
    const { client, reads, record } = fixture(1);
    const optional = reads.find(read => read.queryKey[0] === 'task')!;
    const basis = reads.filter(read => read !== optional);
    const qualified = (queries: typeof reads) => record(queries);
    const envelope = readSize(qualified([]));
    const gap = READ_MAX_BYTES - readSize(qualified(basis));
    const exact = basis.map((read, at) => at ? read : { ...read, state: { ...read.state, data: { ...(read.state.data as object), padding: 'x'.repeat(gap - 13) } } });
    expect(readSize(qualified(exact))).toBe(READ_MAX_BYTES);
    expect(selectRetainedReads(exact, Date.now(), envelope, new Set()).unavailable).toBe(false);
    const over = exact.map((read, at) => at ? read : { ...read, state: { ...read.state, data: { ...(read.state.data as object), padding: 'x'.repeat(gap - 12) } } });
    expect(readSize(qualified(over))).toBe(READ_MAX_BYTES + 1);
    expect(selectRetainedReads(over, Date.now(), envelope, new Set()).unavailable).toBe(true);
    const fullGap = READ_MAX_BYTES - readSize(qualified(reads));
    const full = reads.map(read => read !== optional ? read : { ...read, state: { ...read.state, data: { ...(read.state.data as object), padding: 'x'.repeat(fullGap - 13) } } });
    expect(readSize(qualified(full))).toBe(READ_MAX_BYTES);
    expect(selectRetainedReads(full, Date.now(), envelope, new Set()).queries).toHaveLength(full.length);
    const fullOver = full.map(read => read.queryKey[0] !== 'task' ? read : { ...read, state: { ...read.state, data: { ...(read.state.data as { padding: string }), padding: (read.state.data as { padding: string }).padding + 'x' } } });
    expect(selectRetainedReads(fullOver, Date.now(), envelope, new Set()).queries).toHaveLength(basis.length);
    client.clear();
  });
  test('managed native single-Query GC stays off after standard hydrate; finite group controller is tested through real timers', () => {
    const { client, reads, index } = fixture(); const restored = new QueryClient(); configureReadRetention(restored);
    hydrate(restored, { mutations: [], queries: reads });
    expect(restored.getQueryCache().find({ queryKey: ['task', index.root, 'T1'] })!.gcTime).toBe(Infinity);
    expect(restored.getQueryData(['index'])).toBe(reads[0]!.state.data);
    restored.clear(); client.clear();
  });
});
