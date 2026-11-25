import { test, expect } from "./fixtures.ts";

test("opening a share card shows its loading state and starts reading its numbers while its code is held", async ({ page, runtime }) => {
  let releaseCardCode!: () => void;
  const cardCode = new Promise<void>(resolve => { releaseCardCode = resolve; });
  await page.route("**/assets/Layers-*.js", async route => {
    await cardCode;
    await route.continue();
  });
  let requestedUsage = false;
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === "/api/commands/analysis/usage" && url.searchParams.get("by") === "model") requestedUsage = true;
  });

  try {
    await page.goto(runtime.origin);
    await page.getByRole("button", { name: "Analysis", exact: true }).click();
    const open = page.getByRole("button", { name: "Make a card", exact: true });
    await open.click();
    const card = page.getByRole("dialog", { name: "Make a card" });
    await expect(card.getByRole("status", { name: "Loading" })).toBeVisible();
    await expect.poll(() => requestedUsage).toBe(true);
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect(open).toBeFocused();
  } finally {
    releaseCardCode();
  }
});
