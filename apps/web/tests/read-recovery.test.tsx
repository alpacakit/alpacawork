import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { i18n, startI18n } from '@alpacawork/i18n';
import { ApiError, createApi, DeadlinePassed, readDeadlinePassed } from '../src/data/client';
import { queryClient } from '../src/data/query-client';

beforeAll(async () => { startI18n(); await i18n.changeLanguage('en'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); queryClient.clear(); });

const schema = z.object({ ok: z.literal(true) });
/**
 * The real deadline's place, under this test's hand. What is read of a request is stopped as Chromium stops it: with an
 * AbortError from `json()` and readers, whatever the deadline's own reason (`AbortSignal.any` makes `text()` say so too).
 */
function deadlineHeld() {
  const controller = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  return { pass: () => controller.abort(new DOMException('signal timed out', 'TimeoutError')) };
}
type Asked = { signal: AbortSignal };
const stopped = ({ signal }: Asked) => new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('The user aborted a request.', 'AbortError')), { once: true }));
/** Headers arrived and the body stops part of the way. */
const stalled = (asked: Asked) => ({ ok: true, headers: new Headers(), json: () => stopped(asked), text: () => stopped(asked),
  body: { getReader: () => ({ read: () => stopped(asked), cancel: async () => {}, releaseLock() {} }) } });
const reads = {
  request: (signal?: AbortSignal) => createApi().request('x', schema, signal),
  requestText: (signal?: AbortSignal) => createApi().requestText('/x', signal),
  requestBytes: (signal?: AbortSignal) => createApi().requestBytes('/x', 100, signal),
};

for (const [name, read] of Object.entries(reads)) for (const caller of [false, true]) for (const phase of ['before the answer began', 'with the body part of the way'])
  test(`${name}, ${caller ? 'with' : 'without'} a caller's signal: a deadline ${phase} is no answer, whatever the browser calls it`, async () => {
    const { pass } = deadlineHeld();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, asked: Asked) => {
      if (phase.startsWith('before')) return stopped(asked);
      setTimeout(pass, 0);
      return stalled(asked);
    }));
    if (phase.startsWith('before')) setTimeout(pass, 0);
    const failure = await read(caller ? new AbortController().signal : undefined).catch(error => error as ApiError);
    expect(failure).toBeInstanceOf(DeadlinePassed);
    expect(failure).toMatchObject({ code: 'network_error', retry: 'later' });
    expect(readDeadlinePassed(failure)).toBe(true);
    expect((failure as ApiError).cause).toMatchObject({ name: 'AbortError' });
  });

test('a caller that gave up hears its own abort, not a deadline', async () => {
  deadlineHeld();
  const leaving = new AbortController();
  vi.stubGlobal('fetch', vi.fn(async (_url: string, asked: Asked) => { setTimeout(() => leaving.abort(), 0); return stopped(asked); }));
  const before = await reads.request(leaving.signal).catch(error => error);
  expect(before).not.toBeInstanceOf(ApiError);
  expect(before).toMatchObject({ name: 'AbortError' });
});

test('a name alone says nothing: a failure named so before this deadline passed is not one', async () => {
  deadlineHeld();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('elsewhere', 'TimeoutError'); }));
  const atOnce = await reads.request().catch(error => error);
  expect(atOnce).toMatchObject({ code: 'network_error', retry: 'later' });
  expect(readDeadlinePassed(atOnce)).toBe(false);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, headers: new Headers(), json: async () => { throw new DOMException('broken', 'AbortError'); } })));
  const broken = await reads.request().catch(error => error);
  expect(broken).toMatchObject({ code: 'invalid_response', retry: 'later' });
  expect(readDeadlinePassed(broken)).toBe(false);
});

test('an answer that arrived whole and cannot be read stays the wrong format, and is not asked again', async () => {
  for (const body of ['{"ok"', '{"ok":false}']) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    const error = await createApi().request('x', schema).catch(error => error as ApiError);
    expect(error).toMatchObject({ code: 'invalid_response', retry: 'later' });
    expect(readDeadlinePassed(error)).toBe(false);
  }
});

test('only a read past its deadline is asked again: what failed at once, or what the server said, stands', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
  const refused = await createApi().request('x', schema).catch(error => error as ApiError);
  expect(refused).toMatchObject({ code: 'network_error', retry: 'later' });
  expect(readDeadlinePassed(refused)).toBe(false);
  for (const code of ['unavailable', 'forbidden', 'not_found', 'invalid_response']) expect(readDeadlinePassed(new ApiError(code, code, 'later'))).toBe(false);
  expect(readDeadlinePassed(new Error('a fault here'))).toBe(false);
});

const passed = () => new DeadlinePassed(new DOMException('aborted', 'AbortError'));
test('a read asks again by itself and shows no failure while it can recover, then says its failure', async () => {
  // Query's own waits, shortened; the count is the default's.
  const client = new QueryClient({ defaultOptions: { queries: { ...queryClient.getDefaultOptions().queries, retryDelay: 1 } } });
  let asked = 0;
  await expect(client.fetchQuery({ queryKey: ['recovers'], queryFn: async () => { if (++asked < 3) throw passed(); return 'read'; } })).resolves.toBe('read');
  expect(asked).toBe(3);
  asked = 0;
  await expect(client.fetchQuery({ queryKey: ['stays'], queryFn: async () => { asked++; throw passed(); } })).rejects.toMatchObject({ code: 'network_error' });
  expect(asked).toBe(4);
  asked = 0;
  await expect(client.fetchQuery({ queryKey: ['refused'], queryFn: async () => { asked++; throw new ApiError('no', 'forbidden', 'fix'); } })).rejects.toMatchObject({ code: 'forbidden' });
  expect(asked).toBe(1);
});
