import { createHash } from 'node:crypto';
import { coordinatorMessageDigest } from '@alpacawork/contract/coordinator';
import { test, expect, open, openCoordinator, settleMotion } from './fixtures.ts';

/** A conversation 400 older messages long behind its 20 recent ones, served by the page as serve does, 50 a page. */
const older = 400;
const ask = (i: number) => `Request ${i}: how is T2 going?`;
const turn = (i: number) => ({ id: `turn-${i}`, at: new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString(), ask: ask(i),
  inputDigest: coordinatorMessageDigest({ conversationId: 'history', id: `turn-${i}`, text: ask(i), attachments: [] }),
  attachments: [], status: 'succeeded', waiting: false, seen: true, error: null, result: null,
  answer: `Answer ${i}. T2 is waiting for its review.\n\n- One point\n- Another point`, answeredAt: new Date(Date.UTC(2026, 9, 1) + i * 60_000 + 30_000).toISOString() });
// The latest answer is long: the screen is then sized so that the thread is a little taller than its area, where a
// reading a little short of its end is still taken for following the end.
const latest = { ...turn(older + 19), answer: Array.from({ length: 30 }, (_, n) => `Line ${n + 1} of the latest answer.`).join('\n\n') };
const conversation = { id: 'history', nextLaunch: { agent: 'claude', values: {} }, busy: false, resets: [], context: null,
  autoReset: { tokens: 200_000, percent: 50 }, earlier: { count: older, before: `turn-${older}` },
  turns: [...Array.from({ length: 19 }, (_, n) => turn(older + n)), latest] };

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
test('the history opens in place and is read back a page at a time as the reader nears its top, up to the limit', async ({ page, runtime }) => {
  test.setTimeout(120_000);
  const pages: string[] = [];
  await page.route('**/api/coordinator', async route => {
    const reply = await route.fetch();
    await route.fulfill({ response: reply, json: { ...await reply.json(), conversation, revision: createHash('sha256').update(JSON.stringify(conversation)).digest('hex') } });
  });
  await page.route('**/api/coordinator/turns?*', async route => {
    const before = new URL(route.request().url()).searchParams.get('before')!, end = Number(before.slice('turn-'.length)), start = Math.max(0, end - 50);
    pages.push(before);
    await route.fulfill({ json: { turns: Array.from({ length: end - start }, (_, n) => turn(start + n)), resets: [], more: start > 0 ? `turn-${start}` : null } });
  });
  // Every glide of the reading, as it starts.
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    (window as any).glides = 0;
    Element.prototype.animate = function (...args: Parameters<typeof animate>) {
      if ((args[1] as KeyframeAnimationOptions | undefined)?.id === 'reading-glide') (window as any).glides++;
      return animate.apply(this, args);
    };
  });
  await open(page, runtime);
  await openCoordinator(page); await settleMotion(page);
  const entrance = page.locator('[data-earlier]'), area = page.locator('[data-coordinator-panel] [data-card-scroll]');
  await expect(entrance).toHaveAttribute('data-earlier', 'folded');
  // Taller than its area by about 20px.
  const over = () => area.evaluate(el => el.scrollHeight - el.clientHeight);
  for (let tries = 0; tries < 6 && Math.abs(await over() - 20) > 5; tries++) {
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: size.width, height: size.height + await over() - 20 });
    await settleMotion(page);
  }
  expect(await over()).toBeGreaterThan(0);
  expect(await over()).toBeLessThan(48);
  // Brought up to show the entrance, a little short of the end.
  await area.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
  await settleMotion(page);
  const where = async () => (await entrance.boundingBox())!.y;
  const at = await where();
  await entrance.locator('button').tap();
  // One page comes in above the entrance, which stays where it was pressed, with nothing gliding past.
  await expect(page.locator('[data-coordinator-message]')).toHaveCount(70);
  await settleMotion(page);
  expect(await where()).toBeCloseTo(at, 0);
  expect(await page.evaluate(() => (window as any).glides)).toBe(0);
  expect(pages).toEqual([`turn-${older}`]);
  // Each page comes as the reader nears the top of what is read, and reading back stops at the limit.
  for (let read = 2; read <= 6; read++) {
    await area.evaluate(el => { el.scrollTop = 0; });
    await expect.poll(() => pages.length).toBe(read);
    await expect(page.locator('[data-coordinator-message]')).toHaveCount(20 + 50 * read);
  }
  await area.evaluate(el => { el.scrollTop = 0; });
  await expect(page.locator('[data-earlier-more]')).toHaveAttribute('data-earlier-more', 'full');
  await page.waitForTimeout(500);
  expect(pages).toHaveLength(6);
});
