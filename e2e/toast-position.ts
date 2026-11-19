import { expect, type Locator } from '@playwright/test';

/** Every screen uses the visible viewport's top centre, with safe-area padding and no horizontal overflow. */
export async function atTheTop(toast: Locator) {
  // A box within the position tolerance can still be entering. Finish its own
  // entrance before callers use that box as a stable baseline (for example zoom).
  await toast.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  const viewport = await toast.page().evaluate(() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;padding-top:env(safe-area-inset-top);padding-left:max(14px,env(safe-area-inset-left),env(safe-area-inset-right))';
    document.body.append(probe);
    const style = getComputedStyle(probe), safe = parseFloat(style.paddingTop), gap = parseFloat(style.paddingLeft);
    probe.remove();
    return { top: (visualViewport?.offsetTop ?? 0) + safe + 8,
      left: visualViewport?.offsetLeft ?? 0, width: visualViewport?.width ?? innerWidth, gap };
  });
  // Entrance motion drops in from above; the final position is independent of headers and overlays.
  await expect.poll(async () => Math.abs((await toast.boundingBox())!.y - viewport.top)).toBeLessThanOrEqual(1.5);
  const box = (await toast.boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - (viewport.left + viewport.width / 2))).toBeLessThanOrEqual(1);
  expect(box.x).toBeGreaterThanOrEqual(viewport.left + viewport.gap - 1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.left + viewport.width - viewport.gap + 1);
}
