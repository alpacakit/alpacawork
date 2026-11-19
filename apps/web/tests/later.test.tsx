import { afterEach, expect, test, vi } from 'vitest';
import { later } from '../src/lib/later';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test('at the lowest priority where the browser has one', async () => {
  const postTask = vi.fn((work: () => void) => Promise.resolve().then(work));
  vi.stubGlobal('scheduler', { postTask });
  const work = vi.fn();
  later(work);
  expect(postTask).toHaveBeenCalledWith(work, { priority: 'background' });
  await vi.waitFor(() => expect(work).toHaveBeenCalledOnce());
});

test('without one: the next timer, or at once for work already in a task of its own', () => {
  vi.stubGlobal('scheduler', undefined);
  vi.useFakeTimers();
  const timed = vi.fn(), now = vi.fn();
  later(timed);
  expect(timed).not.toHaveBeenCalled();
  vi.advanceTimersByTime(0);
  expect(timed).toHaveBeenCalledOnce();
  later(now, { orNow: true });
  expect(now).toHaveBeenCalledOnce();
});

test('a failure in the work is reported, not lost', async () => {
  const report = vi.fn();
  vi.stubGlobal('reportError', report);
  vi.stubGlobal('scheduler', { postTask: (work: () => void) => Promise.resolve().then(work) });
  later(() => { throw new Error('broke'); });
  await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
});
