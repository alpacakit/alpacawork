import type { Page } from "@playwright/test";
import { test, expect, open, touch } from "./fixtures.ts";

test.use({ isolated: true, isMobile: true, hasTouch: true, viewport: { width: 412, height: 915 } });

type Point = { x: number; y: number };
/** One finger from `from`, down by `by` in even steps; `then` adds steps before it lifts (a second finger, say). */
const pull = (from: Point, by: number, steps = 20, then: Point[][] = []) =>
  [...Array.from({ length: steps + 1 }, (_, i) => [{ x: from.x, y: from.y + by * i / steps }]), ...then];
/** The phases the pull's mark goes through from now on: `went()` says them so far, `went(true)` also starts again. */
async function phases(page: Page) {
  await expect(page.locator("[data-pull-mark]")).toHaveAttribute("data-phase", "rest");
  await page.evaluate(() => {
    const mark = document.querySelector<HTMLElement>("[data-pull-mark]")!;
    const seen: string[] = ((window as unknown as { pullPhases: string[] }).pullPhases = []);
    new MutationObserver(() => { if (seen.at(-1) !== mark.dataset.phase) seen.push(mark.dataset.phase!); })
      .observe(mark, { attributes: true, attributeFilter: ["data-phase"] });
  });
  return (clear = false) => page.evaluate((clear) => {
    const seen = (window as unknown as { pullPhases: string[] }).pullPhases;
    return clear ? seen.splice(0) : [...seen];
  }, clear);
}

test("a refresh that fails shows no tick and goes back; the next one works", async ({ page, runtime }) => {
  await open(page, runtime);
  const went = await phases(page);
  await page.route("**/api/events", (route) => route.abort());
  await touch(page, pull({ x: 206, y: 300 }, 300));
  await expect.poll(() => went(), { timeout: 15_000 }).toEqual(["pull", "armed", "refreshing", "rest"]);
  await went(true);
  const reconnected = page.waitForResponse(response => new URL(response.url()).pathname === "/api/events" && response.status() === 200, { timeout: 15_000 });
  await page.unroute("**/api/events");
  await reconnected;
  await expect(page.locator("[data-offline-mark]")).toHaveCount(0);
  // The feed is back on its own; a pull then refreshes as ever.
  await expect(page.locator("[data-pull-mark]")).toHaveAttribute("data-phase", "rest");
  await touch(page, pull({ x: 206, y: 300 }, 300));
  await expect.poll(() => went(), { timeout: 15_000 }).toContain("done");
});
