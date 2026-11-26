import { test, expect, settleMotion, swipe } from "./fixtures.ts";

test("opening a share card shows its loading state and starts reading its numbers while its code is held", async ({ page, runtime }) => {
  let releaseCardCode!: () => void;
  const cardCode = new Promise<void>(resolve => { releaseCardCode = resolve; });
  await page.route("**/assets/Layers-*.js", async route => {
    await cardCode;
    await route.continue();
  });
  let usageView: string | null | undefined;
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === "/api/commands/analysis/usage" && url.searchParams.get("by") === "model") usageView = url.searchParams.get("view");
  });

  try {
    await page.goto(runtime.origin);
    await page.getByRole("button", { name: "Analysis", exact: true }).click();
    const open = page.getByRole("button", { name: "Make a card", exact: true });
    await open.click();
    const card = page.getByRole("dialog", { name: "Make a card" });
    await expect(card.getByRole("status", { name: "Loading" })).toBeVisible();
    await expect.poll(() => usageView).toBe("summary");
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect(open).toBeFocused();
  } finally {
    releaseCardCode();
  }
});

test("in a short window the share card's picture keeps its size when its code arrives and brings a scrollbar", async ({ playwright, launchOptions, runtime }) => {
  // Scrollbars that take room, as on Windows and most Linux desktops: headless Chromium hides its own.
  const browser = await playwright.chromium.launch({ ...launchOptions, ignoreDefaultArgs: ["--hide-scrollbars"],
    args: ["--disable-features=OverlayScrollbar,FluentOverlayScrollbar"] });
  let releaseCardCode!: () => void;
  const cardCode = new Promise<void>(resolve => { releaseCardCode = resolve; });
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 640 }, locale: "en-US", serviceWorkers: "block" });
    await page.route("**/assets/Layers-*.js", async route => {
      await cardCode;
      await route.continue();
    });
    await page.goto(`${runtime.origin}/?face=analysis`);
    await page.getByRole("button", { name: "Make a card", exact: true }).click();
    const card = page.getByRole("dialog", { name: "Make a card" });
    const frame = card.getByRole("status", { name: "Loading" }).locator("..");
    await expect(frame).toBeVisible();
    await settleMotion(page, card, true);
    const body = card.locator("[data-analysis-layer]");
    // [the room kept for the scrollbar, taller than the window]. The room is there while the card waits.
    const scroll = () => body.evaluate(node => [Math.round(node.getBoundingClientRect().width) - node.clientWidth, node.scrollHeight > node.clientHeight]);
    const [barWhileWaiting] = await scroll();
    const waiting = (await frame.boundingBox())!;
    releaseCardCode();
    const picture = card.getByRole("img", { name: /^Work handed to AI/ });
    await expect(picture).toBeVisible();
    await expect(card.getByRole("button", { name: "Share on X" })).toBeVisible();
    // The picture and its controls overflow the window, so the bar is really there once they have come.
    expect(await scroll()).toEqual([barWhileWaiting, true]);
    expect(barWhileWaiting).toBeGreaterThan(0);
    const drawn = (await picture.boundingBox())!;
    expect([drawn.x, drawn.width, drawn.height]).toEqual([waiting.x, waiting.width, waiting.height]);
  } finally {
    releaseCardCode();
    await browser.close();
  }
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("flicking the share card down closes it and keeps the analysis open", async ({ page, runtime }) => {
    await page.goto(`${runtime.origin}/?face=analysis`);
    await page.getByRole("button", { name: "Make a card", exact: true }).tap();
    const card = page.getByRole("dialog", { name: "Make a card" });
    await expect(card).toBeVisible();
    await settleMotion(page, card);
    const grip = (await card.getByRole("separator").boundingBox())!;
    const from = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
    await swipe(page, from, { ...from, y: from.y + 200 });
    await expect(card).toHaveCount(0);
    await expect(page).toHaveURL(url => url.searchParams.get("face") === "analysis" && !url.searchParams.has("card"));
  });

  test("a share card made shorter by hand opens at its full height the next time", async ({ page, runtime }) => {
    await page.goto(`${runtime.origin}/?face=analysis`);
    const open = page.getByRole("button", { name: "Make a card", exact: true });
    const card = page.getByRole("dialog", { name: "Make a card" });
    const height = async () => (await card.boundingBox())!.height;
    await open.tap();
    await settleMotion(page, card);
    const full = await height();
    await card.getByRole("separator").focus();
    for (let step = 0; step < 6; step++) await page.keyboard.press("ArrowDown");
    await expect.poll(height).toBeLessThan(full - 100);
    await card.getByRole("button", { name: "Close", exact: true }).tap();
    await expect(card).toHaveCount(0);
    await open.tap();
    await settleMotion(page, card);
    expect(await height()).toBe(full);
  });
});
