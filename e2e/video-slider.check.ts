import { commandFetch as fetch } from "../tests/helpers/command-fetch.ts";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect, open, swipe, waitForSliderArrival } from "./fixtures.ts";
import { seedReview, taskFolder } from "./fixture/task-state.ts";
import { publishFixtureFiles } from "./fixture-writes.ts";
import type { Runtime } from "./server.ts";

// Eight seconds, 640×360, with a quiet tone: long enough to seek and catch sound left behind after leaving a slide.
const clip = new URL("./fixture/swipe-clip.webm", import.meta.url);
const small = new URL("./fixture/swipe-small.webm", import.meta.url);
const png = readFileSync(new URL("./fixture/wide-report.png", import.meta.url));
const modal = (page: Page) => page.locator("[data-image-slider-modal]");
const video = (page: Page) => modal(page).locator("video[data-image-slider-large]");
const count = (page: Page) => modal(page).locator("[data-image-slider-count]");
const ready = async (element: Locator) => expect.poll(() => element.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
const stopped = async (page: Page) => expect.poll(() => page.locator("video[data-task-video]").evaluateAll(videos => videos.every(v => (v as HTMLVideoElement).paused))).toBe(true);
async function settled(page: Page) {
  // Selection precedes arrival. Two equal track positions can belong to a delayed frame or an edge bounce.
  // Independent strokes start at the selected picture, through the same arrival boundary as other viewer checks.
  await waitForSliderArrival(modal(page));
}
async function across(page: Page, element: Locator, next = true) {
  await settled(page);
  const b = (await element.boundingBox())!;
  const y = b.y + b.height / 2;
  await swipe(page, { x: b.x + b.width * (next ? .85 : .15), y }, { x: b.x + b.width * (next ? .15 : .85), y });
}
async function seed(runtime: Runtime, task = "T111", first = clip) {
  const folder = join(taskFolder(runtime.root, task), "media");
  mkdirSync(folder, { recursive: true });
  copyFileSync(first, join(folder, "a.webm"));
  copyFileSync(small, join(folder, "b.webm"));
  writeFileSync(join(folder, "c.png"), png);
  publishFixtureFiles(runtime.root);
  await expect.poll(async () => {
    const view = await (await fetch(`${runtime.origin}/api/task/view?task=${task}`)).json() as { task: { files: { name: string }[] } };
    return view.task.files.filter(file => file.name.startsWith("media/")).length;
  }).toBe(3);
}

test.use({ isolated: true });
test.describe.configure({ timeout: 45_000 });
test.describe("phone video gestures through the shared slider", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a sent report uses the shared gallery for video swipes and returns to the report on close", async ({ page, runtime }) => {
    await seed(runtime, "T112");
    seedReview(runtime.root, "T112", { title: "Video review", description: "![Video A](media/a.webm)\n![Image](media/c.png)\n![Video B](media/b.webm)" });
    await open(page, runtime, "?agent=1&task=T112");
    await page.locator('[data-report-image-trigger][data-image-path="media/a.webm"]').tap();
    await ready(video(page));
    await expect(count(page)).toHaveText("1 of 3");
    await across(page, video(page));
    await expect(count(page)).toHaveText("2 of 3");
    await across(page, modal(page).locator("img[data-image-slider-large]"));
    await expect(count(page)).toHaveText("3 of 3");
    await ready(video(page));
    await across(page, video(page));
    await expect(count(page)).toHaveText("3 of 3");
    await stopped(page);
    await across(page, video(page), false);
    await expect(count(page)).toHaveText("2 of 3");
    await modal(page).locator("[data-image-slider-close]").tap();
    await expect(modal(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Video review/ })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("image")).toBeNull();
    await stopped(page);
  });
});
