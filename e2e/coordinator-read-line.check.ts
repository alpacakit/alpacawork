import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect, open, openCoordinator, settleMotion } from './fixtures.ts';
import { clearReadCheckpoint } from './read-fixture.ts';
import { configureCoordinator, foldConversation } from './coordinator-fixture.ts';
import type { Runtime } from './server.ts';
import { INDEX_HEARTBEAT_MS } from '@alpacawork/contract/control';
import { SAMPLE_NOW } from './fixture/sample.ts';

// Opening reads every completed reply; folds and positions are presentation only.
test.use({ isolated: true });
const LONG = ['This is a long answer.', ...Array.from({ length: 40 }, (_, at) => `- ${at + 1}: A long answer used to check position while earlier history opens.`), '', 'This is the end of the answer.'].join('\n');
type Turn = { id: string; status: string; answeredAt: string | null; seen: boolean };
const turnsOf = async (page: Page, runtime: Runtime) => (await (await page.request.get(`${runtime.origin}/api/coordinator`)).json()).conversation.turns as Turn[];
const answers = async (page: Page, runtime: Runtime) => (await turnsOf(page, runtime)).map(turn => turn.answeredAt).filter((at): at is string => !!at);
/** Read through what is drawn: from its top (an opening on the dot starts below what else is unread) to its end. */
const readToEnd = async (page: Page) => {
  const box = await scroller(page).boundingBox();
  if (!box) throw Error('Conversation scroller is not visible');
  await toTop(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const finger = await page.evaluate(() => navigator.maxTouchPoints > 0);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (finger) {
      // Held still before it lifts, so no fling goes on past the strokes: each moves a known distance. A fling is the
      // likely reason this once left an answer unread on a busy screen (not reproduced); it reads through the same scroll handler.
      const x = box.x + box.width / 2, y = box.y + box.height * 0.8;
      const session = await page.context().newCDPSession(page);
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (const by of [60, 120, 180]) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - by }] });
      await page.waitForTimeout(150);
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await session.detach();
    } else await page.mouse.wheel(0, 200);
    await page.waitForTimeout(80);
    if (await scroller(page).evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight < 2)) return;
  }
  throw Error('Conversation did not reach its end');
};
const scroller = (page: Page) => page.locator('[data-coordinator-panel] [data-card-scroll], [data-coordinator-own-window] [data-card-scroll]').first();
const toTop = (page: Page) => scroller(page).evaluate(element => element.scrollTo({ top: 0 }));
const earlier = (page: Page) => page.locator('[data-earlier]');
const clickInSight = async (page: Page, button: Locator) => {
  await expect(button).toBeInViewport();
  const box = (await button.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};
/** Sends through serve's API, as another device would; each answered before the next. `long`: which (from 1) answer at length. */
async function send(page: Page, runtime: Runtime, text: string) {
  const { id } = (await (await page.request.get(`${runtime.origin}/api/coordinator`)).json()).conversation;
  const response = await page.request.post(`${runtime.origin}/api/coordinator/messages`, { data: { conversationId: id, id: crypto.randomUUID(), text, attachments: [] } });
  expect(response.ok()).toBe(true);
}
/** Polled often: an answer comes in moments, and expect.poll's own back-off would wait up to a second past each one. */
const answered = (page: Page, runtime: Runtime, count: number) => expect.poll(async () => (await answers(page, runtime)).length, { timeout: 20_000, intervals: [50] }).toBe(count);
async function seed(page: Page, runtime: Runtime, count: number, long: number[] = []) {
  configureCoordinator(runtime.root);
  const file = join(runtime.root, 'long-answer.md'); writeFileSync(file, LONG);
  await open(page, runtime, '?agent=1');
  for (let n = 1; n <= count; n++) {
    // A short answer is the fake's fixed words (markdown-answer), not its report of the run: that holds the workspace's
    // paths, as long as the temporary folder's, and could push an answer's end out of sight.
    await send(page, runtime, long.includes(n) ? `answer-from:${file}` : `markdown-answer number ${n}`);
    await answered(page, runtime, n);
  }
}
/** Server-owned read facts, as after another device has read the first n answers. */
async function readUpTo(page: Page, runtime: Runtime, n: number) {
  const response = await page.request.get(`${runtime.origin}/api/coordinator`);
  const conversation = (await response.json()).conversation;
  const seen = conversation.turns.filter((turn: Turn) => !!turn.answeredAt).slice(0, n).map((turn: Turn) => turn.id);
  if (seen.length) expect((await page.request.post(`${runtime.origin}/api/coordinator/read`, {
    data: { conversationId: conversation.id, seen },
  })).ok()).toBe(true);
  await open(page, runtime);
}
async function fold(page: Page) {
  await foldConversation(page);
  await expect(page.locator('[data-coordinator-panel]')).toHaveCount(0);
}

// useThreadPosition has one owner for both widths; a phone's finger reading is in the 390px case below.
test('reading during a delayed opening refresh keeps its position', async ({ page, runtime }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seed(page, runtime, 3, [2, 3]);
  // A checkpoint from seeding can still show the last turn running; opening on that short row exposes the
  // previous answer's end and reads it before the delayed-opening scenario starts. Prepare from the finished data.
  await clearReadCheckpoint(page);
  await readUpTo(page, runtime, 1);
  await openCoordinator(page); await settleMotion(page);
  // The completed history is read without opening its fold.
  await expect(earlier(page)).toContainText('2 earlier messages');
  await expect.poll(async () => (await turnsOf(page, runtime)).every(turn => turn.seen)).toBe(true);
  await fold(page);
  let release!: () => void, requests = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/coordinator', async route => { requests++; await held; await route.continue(); });
  try {
    await openCoordinator(page); await settleMotion(page);
    await expect.poll(() => requests).toBeGreaterThan(0);
    const box = (await scroller(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 240);
    await expect.poll(() => scroller(page).evaluate(element => element.scrollTop)).toBeGreaterThan(150);
    await page.waitForTimeout(300);
    const before = await scroller(page).evaluate(element => element.scrollTop);
    await page.waitForTimeout(2500);
    const response = page.waitForResponse(response => response.url().endsWith('/api/coordinator') && response.request().method() === 'GET');
    release();
    await (await response).finished(); await page.waitForTimeout(500);
    const after = await scroller(page).evaluate(element => element.scrollTop);
    await info.attach('delayed-opening-position', { body: JSON.stringify({ before, after }), contentType: 'application/json' });
    expect(Math.abs(after - before)).toBeLessThan(2);
    await expect(page.locator('[data-earlier]')).toHaveAttribute('data-earlier', 'folded');
  } finally { release(); }
});

test('a reply that comes while the conversation is open stays unread until the next input there (initial GET held)', async ({ page, runtime }) => {
  await seed(page, runtime, 1);
  let releaseFirstRead!: () => void;
  let firstReadStarted = false;
  const ready = new Promise<void>(resolve => { releaseFirstRead = resolve; });
  await page.route('**/api/coordinator', async route => {
    if (!new URL(route.request().frame().url()).searchParams.has('agent')) { firstReadStarted = true; await ready; }
    await route.continue();
  });
  try {
    await readUpTo(page, runtime, 1); await openCoordinator(page);
    await expect.poll(() => firstReadStarted).toBe(true);
  } finally { releaseFirstRead(); }
  await expect(page.locator('[data-coordinator-turn]')).toHaveCount(1);
  await settleMotion(page);
  let posted = 0; page.on('request', request => { if (new URL(request.url()).pathname === '/api/coordinator/read') posted++; });
  await send(page, runtime, 'markdown-answer arrives while nobody acts');
  // Sent by the API: nothing happens on the page while the reply arrives and is shown.
  await expect(page.locator('[data-ask-answer]')).toHaveCount(2, { timeout: 20_000 });
  await page.waitForTimeout(400);
  expect((await turnsOf(page, runtime)).at(-1)?.seen).toBe(false);
  expect(posted).toBe(0);
  await page.keyboard.press('Shift');
  await expect.poll(async () => (await turnsOf(page, runtime)).at(-1)?.seen).toBe(true);
  const count = posted;
  expect(count).toBeGreaterThan(0);
  await page.waitForTimeout(400);
  expect(posted).toBe(count); // Notification -> GET must not create a write cycle.
});

test('an agent view accepts real input and scrolling without writing any shared read facts', async ({ page, runtime }) => {
  await seed(page, runtime, 2, [2]);
  let posted = 0; page.on('request', request => { if (new URL(request.url()).pathname === '/api/coordinator/read') posted++; });
  await openCoordinator(page); await readToEnd(page); await page.keyboard.press('PageUp');
  expect((await turnsOf(page, runtime)).some(turn => turn.seen)).toBe(false);
  expect(posted).toBe(0);
});

test('an open conversation queues every folded reply while offline and resumes together', async ({ page, runtime }) => {
  await seed(page, runtime, 3, [2, 3]); await readUpTo(page, runtime, 1);
  let allowSave = false;
  await page.route('**/api/coordinator/read', route => allowSave ? route.continue() : route.abort('internetdisconnected'));
  await openCoordinator(page);
  await page.context().setOffline(true);
  // setOffline does not close an already-open SSE stream. Let the real feed owner detect
  // the missing heartbeat so reconnecting is an actual product transition, not a DOM event alone.
  await page.clock.setFixedTime(new Date(Date.parse(SAMPLE_NOW) + 2 * INDEX_HEARTBEAT_MS + 1_000));
  await page.clock.runFor(INDEX_HEARTBEAT_MS);
  await expect(page.locator('[data-offline-mark]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-progress-line="offline"]')).toBeVisible();
  await readToEnd(page);
  // A failed save has not acknowledged either folded history or the latest reply.
  expect((await turnsOf(page, runtime)).map(turn => turn.seen)).toEqual([true, false, false]);
  allowSave = true;
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => (await turnsOf(page, runtime)).every(turn => turn.seen), { timeout: 20_000 }).toBe(true);
});

test('a separate conversation window reads through its own input and document', async ({ page, runtime }) => {
  await seed(page, runtime, 2, [2]); await readUpTo(page, runtime, 1); await openCoordinator(page);
  const opened = page.context().waitForEvent('page');
  await page.getByRole('button', { name: 'Open in a separate window' }).click();
  const own = await opened;
  await expect(own.locator('[data-coordinator-own-window]')).toBeVisible();
  await readToEnd(own);
  await expect.poll(async () => (await turnsOf(page, runtime)).every(turn => turn.seen)).toBe(true);
  await own.close();
  await expect(page.locator('[data-coordinator-panel]')).toBeVisible();
});

// Playwright emulates focused tabs by default. This check runs separately with --headed under Xvfb, so a tab in the
// background is really out of sight: what comes meanwhile stays unread when the page is shown again (a tab before it
// may have closed by itself), until the next input there.
test('a background tab keeps a reply unread when shown again, until the next input there', async ({ page, runtime }, info) => {
  test.skip(info.project.use.headless !== false, 'Run --headed under Xvfb to exercise actual browser focus');
  const session = await page.context().newCDPSession(page);
  await seed(page, runtime, 1); await readUpTo(page, runtime, 1); await openCoordinator(page);
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  const other = await page.context().newPage();
  const otherSession = await page.context().newCDPSession(other);
  try {
    await other.goto('about:blank');
    await otherSession.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await other.bringToFront();
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
    await send(page, runtime, 'markdown-answer while the window is in the background');
    await expect.poll(async () => (await turnsOf(page, runtime)).length, { timeout: 20_000 }).toBe(2);
    await page.waitForTimeout(300);
    expect((await turnsOf(page, runtime)).at(-1)?.seen).toBe(false);
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    await page.waitForTimeout(300);
    expect((await turnsOf(page, runtime)).at(-1)?.seen).toBe(false);
    await page.keyboard.press('Shift');
    await expect.poll(async () => (await turnsOf(page, runtime)).at(-1)?.seen).toBe(true);
  } finally { await otherSession.detach(); await other.close(); await session.detach(); }
});

test('an initial load failure recovers to folded history whose replies are all read', async ({ page, runtime }) => {
  await seed(page, runtime, 3, [1, 2, 3]);
  // The seed visit may have saved a valid opening. This case requires a cold initial GET.
  await clearReadCheckpoint(page);
  let fail = true, failed = 0;
  await page.route('**/api/coordinator', async route => {
    if (fail) { failed++; await route.abort('internetdisconnected'); } else await route.continue();
  });
  await open(page, runtime); await openCoordinator(page);
  await expect.poll(() => failed).toBeGreaterThan(1);
  fail = false;
  // The existing read owner's bounded retry performs the recovery; the conversation stays open.
  await page.clock.runFor(4_100);
  await expect(earlier(page)).toContainText('2 earlier messages');
  await expect(page.locator('[data-coordinator-turn]')).toHaveCount(1);
  await expect.poll(async () => (await turnsOf(page, runtime)).every(turn => turn.seen)).toBe(true);
});

const endGap = (page: Page) => scroller(page).evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight);

test.describe('explicit sends and incoming answers share the reading position', () => {
  test.use({ fixedTime: false, writeGraceMs: 5000 });
  // The phone's sheet alone takes its room through React (CoordinatorCard's setFootSize); the position's owner has no width.
  test('own send moves immediately, incoming answers respect reading, closed stays closed (390px)', async ({ page, runtime }, info) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 900 });
    await seed(page, runtime, 3, [2, 3]);
    await readUpTo(page, runtime, 3);
    await openCoordinator(page); await settleMotion(page);
    const box = (await scroller(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 200);
    await expect.poll(() => scroller(page).evaluate(element => element.scrollTop)).toBeGreaterThan(150);
    const input = page.locator('[data-one-input]');
    await input.fill('markdown-answer OWN-LATEST');
    await page.locator('[data-coordinator-card] [data-ask-send]').click();
    // Before the five-second transport grace expires, the user's send already chooses the latest row.
    await expect.poll(() => endGap(page), { timeout: 2000 }).toBeLessThan(2);
    await expect(scroller(page).locator('[data-coordinator-local]')).toContainText('OWN-LATEST');
    const latestBeforeAnswer = await scroller(page).evaluate(element => element.scrollTop);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -240);
    await expect.poll(() => endGap(page)).toBeGreaterThan(150);
    await page.waitForTimeout(200);
    const reading = await scroller(page).evaluate(element => element.scrollTop);
    await answered(page, runtime, 4);
    // Drawn here: an answer that moved the reading would have done it by now.
    await expect(scroller(page).locator('[data-coordinator-turn]').filter({ hasText: 'OWN-LATEST' }).locator('[data-ask-answer]')).toHaveCount(1);
    await page.waitForTimeout(300);
    expect(Math.abs(await scroller(page).evaluate(element => element.scrollTop) - reading)).toBeLessThan(2);
    // Latest readers follow a new reply's full height, including completion after its running placeholder.
    await scroller(page).evaluate(element => { element.scrollTop = element.scrollHeight; });
    const gate = join(runtime.root, 'position-answer-now');
    await send(page, runtime, `wait:${gate}`);
    await expect(scroller(page).locator('[data-coordinator-turn=running]')).toHaveCount(1);
    await expect.poll(() => endGap(page)).toBeLessThan(2);
    writeFileSync(gate, '');
    await answered(page, runtime, 5);
    await expect.poll(() => endGap(page)).toBeLessThan(2);
    await info.attach('send-and-reading-position', { body: JSON.stringify({ latestBeforeAnswer, reading }), contentType: 'application/json' });
    await fold(page);
    const closedAt = await page.evaluate(() => scrollY);
    await input.fill('markdown-answer CLOSED-SEND');
    await page.locator('[data-coordinator-card] [data-ask-send]').click();
    // This checks serve's answer count, independently of the browser/Playwright transport being
    // used to draw the conversation. The original trace spent 15s receiving one stale APIRequest
    // response. Keep the same 20s/50ms bound, including send grace, and read the real HTTP owner.
    const deadline = performance.now() + 20_000;
    await expect.poll(async () => {
      const response = await fetch(`${runtime.origin}/api/coordinator`, {
        signal: AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now()))),
      });
      expect(response.ok).toBe(true);
      const { conversation } = await response.json();
      expect(performance.now()).toBeLessThanOrEqual(deadline);
      return conversation.turns.filter((turn: Turn) => !!turn.answeredAt).length;
    }, { timeout: 20_000, intervals: [50] }).toBe(6);
    // Told here (its notice says the answer): an answer that opened the conversation would have by now.
    await expect(page.locator('[data-coordinator-pill] [data-coordinator-unseen]')).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page.locator('[data-coordinator-panel]')).toHaveCount(0);
    expect(await page.evaluate(() => scrollY)).toBe(closedAt);
  });
});

const pressed = async (page: Page, state: string) => {
  await expect(page.locator(`[data-coordinator-pill-state=${state}]`)).toBeVisible();
  await page.locator('[data-coordinator-pill]').click();
  await expect(page.locator('[data-coordinator-panel]')).toBeVisible();
  // At work something pulses for as long as it works: no motion to wait out, only the opening's own.
  if (state === 'running') await page.waitForTimeout(500); else await settleMotion(page);
};
const top = (page: Page) => scroller(page).evaluate(element => element.scrollTop);

test('at work folded history is read too; the new answer moves nothing', async ({ page, runtime }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await seed(page, runtime, 3, [1, 2, 3]);
  await readUpTo(page, runtime, 1);
  const gate = join(runtime.root, 'at-work');
  await send(page, runtime, `wait:${gate}`);
  await pressed(page, 'running');
  await expect(page.locator('[data-coordinator-turn=running] [data-sent-message]')).toBeInViewport();
  await expect(page.locator('[data-coordinator-turn]')).toHaveCount(1);
  await expect(earlier(page)).toContainText('3 earlier messages');
  const before = await top(page);
  writeFileSync(gate, '');
  await answered(page, runtime, 4);
  await expect.poll(async () => (await turnsOf(page, runtime)).map(turn => turn.seen)).toEqual([true, true, true, false]);
  // The answer that came in while nobody acted is read by the next input.
  await page.keyboard.press('Shift');
  await expect.poll(async () => (await turnsOf(page, runtime)).map(turn => turn.seen)).toEqual([true, true, true, true]);
  await page.waitForTimeout(300);
  expect(await top(page)).toBe(before);
  await expect(earlier(page)).toContainText('3 earlier messages');
});

// At either width: closed/input-only leaves replies unread; opening reads all while preserving the history fold.
test.describe('send, answer, close and open again', () => {
  test.use({ fixedTime: false });
  for (const { width, height } of [{ width: 412, height: 915 }, { width: 1440, height: 900 }])
    test(`opening reads folded history, input alone stays unread, and another device synchronizes (${width}px)`, async ({ page, runtime }, info) => {
      test.setTimeout(60_000);
      await page.setViewportSize({ width, height });
      await seed(page, runtime, 2);
      await readUpTo(page, runtime, 2);
      await openCoordinator(page); await settleMotion(page);
      const input = page.locator('[data-one-input]');
      const sendHere = async (text: string) => { await input.fill(text); await page.locator('[data-coordinator-card] [data-ask-send]').click(); };
      await sendHere('markdown-answer IN-SIGHT');
      await answered(page, runtime, 3);
      // Shown, it is read by the next input on the page.
      await expect(page.locator('[data-coordinator-turn]').last()).toContainText('IN-SIGHT');
      await page.keyboard.press('Shift');
      await expect.poll(async () => (await turnsOf(page, runtime)).at(-1)?.seen).toBe(true);
      await page.screenshot({ path: info.outputPath(`1-answered-in-sight-${width}.png`) });
      // Two answers come while it is closed: the first folds, the latest stays shown.
      const gate = join(runtime.root, 'closed markdown-answer');
      await sendHere(`wait:${gate}`);
      await expect(page.locator('[data-coordinator-turn=running]')).toHaveCount(1);
      await fold(page);
      writeFileSync(gate, '');
      await answered(page, runtime, 4);
      await send(page, runtime, 'markdown-answer LATEST');
      await answered(page, runtime, 5);
      await expect(page.locator('[data-coordinator-pill] [data-coordinator-unseen]')).toBeVisible();
      expect((await turnsOf(page, runtime)).slice(-2).map(turn => turn.seen)).toEqual([false, false]);
      await openCoordinator(page); await settleMotion(page);
      await expect.poll(async () => (await turnsOf(page, runtime)).every(turn => turn.seen)).toBe(true);
      await expect(earlier(page)).toContainText('4 earlier messages');
      await expect(page.locator('[data-coordinator-turn]')).toHaveCount(1);
      await expect(page.locator('[data-coordinator-turn]')).toContainText('LATEST');
      await page.screenshot({ path: info.outputPath(`2-opened-folded-${width}.png`) });
      await toTop(page); await page.waitForTimeout(300);
      await clickInSight(page, earlier(page).locator('button')); await settleMotion(page);
      await expect(page.locator('[data-earlier]')).toHaveCount(0);
      await expect(page.locator('[data-coordinator-turn]')).toHaveCount(5);
      await page.screenshot({ path: info.outputPath(`3-opened-history-${width}.png`) });
      await fold(page);
      await input.fill('Draft only, do not send');
      await send(page, runtime, 'markdown-answer READ-ON-OTHER-DEVICE'); await answered(page, runtime, 6);
      await expect(page.locator('[data-coordinator-unseen]')).toBeVisible();
      expect((await turnsOf(page, runtime)).at(-1)?.seen).toBe(false);
      const otherContext = await page.context().browser()!.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
      try {
        const other = await otherContext.newPage();
        await open(other, runtime); await openCoordinator(other);
        await expect.poll(async () => (await turnsOf(page, runtime)).every(turn => turn.seen)).toBe(true);
        await expect(page.locator('[data-coordinator-unseen]')).toHaveCount(0);
        await expect(page.locator('[data-coordinator-panel]')).toHaveCount(0);
      } finally { await otherContext.close(); }
    });
});
