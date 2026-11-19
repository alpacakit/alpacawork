import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { createApi } from '../src/data/client';
import { requestsPending, trackedFetch } from '../src/data/request-activity';

afterEach(() => { expect(requestsPending()).toBe(false); vi.restoreAllMocks(); });

test('the JSON adapter stays busy through a delayed response body, then releases the idle lane', async () => {
  let deliver!: () => void;
  const response = new Response('{}');
  const decode = vi.spyOn(response, 'json').mockImplementation(() => new Promise(resolve => { deliver = () => resolve({ latest: true }); }));
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
  const reading = createApi().request('outside-query-cache', z.object({ latest: z.boolean() }));
  await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce()); expect(requestsPending()).toBe(true);
  deliver(); await expect(reading).resolves.toEqual({ latest: true });
  expect(requestsPending()).toBe(false);
});

test.each(['network', 'abort', 'decode'] as const)('%s failures release the finite HTTP activity', async failure => {
  const controller = new AbortController();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    if (failure === 'decode') return new Response('{');
    if (failure === 'abort') { controller.abort(); throw new DOMException('Stopped', 'AbortError'); }
    throw new TypeError('offline');
  });
  await expect(createApi().request('fail', z.object({}), controller.signal)).rejects.toBeInstanceOf(Error);
  expect(requestsPending()).toBe(false);
});

test('finishing one raw HTTP request cannot release another outstanding flight', async () => {
  const finish: ((value: Response) => void)[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => finish.push(resolve)));
  const one = trackedFetch('/one'), two = trackedFetch('/two');
  expect(requestsPending()).toBe(true);
  finish[0]!(new Response('one')); await one; expect(requestsPending()).toBe(true);
  finish[1]!(new Response('two')); await two; expect(requestsPending()).toBe(false);
});
