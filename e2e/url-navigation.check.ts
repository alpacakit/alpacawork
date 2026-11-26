import { questionRow } from './fixture/list-rows.ts';
import type { Page } from "@playwright/test";
import { test, expect, open } from "./fixtures.ts";

// Keep the real child and ancestor links while an explicit user question exposes its list row.
test.use({ isolated: true, runtimePrepare: async ({}, use) => { await use(root => questionRow(root, 'T111')); } });
const reader = (page: Page) => page.getByRole("complementary", { name: "Full text of the task" });
const taskParam = (page: Page) => new URL(page.url()).searchParams.get("task");
const widthParam = (page: Page) => new URL(page.url()).searchParams.get("width");

test("a full detail URL opens across the desktop and follows browser navigation", async ({ page, runtime }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, runtime, "?task=T111&width=full");
  await expect(reader(page)).toHaveAttribute("data-reader-mode", "overlay");
  expect((await reader(page).boundingBox())?.width).toBe(1440);
  await reader(page).getByRole("button", { name: "Restore details width" }).click();
  await expect.poll(() => widthParam(page)).toBeNull();
  await expect(reader(page)).toHaveAttribute("data-reader-mode", "docked");
  await reader(page).locator("[data-window-width]").focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => widthParam(page)).toBeNull();
  await reader(page).getByRole("button", { name: "Show details full screen" }).click();
  await expect.poll(() => widthParam(page)).toBe("full");
  await page.evaluate(() => localStorage.removeItem("alpacawork.screen.width"));
  await page.goto(`${runtime.origin}/?task=T111`);
  await expect(reader(page)).toHaveAttribute("data-reader-mode", "docked");
  await page.goBack();
  await expect(reader(page)).toHaveAttribute("data-reader-mode", "overlay");
  await page.goForward();
  await expect(reader(page)).toHaveAttribute("data-reader-mode", "docked");
  await page.goto(`${runtime.origin}/?width=full`);
  await expect(reader(page)).toHaveCount(0);
  await expect.poll(() => widthParam(page)).toBeNull();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${runtime.origin}/?task=T111&width=full`);
  // A phone's reader is its sheet whatever width the URL names.
  await expect(reader(page)).toHaveAttribute("data-reader-mode", "sheet");
  await expect(reader(page).getByRole("button", { name: "Restore details width" })).toHaveCount(0);
});

for (const width of [1440]) {
  test(`report reader, ancestor, search and browser back at ${width}px`, async ({ page, runtime }) => {
    await page.setViewportSize({ width, height: 900 });
    const task = "T111";
    const title = "Invoice reconciliation";
    await open(page, runtime, `?task=${task}&width=full`);
    await expect(reader(page)).toBeVisible();
    await expect(reader(page).locator("[data-report-feed]")).toBeVisible();
    await reader(page).locator("[data-reader-path] span > button").last().click();
    await expect.poll(() => taskParam(page)).toBe("T11");
    await page.goBack();
    await expect.poll(() => taskParam(page)).toBe(task);
    await page.goForward();
    await expect.poll(() => taskParam(page)).toBe("T11");
    await reader(page).getByRole("button", { name: "Close details" }).click();
    await expect(reader(page)).toHaveCount(0);
    if (await page.locator("[data-search-toggle]").isVisible()) await page.locator("[data-search-toggle]").click();
    await page.getByRole("searchbox").fill(title);
    // Search input debounces. The still-visible tree row is a different navigation entrance.
    const result = page.locator("[data-result-list]").locator(`[data-result="${task}"]`);
    await expect(result).toHaveAccessibleName(new RegExp(`${task}.*${title}`));
    await result.click();
    await expect.poll(() => taskParam(page)).toBe(task);
    await expect(reader(page)).toBeVisible();
    await page.goBack();
    await expect(reader(page)).toHaveCount(0);
  });
}
