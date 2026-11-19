import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ApiError } from '../src/data/client';
import { intentKey, watchNewWriteConfirmation, submitWriteIntent, checkWriteIntent, useWriteIntentStore } from '../src/data/write-intent';
import { receiveFullIndex } from '../src/data/resources';
import { queryClient } from '../src/data/query-client';
import { indexOf, tree } from './fixtures';

beforeEach(() => receiveFullIndex(queryClient, indexOf(tree())));
afterEach(() => queryClient.clear());

const key = intentKey('/fixture', 'archive', 'P100');
test('synchronous confirmation is followed exactly once and duplicate presses admit only one operation', async () => {
  const confirmed = vi.fn(), send = vi.fn().mockResolvedValue('saved');
  const observer = watchNewWriteConfirmation(key, confirmed);
  try {
    const first = submitWriteIntent(key, () => ({ task: 'P100' }), send)!;
    expect(submitWriteIntent(key, () => ({ task: 'P100' }), send)).toBeUndefined();
    await first;
    observer.check(); observer.check();
    expect(confirmed).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  } finally { observer.stop(); }
});

test.each(['pending', 'unconfirmed', 'confirmed'] as const)('a pre-existing %s operation never grants a later subscription confirmation rights', async status => {
  let settle!: () => void;
  const pending = submitWriteIntent(key, () => ({ task: 'P100' }), () => new Promise<void>(resolve => { settle = resolve; }))!;
  const entry = useWriteIntentStore.getState().entries[key]!;
  useWriteIntentStore.setState({ entries: { [key]: { ...entry, status } } });
  const confirmed = vi.fn(), observer = watchNewWriteConfirmation(key, confirmed);
  try {
    if (status === 'unconfirmed') await checkWriteIntent(key, async () => undefined);
    settle(); await pending; observer.check();
    expect(confirmed).not.toHaveBeenCalled();
  } finally { observer.stop(); }
});

test('a new subscription cannot adopt an old operation through a new Check attempt; the original subscriber still ends', async () => {
  const original = vi.fn(), later = vi.fn();
  const a = watchNewWriteConfirmation(key, original);
  let b: ReturnType<typeof watchNewWriteConfirmation> | undefined;
  try {
    await submitWriteIntent(key, () => ({ task: 'P100' }), async () => { throw new ApiError('Unknown', 'fixture', 'check'); })?.catch(() => {});
    b = watchNewWriteConfirmation(key, later);
    const before = useWriteIntentStore.getState().entries[key]!;
    await checkWriteIntent(key, async () => undefined);
    const after = useWriteIntentStore.getState().entries[key]!;
    expect(after.operationId).toBe(before.operationId);
    expect(after.attempt).not.toBe(before.attempt);
    expect(original).toHaveBeenCalledTimes(1);
    expect(later).not.toHaveBeenCalled();
  } finally { a.stop(); b?.stop(); }
});
