/** The browser readiness helper's deadlines need HTTP, not a renderer. Real agent/UI controls remain in E2E. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { request as playwrightRequest, type Page, type Request } from '@playwright/test';
import { coordinatorCompleted } from '../e2e/coordinator-completion.ts';
import type { Runtime } from '../e2e/server.ts';

const input = { conversationId: 'deadline-conversation', id: 'deadline-message', text: 'held-admission', attachments: [] };
const terminal = { id: input.conversationId, nextLaunch: null, busy: false, earlier: null, resets: [], context: null, autoReset: { tokens: 200_000, percent: 50 }, turns: [{
  id: input.id, at: '2026-10-16T00:00:00Z', ask: input.text, attachments: [], status: 'succeeded', waiting: false,
  answer: 'Imported', seen: false, answeredAt: '2026-10-16T00:00:01Z', error: null, result: { writes: [], refused: [] },
}] };
async function fixture(t: TestContext) {
  let holdRead = false, entered!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  const server = createServer((req, res) => {
    if (req.url === '/api/coordinator' && holdRead) { entered(); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ root: '/fixture', generation: 'a', revision: 'a'.repeat(64), conversation: terminal }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const api = await playwrightRequest.newContext();
  t.after(async () => { await api.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const admission = await api.post(origin + '/api/coordinator/messages', { data: input });
  assert.equal(admission.ok(), true);
  return { page: { request: api } as Page, runtime: { origin } as Runtime,
    admitted: { postDataJSON: () => input, response: async () => admission } as unknown as Request,
    hold: () => { holdRead = true; }, arrived };
}

test('a held admission response consumes the same completion deadline', async t => {
  const h = await fixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = { ...h.admitted, response: async () => { await gate; return h.admitted.response(); } } as Request;
  try {
    await assert.rejects(coordinatorCompleted(h.page, h.runtime, held, 250), (failure: Error) => {
      assert.match(failure.message, /deadline-message/);
      assert.match((failure.cause as Error).message, /admission/); return true;
    });
  } finally { release(); }
  const completed = await coordinatorCompleted(h.page, h.runtime, held);
  assert.equal(completed.id, input.id); assert.equal(completed.status, 'succeeded');
});

test('a held API read is cancelled by the remaining completion deadline', async t => {
  const h = await fixture(t);
  assert.equal((await coordinatorCompleted(h.page, h.runtime, h.admitted)).id, input.id);
  h.hold();
  const checked = coordinatorCompleted(h.page, h.runtime, h.admitted, 250).then(() => undefined, error => error as Error);
  await h.arrived;
  const failure = await checked;
  assert.ok(failure); assert.match(failure.message, /deadline-message/); assert.match((failure.cause as Error).message, /Timeout/);
});
