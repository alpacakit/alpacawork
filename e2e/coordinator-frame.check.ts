
import type { Page } from '@playwright/test';
import { test, expect, open, openCoordinator, settleMotion } from './fixtures.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commandFetch as fetch } from '../tests/helpers/command-fetch.ts';
import { configureCoordinator } from './coordinator-fixture.ts';

// On a computer the coordinator (its input and the conversation over it) is moved and sized as one, open or
// folded. What is kept is where the hand put it; what is drawn is that held inside the screen's working room.
test.use({ isolated: true, viewport: { width: 1280, height: 800 } });
const panel = (page: Page) => page.locator('[data-coordinator-panel]');
const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;
const kept = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('alpacawork.coordinatorFrame') ?? 'null'));

test('by the keys alone: the grip moves it, Alt sizes it and opens the conversation, and the focus stays on the grip', async ({ page, runtime }) => {
  configureCoordinator(runtime.root);
  await open(page, runtime, '?agent=1');
  const grip = page.locator('[data-frame-grip]');
  await grip.focus();
  const line = await box(page, '[data-coordinator-capsule]');
  await page.keyboard.press('ArrowLeft');
  expect(Math.round((await box(page, '[data-coordinator-capsule]')).x - line.x)).toBe(-16);
  // By the foot the conversation opens upward: Alt + ↑ opens it, and again makes it taller, on the grip it moved to.
  await page.keyboard.press('Alt+ArrowUp');
  await expect(panel(page)).toBeVisible(); await settleMotion(page);
  await expect(page.locator('[data-coordinator-panel] [data-frame-grip]')).toBeFocused();
  const before = (await panel(page).boundingBox())!.height;
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(async () => Math.round((await panel(page).boundingBox())!.height)).toBe(Math.round(before + 24));
  // Folded by Esc, the grip on the input takes the focus back; Home puts it back where it first stood.
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator('[data-coordinator-card] > [data-frame-grip]')).toBeFocused();
  await page.keyboard.press('Home');
  expect(await kept(page)).toBeNull();
});

// Following the end of a conversation of short exchanges, a hand sizing it (its height, or its width, which wraps the
// words anew) keeps the latest words where the pane draws them: each frame's new size is followed at once. A glide
// started on every frame drew the words where they had been, and they shook under the edge.
test('sized by its edges while following the end, the conversation does not glide on every frame', async ({ page, runtime }) => {
  configureCoordinator(runtime.root);
  const answers = { long: join(runtime.root, 'long-answer.md'), short: join(runtime.root, 'short-answer.md') };
  writeFileSync(answers.long, Array.from({ length: 40 }, (_, at) => `- ${at + 1}: one line of a long answer.`).join('\n'));
  writeFileSync(answers.short, 'T2 is waiting for its review; the invoices were compared with the ledger and two gaps are left to check.');
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    (window as any).glides = 0;
    Element.prototype.animate = function (...args: Parameters<typeof animate>) {
      if ((args[1] as KeyframeAnimationOptions | undefined)?.id === 'reading-glide') (window as any).glides++;
      return animate.apply(this, args);
    };
  });
  await open(page, runtime, '?agent=1');
  const { id } = (await (await fetch(`${runtime.origin}/api/coordinator`)).json()).conversation;
  const answered = async () => (await (await fetch(`${runtime.origin}/api/coordinator`)).json()).conversation.turns
    .filter((turn: { answeredAt: string | null }) => !!turn.answeredAt).length;
  const send = async (file: string, count: number) => {
    expect((await fetch(`${runtime.origin}/api/coordinator/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: id, id: crypto.randomUUID(), text: `answer-from:${file}`, attachments: [] }) })).ok).toBe(true);
    await expect.poll(answered, { timeout: 20_000 }).toBe(count);
  };
  await send(answers.long, 1);
  await open(page, runtime, '?agent=1');
  await openCoordinator(page); await settleMotion(page, undefined, true);
  // Short exchanges come in under it as it is read; read down to their end, it follows the end.
  for (let count = 2; count <= 5; count++) await send(answers.short, count);
  const area = panel(page).locator('[data-card-scroll]');
  await expect(area.locator('[data-coordinator-message]')).toHaveCount(5);
  await area.evaluate(el => el.scrollTo({ top: el.scrollHeight }));
  await settleMotion(page);
  for (const [edge, dx, dy] of [['far', 0, 6], ['right', -8, 0]] as const) {
    await page.evaluate(() => { (window as any).glides = 0; });
    const at = await box(page, `[data-frame-edge="${edge}"]`), x = at.x + at.width / 2, y = at.y + at.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    for (let step = 1; step <= 20; step++) { await page.mouse.move(x + dx * step, y + dy * step); await page.waitForTimeout(16); }
    await page.mouse.up();
    await settleMotion(page);
    expect(await page.evaluate(() => (window as any).glides), edge).toBe(0);
  }
});

// The room the page keeps under the coordinator (--coordinator-dock, on the page's root) is that of the height it
// rests at: a hand sizing the conversation, by a computer's far edge or a phone sheet's grip, moves no room behind it
// (each change restyled the whole page on every frame), and let go, even where it then rests, the room is that height's.
const dock = (page: Page) => page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--coordinator-dock')));
const covered = (page: Page) => panel(page).evaluate(el => Math.round(innerHeight - el.getBoundingClientRect().top));
for (const phone of [false, true]) test.describe(phone ? 'a phone sheet' : 'a computer frame', () => {
  if (phone) test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test(`held by the hand, the conversation's height moves no room behind it; let go, the room is the height it rests at${phone ? ' (phone)' : ''}`, async ({ page, runtime }) => {
    configureCoordinator(runtime.root);
    await open(page, runtime, '?agent=1');
    // Opening it starts the background warm-up, whose "Starting the coordinator" pulse lasts as long as that runs: what
    // is measured here is the frame's own finite motion, so the wait is for that (finiteOnly), the pulse ambient.
    await openCoordinator(page); await settleMotion(page, undefined, true);
    const rested = await dock(page), tall = (await panel(page).boundingBox())!.height;
    expect(Math.abs(rested - await covered(page))).toBeLessThanOrEqual(1);
    const at = await box(page, phone ? '[data-coordinator-panel] [data-sheet-grip]' : '[data-frame-edge="far"]');
    const x = at.x + at.width / 2, y = at.y + at.height / 2;
    const cdp = phone ? await page.context().newCDPSession(page) : null;
    const press = async (type: 'touchStart' | 'touchMove' | 'touchEnd', to: number) => cdp
      ? cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: to }] })
      : type === 'touchStart' ? (await page.mouse.move(x, to), page.mouse.down()) : type === 'touchEnd' ? page.mouse.up() : page.mouse.move(x, to);
    await press('touchStart', y);
    for (let by = 20; by <= 100; by += 20) await press('touchMove', y + by);
    // Held: it is drawn shorter, and the room behind it is still the one it rested at.
    await expect.poll(async () => Math.round(tall - (await panel(page).boundingBox())!.height)).toBe(100);
    expect(await dock(page)).toBe(rested);
    // Let go where it is held (still, so no flick): it rests at that height, and the room follows it once.
    await page.waitForTimeout(200);
    await press('touchEnd', y + 100);
    await settleMotion(page, undefined, true);
    await expect.poll(async () => Math.abs(await dock(page) - await covered(page))).toBeLessThanOrEqual(1);
    expect(Math.round(rested - await dock(page))).toBe(100);
  });
  // On a phone the foot stays under the finger, so held there the sheet grows twice the finger's way (the grip at
  // the top carries its edge, once); held, the sizing area takes the pressed step, and gives it back when let go.
  if (phone) test('from the foot the sheet sizes twice the finger\'s way, and its area shows it is held (phone)', async ({ page, runtime }) => {
    configureCoordinator(runtime.root);
    await open(page, runtime, '?agent=1');
    await openCoordinator(page); await settleMotion(page, undefined, true);
    const tall = (await panel(page).boundingBox())!.height, area = page.locator('[data-coordinator-size-area]');
    const at = (await area.boundingBox())!, x = at.x + at.width / 2, y = at.y + at.height / 2;
    const rest = await area.evaluate(element => getComputedStyle(element).backgroundColor);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let by = 10; by <= 50; by += 10) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - by }] });
    await expect.poll(async () => Math.round((await panel(page).boundingBox())!.height - tall)).toBe(100);
    expect(await area.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(rest);
    await page.waitForTimeout(200);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => area.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(rest);
  });
  // On a phone a press on the foot's sizing area that does not move says how it is sized, and sizes nothing; a tap on
  // the grip at the top says nothing.
  if (phone) test('a tap on the sizing area says how, over where it was tapped, and sizes nothing; the top grip stays quiet (phone)', async ({ page, runtime }) => {
    configureCoordinator(runtime.root);
    await open(page, runtime, '?agent=1');
    await openCoordinator(page); await settleMotion(page, undefined, true);
    const tall = (await panel(page).boundingBox())!.height;
    const hint = page.locator('[data-sheet-hint]');
    const grip = await box(page, '[data-coordinator-panel] [data-sheet-grip]');
    await page.touchscreen.tap(grip.x + grip.width / 2, grip.y + grip.height / 2);
    // The tip would show within a frame or two and leave on its own after seconds, so it is counted at once, not waited out.
    await page.waitForTimeout(300);
    expect(await hint.count()).toBe(0);
    const area = await box(page, '[data-coordinator-size-area]');
    await page.touchscreen.tap(area.x + area.width / 2, area.y + area.height / 2);
    await expect(hint).toHaveText('Drag to resize\nSwipe up for full screen, down to close');
    expect((await hint.boundingBox())!.y + (await hint.boundingBox())!.height).toBeLessThanOrEqual(area.y + area.height / 2);
    expect((await panel(page).boundingBox())!.height).toBe(tall);
  });
});
