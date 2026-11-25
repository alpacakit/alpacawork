import { test, expect, openDiagnostics, settleMotion, touch } from "./fixtures.ts";

// The compact bar, ⌘K and Escape are apps/web/tests/chrome-bar.test.tsx; a real page keeps the query and results it already had.
test("the search shortcut focuses an existing query without clearing its results", async ({ page, runtime }) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${runtime.origin}/?q=${encodeURIComponent("Invoice")}`);
    const search = page.locator("input[data-search-input]:visible");
    await expect(search).toHaveValue("Invoice");
    await expect(page.locator("[data-result-list]")).toBeVisible();
    // Focus leaves the search. The header's name is a button that opens the project menu: where the press lands on it
    // (the phone, whose name fills its place), Escape closes the menu and leaves focus on the name.
    const projects = page.getByRole("menu", { name: "Projects" });
    await page.locator("header h1").click();
    if (await projects.isVisible()) {
      await page.keyboard.press("Escape");
      await expect(projects).toHaveCount(0);
      await expect(page.locator("[data-project-trigger]")).toBeFocused();
    }
    await expect(search).not.toBeFocused();
    await page.keyboard.press("Meta+k");
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("Invoice");
    await expect(page.locator("[data-result-list]")).toBeVisible();
  }
});

// ⌘, (Ctrl+, off a Mac) opens the settings from a text field, and in place of another dialog.
test("the settings shortcut opens the settings from a field and over another dialog", async ({ page, runtime }) => {
  await page.goto(runtime.origin);
  const settings = page.getByRole("dialog").filter({ has: page.getByRole("tab", { name: "AI", exact: true }) });
  for (const key of ["Meta+,", "Control+,"]) {
    const search = page.locator("input[data-search-input]:visible");
    await search.click();
    await page.keyboard.press(key);
    await expect(settings).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await openDiagnostics(page);
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(settings).toHaveCount(0);
  await page.keyboard.press("Control+,");
  await expect(settings).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  // The closing diagnostics hand focus back to their opener first; it must not stay outside the settings.
  await expect.poll(() => settings.evaluate(dialog => dialog.contains(document.activeElement))).toBe(true);
});

// A phone's bar is one row: ☰ opens its menu, and the notification state's menu from there comes up from the bottom and
// closes as every sheet there does: by its × and by its grip pulled down.
test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("the bar's menu opens the notification sheet, which closes by its × and by its grip pulled down", async ({ page, runtime }) => {
    await page.goto(runtime.origin);
    const sheet = page.locator("[data-slot=sheet]");
    const fromMenu = async () => {
      await page.locator("[data-bar-menu-trigger]").tap();
      await page.locator("[data-bar-menu-presence]").tap();
      await settleMotion(page);
    };
    await fromMenu();
    await sheet.getByRole("button", { name: "Close", exact: true }).tap();
    await expect(sheet).toHaveCount(0);
    await fromMenu();
    const grip = (await sheet.locator("[data-task-sheet-grab]").boundingBox())!;
    const x = grip.x + grip.width / 2, y = grip.y + 6;
    await touch(page, [[{ x, y }], [{ x, y: y + 80 }], [{ x, y: y + 160 }], [{ x, y: y + 240 }]]);
    await expect(sheet).toHaveCount(0);
  });
});
