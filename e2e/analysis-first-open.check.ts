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
    const open = page.getByRole("button", { name: "Share", exact: true });
    await open.click();
    const card = page.getByRole("dialog", { name: "Share" });
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
    await page.getByRole("button", { name: "Share", exact: true }).click();
    const card = page.getByRole("dialog", { name: "Share" });
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
    await expect(card.getByRole("button", { name: "Post to X" })).toBeVisible();
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

/** A sideways wheel over the analysis once its rows are drawn: the face stays where it is. */
async function noSidewaysSlide(page: import("@playwright/test").Page, origin: string) {
  await page.goto(`${origin}/?face=analysis`);
  const face = page.locator("[data-list-scroll]");
  await expect(face.locator("[data-answer] [data-row]").first()).toBeVisible();
  const box = (await face.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  for (let turn = 0; turn < 2; turn++) {
    await page.mouse.wheel(40, 0);
    await page.waitForTimeout(200);
    expect(await face.evaluate(node => node.scrollLeft)).toBe(0);
  }
}

test("the analysis does not slide sideways when everything on it fits", async ({ page, runtime }) => {
  await noSidewaysSlide(page, runtime.origin);
});

test("each service's button opens that service's post screen with the card's sentence", async ({ page, context, runtime }) => {
  await context.route(/^https:\/\/(x\.com|bsky\.app|www\.threads\.com)\//, route => route.fulfill({ body: "" }));
  await page.goto(`${runtime.origin}/?face=analysis`);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const card = page.getByRole("dialog", { name: "Share" });
  await expect(card.getByRole("img", { name: /^Work handed to AI/ })).toBeVisible();
  for (const [name, start] of [["X", "https://x.com/intent/post?text="], ["Bluesky", "https://bsky.app/intent/compose?text="], ["Threads", "https://www.threads.com/intent/post?text="]] as const) {
    const opened = page.waitForEvent("popup");
    await card.getByRole("button", { name: `Post to ${name}` }).click();
    const url = (await opened).url();
    expect(url.startsWith(start)).toBe(true);
    expect(decodeURIComponent(url.slice(start.length))).toMatch(/#alpacawork$/);
  }
});

test("the share card keeps room at its foot for the coordinator only where the coordinator stands over it", async ({ page, runtime }) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await page.goto(`${runtime.origin}/?face=analysis`);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const card = page.getByRole("dialog", { name: "Share" });
  await expect(card.getByRole("button", { name: "Post to X" })).toBeVisible();
  await settleMotion(page, card);
  // The coordinator's input at the screen's foot, the card, and the card's scrolling part.
  const edges = () => page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const input = box("[data-coordinator-card] :is([data-coordinator-capsule], [data-composer-frame])");
    const panel = box("[data-analysis-panel]"), body = box("[data-analysis-layer]");
    return { inputRight: input.right, inputTop: input.top, panelLeft: panel.left, panelBottom: panel.bottom, bodyBottom: body.bottom };
  });
  // Beside it: what scrolls goes on to the card's foot.
  const beside = await edges();
  expect(beside.inputRight).toBeLessThanOrEqual(beside.panelLeft);
  expect(beside.panelBottom - beside.bodyBottom).toBeLessThan(24);
  // Too narrow for both: the input stands over the card, and what scrolls ends above it.
  await page.setViewportSize({ width: 760, height: 540 });
  await expect.poll(async () => { const over = await edges(); return over.inputRight > over.panelLeft && over.bodyBottom <= over.inputTop; }).toBe(true);
});

test("the analysis keeps its scrollbar's room beside its charts, not over them", async ({ page, runtime }) => {
  await page.goto(`${runtime.origin}/?face=analysis`);
  const face = page.locator("[data-list-scroll]");
  await expect(face.locator("[data-answer] [data-row]").first()).toBeVisible();
  // A scrollbar drawn over what scrolls (a Mac's) stands in the scroller's last 12px: nothing of the face is there.
  const room = await face.evaluate(node => node.getBoundingClientRect().left + node.clientWidth - node.querySelector("[data-answer]")!.getBoundingClientRect().right);
  expect(room).toBeGreaterThanOrEqual(12);
});

test("the window beside the analysis's charts is resized by its edge, no wider than leaves the charts their room", async ({ page, runtime }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`${runtime.origin}/?face=analysis`);
  // The card stands in the window a number's tasks open in.
  await page.getByRole("button", { name: "Make a card", exact: true }).click();
  const panel = page.locator("aside[data-analysis-panel]");
  await expect(panel).toBeVisible();
  await settleMotion(page, panel);
  const width = async () => Math.round((await panel.boundingBox())!.width);
  const start = await width(), from = (await panel.locator("[data-window-width]").boundingBox())!;
  const drag = async (to: number) => {
    const edge = (await panel.locator("[data-window-width]").boundingBox())!;
    await page.mouse.move(edge.x + edge.width / 2, edge.y + 200);
    await page.mouse.down();
    await page.mouse.move(to, edge.y + 200, { steps: 6 });
    await page.mouse.up();
  };
  await drag(from.x + from.width / 2 - 80);
  // It widens as far as the pointer went.
  await expect.poll(width).toBeGreaterThan(start + 60);
  expect(await width()).toBeLessThan(start + 100);
  // Far past what the charts can give: it stops where they keep their room, and stays beside them.
  await drag(40);
  await expect.poll(width).toBe(1600 - 24 - 36 - 680);
  // Let go, the charts are laid out again beside it.
  await expect.poll(async () => {
    const charts = (await page.locator("[data-chart-row]").first().boundingBox())!;
    return charts.x + charts.width <= (await panel.boundingBox())!.x;
  }).toBe(true);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("the analysis does not slide sideways on a phone", async ({ page, runtime }) => {
    await noSidewaysSlide(page, runtime.origin);
  });

  test("flicking the share card down closes it and keeps the analysis open", async ({ page, runtime }) => {
    await page.goto(`${runtime.origin}/?face=analysis`);
    await page.getByRole("button", { name: "Share", exact: true }).tap();
    const card = page.getByRole("dialog", { name: "Share" });
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
    const open = page.getByRole("button", { name: "Share", exact: true });
    const card = page.getByRole("dialog", { name: "Share" });
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
