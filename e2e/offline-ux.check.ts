/** The real SW, connection transitions and pull hook share the shown-offline boundary. */
import { test, expect, controlledPwa } from './pwa-fixture.ts';
import { open } from './fixtures.ts';
test.use({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });
test('offline pull is inactive, reconnect permits a complete pull, and going offline ends an armed pull', async ({ page, context, runtime }) => {
  await open(page, runtime, '?agent=1'); await controlledPwa(page);
  await page.waitForTimeout(1200); // Past initial list motion, on the real screen.
  const mark = page.locator('[data-pull-mark]');
  const session = await context.newCDPSession(page);
  const gesture = async (release = true) => {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 300 }] });
    for (let i = 1; i <= 22; i++) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y: 300 + i * 10 }] });
    if (release) await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const requests: string[] = [];
  context.on('request', request => requests.push(new URL(request.url()).pathname));
  await context.setOffline(true);
  await expect(page.locator('[data-offline-mark]')).toHaveCount(1);
  // Out of reach the line stays, still and grey, beside the bar's one mark.
  await expect(page.locator('[data-progress-line="offline"]')).toBeVisible();
  requests.splice(0);
  await gesture();
  await expect(mark).toHaveAttribute('data-phase', 'rest');
  await expect(mark).toHaveCSS('opacity', '0');
  expect(requests).toEqual([]);
  await context.setOffline(false);
  await expect(page.locator('[data-offline-mark]')).toHaveCount(0);
  await expect.poll(() => requests).toContain('/api/events');
  await page.evaluate(() => {
    const phases: string[] = []; (window as any).pullPhases = phases;
    const mark = document.querySelector<HTMLElement>('[data-pull-mark]')!;
    new MutationObserver(() => { if (phases.at(-1) !== mark.dataset.phase) phases.push(mark.dataset.phase!); })
      .observe(mark, { attributes: true, attributeFilter: ['data-phase'] });
  });
  await gesture();
  await expect.poll(() => page.evaluate(() => (window as any).pullPhases)).toContain('done');
  await expect(mark).toHaveAttribute('data-phase', 'rest');
  await gesture(false);
  await expect(mark).toHaveAttribute('data-phase', 'armed');
  await context.setOffline(true);
  await expect(page.locator('[data-offline-mark]').first()).toBeVisible();
  await expect(mark).toHaveAttribute('data-phase', 'rest');
  await expect(mark).toHaveCSS('opacity', '0');
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
});
