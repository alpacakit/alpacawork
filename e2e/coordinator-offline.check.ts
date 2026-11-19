import type { BrowserContext, Page, Route } from '@playwright/test';
import { test as base, expect, open, openCoordinator } from './fixtures.ts';
import { configureCoordinator, readyCoordinator } from './coordinator-fixture.ts';
import { start } from './server.ts';
import { SAMPLE_NOW } from './fixture/sample.ts';
import { INDEX_HEARTBEAT_MS } from '@alpacawork/contract/control';

// With serve out of reach (the browser offline, the event stream cut, reconnecting) what is written stays the
// person's: the input takes typing, selecting, copying and pasting, and folds and opens; only sending waits, by the button
// and by Enter alike. Back in reach, nothing goes by itself; the person's own send sends it, once.
const test = base.extend({ runtime: async ({}, use) => {
  const runtime = await start(undefined, configureCoordinator);
  try { await use(runtime); } finally { await runtime.stop(); }
} });
test.use({ isolated: true, fixedTime: false });

const card = (page: Page) => page.locator('[data-coordinator-card]');
const field = (page: Page) => card(page).locator('[data-one-input]');
const sendButton = (page: Page) => card(page).locator('[data-ask-send]');
const thread = (page: Page) => page.locator('[data-coordinator-thread]');

/** The messages POSTed, counted as they leave the page. */
function posts(page: Page) {
  const bodies: { id: string; text: string }[] = [];
  void page.route('**/api/coordinator/messages', async (route: Route) => { bodies.push(JSON.parse(route.request().postData()!)); await route.continue(); });
  return bodies;
}
/** The three ways serve goes out of reach; each returns how it comes back. */
const losses = {
  offline: async (_page: Page, context: BrowserContext) => { await context.setOffline(true); return () => context.setOffline(false); },
  cut: async (page: Page) => {
    const cut = (route: Route) => route.abort('internetdisconnected');
    await page.route('**/api/events*', cut);
    return () => page.unroute('**/api/events*', cut);
  },
  // Every try waits unanswered: the line says it is reconnecting, not that it gave up.
  reconnecting: async (page: Page) => {
    const hang = () => {};
    await page.route('**/api/events*', hang);
    return () => page.unroute('**/api/events*', hang);
  },
};
// A route only intercepts the next request, never bytes on the already-open stream.
// Lose those bytes at the fetch boundary too; no connection/store state is fabricated.
declare global {
  interface Window { __offlineStream: { silent: boolean; delivered: number; dropped: number } }
}
test.beforeEach(async ({ page }) => {
  // Date and interval timers must advance together, including after a late chunk or a new try.
  await page.clock.install({ time: new Date(SAMPLE_NOW) });
  await page.addInitScript(() => {
    const stream = window.__offlineStream = { silent: false, delivered: 0, dropped: 0 };
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (!response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) return response;
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (stream.silent) { stream.dropped++; return; }
          stream.delivered++;
          controller.enqueue(chunk);
        },
      }));
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
  });
});
const disconnected = (page: Page) => expect(page.locator('[data-progress-line]'))
  .toHaveAttribute('data-progress-line', 'offline', { timeout: 20_000 });
/** Serve goes out of reach: the open stream falls silent past its limit, and each new try meets the loss. */
async function lose(page: Page, how: keyof typeof losses) {
  const back = await losses[how](page, page.context());
  await page.evaluate(() => { window.__offlineStream.silent = true; });
  // Establish actual silence past the existing limit, then give the existing watch its original two intervals.
  await page.clock.runFor(2 * INDEX_HEARTBEAT_MS + 1000);
  await page.clock.runFor(INDEX_HEARTBEAT_MS);
  if (how === 'offline') {
    // The bar's one mark and the grey line say it, whatever is on screen.
    await expect(page.locator('[data-offline-mark]')).toBeVisible({ timeout: 20_000 });
    await disconnected(page);
  } else await disconnected(page);
  return async () => {
    await page.evaluate(() => { window.__offlineStream.silent = false; });
    await back();
    // Back online, the page tries again at once (as the browser's online event has it).
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
  };
}

test('what is written while out of reach is kept over a reload; a send lost on the way stays unknown, the input stays writable, and only the person resends it', async ({ page, runtime }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: runtime.origin });
  const bodies = posts(page);
  await open(page, runtime, '?agent=1');
  // Prepare before the panel starts its own warm-up, so fixture and UI do not launch it together.
  await readyCoordinator(page, runtime);
  await openCoordinator(page);
  await field(page).click();
  await page.keyboard.insertText('Before');
  const back = await lose(page, 'cut');
  await page.keyboard.insertText('・After');
  // A text long enough to be attached is kept as text while nothing can be attached, not lost.
  const long = 'x'.repeat(10_001);
  await page.evaluate(text => navigator.clipboard.writeText(text), long);
  await page.keyboard.press('ControlOrMeta+V');
  await expect.poll(async () => (await field(page).textContent())?.length).toBe('Before・After'.length + long.length);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('Before・After');
  await expect(field(page)).toHaveText('Before・After');
  await back();
  await page.reload();
  await openCoordinator(page);
  await expect(field(page)).toHaveText('Before・After');
  expect(bodies).toHaveLength(0);

  // The send itself is lost on the way: it stays in the conversation, unknown (coordinator-send.check.ts), and the input
  // is empty and writable for what comes next, its sending held until that one is settled.
  let cut = true;
  await page.route('**/api/coordinator/messages', async route => {
    if (!cut) return route.fallback();
    bodies.push(JSON.parse(route.request().postData()!));
    await route.abort('internetdisconnected');
  });
  await field(page).click();
  await field(page).press('Enter');
  await expect(thread(page).locator('[data-coordinator-local=unknown]')).toContainText('Before・After');
  await expect(field(page)).toHaveAttribute('contenteditable', 'true');
  await field(page).click();
  await page.keyboard.insertText('Next');
  // Local submission remains available; delivery cannot overtake the unknown request.
  await expect(sendButton(page)).toBeEnabled(); expect(bodies).toHaveLength(1);
  // Out of reach again: still writable; resending needs serve and waits.
  const backAgain = await lose(page, 'cut');
  await page.keyboard.insertText('・Disconnected');
  await expect(thread(page).locator('[data-coordinator-resend]')).toBeDisabled();
  cut = false;
  await backAgain();
  await expect(page.locator('[data-progress-line]')).toHaveCount(0, { timeout: 30_000 });
  await page.waitForTimeout(500);
  expect(bodies).toHaveLength(1);
  // The person's resend sends it, as it was, under its ID; what is written meanwhile stays.
  await thread(page).locator('[data-coordinator-resend]').click();
  await expect(thread(page).locator('[data-coordinator-turn=succeeded]').getByText('Before・After', { exact: true })).toHaveCount(1);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]!.id).toBe(bodies[0]!.id);
  await expect(field(page)).toHaveText('Next・Disconnected');
});
