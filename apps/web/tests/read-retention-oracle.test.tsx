import { Buffer } from 'node:buffer';
import { hashKey } from '@tanstack/react-query';
import { expect, test } from 'vitest';
import { readSize } from '../src/data/read-retention';
import { selectRetainedReads } from './retained-reads';
import oracle from './read-retention-order-oracle.json';
import { retentionCase, RETENTION_CASES } from './read-retention-matrix';

test.each(RETENTION_CASES)('retention preserves selection, status, deadlines and current UTF-8 limits: %s', name => {
  const f = retentionCase(name), before = structuredClone(f.reads);
  const expected = oracle.expected[name as keyof typeof oracle.expected];
  const byHash = new Map(f.reads.map(read => [read.queryHash, read]));
  expect(byHash.size).toBe(f.reads.length);
  const reference = expected.queries.map(hash => {
    const read = byHash.get(hash);
    expect(read, `golden input ${hash}`).toBeDefined();
    return read!;
  });
  const bytes = Buffer.byteLength(JSON.stringify(f.record(reference)), 'utf8');
  const result = selectRetainedReads(f.reads, f.now, readSize(f.record([])), f.active);
  // An incomplete basis remains available with its exact missing read; real IDB tests cover writer qualification.
  if (name === 'required-missing') {
    const root = (f.reads.find(read => read.queryKey[0] === 'index')!.state.data as { root: string }).root;
    expect(result.absent).toEqual([hashKey(['person-notices', root])]);
    expect(result.queries).toEqual(f.reads);
    expect(result.unavailable).toBe(false); expect(result.partial).toBe(false);
    expect(readSize(f.record(result.queries))).toBe(Buffer.byteLength(JSON.stringify(f.record(f.reads)), 'utf8'));
    expect(f.reads).toEqual(before); return;
  }
  expect(result.absent).toEqual(name === 'empty-input' ? [hashKey(['index'])] : []);
  const { absent: _absent, ...selected } = result;
  const actual = { ...selected, missing: result.absent.length > 0, queries: result.queries.map(read => read.queryHash),
    expiresAt: Number.isFinite(result.expiresAt) ? result.expiresAt : null };
  expect(actual).toEqual(expected);
  expect(readSize(f.record(result.queries))).toBe(bytes);
  expect(f.reads).toEqual(before);
  if (name === 'bytes--1') expect(bytes).toBe(8 * 1024 * 1024 - 1);
  if (name === 'bytes-0') expect(bytes).toBe(8 * 1024 * 1024);
  if (name === 'bytes-1') expect(result.queries.some(read => read.queryKey[0] === 'task')).toBe(false);
});
