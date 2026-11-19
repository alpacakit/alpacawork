/** SSE data deadlines span comments and partial chunks, rather than resetting after each read. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openIndexStream } from './index-stream.ts';

test('SSE comments keep the connection live but cannot renew the next data event deadline', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  let source!: ReadableStreamDefaultController<Uint8Array>, cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; }, cancel() { cancelled = true; } });
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { status: 200 }));
  const stream = await openIndexStream(new URL('http://fixture.invalid/api/events'), new AbortController().signal, {}, 50);
  let outcome: unknown;
  const waiting = stream.event().then(value => { outcome = value; }, error => { outcome = error; });
  const flush = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };
  try {
    await flush();
    for (let at = 0; at < 3; at++) {
      source.enqueue(new TextEncoder().encode(': collector heartbeat\n\n'));
      await flush();
      if (at < 2) t.mock.timers.tick(20);
    }
    assert.equal(outcome, undefined, 'comments are not data events');
    t.mock.timers.tick(11);
    await flush();
    assert.ok(outcome instanceof assert.AssertionError, 'the original 50 ms data deadline expires despite fresh comments');
    assert.match(outcome.message, /no event from \/api\/events within 50 ms/);
    assert.equal(cancelled, true, 'an expired event closes the reader');
  } finally {
    if (!cancelled) source.close();
    await waiting;
  }
});
